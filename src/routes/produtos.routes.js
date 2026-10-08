/*
 * routes/produtos.routes.js
 * -----------------------------------------------------------------------------
 * Catalogo publico.
 *
 * Contrato mantido do front atual (a vitrine faz Promise.all nessas duas):
 *   GET /api/produtos             -> 200 [ produto, ... ]
 *   GET /api/produtos/categorias  -> 200 [ { nome, total }, ... ]
 *   GET /api/produtos/:id         -> 200 produto | 404
 *
 * A paginacao vai nos cabecalhos (X-Total-Count, X-Page, X-Per-Page) para que
 * o corpo continue sendo um array simples, como o front espera.
 */
'use strict';

const express = require('express');
const catalogoService = require('../services/catalogo.service');
const { assincrono } = require('../middlewares/contexto');
const { validarIdOuSlug } = require('../middlewares/validar');
const { lerInteiro } = require('../utils/validacao');

const router = express.Router();

// Filtros comuns a listagem e a contagem.
function lerFiltros(req) {
  return {
    categoria: req.query.categoria,
    destaque: req.query.destaque,
    busca: req.query.busca,
    ordem: req.query.ordem
  };
}

router.get('/', assincrono((req, res) => {
  const filtros = lerFiltros(req);

  // Sem ?limite nem ?pagina, devolve o catalogo inteiro (uso da vitrine).
  const temPaginacao = req.query.limite !== undefined || req.query.pagina !== undefined;

  if (!temPaginacao) {
    const produtos = catalogoService.listar({ ...filtros, limite: 200 });
    res.set('X-Total-Count', String(produtos.length));
    return res.json(produtos);
  }

  const limite = Math.min(Math.max(lerInteiro(req.query.limite, 24), 1), 100);
  const pagina = Math.max(lerInteiro(req.query.pagina, 1), 1);

  const resultado = catalogoService.listarPaginado({ ...filtros, limite, pagina });

  res.set({
    'X-Total-Count': String(resultado.total),
    'X-Page': String(resultado.pagina),
    'X-Per-Page': String(resultado.limite),
    'X-Total-Pages': String(resultado.paginas)
  });
  res.json(resultado.itens);
}));

// Precisa vir ANTES de /:id, senao "categorias" seria lido como um id.
router.get('/categorias', assincrono((req, res) => {
  res.json(catalogoService.categorias());
}));

/*
 * Produtos em destaque (atalho usado pela home).
 *
 * Sem ?limite devolve TODOS os destaques ativos — o painel nao limita quantos
 * produtos podem ser destaque, entao a home tambem nao pode. O teto existe so
 * para a consulta nunca ficar ilimitada (o mesmo da listagem paginada).
 */
const LIMITE_MAXIMO_DESTAQUES = 100;

router.get('/destaques', assincrono((req, res) => {
  const pedido = lerInteiro(req.query.limite, LIMITE_MAXIMO_DESTAQUES);
  const limite = Math.min(Math.max(pedido, 1), LIMITE_MAXIMO_DESTAQUES);
  res.json(catalogoService.destaques(limite));
}));

// Aceita tanto o id (UUID) quanto o slug.
router.get('/:id', validarIdOuSlug, assincrono((req, res) => {
  const usuarioId = req.usuario ? req.usuario.id : null;
  res.json(catalogoService.detalhar(req.params.id, usuarioId));
}));

module.exports = router;
