/*
 * repositories/avaliacoes.repo.js
 * -----------------------------------------------------------------------------
 * Avaliacoes de produto (1 a 5 estrelas). A regra "um cliente avalia cada
 * produto uma vez" e garantida por UNIQUE(produto_id, usuario_id) no banco,
 * entao nao ha como furar a regra nem em corrida.
 */
'use strict';

const { obter } = require('../db/conexao');
const { agoraISO } = require('../utils/datas');

function mapear(linha) {
  if (!linha) return null;
  return {
    id: linha.id,
    produtoId: linha.produto_id,
    usuarioId: linha.usuario_id,
    vendaId: linha.venda_id,
    nota: linha.nota,
    comentario: linha.comentario,
    criadoEm: linha.criado_em,
    atualizadoEm: linha.atualizado_em
  };
}

/**
 * Cria a avaliacao ou atualiza a que ja existe (upsert).
 * @returns {object} a avaliacao resultante
 */
function salvar({ id, produtoId, usuarioId, vendaId = null, nota, comentario = '' }) {
  const agora = agoraISO();
  obter()
    .prepare(`
      INSERT INTO avaliacoes (id, produto_id, usuario_id, venda_id, nota, comentario, criado_em, atualizado_em)
      VALUES (@id, @produtoId, @usuarioId, @vendaId, @nota, @comentario, @criadoEm, @atualizadoEm)
      ON CONFLICT (produto_id, usuario_id) DO UPDATE SET
        nota          = excluded.nota,
        comentario    = excluded.comentario,
        atualizado_em = excluded.atualizado_em
    `)
    .run({ id, produtoId, usuarioId, vendaId, nota, comentario, criadoEm: agora, atualizadoEm: agora });

  return buscarDoUsuario(produtoId, usuarioId);
}

function buscarDoUsuario(produtoId, usuarioId) {
  if (!produtoId || !usuarioId) return null;
  return mapear(
    obter().prepare('SELECT * FROM avaliacoes WHERE produto_id = ? AND usuario_id = ?').get(produtoId, usuarioId)
  );
}

function buscarPorId(id) {
  if (!id) return null;
  return mapear(obter().prepare('SELECT * FROM avaliacoes WHERE id = ?').get(id));
}

/** Avaliacoes publicas de um produto, com o nome de quem avaliou. */
function listarDoProduto(produtoId, { limite = 20, deslocamento = 0 } = {}) {
  return obter()
    .prepare(`
      SELECT a.*, u.nome AS autor_nome
      FROM avaliacoes a
      JOIN usuarios u ON u.id = a.usuario_id
      WHERE a.produto_id = @produtoId
      ORDER BY a.criado_em DESC
      LIMIT @limite OFFSET @deslocamento
    `)
    .all({ produtoId, limite, deslocamento })
    .map(linha => ({ ...mapear(linha), autorNome: linha.autor_nome }));
}

function contarDoProduto(produtoId) {
  const linha = obter().prepare('SELECT COUNT(*) AS total FROM avaliacoes WHERE produto_id = ?').get(produtoId);
  return linha ? linha.total : 0;
}

/** Media e total das avaliacoes REAIS (sem a base historica). */
function agregadoDoProduto(produtoId) {
  const linha = obter()
    .prepare('SELECT COUNT(*) AS total, COALESCE(SUM(nota), 0) AS soma FROM avaliacoes WHERE produto_id = ?')
    .get(produtoId);
  return { total: linha ? linha.total : 0, soma: linha ? linha.soma : 0 };
}

function remover(id) {
  return obter().prepare('DELETE FROM avaliacoes WHERE id = ?').run(id).changes > 0;
}

/** Ultimas avaliacoes da loja inteira (moderacao no painel). */
function listarRecentes(limite = 20) {
  return obter()
    .prepare(`
      SELECT a.*, u.nome AS autor_nome, u.email AS autor_email, p.nome AS produto_nome
      FROM avaliacoes a
      JOIN usuarios u ON u.id = a.usuario_id
      JOIN produtos p ON p.id = a.produto_id
      ORDER BY a.criado_em DESC
      LIMIT ?
    `)
    .all(limite)
    .map(linha => ({
      ...mapear(linha),
      autorNome: linha.autor_nome,
      autorEmail: linha.autor_email,
      produtoNome: linha.produto_nome
    }));
}

function contar() {
  const linha = obter().prepare('SELECT COUNT(*) AS total FROM avaliacoes').get();
  return linha ? linha.total : 0;
}

/** Quantas avaliacoes um usuario ja escreveu. */
function contarDoUsuario(usuarioId) {
  const linha = obter().prepare('SELECT COUNT(*) AS total FROM avaliacoes WHERE usuario_id = ?').get(usuarioId);
  return linha ? linha.total : 0;
}

module.exports = {
  mapear,
  salvar,
  buscarPorId,
  buscarDoUsuario,
  listarDoProduto,
  contarDoProduto,
  agregadoDoProduto,
  remover,
  listarRecentes,
  contar,
  contarDoUsuario
};
