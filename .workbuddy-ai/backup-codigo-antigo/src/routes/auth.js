const express = require('express');
const rateLimit = require('express-rate-limit');
const {
  SESSAO_DURACAO_MS,
  normalizarEmail,
  criarUsuario,
  buscarUsuarioPorEmail,
  verificarSenha,
  verificarSenhaFicticia,
  usuarioPublico,
  criarSessao,
  removerSessao
} = require('../data/db');

const router = express.Router();

const EMAIL_VALIDO = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const CARACTERES_CONTROLE = /[\u0000-\u001F\u007F]/;
const NOME_MIN = 2;
const NOME_MAX = 60;
const EMAIL_MAX = 254;
const SENHA_MIN = 6;
const SENHA_MAX = 128;

// Limite mais rígido para login e cadastro (contra força bruta e spam de contas)
function criarLimiteAuth(opcoes = {}) {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { erro: 'Muitas tentativas. Aguarde 15 minutos e tente novamente.' },
    ...opcoes
  });
}

// No login só contam as tentativas que falharam
const limiteLogin = criarLimiteAuth({ skipSuccessfulRequests: true });
const limiteRegistro = criarLimiteAuth();

// Respostas de autenticação nunca devem ir para cache
router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

function lerTexto(valor) {
  return typeof valor === 'string' ? valor : '';
}

// Opções do cookie de sessão (sem maxAge = cookie de sessão do navegador)
function opcoesCookie(lembrar) {
  const opcoes = {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: process.env.NODE_ENV === 'production'
  };
  if (lembrar) opcoes.maxAge = SESSAO_DURACAO_MS;
  return opcoes;
}

// Troca a sessão anterior (se existir) por uma nova e grava o cookie
function iniciarSessao(req, res, usuario, lembrar) {
  const sidAnterior = req.cookies && req.cookies.sid;
  if (typeof sidAnterior === 'string') removerSessao(sidAnterior);

  const sid = criarSessao(usuario.id);
  res.cookie('sid', sid, opcoesCookie(lembrar));
}

// "lembrar" é opcional: só false desliga o cookie persistente de 7 dias
function querLembrar(valor) {
  return valor !== false && valor !== 'false';
}

// body: { email, senha, lembrar? }
router.post('/login', limiteLogin, (req, res) => {
  const body = req.body || {};
  const email = normalizarEmail(body.email);
  const senha = lerTexto(body.senha);

  if (!email || !senha) {
    return res.status(400).json({ erro: 'Informe e-mail e senha' });
  }
  if (senha.length > SENHA_MAX) {
    return res.status(401).json({ erro: 'E-mail ou senha inválidos' });
  }

  const usuario = buscarUsuarioPorEmail(email);
  const senhaConfere = usuario
    ? verificarSenha(senha, usuario.salt, usuario.hash)
    : verificarSenhaFicticia(senha);

  if (!usuario || !senhaConfere) {
    return res.status(401).json({ erro: 'E-mail ou senha inválidos' });
  }

  iniciarSessao(req, res, usuario, querLembrar(body.lembrar));
  res.json({ usuario: usuarioPublico(usuario) });
});

// body: { nome, email, senha }
router.post('/registrar', limiteRegistro, (req, res) => {
  const body = req.body || {};
  const nome = lerTexto(body.nome).trim().replace(/\s+/g, ' ');
  const email = normalizarEmail(body.email);
  const senha = lerTexto(body.senha);

  if (nome.length < NOME_MIN) {
    return res.status(400).json({ erro: `Informe seu nome (mínimo de ${NOME_MIN} caracteres)` });
  }
  if (nome.length > NOME_MAX || CARACTERES_CONTROLE.test(nome)) {
    return res.status(400).json({ erro: `Nome inválido (máximo de ${NOME_MAX} caracteres)` });
  }
  if (email.length > EMAIL_MAX || !EMAIL_VALIDO.test(email)) {
    return res.status(400).json({ erro: 'Informe um e-mail válido' });
  }
  if (senha.length < SENHA_MIN) {
    return res.status(400).json({ erro: `A senha deve ter pelo menos ${SENHA_MIN} caracteres` });
  }
  if (senha.length > SENHA_MAX) {
    return res.status(400).json({ erro: `A senha deve ter no máximo ${SENHA_MAX} caracteres` });
  }
  if (buscarUsuarioPorEmail(email)) {
    return res.status(409).json({ erro: 'E-mail já cadastrado' });
  }

  const usuario = criarUsuario({ nome, email, senha });
  iniciarSessao(req, res, usuario, true);
  res.status(201).json({ usuario: usuarioPublico(usuario) });
});

// Encerra a sessão atual e apaga o cookie
router.post('/logout', (req, res) => {
  const sid = req.cookies && req.cookies.sid;
  if (typeof sid === 'string') removerSessao(sid);

  res.clearCookie('sid', opcoesCookie(false));
  res.status(204).end();
});

// Usuário da sessão atual
router.get('/me', (req, res) => {
  if (!req.usuario) {
    return res.status(401).json({ erro: 'Não autenticado' });
  }
  res.json({ usuario: req.usuario });
});

module.exports = router;
