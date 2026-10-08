/*
 * repositories/sessoes.repo.js
 * -----------------------------------------------------------------------------
 * Sessoes ficam no banco (e nao em memoria) para que o login sobreviva a
 * reinicios e funcione com mais de uma instancia da aplicacao.
 */
'use strict';

const { obter } = require('../db/conexao');
const { agoraISO, expirou } = require('../utils/datas');

function mapear(linha) {
  if (!linha) return null;
  return {
    sid: linha.sid,
    usuarioId: linha.usuario_id,
    criadaEm: linha.criada_em,
    expiraEm: linha.expira_em,
    persistente: linha.persistente === 1,
    ip: linha.ip,
    userAgent: linha.user_agent
  };
}

function criar({ sid, usuarioId, expiraEm, persistente = true, ip = null, userAgent = null }) {
  obter()
    .prepare(`
      INSERT INTO sessoes (sid, usuario_id, criada_em, expira_em, persistente, ip, user_agent)
      VALUES (@sid, @usuarioId, @criadaEm, @expiraEm, @persistente, @ip, @userAgent)
    `)
    .run({
      sid,
      usuarioId,
      criadaEm: agoraISO(),
      expiraEm,
      persistente: persistente ? 1 : 0,
      ip,
      userAgent
    });
  return buscar(sid);
}

/** Busca a sessao e descarta na hora se ja venceu. */
function buscar(sid) {
  if (!sid) return null;
  const sessao = mapear(obter().prepare('SELECT * FROM sessoes WHERE sid = ?').get(sid));
  if (!sessao) return null;
  if (expirou(sessao.expiraEm)) {
    remover(sid);
    return null;
  }
  return sessao;
}

function remover(sid) {
  if (!sid) return false;
  return obter().prepare('DELETE FROM sessoes WHERE sid = ?').run(sid).changes > 0;
}

/** Encerra todas as sessoes de um usuario (troca de senha, "sair de tudo"). */
function removerDoUsuario(usuarioId, { exceto = null } = {}) {
  if (exceto) {
    return obter()
      .prepare('DELETE FROM sessoes WHERE usuario_id = ? AND sid <> ?')
      .run(usuarioId, exceto).changes;
  }
  return obter().prepare('DELETE FROM sessoes WHERE usuario_id = ?').run(usuarioId).changes;
}

function contarDoUsuario(usuarioId) {
  const linha = obter()
    .prepare('SELECT COUNT(*) AS total FROM sessoes WHERE usuario_id = ? AND expira_em > ?')
    .get(usuarioId, agoraISO());
  return linha ? linha.total : 0;
}

/** Sessoes ainda validas de um usuario, da mais recente para a mais antiga. */
function listarDoUsuario(usuarioId) {
  return obter()
    .prepare('SELECT * FROM sessoes WHERE usuario_id = ? AND expira_em > ? ORDER BY criada_em DESC')
    .all(usuarioId, agoraISO())
    .map(mapear);
}

/** Apaga sessoes vencidas. Roda periodicamente e no boot. */
function limparExpiradas() {
  return obter().prepare('DELETE FROM sessoes WHERE expira_em <= ?').run(agoraISO()).changes;
}

module.exports = {
  mapear,
  criar,
  buscar,
  remover,
  removerDoUsuario,
  contarDoUsuario,
  listarDoUsuario,
  limparExpiradas
};
