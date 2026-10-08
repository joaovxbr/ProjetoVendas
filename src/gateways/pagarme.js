/*
 * gateways/pagarme.js
 * -----------------------------------------------------------------------------
 * Integracao com a Pagar.me (API v5 de Orders).
 *
 * Fluxo real:
 *   POST /core/v5/orders -> cria o pedido com a cobranca (Pix, cartao, boleto)
 *
 * Autenticacao: HTTP Basic com a `secret_key` como usuario e senha vazia —
 * exatamente como a Pagar.me documenta. Valores em CENTAVOS.
 *
 * Sem credenciais, cai na simulacao local.
 */
'use strict';

const base = require('./base');

const id = 'pagarme';
const prefixo = 'pme';

const METODO_API = { pix: 'pix', cartao: 'credit_card', boleto: 'boleto' };

const STATUS = {
  paid: 'aprovado',
  authorized: 'aprovado',
  pending: 'pendente',
  processing: 'pendente',
  failed: 'recusado',
  canceled: 'recusado',
  refused: 'recusado'
};

function traduzirStatus(status) {
  return STATUS[String(status || '').toLowerCase()] || 'pendente';
}

function urlBase(modo, gateway) {
  return modo === 'producao' ? gateway.integracao.urlProducao : gateway.integracao.urlSandbox;
}

function cabecalhos(credenciais, referencia) {
  const token = Buffer.from(`${credenciais.secret_key || ''}:`).toString('base64');
  return { Authorization: `Basic ${token}`, 'Idempotency-Key': String(referencia) };
}

function instrucoesDe(cobranca) {
  const transacao = cobranca && cobranca.last_transaction;
  if (!transacao) return null;

  if (transacao.qr_code) {
    return {
      copiaECola: transacao.qr_code,
      qrCodeBase64: transacao.qr_code_url || null,
      aviso: 'Escaneie o QR Code ou use o Pix copia e cola.'
    };
  }
  if (transacao.url) {
    return {
      linkPagamento: transacao.url,
      linhaDigitavel: transacao.line || '',
      aviso: 'Pague o boleto. A liberacao acontece apos a compensacao.'
    };
  }
  return null;
}

async function cobrarReal({ valorCentavos, metodo, referencia, descricao, credenciais, modo, pagador, cartaoToken, gateway }) {
  const forma = METODO_API[metodo] || 'pix';

  const corpo = {
    items: [{
      amount: Math.round(valorCentavos),
      description: String(descricao || `Pedido ${referencia}`).slice(0, 250),
      quantity: 1
    }],
    customer: {
      name: (pagador && pagador.nome) || 'Comprador',
      email: (pagador && pagador.email) || 'comprador@nexus.gg',
      type: 'individual',
      ...(pagador && pagador.documento
        ? { document: String(pagador.documento).replace(/\D/g, ''), document_type: 'CPF' }
        : {})
    },
    payments: [{
      payment_method: forma,
      ...(forma === 'pix' ? { pix: { expires_in: 3600 } } : {}),
      ...(forma === 'boleto' ? { boleto: { instructions: 'Pedido ' + referencia } } : {}),
      ...(forma === 'credit_card'
        ? { credit_card: { installments: 1, ...(cartaoToken ? { card_token: cartaoToken } : {}) } }
        : {})
    }],
    metadata: { referencia: String(referencia) }
  };

  const resposta = await base.requisitar(`${urlBase(modo, gateway)}/core/v5/orders`, {
    cabecalhos: cabecalhos(credenciais, referencia),
    corpo
  });
  const dados = base.exigirResposta(resposta, 'Pagar.me');

  const cobranca = (dados.charges && dados.charges[0]) || null;
  const status = traduzirStatus((cobranca && cobranca.status) || dados.status);

  return {
    id: `pme_${dados.id}`,
    metodo,
    status,
    valorCentavos,
    aprovadoEm: status === 'aprovado' ? new Date().toISOString() : undefined,
    instrucoes: instrucoesDe(cobranca) || undefined
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

  const idLimpo = String(pagamentoId || '').replace(/^pme_/, '');
  const resposta = await base.requisitar(
    `${urlBase(modo, gateway)}/core/v5/charges/${encodeURIComponent(idLimpo)}/refund`,
    { cabecalhos: cabecalhos(credenciais, idLimpo), corpo: { amount: Math.round(valorCentavos || 0) } }
  );
  base.exigirResposta(resposta, 'Pagar.me');
  return { ok: true };
}

/**
 * Webhook da Pagar.me: assinatura `x-hub-signature-256` no formato
 * "sha256=<hmac do corpo bruto>".
 */
async function verificarWebhook({ corpoBruto, cabecalhos, dados, credenciais }) {
  const segredo = credenciais && credenciais.webhook_secret;
  const assinatura = cabecalhos && (cabecalhos['x-hub-signature-256'] || cabecalhos['X-Hub-Signature-256']);

  if (segredo) {
    const esperada = `sha256=${base.hmacSha256(segredo, corpoBruto || '')}`;
    if (!base.assinaturaConfere(esperada, assinatura)) {
      return { valido: false, motivo: 'assinatura invalida' };
    }
  }

  const pedido = (dados && (dados.data || dados.order)) || {};
  const referencia = (pedido.metadata && pedido.metadata.referencia) || pedido.code;
  if (!referencia) return { valido: false, motivo: 'evento sem referencia' };

  const status = traduzirStatus(dados && dados.type ? String(dados.type).replace('order.', '') : pedido.status);
  return {
    valido: true,
    referencia: String(referencia),
    pagamentoId: pedido.id ? `pme_${pedido.id}` : null,
    status,
    evento: `pagamento.${status}`
  };
}

/** Teste de conexao: listagem (leitura) de cobrancas. Nao cobra nada. */
async function testarConexao({ credenciais, modo, gateway }) {
  const resposta = await base.requisitar(`${urlBase(modo, gateway)}/core/v5/charges?size=1`, {
    metodo: 'GET',
    cabecalhos: cabecalhos(credenciais, 'diagnostico')
  });
  if (!resposta.ok) {
    return { ok: false, mensagem: `Pagar.me recusou as credenciais (HTTP ${resposta.status}).` };
  }
  return { ok: true, mensagem: 'Credenciais validas: a Pagar.me respondeu a uma consulta de leitura.' };
}

module.exports = { id, prefixo, cobrar, reembolsar, verificarWebhook, testarConexao };
