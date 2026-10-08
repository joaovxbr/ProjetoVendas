/*
 * routes/auth.routes.js
 * -----------------------------------------------------------------------------
 * Cadastro, login, logout, sessao e senhas.
 *
 * Contrato mantido do front atual:
 *   POST /api/auth/login     -> 200 { usuario }
 *   POST /api/auth/registrar -> 201 { usuario }
 *   POST /api/auth/logout    -> 204
 *   GET  /api/auth/me        -> 200 { usuario } | 401 { erro }
 */
'use strict';

const express = require('express');
const config = require('../config');
const authService = require('../services/auth.service');
const contaService = require('../services/conta.service');
const { requireAuth } = require('../middlewares/sessao');
const { assincrono } = require('../middlewares/contexto');
const { exigirCorpo, lerLembrar } = require('../middlewares/validar');
const limites = require('../middlewares/limites');
const { agenteDaRequisicao } = require('../utils/validacao');

const router = express.Router();

/* -------------------------------------------------------------------------- */
/* Cookie de sessao                                                           */
/* -------------------------------------------------------------------------- */

/*
 * httpOnly impede leitura por JavaScript (mitiga XSS), sameSite=lax bloqueia
 * envio em requisicoes cross-site (mitiga CSRF) e secure so vale em HTTPS.
 * Sem maxAge o cookie morre ao fechar o navegador; com maxAge ele persiste.
 */
function opcoesCookie(persistente) {
  const opcoes = {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: config.producao
  };
  if (persistente) opcoes.maxAge = config.sessao.duracaoMs;
  return opcoes;
}

function gravarSessao(req, res, sessao) {
  res.cookie(config.sessao.nomeCookie, sessao.sid, opcoesCookie(sessao.persistente));
}

// Respostas de autenticacao nunca devem ser cacheadas.
router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

/* -------------------------------------------------------------------------- */
/* Login / cadastro / logout                                                  */
/* -------------------------------------------------------------------------- */

// body: { email, senha, lembrar? }
router.post('/login', limites.login, exigirCorpo, assincrono((req, res) => {
  const { email, senha, lembrar } = req.body;

  const { usuario, sessao } = authService.autenticar({
    email,
    senha,
    lembrar: lerLembrar(lembrar),
    ip: req.ipCliente,
    userAgent: agenteDaRequisicao(req)
  });

  gravarSessao(req, res, sessao);
  res.json({ usuario });
}));

// body: { nome, email, senha }
router.post('/registrar', limites.registro, exigirCorpo, assincrono((req, res) => {
  const { nome, email, senha } = req.body;

  const { usuario, sessao } = authService.registrar({
    nome,
    email,
    senha,
    ip: req.ipCliente,
    userAgent: agenteDaRequisicao(req)
  });

  gravarSessao(req, res, sessao);
  res.status(201).json({ usuario });
}));

// Encerra a sessao atual e apaga o cookie.
router.post('/logout', assincrono((req, res) => {
  const sid = req.cookies ? req.cookies[config.sessao.nomeCookie] : null;
  if (typeof sid === 'string') authService.encerrarSessao(sid);

  res.clearCookie(config.sessao.nomeCookie, opcoesCookie(false));
  res.status(204).end();
}));

// Usuario da sessao atual.
router.get('/me', (req, res) => {
  if (!req.usuario) {
    return res.status(401).json({ erro: 'Nao autenticado', codigo: 'nao_autenticado' });
  }
  res.json({ usuario: req.usuario });
});

/* -------------------------------------------------------------------------- */
/* Senhas                                                                     */
/* -------------------------------------------------------------------------- */

// body: { senhaAtual, novaSenha } — derruba as outras sessoes
router.patch('/senha', requireAuth, exigirCorpo, assincrono((req, res) => {
  const resultado = authService.trocarSenha(
    req.usuario.id,
    req.body.senhaAtual,
    req.body.novaSenha,
    { sidAtual: req.sessao ? req.sessao.sid : null, ip: req.ipCliente }
  );

  res.json({
    mensagem: 'Senha alterada com sucesso',
    sessoesEncerradas: resultado.sessoesEncerradas
  });
}));

// body: { email } — resposta sempre igual, exista ou nao a conta
router.post('/recuperar-senha', limites.recuperacao, exigirCorpo, assincrono((req, res) => {
  const resultado = authService.solicitarRecuperacao(req.body.email, { ip: req.ipCliente });
  res.json(resultado);
}));

// body: { token, senha }
router.post('/redefinir-senha', limites.recuperacao, exigirCorpo, assincrono((req, res) => {
  const resultado = authService.redefinirSenha(req.body.token, req.body.senha, { ip: req.ipCliente });
  res.json(resultado);
}));

/* -------------------------------------------------------------------------- */
/* Sessoes ativas                                                             */
/* -------------------------------------------------------------------------- */

router.get('/sessoes', requireAuth, assincrono((req, res) => {
  res.json({
    sessoes: contaService.dispositivos(req.usuario.id, req.sessao ? req.sessao.sid : null)
  });
}));

// Encerra todas as outras sessoes, mantendo a atual.
router.post('/sessoes/encerrar-outras', requireAuth, assincrono((req, res) => {
  const encerradas = authService.encerrarTodas(req.usuario.id, {
    exceto: req.sessao ? req.sessao.sid : null
  });
  res.json({ mensagem: 'Sessoes encerradas', encerradas });
}));

module.exports = router;
