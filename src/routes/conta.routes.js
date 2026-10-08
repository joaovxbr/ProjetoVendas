/*
 * routes/conta.routes.js
 * -----------------------------------------------------------------------------
 * Area do cliente: um painel consolidado, o historico de compras, o historico
 * de atividades, as preferencias e a edicao do perfil.
 *
 *   GET    /api/conta              -> resumo (pedidos, chaves, gasto, favoritos)
 *   GET    /api/conta/pedidos      -> historico completo
 *   GET    /api/conta/dispositivos -> sessoes abertas
 *   GET    /api/conta/atividades   -> linha do tempo do cliente
 *   DELETE /api/conta/atividades   -> limpa o historico
 *   GET    /api/conta/preferencias -> preferencias + catalogo
 *   PATCH  /api/conta/preferencias -> salva preferencias (patch parcial)
 *   PATCH  /api/conta              -> atualiza nome/e-mail
 */
'use strict';

const express = require('express');
const contaService = require('../services/conta.service');
const authService = require('../services/auth.service');
const { requireAuth } = require('../middlewares/sessao');
const { assincrono } = require('../middlewares/contexto');
const { exigirCorpo, paginacao } = require('../middlewares/validar');

const router = express.Router();

router.use(requireAuth);

router.get('/', assincrono((req, res) => {
  res.json(contaService.resumo(req.usuario.id, {
    sidAtual: req.sessao ? req.sessao.sid : null
  }));
}));

router.get('/pedidos', paginacao({ limitePadrao: 20 }), assincrono((req, res) => {
  res.json(contaService.historico(req.usuario.id, {
    status: req.query.status || null,
    limite: req.paginacao.limite,
    deslocamento: req.paginacao.deslocamento
  }));
}));

router.get('/dispositivos', assincrono((req, res) => {
  res.json({
    dispositivos: contaService.dispositivos(req.usuario.id, req.sessao ? req.sessao.sid : null)
  });
}));

/* Historico de atividades ------------------------------------------------- */

router.get('/atividades', paginacao({ limitePadrao: 30, limiteMax: 100 }), assincrono((req, res) => {
  res.json(contaService.atividades(req.usuario.id, {
    tipo: req.query.tipo || null,
    busca: req.query.busca || null,
    limite: req.paginacao.limite,
    deslocamento: req.paginacao.deslocamento
  }));
}));

// Apagar o proprio historico e um direito do titular dos dados.
router.delete('/atividades', assincrono((req, res) => {
  res.json(contaService.limparAtividades(req.usuario.id));
}));

/* Preferencias ------------------------------------------------------------ */

router.get('/preferencias', assincrono((req, res) => {
  res.json(contaService.preferencias(req.usuario.id));
}));

// body: { avisoLicenca?, novidadesEmail?, resumoCompras?, tema? }
router.patch('/preferencias', exigirCorpo, assincrono((req, res) => {
  res.json(contaService.salvarPreferencias(req.usuario.id, req.body, { ip: req.ipCliente }));
}));

/* Perfil ------------------------------------------------------------------ */

// body: { nome?, email? }
router.patch('/', exigirCorpo, assincrono((req, res) => {
  const usuario = authService.atualizarPerfil(
    req.usuario.id,
    { nome: req.body.nome, email: req.body.email },
    { ip: req.ipCliente }
  );
  res.json({ usuario, mensagem: 'Perfil atualizado' });
}));

module.exports = router;
