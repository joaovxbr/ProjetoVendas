/*
 * gateways/simulado.js
 * -----------------------------------------------------------------------------
 * Gateway interno. Nao fala com a rede: aprova Pix e cartao na hora e deixa o
 * boleto pendente. E o que faz a loja funcionar de imediato, sem credencial
 * nenhuma — e o que a suite de testes usa para exercitar o fluxo completo.
 *
 * Ele tambem e a REDE DE SEGURANCA dos outros gateways: quando um gateway real
 * esta ligado mas sem credenciais, a fachada cai para ca (marcando
 * `simuladoLocal`), em vez de tentar uma cobranca que so pode falhar.
 */
'use strict';

const { simularLocal } = require('./base');

const id = 'simulado';
const prefixo = 'sim';

/** Cobra: sempre resolve na hora, com resultado deterministico. */
async function cobrar({ valorCentavos, metodo, referencia }) {
  return { ...simularLocal({ prefixo, valorCentavos, metodo, referencia }), simuladoLocal: true };
}

/** Reembolso simulado: nao ha dinheiro real para devolver. */
async function reembolsar({ pagamentoId }) {
  return { ok: true, simuladoLocal: true, id: pagamentoId || null };
}

/**
 * Webhook simulado. Aceita qualquer corpo, mas exige o campo `referencia`
 * (o numero do pedido) para saber o que confirmar.
 */
function verificarWebhook({ dados }) {
  const referencia = dados && (dados.referencia || dados.numero || (dados.data && dados.data.referencia));
  if (!referencia) return { valido: false, motivo: 'sem referencia' };
  return {
    valido: true,
    referencia: String(referencia),
    pagamentoId: dados.pagamentoId ? String(dados.pagamentoId) : null,
    status: 'aprovado',
    evento: 'pagamento.aprovado'
  };
}

module.exports = { id, prefixo, cobrar, reembolsar, verificarWebhook, somenteSimulacao: true };
