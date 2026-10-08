const express = require('express');
const { v4: uuid } = require('uuid');
const dayjs = require('dayjs');
const { produtos, vendas, gerarChave } = require('../data/db');
const { requireAuth } = require('../middlewares/auth');

const router = express.Router();

const MAX_ITENS = 20;
const MAX_QUANTIDADE = 10;

// Valores em dinheiro sempre com 2 casas
const arredondar = valor => Math.round(valor * 100) / 100;

// Aceita 2 ou "2"; qualquer outra coisa vira NaN
function lerQuantidade(valor) {
  if (valor === undefined) return 1;
  if (typeof valor === 'number') return valor;
  if (typeof valor === 'string' && /^\d+$/.test(valor.trim())) return Number(valor.trim());
  return NaN;
}

// Pedidos do usuário logado
router.get('/', requireAuth, (req, res) => {
  const minhas = vendas.filter(v => v.usuarioId === req.usuario.id);
  const total = arredondar(minhas.reduce((soma, v) => soma + v.total, 0));
  res.json({ quantidade: minhas.length, total, vendas: minhas });
});

// body: { itens: [{ produtoId, planoId, quantidade }] }
router.post('/', requireAuth, (req, res) => {
  const itens = req.body && req.body.itens;
  if (!Array.isArray(itens) || itens.length === 0) {
    return res.status(400).json({ erro: 'Seu carrinho está vazio' });
  }
  if (itens.length > MAX_ITENS) {
    return res.status(400).json({ erro: `Um pedido pode ter no máximo ${MAX_ITENS} itens` });
  }

  // 1) Valida todos os itens antes de criar qualquer coisa
  const linhas = [];
  for (const item of itens) {
    const produto = item && produtos.find(p => p.id === item.produtoId);
    if (!produto) {
      return res.status(404).json({ erro: 'Um dos produtos do carrinho não está mais disponível' });
    }

    const plano = produto.planos.find(p => p.id === item.planoId);
    if (!plano) {
      return res.status(400).json({ erro: `Escolha um plano válido para ${produto.nome}` });
    }

    const quantidade = lerQuantidade(item.quantidade);
    if (!Number.isInteger(quantidade) || quantidade < 1 || quantidade > MAX_QUANTIDADE) {
      return res.status(400).json({ erro: `Quantidade inválida (de 1 a ${MAX_QUANTIDADE})` });
    }

    linhas.push({ produto, plano, quantidade });
  }

  // 2) Entrega automática: uma chave de licença por unidade
  const venda = {
    id: uuid(),
    usuarioId: req.usuario.id,
    cliente: req.usuario.nome,
    data: dayjs().format('DD/MM/YYYY HH:mm'),
    itens: linhas.map(({ produto, plano, quantidade }) => ({
      produtoId: produto.id,
      nome: produto.nome,
      plano: plano.nome,
      preco: plano.preco,
      quantidade,
      chaves: Array.from({ length: quantidade }, gerarChave)
    })),
    total: arredondar(linhas.reduce((soma, { plano, quantidade }) => soma + plano.preco * quantidade, 0))
  };

  vendas.push(venda);
  res.status(201).json(venda);
});

module.exports = router;
