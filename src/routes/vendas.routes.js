/*
 * routes/vendas.routes.js
 * -----------------------------------------------------------------------------
 * Checkout e pedidos.
 *
 * Contrato mantido do front atual:
 *   POST /api/vendas -> 201 pedido com itens[].chaves   (401 se nao logado)
 *   GET  /api/vendas -> { quantidade, total, vendas }
 */
'use strict';

const express = require('express');
const checkoutService = require('../services/checkout.service');
const { requireAuth, requireAdmin } = require('../middlewares/sessao');
const { assincrono } = require('../middlewares/contexto');
const { exigirCorpo, exigirUuidParam, paginacao } = require('../middlewares/validar');
const limites = require('../middlewares/limites');
const { lerTexto } = require('../utils/validacao');

const router = express.Router();

/*
 * Cria o pedido. O corpo traz apenas ids e quantidades: precos, descontos e
 * disponibilidade sao sempre resolvidos no servidor.
 *
 * body: { itens, cupom?, metodoPagamento?, gatewayId?, cartaoToken?, cpf? }
 *
 * SEGURANCA: o "pagador" enviado ao gateway e montado a partir da SESSAO, nao
 * do corpo. Assim ninguem consegue se passar por outro CPF/e-mail na hora de
 * gerar a cobranca. Do cliente aceitamos apenas o CPF (exigido por boleto).
 */
router.post('/', requireAuth, limites.escrita, exigirCorpo, assincrono(async (req, res) => {
  const cpf = lerTexto(req.body.cpf || (req.body.pagador && req.body.pagador.documento)) || null;

  const pedido = await checkoutService.finalizar({
    usuario: req.usuario,
    itens: req.body.itens,
    cupomCodigo: lerTexto(req.body.cupom || req.body.cupomCodigo) || null,
    metodoPagamento: lerTexto(req.body.metodoPagamento) || null,
    gatewayId: lerTexto(req.body.gatewayId) || null,
    pagador: { nome: req.usuario.nome, email: req.usuario.email, documento: cpf },
    cartaoToken: lerTexto(req.body.cartaoToken) || null,
    ip: req.ipCliente
  });

  res.status(201).json(pedido);
}));

// Pedidos do usuario logado.
router.get('/', requireAuth, paginacao({ limitePadrao: 50 }), assincrono((req, res) => {
  res.json(checkoutService.meusPedidos(req.usuario.id, {
    limite: req.paginacao.limite,
    deslocamento: req.paginacao.deslocamento
  }));
}));

// Um pedido especifico (so o dono ou um admin enxerga).
router.get('/:id', requireAuth, exigirUuidParam('id'), assincrono((req, res) => {
  res.json(checkoutService.pedidoDoUsuario(req.params.id, req.usuario));
}));

// Cancela um pedido ainda nao pago.
router.post('/:id/cancelar', requireAuth, exigirUuidParam('id'), assincrono((req, res) => {
  // Garante que o pedido e do usuario antes de cancelar.
  checkoutService.pedidoDoUsuario(req.params.id, req.usuario);

  const pedido = checkoutService.cancelar(req.params.id, {
    motivo: lerTexto(req.body && req.body.motivo) || 'cancelado pelo cliente',
    atorId: req.usuario.id,
    ip: req.ipCliente
  });

  res.json(pedido);
}));

/*
 * Confirma um pagamento pendente (boleto).
 *
 * Na vida real quem chama isso e o webhook do provedor de pagamento, por isso
 * a rota e restrita a administradores. Em ambiente de simulacao, serve para
 * testar o ciclo completo: pedido pendente -> confirmado -> chaves liberadas.
 */
router.post('/:id/confirmar-pagamento', requireAdmin, exigirUuidParam('id'), assincrono((req, res) => {
  const resultado = checkoutService.confirmarPagamento(req.params.id, {
    atorId: req.usuario.id,
    ip: req.ipCliente
  });

  res.json({
    pedido: resultado.pedido,
    jaEstavaPago: resultado.jaEstavaPago,
    mensagem: resultado.jaEstavaPago
      ? 'Este pedido ja estava pago'
      : 'Pagamento confirmado e chaves liberadas'
  });
}));

module.exports = router;
