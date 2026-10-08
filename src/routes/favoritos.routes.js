/*
 * routes/favoritos.routes.js
 * -----------------------------------------------------------------------------
 * Lista de desejos do cliente.
 *
 *   GET    /api/favoritos                    -> produtos favoritados
 *   POST   /api/favoritos/:produtoId         -> adiciona
 *   DELETE /api/favoritos/:produtoId         -> remove
 *   POST   /api/favoritos/:produtoId/alternar-> adiciona ou remove (para o botao)
 */
'use strict';

const express = require('express');
const favoritoService = require('../services/favorito.service');
const { requireAuth } = require('../middlewares/sessao');
const { assincrono } = require('../middlewares/contexto');
const { exigirUuidParam } = require('../middlewares/validar');
const limites = require('../middlewares/limites');

const router = express.Router();

// Todas as rotas exigem login.
router.use(requireAuth);

router.get('/', assincrono((req, res) => {
  res.json(favoritoService.listar(req.usuario.id));
}));

router.post('/:produtoId', limites.escrita, exigirUuidParam('produtoId'), assincrono((req, res) => {
  res.status(201).json(favoritoService.adicionar(req.usuario.id, req.params.produtoId, { ip: req.ipCliente }));
}));

router.delete('/:produtoId', exigirUuidParam('produtoId'), assincrono((req, res) => {
  res.json(favoritoService.remover(req.usuario.id, req.params.produtoId, { ip: req.ipCliente }));
}));

// Um unico endpoint para o botao de coracao: alterna e devolve o estado final.
router.post('/:produtoId/alternar', limites.escrita, exigirUuidParam('produtoId'), assincrono((req, res) => {
  res.json(favoritoService.alternar(req.usuario.id, req.params.produtoId, { ip: req.ipCliente }));
}));

module.exports = router;
