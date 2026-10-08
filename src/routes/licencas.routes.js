/*
 * routes/licencas.routes.js
 * -----------------------------------------------------------------------------
 * Chaves de licenca do cliente.
 *
 *   GET  /api/licencas          -> minhas chaves
 *   POST /api/licencas/resgatar -> ativa uma chave (comeca a contar o prazo)
 */
'use strict';

const express = require('express');
const licencaService = require('../services/licenca.service');
const { requireAuth } = require('../middlewares/sessao');
const { assincrono } = require('../middlewares/contexto');
const { exigirCorpo } = require('../middlewares/validar');
const limites = require('../middlewares/limites');

const router = express.Router();

router.get('/', requireAuth, assincrono((req, res) => {
  res.json(licencaService.minhas(req.usuario.id, {
    produtoId: req.query.produtoId || null,
    status: req.query.status || null
  }));
}));

// Resumo curto (bom para o cabecalho da area do cliente).
router.get('/resumo', requireAuth, assincrono((req, res) => {
  res.json(licencaService.resumo(req.usuario.id));
}));

// body: { chave }
router.post('/resgatar', requireAuth, limites.escrita, exigirCorpo, assincrono((req, res) => {
  const licenca = licencaService.resgatar(req.body.chave, req.usuario.id, { ip: req.ipCliente });
  res.json({
    licenca,
    mensagem: licenca.vitalicia
      ? 'Chave ativada. Sua licenca e vitalicia.'
      : `Chave ativada. Valida ate ${licenca.expiraEmFormatado}.`
  });
}));

module.exports = router;
