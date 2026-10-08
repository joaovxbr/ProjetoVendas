/*
 * repositories/auditoria.repo.js
 * -----------------------------------------------------------------------------
 * Trilha de auditoria: registra quem fez o que, quando e de qual IP. Serve
 * para investigar disputas ("nao fui eu que comprei") e para rastrear acoes
 * administrativas. NUNCA guarde senhas ou tokens aqui.
 */
'use strict';

const { obter } = require('../db/conexao');
const { agoraISO } = require('../utils/datas');

function mapear(linha) {
  if (!linha) return null;
  return {
    id: linha.id,
    atorId: linha.ator_id,
    acao: linha.acao,
    entidade: linha.entidade,
    entidadeId: linha.entidade_id,
    dados: linha.dados ? JSON.parse(linha.dados) : null,
    ip: linha.ip,
    criadoEm: linha.criado_em
  };
}

/**
 * Grava um evento. Nunca lanca: auditoria nao pode derrubar a operacao
 * principal, entao qualquer falha aqui e engolida com um aviso no log.
 */
function registrar({ atorId = null, acao, entidade = null, entidadeId = null, dados = null, ip = null }) {
  try {
    obter()
      .prepare(`
        INSERT INTO auditoria (ator_id, acao, entidade, entidade_id, dados, ip, criado_em)
        VALUES (@atorId, @acao, @entidade, @entidadeId, @dados, @ip, @criadoEm)
      `)
      .run({
        atorId,
        acao,
        entidade,
        entidadeId: entidadeId === null || entidadeId === undefined ? null : String(entidadeId),
        dados: dados ? JSON.stringify(dados) : null,
        ip,
        criadoEm: agoraISO()
      });
    return true;
  } catch (erro) {
    // Import tardio para evitar dependencia circular com o logger.
    require('../utils/logger').warn('Falha ao registrar auditoria', { acao, erro: erro.message });
    return false;
  }
}

function listar({ limite = 50, deslocamento = 0, entidade = null, acao = null } = {}) {
  const condicoes = [];
  const parametros = { limite, deslocamento };

  if (entidade) {
    condicoes.push('a.entidade = @entidade');
    parametros.entidade = entidade;
  }
  if (acao) {
    condicoes.push('a.acao = @acao');
    parametros.acao = acao;
  }

  const where = condicoes.length ? `WHERE ${condicoes.join(' AND ')}` : '';
  return obter()
    .prepare(`
      SELECT a.*, u.nome AS ator_nome, u.email AS ator_email
      FROM auditoria a
      LEFT JOIN usuarios u ON u.id = a.ator_id
      ${where}
      ORDER BY a.id DESC
      LIMIT @limite OFFSET @deslocamento
    `)
    .all(parametros)
    .map(linha => ({ ...mapear(linha), atorNome: linha.ator_nome, atorEmail: linha.ator_email }));
}

/** Eventos ligados a uma entidade especifica (ex.: um pedido). */
function listarDaEntidade(entidade, entidadeId) {
  return obter()
    .prepare(`
      SELECT a.*, u.nome AS ator_nome, u.email AS ator_email
      FROM auditoria a
      LEFT JOIN usuarios u ON u.id = a.ator_id
      WHERE a.entidade = ? AND a.entidade_id = ?
      ORDER BY a.id DESC
    `)
    .all(entidade, String(entidadeId))
    .map(linha => ({ ...mapear(linha), atorNome: linha.ator_nome, atorEmail: linha.ator_email }));
}

function contar() {
  const linha = obter().prepare('SELECT COUNT(*) AS total FROM auditoria').get();
  return linha ? linha.total : 0;
}

module.exports = { mapear, registrar, listar, listarDaEntidade, contar };
