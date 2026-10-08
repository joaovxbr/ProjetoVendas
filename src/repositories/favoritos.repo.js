/*
 * repositories/favoritos.repo.js
 * -----------------------------------------------------------------------------
 * Lista de desejos. A chave primaria composta (usuario_id, produto_id) torna
 * impossivel duplicar o mesmo favorito.
 */
'use strict';

const { obter } = require('../db/conexao');
const { agoraISO } = require('../utils/datas');

function adicionar(usuarioId, produtoId) {
  obter()
    .prepare('INSERT OR IGNORE INTO favoritos (usuario_id, produto_id, criado_em) VALUES (?, ?, ?)')
    .run(usuarioId, produtoId, agoraISO());
  return existe(usuarioId, produtoId);
}

function remover(usuarioId, produtoId) {
  return obter().prepare('DELETE FROM favoritos WHERE usuario_id = ? AND produto_id = ?').run(usuarioId, produtoId).changes > 0;
}

function existe(usuarioId, produtoId) {
  const linha = obter()
    .prepare('SELECT 1 AS existe FROM favoritos WHERE usuario_id = ? AND produto_id = ?')
    .get(usuarioId, produtoId);
  return !!linha;
}

/** Adiciona se nao estiver na lista, remove se estiver. */
function alternar(usuarioId, produtoId) {
  if (existe(usuarioId, produtoId)) {
    remover(usuarioId, produtoId);
    return { favoritado: false };
  }
  adicionar(usuarioId, produtoId);
  return { favoritado: true };
}

/** Ids dos produtos favoritados (usado para marcar os cards). */
function listarIds(usuarioId) {
  return obter()
    .prepare('SELECT produto_id FROM favoritos WHERE usuario_id = ? ORDER BY criado_em DESC')
    .all(usuarioId)
    .map(linha => linha.produto_id);
}

function contarDoUsuario(usuarioId) {
  const linha = obter().prepare('SELECT COUNT(*) AS total FROM favoritos WHERE usuario_id = ?').get(usuarioId);
  return linha ? linha.total : 0;
}

function contarDoProduto(produtoId) {
  const linha = obter().prepare('SELECT COUNT(*) AS total FROM favoritos WHERE produto_id = ?').get(produtoId);
  return linha ? linha.total : 0;
}

module.exports = { adicionar, remover, existe, alternar, listarIds, contarDoUsuario, contarDoProduto };
