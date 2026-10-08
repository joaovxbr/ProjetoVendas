/*
 * services/favorito.service.js
 * -----------------------------------------------------------------------------
 * Lista de desejos: operacoes simples sobre a tabela "favoritos", devolvendo
 * os produtos no formato publico da vitrine.
 */
'use strict';

const favoritosRepo = require('../repositories/favoritos.repo');
const produtosRepo = require('../repositories/produtos.repo');
const catalogoService = require('./catalogo.service');
const atividadeService = require('./atividade.service');
const { NaoEncontrado } = require('../utils/erros');

/*
 * Favoritos sao eventos de baixo valor sozinhos, mas entram no historico porque
 * a linha do tempo fica estranha se pular o que a pessoa claramente fez na loja.
 * O registro usa o nome do produto para a atividade fazer sentido depois.
 */
function registrarFavorito(usuarioId, produto, favoritado, ip = null) {
  atividadeService.registrar(usuarioId, {
    tipo: favoritado ? 'favorito_adicionado' : 'favorito_removido',
    titulo: favoritado ? 'Adicionado aos favoritos' : 'Removido dos favoritos',
    descricao: produto ? produto.nome : '',
    referenciaId: produto ? produto.id : null,
    ip
  });
}

/** Adiciona se nao estiver na lista, remove se estiver. */
function alternar(usuarioId, produtoId, { ip = null } = {}) {
  const produto = produtosRepo.buscarPorId(produtoId);
  if (!produto || !produto.ativo) throw new NaoEncontrado('Produto nao encontrado');

  const resultado = favoritosRepo.alternar(usuarioId, produtoId);
  registrarFavorito(usuarioId, produto, resultado.favoritado, ip);

  return { ...resultado, produtoId, total: favoritosRepo.contarDoUsuario(usuarioId) };
}

function adicionar(usuarioId, produtoId, { ip = null } = {}) {
  const produto = produtosRepo.buscarPorId(produtoId);
  if (!produto || !produto.ativo) throw new NaoEncontrado('Produto nao encontrado');

  favoritosRepo.adicionar(usuarioId, produtoId);
  registrarFavorito(usuarioId, produto, true, ip);

  return { favoritado: true, produtoId, total: favoritosRepo.contarDoUsuario(usuarioId) };
}

function remover(usuarioId, produtoId, { ip = null } = {}) {
  const produto = produtosRepo.buscarPorId(produtoId);
  favoritosRepo.remover(usuarioId, produtoId);
  registrarFavorito(usuarioId, produto, false, ip);

  return { favoritado: false, produtoId, total: favoritosRepo.contarDoUsuario(usuarioId) };
}

/** Produtos favoritados, prontos para renderizar como cards. */
function listar(usuarioId) {
  const ids = favoritosRepo.listarIds(usuarioId);
  if (!ids.length) return { quantidade: 0, produtos: [] };

  const produtos = ids
    .map(id => produtosRepo.buscarPorId(id))
    .filter(produto => produto && produto.ativo)
    .map(produto => catalogoService.paraPublico(produto, { favoritado: true }));

  return { quantidade: produtos.length, produtos };
}

module.exports = { alternar, adicionar, remover, listar };
