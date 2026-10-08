/*
 * gateways/infinitypay.js
 * -----------------------------------------------------------------------------
 * Integracao com a InfinityPay (API v2 de transacoes).
 *
 * Fluxo real:
 *   POST /v2/transactions   -> cria a transacao (Pix, cartao ou boleto)
 *   GET  /v2/transactions/:id -> consulta a transacao (usada no webhook)
 *
 * Autenticacao: HTTP Basic, com `api_key` como usuario e `api_secret` como
 * senha. A InfinityPay trabalha com VALORES EM CENTAVOS, o que casa direto com
 * o resto do sistema (nada de conversao para decimal aqui).
 *
 * Sem credenciais, cai na simulacao local.
 */
'use strict';

const base = require('./base');

const id = 'infinitypay';
const prefixo = 'inf';

// A API usa nomes proprios para cada forma de pagamento.
const METODO_API = {
  pix: 'pix',
  cartao: 'credit_card',
  boleto: 'boleto'
};

const STATUS = {
  paid: 'aprovado',
  authorized: 'aprovado',
  approved: 'aprovado',
  waiting_payment: 'pendente',
  pending: 'pendente',
  processing: 'pendente',
  refused: 'recusado',
  canceled: 'recusado',
  cancelled: 'recusado',
  failed: 'recusado'
};

function traduzirStatus(status) {
  return STATUS[String(status || '').toLowerCase()] || 'pendente';
}

function urlBase(modo, gateway) {
  return modo === 'producao' ? gateway.integracao.urlProducao : gateway.integracao.urlSandbox;
}

/** Basic Auth: "api_key:api_secret" em base64. */
function cabecalhos(credenciais, referencia) {
  const usuario = String(credenciais.api_key || '');
  const senha = String(credenciais.api_secret || '');
  const token = Buffer.from(`${usuario}:${senha}`).toString('base64');
  return {
    Authorization: `Basic ${token}`,
    'X-Idempotency-Key': String(referencia)
  };
}

function instrucoesDe(dados) {
  if (!dados) return null;

  if (dados.pix && (dados.pix.qr_code || dados.pix.qrcode)) {
    return {
      copiaECola: dados.pix.qr_code || dados.pix.qrcode,
      qrCodeBase64: dados.pix.qr_code_base64 || null,
      aviso: 'Escaneie o QR Code ou use o Pix copia e cola.'
    };
  }
  if (dados.boleto && (dados.boleto.url || dados.boleto.barcode)) {
    return {
      linkPagamento: dados.boleto.url || null,
      linhaDigitavel: dados.boleto.barcode || '',
      vencimentoFormatado: dados.boleto.due_date || null,
      aviso: 'Pague o boleto. A liberacao acontece apos a compensacao.'
    };
  }
  if (dados.acquirer && dados.acquirer.return_url) {
    return { linkPagamento: dados.acquirer.return_url, aviso: 'Conclua o pagamento com o emissor.' };
  }
  return null;
}

async function cobrarReal({ valorCentavos, metodo, referencia, descricao, credenciais, modo, pagador, cartaoToken, gateway }) {
  const corpo = {
    amount: Math.round(valorCentavos), // centavos, como a InfinityPay espera
    payment_method: METODO_API[metodo] || 'pix',
    reference: String(referencia),
    description: String(descricao || `Pedido ${referencia}`).slice(0, 250),
    customer: {
      name: (pagador && pagador.nome) || 'Comprador',
      email: (pagador && pagador.email) || 'comprador@nexus.gg',
      ...(pagador && pagador.documento ? { document: String(pagador.documento).replace(/\D/g, '') } : {})
    },
    ...(cartaoToken ? { card_token: cartaoToken } : {}),
    ...(metodo === 'cartao' && !cartaoToken ? { capture: false } : {})
  };

  const resposta = await base.requisitar(`${urlBase(modo, gateway)}/v2/transactions`, {
    cabecalhos: cabecalhos(credenciais, referencia),
    corpo
  });
  const dados = base.exigirResposta(resposta, 'InfinityPay');
  const status = traduzirStatus(dados.status);

  return {
    id: `inf_${dados.id}`,
    metodo,
    status,
    valorCentavos,
    aprovadoEm: status === 'aprovado' ? new Date().toISOString() : undefined,
    instrucoes: instrucoesDe(dados) || undefined
  };
}

async function cobrar(dados) {
  const { credenciais, gateway, valorCentavos, metodo, referencia } = dados;
  const pronto = base.conferirCredenciais(credenciais, gateway.campos);
  if (!pronto.ok) {
    return { ...base.simularLocal({ prefixo, valorCentavos, metodo, referencia }), simuladoLocal: true };
  }
  return cobrarReal(dados);
}

async function reembolsar({ pagamentoId, valorCentavos, credenciais, modo, gateway }) {
  const pronto = base.conferirCredenciais(credenciais, gateway.campos);
  if (!pronto.ok) return { ok: true, simuladoLocal: true };

  const idLimpo = String(pagamentoId || '').replace(/^inf_/, '');
  const resposta = await base.requisitar(
    `${urlBase(modo, gateway)}/v2/transactions/${encodeURIComponent(idLimpo)}/refund`,
    { cabecalhos: cabecalhos(credenciais, idLimpo), corpo: { amount: Math.round(valorCentavos || 0) } }
  );
  base.exigirResposta(resposta, 'InfinityPay');
  return { ok: true };
}

/**
 * Webhook da InfinityPay. O payload traz a transacao em `data`. Valida a
 * assinatura HMAC quando ha segredo configurado.
 */
async function verificarWebhook({ corpoBruto, cabecalhos, dados, credenciais, gateway }) {
  const segredo = credenciais && credenciais.webhook_secret;
  const assinatura = cabecalhos && (cabecalhos['x-infinity-signature'] || cabecalhos['X-Infinity-Signature']);

  if (segredo) {
    const esperada = base.hmacSha256(segredo, corpoBruto || '');
    if (!base.assinaturaConfere(esperada, assinatura)) {
      return { valido: false, motivo: 'assinatura invalida' };
    }
  }

  const transacao = (dados && (dados.data || dados.transaction)) || {};
  const referencia = transacao.reference || transacao.external_reference || (dados && dados.reference);

  if (!referencia) return { valido: false, motivo: 'evento sem referencia' };

  const status = traduzirStatus(transacao.status);
  return {
    valido: true,
    referencia: String(referencia),
    pagamentoId: transacao.id ? `inf_${transacao.id}` : null,
    status,
    evento: `pagamento.${status}`
  };
}

/** Teste de conexao: listagem (leitura) de transacoes. Nao cobra nada. */
async function testarConexao({ credenciais, modo, gateway }) {
  const resposta = await base.requisitar(`${urlBase(modo, gateway)}/v2/transactions?limit=1`, {
    metodo: 'GET',
    cabecalhos: cabecalhos(credenciais, 'diagnostico')
  });
  if (!resposta.ok) {
    return { ok: false, mensagem: `InfinityPay recusou as credenciais (HTTP ${resposta.status}).` };
  }
  return { ok: true, mensagem: 'Credenciais validas: a InfinityPay respondeu a uma consulta de leitura.' };
}

module.exports = { id, prefixo, cobrar, reembolsar, verificarWebhook, testarConexao };
