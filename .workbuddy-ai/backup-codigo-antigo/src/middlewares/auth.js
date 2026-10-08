const { buscarSessao, removerSessao, buscarUsuarioPorId, usuarioPublico } = require('../data/db');

// sid válido: 64 caracteres hexadecimais (32 bytes aleatórios)
const FORMATO_SID = /^[a-f0-9]{64}$/;

// Lê o cookie "sid" e deixa o usuário logado em req.usuario (ou null)
function carregarUsuario(req, res, next) {
  req.usuario = null;

  const sid = req.cookies && req.cookies.sid;
  if (typeof sid !== 'string' || !FORMATO_SID.test(sid)) return next();

  const sessao = buscarSessao(sid);
  if (!sessao) return next();

  const usuario = buscarUsuarioPorId(sessao.usuarioId);
  if (!usuario) {
    removerSessao(sid);
    return next();
  }

  req.usuario = usuarioPublico(usuario);
  next();
}

// Bloqueia a rota para quem não está logado
function requireAuth(req, res, next) {
  if (!req.usuario) {
    return res.status(401).json({ erro: 'Faça login para continuar' });
  }
  next();
}

module.exports = { carregarUsuario, requireAuth };
