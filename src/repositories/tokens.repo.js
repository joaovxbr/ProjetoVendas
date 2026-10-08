/*
 * repositories/tokens.repo.js
 * -----------------------------------------------------------------------------
 * Tokens de recuperacao de senha. O token em texto puro so existe no link
 * enviado ao usuario; no banco fica apenas o SHA-256 dele. Assim, um vazamento
 * do banco nao permite redefinir a senha de ninguem.
 */
'use strict';

const { obter } = require('../db/conexao');
const { agoraISO, expirou } = require('../utils/datas');

function mapear(linha) {
  if (!linha) return null;
  return {
    tokenHash: linha.token_hash,
    usuarioId: linha.usuario_id,
    criadoEm: linha.criado_em,
    expiraEm: linha.expira_em,
    usadoEm: linha.usado_em
  };
}

function criar({ tokenHash, usuarioId, expiraEm }) {
  obter()
    .prepare(`
      INSERT INTO tokens_senha (token_hash, usuario_id, criado_em, expira_em, usado_em)
      VALUES (@tokenHash, @usuarioId, @criadoEm, @expiraEm, NULL)
    `)
    .run({ tokenHash, usuarioId, criadoEm: agoraISO(), expiraEm });
  return buscar(tokenHash);
}

/** Devolve o token apenas se ainda for valido (nao usado e nao vencido). */
function buscar(tokenHash) {
  if (!tokenHash) return null;
  const token = mapear(obter().prepare('SELECT * FROM tokens_senha WHERE token_hash = ?').get(tokenHash));
  if (!token) return null;
  if (token.usadoEm || expirou(token.expiraEm)) return null;
  return token;
}

function marcarUsado(tokenHash) {
  return obter()
    .prepare('UPDATE tokens_senha SET usado_em = ? WHERE token_hash = ?')
    .run(agoraISO(), tokenHash).changes > 0;
}

/** Invalida pedidos anteriores quando um novo e gerado. */
function invalidarDoUsuario(usuarioId) {
  return obter()
    .prepare('DELETE FROM tokens_senha WHERE usuario_id = ? AND usado_em IS NULL')
    .run(usuarioId).changes;
}

function limparExpirados() {
  return obter()
    .prepare('DELETE FROM tokens_senha WHERE expira_em <= ? OR usado_em IS NOT NULL')
    .run(agoraISO()).changes;
}

module.exports = { mapear, criar, buscar, marcarUsado, invalidarDoUsuario, limparExpirados };
