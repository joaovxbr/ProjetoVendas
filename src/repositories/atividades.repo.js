/*
 * repositories/atividades.repo.js
 * -----------------------------------------------------------------------------
 * Acesso a tabela "atividades" — o historico do CLIENTE.
 *
 * Nao confundir com auditoria.repo.js: a auditoria e a trilha do admin (quem
 * mudou o que no sistema). Aqui e a linha do tempo da propria pessoa, exibida no
 * painel /conta. Como o repositorio so fala com o banco, ele nao decide o texto
 * nem o que merece ser registrado — isso e do atividade.service.
 */
'use strict';

const { obter } = require('../db/conexao');
const { agoraISO } = require('../utils/datas');

function mapear(linha) {
  if (!linha) return null;
  return {
    id: linha.id,
    usuarioId: linha.usuario_id,
    tipo: linha.tipo,
    titulo: linha.titulo,
    descricao: linha.descricao,
    referenciaId: linha.referencia_id,
    ip: linha.ip,
    criadoEm: linha.criado_em
  };
}

/** Insere uma atividade e devolve o registro criado. */
function inserir({
  id,
  usuarioId,
  tipo,
  titulo,
  descricao = '',
  referenciaId = null,
  ip = null,
  criadoEm = null
}) {
  obter()
    .prepare(`
      INSERT INTO atividades (id, usuario_id, tipo, titulo, descricao, referencia_id, ip, criado_em)
      VALUES (@id, @usuarioId, @tipo, @titulo, @descricao, @referenciaId, @ip, @criadoEm)
    `)
    .run({
      id,
      usuarioId,
      tipo,
      titulo,
      descricao,
      referenciaId,
      ip,
      criadoEm: criadoEm || agoraISO()
    });

  return mapear(obter().prepare('SELECT * FROM atividades WHERE id = ?').get(id));
}

/** Monta o WHERE compartilhado por listagem e contagem. */
function montarFiltro({ usuarioId, tipo = null, busca = null }) {
  const condicoes = ['usuario_id = @usuarioId'];
  const parametros = { usuarioId };

  if (tipo) {
    condicoes.push('tipo = @tipo');
    parametros.tipo = tipo;
  }

  const termo = String(busca || '').trim();
  if (termo) {
    condicoes.push('(titulo LIKE @busca OR descricao LIKE @busca)');
    parametros.busca = `%${termo}%`;
  }

  return { where: `WHERE ${condicoes.join(' AND ')}`, parametros };
}

/**
 * Atividades do usuario, mais recentes primeiro.
 * O desempate por rowid mantem a ordem estavel quando duas linhas caem no mesmo
 * segundo (o que acontece num checkout, que grava varias de uma vez).
 */
function listarDoUsuario({ usuarioId, tipo = null, busca = null, limite = 30, deslocamento = 0 } = {}) {
  const { where, parametros } = montarFiltro({ usuarioId, tipo, busca });

  return obter()
    .prepare(`
      SELECT * FROM atividades
      ${where}
      ORDER BY criado_em DESC, rowid DESC
      LIMIT @limite OFFSET @deslocamento
    `)
    .all({ ...parametros, limite, deslocamento })
    .map(mapear);
}

function contarDoUsuario({ usuarioId, tipo = null, busca = null } = {}) {
  const { where, parametros } = montarFiltro({ usuarioId, tipo, busca });
  const linha = obter().prepare(`SELECT COUNT(*) AS total FROM atividades ${where}`).get(parametros);
  return linha ? linha.total : 0;
}

/** Quantas atividades por tipo — alimenta os filtros da tela. */
function contarPorTipo(usuarioId) {
  return obter()
    .prepare('SELECT tipo, COUNT(*) AS total FROM atividades WHERE usuario_id = ? GROUP BY tipo')
    .all(usuarioId)
    .reduce((acumulado, linha) => ({ ...acumulado, [linha.tipo]: linha.total }), {});
}

/** Apaga tudo de um usuario (usado no "limpar histórico"). */
function removerDoUsuario(usuarioId) {
  const info = obter().prepare('DELETE FROM atividades WHERE usuario_id = ?').run(usuarioId);
  return info.changes;
}

module.exports = {
  mapear,
  inserir,
  listarDoUsuario,
  contarDoUsuario,
  contarPorTipo,
  removerDoUsuario
};
