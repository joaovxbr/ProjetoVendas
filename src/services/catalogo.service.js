/*
 * services/catalogo.service.js
 * -----------------------------------------------------------------------------
 * Regras do catalogo e — importante — a traducao do formato interno (centavos,
 * snake_case, JSON) para o formato publico que o front consome (reais,
 * camelCase, "planos" com "preco").
 *
 * Manter essa conversao em um unico lugar evita o classico bug de preco
 * aparecendo como 999 em vez de 9,99 em alguma tela esquecida.
 */
'use strict';

const produtosRepo = require('../repositories/produtos.repo');
const avaliacoesRepo = require('../repositories/avaliacoes.repo');
const favoritosRepo = require('../repositories/favoritos.repo');
const estoqueService = require('./estoque.service');
const { NaoEncontrado } = require('../utils/erros');
const { paraReais } = require('../utils/dinheiro');

const ORDENS_VALIDAS = ['relevancia', 'menor-preco', 'maior-preco', 'avaliacao', 'recentes'];

/** Agrupa um mapa "produtoId|planoId" -> qtd em Map(produtoId -> Map(planoId -> qtd)). */
function agruparPorProduto(mapa) {
  const porProduto = new Map();
  mapa.forEach((valor, chave) => {
    const [produtoId, planoId] = chave.split('|');
    if (!porProduto.has(produtoId)) porProduto.set(produtoId, new Map());
    porProduto.get(produtoId).set(planoId, valor);
  });
  return porProduto;
}

/**
 * Converte um produto interno no formato publico esperado pelo front.
 * @param {object} produto produto vindo do repositorio (centavos)
 * @param {object} [extras] campos adicionais (favoritado, resumo de avaliacoes)
 * @param {Map<string,number>} [extras.disponibilidade] planoId -> chaves disponiveis
 */
function paraPublico(produto, extras = {}) {
  if (!produto) return null;

  const { disponibilidade, ...resto } = extras;
  const mapa = disponibilidade instanceof Map ? disponibilidade : estoqueService.disponibilidade(produto.id);

  // Estoque entra plano a plano: e o que permite a vitrine esconder/avisar o
  // plano esgotado sem esconder o produto inteiro.
  const planos = (produto.planos || []).map(plano => {
    const estoque = mapa.get(plano.id) || 0;
    return {
      id: plano.id,
      nome: plano.nome,
      preco: paraReais(plano.precoCentavos),
      dias: plano.dias ?? null,
      estoque,
      esgotado: estoque === 0
    };
  });

  const estoqueTotal = planos.reduce((soma, plano) => soma + plano.estoque, 0);

  return {
    id: produto.id,
    slug: produto.slug,
    nome: produto.nome,
    linha: produto.linha,
    nivel: produto.nivel,
    categoria: produto.categoria,
    descricao: produto.descricao,
    descricaoLonga: produto.descricaoLonga || '',
    recursos: produto.recursos,
    capa: produto.capa,
    imagem: produto.imagem,
    badge: produto.badge,
    plataforma: produto.plataforma,
    entrega: produto.entrega,
    destaque: produto.destaque,
    avaliacao: produto.avaliacao,
    avaliacoes: produto.avaliacoes,
    planos,
    // Produto so fica "esgotado" quando TODOS os planos zeram. Se um plano tem
    // chave, ainda da para comprar.
    esgotado: planos.length > 0 && planos.every(plano => plano.esgotado),
    estoqueTotal,
    precoMin: paraReais(produto.precoMinCentavos),
    precoMax: paraReais(produto.precoMaxCentavos),
    ...resto
  };
}

/**
 * Lista produtos para a vitrine.
 * @param {object} filtros categoria, destaque, busca, ordem, limite, deslocamento
 */
function listar(filtros = {}) {
  const ordem = ORDENS_VALIDAS.includes(filtros.ordem) ? filtros.ordem : 'relevancia';

  const produtos = produtosRepo.listar({
    categoria: filtros.categoria,
    destaque: filtros.destaque === true || filtros.destaque === 'true',
    busca: filtros.busca,
    ordem,
    limite: filtros.limite,
    deslocamento: filtros.deslocamento
  });

  // Uma consulta so para o estoque de todos os produtos da pagina.
  const disponibilidade = agruparPorProduto(estoqueService.disponibilidadeDeVarios(produtos.map(produto => produto.id)));

  return produtos.map(produto =>
    paraPublico(produto, { disponibilidade: disponibilidade.get(produto.id) || new Map() })
  );
}

/** Listagem com metadados de paginacao (usada quando o cliente pede paginas). */
function listarPaginado(filtros = {}) {
  const limite = Math.min(Math.max(Number(filtros.limite) || 24, 1), 100);
  const pagina = Math.max(Number(filtros.pagina) || 1, 1);
  const deslocamento = (pagina - 1) * limite;

  const total = produtosRepo.contar({
    categoria: filtros.categoria,
    destaque: filtros.destaque === true || filtros.destaque === 'true',
    busca: filtros.busca
  });

  return {
    itens: listar({ ...filtros, limite, deslocamento }),
    total,
    pagina,
    limite,
    paginas: Math.max(Math.ceil(total / limite), 1)
  };
}

/** Detalhe por id ou slug, com avaliacoes e favorito do usuario (se logado). */
function detalhar(idOuSlug, usuarioId = null) {
  const produto = produtosRepo.buscarPorIdOuSlug(idOuSlug);
  if (!produto || (!produto.ativo && !usuarioId)) {
    throw new NaoEncontrado('Produto nao encontrado');
  }

  const avaliacoes = avaliacoesRepo.listarDoProduto(produto.id, { limite: 10 });

  return paraPublico(produto, {
    favoritado: usuarioId ? favoritosRepo.existe(usuarioId, produto.id) : false,
    avaliacoesRecentes: avaliacoes.map(avaliacao => ({
      id: avaliacao.id,
      nota: avaliacao.nota,
      comentario: avaliacao.comentario,
      autor: avaliacao.autorNome,
      criadoEm: avaliacao.criadoEm
    }))
  });
}

/** Categorias com contagem, para a barra lateral. */
function categorias() {
  return produtosRepo.listarCategorias();
}

/**
 * Produtos em destaque para a home — os MAIS RECENTES primeiro.
 *
 * A ordem aqui e por data de criacao, nao por `ordem` (a "Ordem na vitrine").
 * Isso e proposital: `proximaOrdem()` coloca todo produto novo no FIM da lista
 * (MAX(ordem)+1), entao com a ordenacao de relevancia (`destaque DESC, ordem
 * ASC, nome ASC`) um produto recem-criado ficava no fim da lista. Ordenando por
 * recencia, o destaque mais novo vem primeiro.
 *
 * Sem limite explicito devolve todos os destaques (ate o teto do repositorio):
 * a quantidade de destaques e decisao do admin, nao do servidor.
 *
 * A "Ordem na vitrine" continua mandando no catalogo (`/api/produtos`).
 */
function destaques(limite = 100) {
  return listar({ destaque: true, ordem: 'recentes', limite });
}

/** Produto interno (com centavos) — usado pelo checkout e pelo admin. */
function buscarInterno(idOuSlug) {
  return produtosRepo.buscarPorIdOuSlug(idOuSlug);
}

module.exports = {
  ORDENS_VALIDAS,
  paraPublico,
  listar,
  listarPaginado,
  detalhar,
  categorias,
  destaques,
  buscarInterno
};
