/*
 * routes/cupons.routes.js
 * -----------------------------------------------------------------------------
 * Cupons.
 *
 *   GET  /api/cupons         -> cupons ativos (campanha publica)
 *   POST /api/cupons/validar -> confere um cupom contra o carrinho atual
 *
 * A validacao recalcula o carrinho no servidor: o cliente manda os mesmos itens
 * que vai comprar, e o desconto devolvido e o que sera realmente aplicado.
 */
'use strict';

const express = require('express');
const cupomService = require('../services/cupom.service');
const checkoutService = require('../services/checkout.service');
const { assincrono } = require('../middlewares/contexto');
const { exigirCorpo } = require('../middlewares/validar');
const { paraReais } = require('../utils/dinheiro');
const { lerTexto } = require('../utils/validacao');

const router = express.Router();

router.get('/', assincrono((req, res) => {
  res.json(cupomService.listarPublicos());
}));

// body: { codigo, itens: [{ produtoId, planoId, quantidade }] }
router.post('/validar', exigirCorpo, assincrono((req, res) => {
  // Reaproveita a mesma resolucao de itens do checkout: nada de preco vindo do cliente.
  const linhas = checkoutService.resolverItens(req.body.itens);
  const subtotalCentavos = linhas.reduce((soma, linha) => soma + linha.subtotalCentavos, 0);

  const resultado = cupomService.validar(lerTexto(req.body.codigo), subtotalCentavos);

  res.json({
    valido: true,
    codigo: resultado.cupom.codigo,
    tipo: resultado.cupom.tipo,
    valor: resultado.cupom.valor,
    descricao: resultado.cupom.descricao,
    subtotal: paraReais(subtotalCentavos),
    desconto: paraReais(resultado.descontoCentavos),
    total: paraReais(resultado.totalCentavos)
  });
}));

module.exports = router;
