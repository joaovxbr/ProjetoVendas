/*
 * gateways/asaas.js
 * -----------------------------------------------------------------------------
 * Integracao com o Asaas (API v3).
 *
 * Fluxo real:
 *   POST /v3/payments -> cria a cobranca (PIX, CREDIT_CARD ou BOLETO)
 *
 * Autenticacao: cabecalho `access_token`. ATENCAO: o Asaas trabalha com valor
 * em DECIMAL (reais), diferente dos outros — por isso a conversao explicita.
 *
 * Sem credenciais, cai na simulacao local.
 */
'use strict';

const base = require('./base');

const id = 'asaas';
const prefixo = 'asa';

const METODO_API = { pix: 'PIX', cartao: 'CREDIT_CARD', boleto: 'BOLETO' };

const STATUS = {
  confirmed: 'aprovado',
  received: 'aprovado',
  received_in_cash: 'aprovado',
  pending: 'pendente',
  awaiting_risk_analysis: 'pendente',
  overdue: 'recusado',
  refunded: 'recusado',
  chargeback: 'recusado',
  declined: 'recusado'
};

function traduzirStatus(status) {
  return STATUS[String(status || '').toLowerCase()] || 'pendente';
}

function urlBase(modo, gateway) {
  return modo === 'producao' ? gateway.integracao.urlProducao : gateway.integracao.urlSandbox;
}

function cabecalhos(credenciais) {
  return { access_token: String(credenciais.api_key || '') };
}

/** Data de vencimento (hoje + 3 dias) no formato AAAA-MM-DD. */
function vencimento(dias = 3) {
  const data = new Date(Date.now() + dias * 24 * 60 * 60 * 1000);
  return data.toISOString().slice(0, 10);
}

function instrucoesDe(dados) {
  if (!dados) return null;
  if (dados.billingType === 'PIX') {
    return {
      copiaECola: dados.pixQrCode || null,
      linkPagamento: dados.invoiceUrl || null,
      aviso: 'Escaneie o QR Code ou use o Pix copia e cola.'
    };
  }
  if (dados.billingType === 'BOLETO') {
    return {
      linkPagamento: dados.bankSlipUrl || dados.invoiceUrl || null,
      linhaDigitavel: dados.nossoNumero || '',
      vencimentoFormatado: dados.dueDate || null,
      aviso: 'Pague o boleto. A liberacao acontece apos a compensacao.'
    };
  }
  return dados.invoiceUrl ? { linkPagamento: dados.invoiceUrl } : null;
}

async function cobrarReal({ valorCentavos, metodo, referencia, descricao, credenciais, modo, pagador, gateway }) {
  const corpo = {
    billingType: METODO_API[metodo] || 'PIX',
    value: Math.round(valorCentavos) / 100, // Asaas usa decimal
    dueDate: vencimento(3),
    description: String(descricao || `Pedido ${referencia}`).slice(0, 250),
    externalReference: String(referencia),
    ...(pagador && pagador.nome ? { customer: pagador.nome } : {})
  };

  const resposta = await base.requisitar(`${urlBase(modo, gateway)}/v3/payments`, {
    cabecalhos: cabecalhos(credenciais),
    corpo
  });
  const dados = base.exigirResposta(resposta, 'Asaas');
  const status = traduzirStatus(dados.status);

  return {
    id: `asa_${dados.id}`,
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

async function reembolsar({ pagamentoId, credenciais, modo, gateway }) {
  const pronto = base.conferirCredenciais(credenciais, gateway.campos);
  if (!pronto.ok) return { ok: true, simuladoLocal: true };

  const idLimpo = String(pagamentoId || '').replace(/^asa_/, '');
  const resposta = await base.requisitar(
    `${urlBase(modo, gateway)}/v3/payments/${encodeURIComponent(idLimpo)}/refund`,
    { cabecalhos: cabecalhos(credenciais), corpo: {} }
  );
  base.exigirResposta(resposta, 'Asaas');
  return { ok: true };
}

/**
 * Webhook do Asaas: o token vai no cabecalho `asaas-access-token` e e
 * comparado de forma literal (e em tempo constante).
 */
async function verificarWebhook({ cabecalhos, dados, credenciais }) {
  const token = credenciais && credenciais.webhook_token;
  const recebido = cabecalhos && (cabecalhos['asaas-access-token'] || cabecalhos['Asaas-Access-Token']);

  if (token && !base.assinaturaConfere(token, recebido)) {
    return { valido: false, motivo: 'token invalido' };
  }

  const pagamento = (dados && (dados.payment || dados)) || {};
  const referencia = pagamento.externalReference;
  if (!referencia) return { valido: false, motivo: 'evento sem referencia' };

  const status = traduzirStatus(pagamento.status);
  return {
    valido: true,
    referencia: String(referencia),
    pagamentoId: pagamento.id ? `asa_${pagamento.id}` : null,
    status,
    evento: `pagamento.${status}`
  };
}

/** Teste de conexao: listagem (leitura) de clientes. Nao cobra nada. */
async function testarConexao({ credenciais, modo, gateway }) {
  const resposta = await base.requisitar(`${urlBase(modo, gateway)}/v3/customers?limit=1`, {
    metodo: 'GET',
    cabecalhos: cabecalhos(credenciais)
  });
  if (!resposta.ok) {
    return { ok: false, mensagem: `Asaas recusou as credenciais (HTTP ${resposta.status}).` };
  }
  return { ok: true, mensagem: 'Credenciais validas: o Asaas respondeu a uma consulta de leitura.' };
}

module.exports = { id, prefixo, cobrar, reembolsar, verificarWebhook, testarConexao };
