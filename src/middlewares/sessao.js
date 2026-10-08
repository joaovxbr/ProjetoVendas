/*
 * middlewares/sessao.js
 * -----------------------------------------------------------------------------
 * Le o cookie de sessao e popula req.usuario. Tambem oferece as guardas de
 * autorizacao usadas nas rotas.
 */
'use strict';

const config = require('../config');
const authService = require('../services/auth.service');
const { NaoAutenticado, SemPermissao } = require('../utils/erros');

// sid valido: 32 bytes aleatorios em hexadecimal = 64 caracteres.
const FORMATO_SID = /^[a-f0-9]{64}$/;

/**
 * Nunca bloqueia: apenas descobre quem esta falando.
 * req.usuario = null quando nao ha sessao valida.
 */
function carregarUsuario(req, res, next) {
  req.usuario = null;
  req.usuarioInterno = null;
  req.sessao = null;

  const sid = req.cookies ? req.cookies[config.sessao.nomeCookie] : null;

  // Formato errado: nem consulta o banco.
  if (typeof sid !== 'string' || !FORMATO_SID.test(sid)) return next();

  const resultado = authService.usuarioDaSessao(sid);
  if (!resultado) return next();

  req.sessao = resultado.sessao;
  req.usuarioInterno = resultado.usuario;
  req.usuario = authService.paraPublico(resultado.usuario);

  next();
}

/** Exige sessao valida. */
function requireAuth(req, res, next) {
  if (!req.usuario) return next(new NaoAutenticado());
  next();
}

/** Exige sessao valida E papel de administrador. */
function requireAdmin(req, res, next) {
  if (!req.usuario) return next(new NaoAutenticado());
  if (req.usuario.papel !== 'admin') {
    return next(new SemPermissao('Area restrita a administradores'));
  }
  next();
}

/** Deixa passar sem exigir login, mas garante que req.usuario exista. */
function usuarioOpcional(req, res, next) {
  if (!req.usuario) req.usuario = null;
  next();
}

module.exports = { carregarUsuario, requireAuth, requireAdmin, usuarioOpcional, FORMATO_SID };
