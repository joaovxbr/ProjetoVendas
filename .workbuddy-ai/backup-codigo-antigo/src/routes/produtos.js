const express = require('express');
const { produtos, listarCategorias, normalizarTexto } = require('../data/db');

const router = express.Router();

const ORDENS = {
  relevancia: null,
  'menor-preco': (a, b) => a.precoMin - b.precoMin,
  'maior-preco': (a, b) => b.precoMin - a.precoMin,
  avaliacao: (a, b) => b.avaliacao - a.avaliacao || b.avaliacoes - a.avaliacoes
};

// Lista com filtros opcionais: ?categoria=Macros&destaque=true&busca=fps&ordem=menor-preco
router.get('/', (req, res) => {
  const { categoria, destaque, busca, ordem } = req.query;
  let lista = produtos;

  if (typeof categoria === 'string' && categoria.trim()) {
    const alvo = normalizarTexto(categoria);
    lista = lista.filter(p => normalizarTexto(p.categoria) === alvo);
  }
  if (destaque === 'true') {
    lista = lista.filter(p => p.destaque);
  }
  if (typeof busca === 'string' && busca.trim()) {
    const termo = normalizarTexto(busca);
    lista = lista.filter(p => normalizarTexto(`${p.nome} ${p.categoria}`).includes(termo));
  }
  if (typeof ordem === 'string' && ORDENS[ordem]) {
    lista = [...lista].sort(ORDENS[ordem]);
  }

  res.json(lista);
});

// Precisa vir antes de /:id -> [{ nome, total }]
router.get('/categorias', (req, res) => {
  res.json(listarCategorias());
});

// Busca por id (ou pelo slug, por conveniência)
router.get('/:id', (req, res) => {
  const produto = produtos.find(p => p.id === req.params.id || p.slug === req.params.id);
  if (!produto) return res.status(404).json({ erro: 'Produto não encontrado' });
  res.json(produto);
});

module.exports = router;
