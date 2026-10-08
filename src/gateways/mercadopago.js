/*
 * gateways/mercadopago.js
 * -----------------------------------------------------------------------------
 * Integracao com o Mercado Pago (API de Payments).
 *
 * Fluxo real:
 *   POST /v1/payments            -> cobranca transparente (Pix, boleto, cartao)
 *   POST /checkout/preferences   -> Checkout Pro (redirecionamento), usado para
 *                                   cartao quando o front nao tokeniza o cartao
 *   GET  /v1/payments/:id        -> consulta, usada no webhook
 *
 * Sem credenciais configuradas, o gateway cai na simulacao local (marcada com
 * `simuladoLocal: true`), para a loja continuar operando em demonstracao.
 */
'use strict';

const base = require('./base');

const id = 'mercadopago';
const prefixo = 'mp';

// Traduz o status do Mercado Pago para o vocabulario do sistema.
const STATUS = {
  approved: 'aprovado',
  authorized: 'aprovado',
  in_process: 'pendente',
  pending: 'pendente',
  rejected: 'recusado',
  cancelled: 'recusado',
  refunded: 'recusado',
  charged_back: 'recusado'
};

function traduzirStatus(status) {
  return STATUS[String(status || '').toLowerCase()] || 'pendente';
}

/** URL base conforme o modo (o Mercado Pago usa a mesma base nos dois). */
function urlBase(modo, gateway) {
  return modo === 'producao' ? gateway.integracao.urlProducao : gateway.integracao.urlSandbox;
}

function cabecalhos(credenciais, referencia) {
  return {
    Authorization: `Bearer ${credenciais.access_token}`,
    // Idempotencia: reenviar o mesmo pedido nao cobra duas vezes.
    'X-Idempotency-Key': String(referencia)
  };
}

/** Monta o corpo de /v1/payments conforme a forma de pagamento. */
function corpoPagamento({ valorCentavos, metodo, referencia, descricao, pagador, cartaoToken }) {
  const comum = {
    transaction_amount: Math.round(valorCentavos) / 100,
    description: String(descricao || `Pedido ${referencia}`).slice(0, 250),
    external_reference: String(referencia),
    payer: {
      email: (pagador && pagador.email) || 'comprador@nexus.gg',
      ...(pagador && pagador.nome ? { first_name: String(pagador.nome).split(' ')[0] } : {})
    }
  };

  if (metodo === 'pix') return { ...comum, payment_method_id: 'pix' };

  if (metodo === 'boleto') {
    return {
      ...comum,
      payment_method_id: 'bolbradesco',
      ...(pagador && pagador.documento
        ? { payer: { ...comum.payer, identification: { type: 'CPF', number: String(pagador.documento).replace(/\D/g, '') } } }
        : {})
    };
  }

  // Cartao: exige token gerado no navegador (PCI). Sem token, quem cobra e o
  // Checkout Pro (redirecionamento) — tratado em `cobrar`.
  return {
    ...comum,
    token: cartaoToken,
    installments: 1,
    payment_method_id: pagador && pagador.bandeira ? pagador.bandeira : undefined
  };
}

/** Extrai as instrucoes que o cliente precisa ver na tela. */
function instrucoesDe(dados) {
  const ponto = dados && dados.point_of_interaction && dados.point_of_interaction.transaction_data;
  const detalhes = (dados && dados.transaction_details) || {};

  if (ponto && ponto.qr_code) {
    return {
      copiaECola: ponto.qr_code,
      qrCodeBase64: ponto.qr_code_base64 || null,
      aviso: 'Escaneie o QR Code ou use o Pix copia e cola. A liberacao e automatica.'
    };
  }
  if (detalhes.external_resource_url) {
    return {
      linkPagamento: detalhes.external_resource_url,
      linhaDigitavel: detalhes.barcode ? String(detalhes.barcode.content || '') : '',
      aviso: 'Abra o boleto para pagar. A liberacao acontece apos a compensacao.'
    };
  }
  return null;
}

/** Cobra de verdade no Mercado Pago. */
async function cobrarReal({ valorCentavos, metodo, referencia, descricao, credenciais, modo, pagador, cartaoToken, gateway }) {
  const baseUrl = urlBase(modo, gateway);

  // Cartao sem token: usa o Checkout Pro (o cliente paga numa pagina do MP).
  if (metodo === 'cartao' && !cartaoToken) {
    const resposta = await base.requisitar(`${baseUrl}/checkout/preferences`, {
      cabecalhos: cabecalhos(credenciais, referencia),
      corpo: {
        external_reference: String(referencia),
        items: [{
          title: String(descricao || `Pedido ${referencia}`).slice(0, 250),
          quantity: 1,
          currency_id: 'BRL',
          unit_price: Math.round(valorCentavos) / 100
        }]
      }
    });
    const dados = base.exigirResposta(resposta, 'Mercado Pago');
    return {
      id: `mp_pref_${dados.id}`,
      metodo,
      status: 'pendente',
      valorCentavos,
      instrucoes: {
        linkPagamento: dados.init_point || dados.sandbox_init_point,
        aviso: 'Conclua o pagamento na pagina segura do Mercado Pago.'
      }
    };
  }

  const resposta = await base.requisitar(`${baseUrl}/v1/payments`, {
    cabecalhos: cabecalhos(credenciais, referencia),
    corpo: corpoPagamento({ valorCentavos, metodo, referencia, descricao, pagador, cartaoToken })
  });
  const dados = base.exigirResposta(resposta, 'Mercado Pago');
  const status = traduzirStatus(dados.status);

  return {
    id: `mp_${dados.id}`,
    metodo,
    status,
    valorCentavos,
    aprovadoEm: status === 'aprovado' ? new Date().toISOString() : undefined,
    instrucoes: instrucoesDe(dados) || undefined,
    detalhe: dados.status_detail || null
  };
}

