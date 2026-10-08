/*
 * routes/avaliacoes.routes.js
 * -----------------------------------------------------------------------------
 *   GET    /api/avaliacoes/produto/:produtoId -> avaliacoes publicas do produto
 *   GET    /api/avaliacoes/minhas             -> o que eu ja avaliei
 *   POST   /api/avaliacoes                    -> cria/atualiza (exige compra)
 *   DELETE /api/avaliacoes/:id                -> remove a minha (ou admin)
 */
'use strict';

const express = require('express');
const avaliacaoService = require('../services/avaliacao.service');
const { requireAuth } = require('../middlewares/sessao');
const { assincrono } = require('../middlewares/contexto');
const { exigirCorpo, exigirUuidParam, paginacao } = require('../middlewares/validar');
const limites = require('../middlewares/limites');

const router = express.Router();

router.get('/produto/:produtoId', exigirUuidParam('produtoId'), paginacao({ limitePadrao: 20 }), assincrono((req, res) => {
  res.json(avaliacaoService.doProduto(req.params.produtoId, {
    limite: req.paginacao.limite,
    deslocamento: req.paginacao.deslocamento
  }));
}));

router.get('/minhas', requireAuth, assincrono((req, res) => {
  res.json({ itens: avaliacaoService.minhas(req.usuario.id) });
}));

// body: { produtoId, nota, comentario? }
router.post('/', requireAuth, limites.escrita, exigirCorpo, assincrono((req, res) => {
  const resultado = avaliacaoService.avaliar(
    req.usuario.id,
    req.body.produtoId,
    { nota: req.body.nota, comentario: req.body.comentario },
    { ip: req.ipCliente }
  );

  res.status(201).json(resultado);
}));

router.delete('/:id', requireAuth, exigirUuidParam('id'), assincrono((req, res) => {
  res.json(avaliacaoService.remover(req.params.id, req.usuario, { ip: req.ipCliente }));
}));

module.exports = router;
