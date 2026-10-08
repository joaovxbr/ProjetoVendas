/*
 * services/pagamento.service.js
 * -----------------------------------------------------------------------------
 * Fachada de pagamento. O resto do sistema (checkout, admin, webhook) fala SO
 * com este modulo e nao precisa saber que Mercado Pago, InfinityPay e
 * companhia existem.
 *
 * O trabalho pesado de "quem cobra o que" esta em gateway.service.js. Aqui so
 * ficamos com o contrato de cobranca:
 *
 *   cobrar()            -> escolhe o gateway e cobra
 *   reembolsar()        -> estorna no gateway que processou a venda
 *   processarWebhook()  -> traduz a notificacao do gateway
 *
 * IMPORTANTE: estas funcoes sao ASSINCRONAS (gateways reais sao chamadas de
 * rede). O checkout aguarda o resultado antes de decidir se emite licenca.
 */
'use strict';

const registro = require('../gateways');
const gatewayService = require('./gateway.service');
const { ErroValidacao, Indisponivel } = require('../utils/erros');
const { formatarBRL } = require('../utils/dinheiro');
const { novoId } = require('../utils/seguranca');

// Formas de pagamento que o sistema entende (fonte unica: catalogo).
const METODOS = registro.IDS_METODOS;

/** Um pagamento esta aprovado? */
function estaAprovado(status) {
  return status === 'aprovado';
}

/**
 * Cobra um pedido.
 *
 * @param {object} pedido
 * @param {number} pedido.valorCentavos
 * @param {string} pedido.metodo            pix | cartao | boleto
 * @param {string} pedido.referencia        numero do pedido
 * @param {string} [pedido.descricao]
 * @param {object} [pedido.pagador]         { nome, email, documento }
 * @param {string} [pedido.cartaoToken]
 * @param {string} [pedido.gatewayId]       forca um gateway especifico
 * @returns {Promise<object>} envelope de resultado + `provedor`
 */
async function cobrar({
  valorCentavos,
  metodo,
  referencia,
  descricao = '',
  pagador = null,
  cartaoToken = null,
  gatewayId = null
}) {
  if (!Number.isInteger(valorCentavos) || valorCentavos <= 0) {
    throw new ErroValidacao('Valor de pagamento invalido');
  }

  // Lanca ErroValidacao/RegraNegocio se o metodo nao existe ou nada o aceita.
  const resolvido = gatewayService.resolverMetodo(metodo, { gatewayId });
  const modulo = registro.modulo(resolvido.gatewayId);

  if (!modulo) {
    throw new Indisponivel(`Gateway ${resolvido.gatewayId} nao esta disponivel`);
  }

  const resultado = await modulo.cobrar({
    valorCentavos,
    metodo: String(metodo).toLowerCase(),
    referencia: String(referencia || novoId()),
    descricao: descricao || `Pedido ${referencia} - ${formatarBRL(valorCentavos)}`,
    credenciais: resolvido.credenciais,
    modo: resolvido.modo,
    pagador,
    cartaoToken,
    // O modulo recebe a DEFINICAO inteira: precisa de `.campos` e `.integracao`.
    gateway: resolvido.definicao
  });

  return {
    ...resultado,
    provedor: resolvido.gatewayId,
    modoEfetivo: resolvido.efetivoReal ? 'real' : 'demonstracao'
  };
}

/**
 * Estorna um pagamento. Usa o gateway que processou a venda.
 * Nunca derruba o fluxo de reembolso: se o gateway recusar, devolve ok:false
 * com o motivo (o admin decide o que fazer, o pedido ja esta marcado).
 */
async function reembolsar({ pagamentoId, valorCentavos, gatewayId, metodo = 'pix' }) {
  if (!gatewayId || !registro.existe(gatewayId)) {
    return { ok: true, ignorado: true, motivo: 'Venda sem gateway identificado' };
  }

  const modulo = registro.modulo(gatewayId);
  if (!modulo || typeof modulo.reembolsar !== 'function') {
    return { ok: true, ignorado: true, motivo: `Gateway ${gatewayId} nao suporta estorno automatico` };
  }

  const linha = require('../repositories/gateways.repo').buscar(gatewayId);
  const definicao = registro.buscar(gatewayId);

  try {
    const resultado = await modulo.reembolsar({
      pagamentoId,
      valorCentavos,
      metodo,
      credenciais: gatewayService.credenciaisDe(gatewayId),
      modo: linha ? linha.modo : 'sandbox',
      gateway: definicao
    });
    return { ok: true, ...resultado };
  } catch (erro) {
    return { ok: false, motivo: erro.message };
  }
}

/**
 * Traduz a notificacao (webhook) de um gateway para o formato interno.
 *
 * @param {object} entrada
 * @param {string} entrada.gatewayId
 * @param {string} entrada.corpoBruto    corpo exato recebido (para assinatura)
 * @param {object} entrada.cabecalhos
 * @param {object} entrada.dados         JSON ja parseado
 * @returns {Promise<{valido:boolean, referencia?:string, status?:string, evento?:string, motivo?:string}>}
 */
async function processarWebhook({ gatewayId, corpoBruto, cabecalhos, dados }) {
  if (!registro.existe(gatewayId)) {
    return { valido: false, motivo: 'gateway desconhecido' };
  }

  const modulo = registro.modulo(gatewayId);
  const definicao = registro.buscar(gatewayId);
  if (!modulo || typeof modulo.verificarWebhook !== 'function') {
    return { valido: false, motivo: 'gateway sem suporte a webhook' };
  }

  const linha = require('../repositories/gateways.repo').buscar(gatewayId);
  const credenciais = gatewayService.credenciaisDe(gatewayId);

  return modulo.verificarWebhook({
    corpoBruto,
    cabecalhos: cabecalhos || {},
    dados,
    credenciais,
    modo: linha ? linha.modo : 'sandbox',
    gateway: definicao
  });
}

module.exports = { METODOS, cobrar, reembolsar, processarWebhook, estaAprovado };