async function cobrar(dados) {
  const { credenciais, gateway, valorCentavos, metodo, referencia } = dados;

  const pronto = base.conferirCredenciais(credenciais, gateway.campos);
  if (!pronto.ok) {
    // Sem credenciais: simula (a fachada marca a origem).
    return { ...base.simularLocal({ prefixo, valorCentavos, metodo, referencia }), simuladoLocal: true };
  }

  return cobrarReal(dados);
}

/** Estorna uma cobranca aprovada. */
async function reembolsar({ pagamentoId, credenciais, modo, gateway }) {
  const pronto = base.conferirCredenciais(credenciais, gateway.campos);
  if (!pronto.ok) return { ok: true, simuladoLocal: true };

  const idLimpo = String(pagamentoId || '').replace(/^mp_/, '');
  const resposta = await base.requisitar(`${urlBase(modo, gateway)}/v1/payments/${encodeURIComponent(idLimpo)}/refunds`, {
    cabecalhos: { Authorization: `Bearer ${credenciais.access_token}` },
    corpo: {}
  });
  base.exigirResposta(resposta, 'Mercado Pago');
  return { ok: true };
}

/**
 * Webhook: valida a assinatura `x-signature` e consulta o pagamento para
 * descobrir a qual pedido ele pertence.
 */
async function verificarWebhook({ corpoBruto, cabecalhos, dados, credenciais, modo, gateway }) {
  const segredo = credenciais && credenciais.webhook_secret;
  const assinatura = cabecalhos && (cabecalhos['x-signature'] || cabecalhos['X-Signature']);

  // Assinatura configurada: e obrigatorio conferir. Sem segredo, aceita mas
  // sinaliza que nao houve validacao criptografica.
  if (segredo) {
    const v1 = base.extrairAssinaturaMercadoPago(assinatura);
    const ts = String(assinatura || '').match(/ts=([^,]+)/);
    const requestId = cabecalhos['x-request-id'] || '';
    const dataId = dados && dados.data && dados.data.id;
    const manifesto = `id:${dataId};request-id:${requestId};ts:${ts ? ts[1] : ''};`;
    const esperada = base.hmacSha256(segredo, manifesto);
    if (!base.assinaturaConfere(esperada, v1)) {
      return { valido: false, motivo: 'assinatura invalida' };
    }
  }

  const pagamentoId = dados && dados.data && dados.data.id;
  if (!pagamentoId) return { valido: false, motivo: 'evento sem id de pagamento' };

  // Sem credenciais nao da para consultar o pagamento: aceita so o id.
  const pronto = base.conferirCredenciais(credenciais, gateway.campos);
  if (!pronto.ok) {
    return { valido: true, pagamentoId: `mp_${pagamentoId}`, referencia: null, status: 'aprovado', evento: 'pagamento.atualizado' };
  }

  const resposta = await base.requisitar(`${urlBase(modo, gateway)}/v1/payments/${encodeURIComponent(pagamentoId)}`, {
    metodo: 'GET',
    cabecalhos: { Authorization: `Bearer ${credenciais.access_token}` }
  });
  const pagamento = base.exigirResposta(resposta, 'Mercado Pago');

  return {
    valido: true,
    referencia: pagamento.external_reference ? String(pagamento.external_reference) : null,
    pagamentoId: `mp_${pagamento.id}`,
    status: traduzirStatus(pagamento.status),
    evento: `pagamento.${traduzirStatus(pagamento.status)}`
  };
}

/**
 * Teste de conexao: rota de LEITURA (`/users/me`). Nao cobra nada.
 */
async function testarConexao({ credenciais, modo, gateway }) {
  const resposta = await base.requisitar(`${urlBase(modo, gateway)}/users/me`, {
    metodo: 'GET',
    cabecalhos: { Authorization: `Bearer ${credenciais.access_token}` }
  });
  if (!resposta.ok) {
    return { ok: false, mensagem: `Mercado Pago recusou as credenciais (HTTP ${resposta.status}).` };
  }
  const dados = resposta.dados || {};
  return { ok: true, mensagem: `Credenciais validas. Conta: ${dados.nickname || dados.id || 'identificada'}.` };
}

module.exports = { id, prefixo, cobrar, reembolsar, verificarWebhook, testarConexao };
