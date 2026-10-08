/*
 * gateways/stripe.js
 * -----------------------------------------------------------------------------
 * Integracao com a Stripe (PaymentIntents).
 *
 * Fluxo real:
 *   POST /v1/payment_intents -> cria a intencao de pagamento (cartao)
 *
 * Particularidades:
 *   - A Stripe exige corpo em `application/x-www-form-urlencoded` (por isso o
 *     helper `formulario` do base.js) e valores em CENTAVOS com `currency=brl`.
 *   - Cartao exige um `payment_method` (pm_...) gerado no NAVEGADOR pelos
 *     Stripe Elements. Sem ele, devolvemos `client_secret` para o front
 *     concluir — o pedido fica pendente ate a confirmacao.
 *
 * Sem credenciais, cai na simulacao local.
 */
'use strict';

const base = require('./base');

const id = 'stripe';
const prefixo = 'stp';

const STATUS = {
  succeeded: 'aprovado',
  processing: 'pendente',
  requires_payment_method: 'pendente',
  requires_confirmation: 'pendente',
  requires_action: 'pendente',
  requires_capture: 'pendente',
  canceled: 'recusado'
};

function traduzirStatus(status) {
  return STATUS[String(status || '').toLowerCase()] || 'pendente';
}

function urlBase(modo, gateway) {
  return modo === 'producao' ? gateway.integracao.urlProducao : gateway.integracao.urlSandbox;
}

function cabecalhos(credenciais) {
  return { Authorization: `Bearer ${credenciais.secret_key}` };
}

async function cobrarReal({ valorCentavos, referencia, descricao, credenciais, modo, paymentMethod, gateway }) {
  const formulario = {
    amount: Math.round(valorCentavos),
    currency: 'brl',
    description: String(descricao || `Pedido ${referencia}`).slice(0, 250),
    'metadata[referencia]': String(referencia),
    'automatic_payment_methods[enabled]': 'true',
    ...(paymentMethod ? { payment_method: paymentMethod, confirm: 'true' } : {})
  };

  const resposta = await base.requisitar(`${urlBase(modo, gateway)}/v1/payment_intents`, {
    cabecalhos: cabecalhos(credenciais),
    formulario
  });
  const dados = base.exigirResposta(resposta, 'Stripe');
  const status = traduzirStatus(dados.status);

  return {
    id: `stp_${dados.id}`,
    metodo: 'cartao',
    status,
    valorCentavos,
    aprovadoEm: status === 'aprovado' ? new Date().toISOString() : undefined,
    instrucoes: dados.client_secret
      ? { clientSecret: dados.client_secret, aviso: 'Confirme o pagamento na pagina segura.' }
      : undefined
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

async function reembolsar({ pagamentoId, credenciais, modo, gateway }) {
  const pronto = base.conferirCredenciais(credenciais, gateway.campos);
  if (!pronto.ok) return { ok: true, simuladoLocal: true };

  const idLimpo = String(pagamentoId || '').replace(/^stp_/, '');
  const resposta = await base.requisitar(`${urlBase(modo, gateway)}/v1/refunds`, {
    cabecalhos: cabecalhos(credenciais),
    formulario: { payment_intent: idLimpo }
  });
  base.exigirResposta(resposta, 'Stripe');
  return { ok: true };
}

/**
 * Webhook da Stripe: cabecalho `stripe-signature` no formato "t=...,v1=..."
 * assinado sobre "<t>.<corpoBruto>".
 */
async function verificarWebhook({ corpoBruto, cabecalhos, dados, credenciais }) {
  const segredo = credenciais && credenciais.webhook_secret;
  const assinatura = cabecalhos && (cabecalhos['stripe-signature'] || cabecalhos['Stripe-Signature']);

  if (segredo && !base.verificarAssinaturaStripe({ cabecalho: assinatura, segredo, corpoBruto })) {
    return { valido: false, motivo: 'assinatura invalida' };
  }

  const objeto = (dados && dados.data && dados.data.object) || {};
  const referencia = (objeto.metadata && objeto.metadata.referencia) || null;
  if (!referencia) return { valido: false, motivo: 'evento sem referencia' };

  const status = traduzirStatus(objeto.status);
  return {
    valido: true,
    referencia: String(referencia),
    pagamentoId: objeto.id ? `stp_${objeto.id}` : null,
    status,
    evento: `pagamento.${status}`
  };
}

/** Teste de conexao: consulta de saldo (leitura). Nao cobra nada. */
async function testarConexao({ credenciais, modo, gateway }) {
  const resposta = await base.requisitar(`${urlBase(modo, gateway)}/v1/balance`, {
    metodo: 'GET',
    cabecalhos: cabecalhos(credenciais)
  });
  if (!resposta.ok) {
    return { ok: false, mensagem: `Stripe recusou as credenciais (HTTP ${resposta.status}).` };
  }
  return { ok: true, mensagem: 'Credenciais validas: a Stripe respondeu a uma consulta de leitura.' };
}

module.exports = { id, prefixo, cobrar, reembolsar, verificarWebhook, testarConexao };
