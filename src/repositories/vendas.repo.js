/*
 * repositories/vendas.repo.js
 * -----------------------------------------------------------------------------
 * Pedidos e seus itens. Os itens guardam uma COPIA do nome do produto e do
 * preco no momento da compra: se o catalogo mudar depois, o historico do
 * cliente continua contando a verdade do que ele pagou.
 */
'use strict';

const { obter } = require('../db/conexao');

/** Converte a coluna de instrucoes (TEXT/JSON) em objeto, sem nunca lancar. */
function lerInstrucoes(bruto) {
  if (!bruto) return null;
  try {
    const dados = JSON.parse(bruto);
    return dados && typeof dados === 'object' ? dados : null;
  } catch {
    return null;
  }
}

function mapearVenda(linha) {
  if (!linha) return null;
  return {
    id: linha.id,
    numero: linha.numero,
    usuarioId: linha.usuario_id,
    status: linha.status,
    subtotalCentavos: linha.subtotal_centavos,
    descontoCentavos: linha.desconto_centavos,
    totalCentavos: linha.total_centavos,
    cupomCodigo: linha.cupom_codigo,
    metodoPagamento: linha.metodo_pagamento,
    provedorPagamento: linha.provedor_pagamento,
    pagamentoId: linha.pagamento_id,
    pagamentoStatus: linha.pagamento_status,
    instrucoesPagamento: lerInstrucoes(linha.instrucoes_pagamento),
    pagoEm: linha.pago_em,
    criadoEm: linha.criado_em,
    atualizadoEm: linha.atualizado_em
  };
}

function mapearItem(linha) {
  if (!linha) return null;
  return {
    id: linha.id,
    vendaId: linha.venda_id,
    produtoId: linha.produto_id,
    produtoNome: linha.produto_nome,
    planoId: linha.plano_id,
    planoNome: linha.plano_nome,
    precoCentavos: linha.preco_centavos,
    quantidade: linha.quantidade,
    subtotalCentavos: linha.subtotal_centavos
  };
}

function inserirVenda(venda) {
  obter()
    .prepare(`
      INSERT INTO vendas (
        id, numero, usuario_id, status, subtotal_centavos, desconto_centavos, total_centavos,
        cupom_codigo, metodo_pagamento, provedor_pagamento, pagamento_id, pagamento_status,
        instrucoes_pagamento, pago_em, criado_em, atualizado_em
      ) VALUES (
        @id, @numero, @usuarioId, @status, @subtotalCentavos, @descontoCentavos, @totalCentavos,
        @cupomCodigo, @metodoPagamento, @provedorPagamento, @pagamentoId, @pagamentoStatus,
        @instrucoesPagamento, @pagoEm, @criadoEm, @atualizadoEm
      )
    `)
    .run({
      id: venda.id,
      numero: venda.numero,
      usuarioId: venda.usuarioId,
      status: venda.status,
      subtotalCentavos: venda.subtotalCentavos,
      descontoCentavos: venda.descontoCentavos,
      totalCentavos: venda.totalCentavos,
      cupomCodigo: venda.cupomCodigo ?? null,
      metodoPagamento: venda.metodoPagamento,
      provedorPagamento: venda.provedorPagamento,
      pagamentoId: venda.pagamentoId ?? null,
      pagamentoStatus: venda.pagamentoStatus,
      instrucoesPagamento: venda.instrucoesPagamento ? JSON.stringify(venda.instrucoesPagamento) : null,
      pagoEm: venda.pagoEm ?? null,
      criadoEm: venda.criadoEm,
      atualizadoEm: venda.atualizadoEm
    });
  return buscarPorId(venda.id);
}

/**
 * Grava (ou limpa) as instrucoes de pagamento de um pedido. Chamado depois da
 * cobranca, quando o gateway devolve o Pix copia-e-cola ou a linha digitavel.
 */
function definirInstrucoesPagamento(vendaId, instrucoes) {
  obter()
    .prepare('UPDATE vendas SET instrucoes_pagamento = @instrucoes WHERE id = @id')
    .run({
      id: vendaId,
      instrucoes: instrucoes && Object.keys(instrucoes).length ? JSON.stringify(instrucoes) : null
    });
  return buscarPorId(vendaId);
}

function inserirItem(item) {
  obter()
    .prepare(`
      INSERT INTO venda_itens (
        id, venda_id, produto_id, produto_nome, plano_id, plano_nome,
        preco_centavos, quantidade, subtotal_centavos
      ) VALUES (
        @id, @vendaId, @produtoId, @produtoNome, @planoId, @planoNome,
        @precoCentavos, @quantidade, @subtotalCentavos
      )
    `)
    .run(item);
  return item.id;
}

function buscarPorId(id) {
  if (!id) return null;
  return mapearVenda(obter().prepare('SELECT * FROM vendas WHERE id = ?').get(id));
}

function buscarPorNumero(numero) {
  if (!numero) return null;
  return mapearVenda(obter().prepare('SELECT * FROM vendas WHERE numero = ?').get(String(numero).toUpperCase()));
}

/** Pedido completo: cabecalho + itens. */
function buscarCompleto(id) {
  const venda = buscarPorId(id);
  if (!venda) return null;
  return { ...venda, itens: listarItens(id) };
}

function listarItens(vendaId) {
  return obter()
    .prepare('SELECT * FROM venda_itens WHERE venda_id = ? ORDER BY rowid ASC')
    .all(vendaId)
    .map(mapearItem);
}

/** Pedidos de um cliente, do mais recente para o mais antigo. */
function listarDoUsuario(usuarioId, { limite = 50, deslocamento = 0 } = {}) {
  const vendas = obter()
    .prepare('SELECT * FROM vendas WHERE usuario_id = @usuarioId ORDER BY criado_em DESC LIMIT @limite OFFSET @deslocamento')
    .all({ usuarioId, limite, deslocamento })
    .map(mapearVenda);

  if (!vendas.length) return [];

  const ids = vendas.map(venda => venda.id);
  const marcadores = ids.map(() => '?').join(', ');
  const itens = obter()
    .prepare(`SELECT * FROM venda_itens WHERE venda_id IN (${marcadores}) ORDER BY rowid ASC`)
    .all(...ids)
    .map(mapearItem);

  const porVenda = new Map();
  itens.forEach(item => {
    if (!porVenda.has(item.vendaId)) porVenda.set(item.vendaId, []);
    porVenda.get(item.vendaId).push(item);
  });

  return vendas.map(venda => ({ ...venda, itens: porVenda.get(venda.id) || [] }));
}

function contarDoUsuario(usuarioId) {
  const linha = obter().prepare('SELECT COUNT(*) AS total FROM vendas WHERE usuario_id = ?').get(usuarioId);
  return linha ? linha.total : 0;
}

/** Soma dos pedidos pagos de um cliente (usado no perfil). */
function totalGastoDoUsuario(usuarioId) {
  const linha = obter()
    .prepare("SELECT COALESCE(SUM(total_centavos), 0) AS total FROM vendas WHERE usuario_id = ? AND status = 'pago'")
    .get(usuarioId);
  return linha ? linha.total : 0;
}

/* -------------------------------------------------------------------------- */
/* Administracao                                                              */
/* -------------------------------------------------------------------------- */

function listarTodos({ status = null, limite = 50, deslocamento = 0 } = {}) {
  const filtro = status ? 'WHERE v.status = @status' : '';
  return obter()
    .prepare(`
      SELECT v.*, u.nome AS cliente_nome, u.email AS cliente_email
      FROM vendas v
      JOIN usuarios u ON u.id = v.usuario_id
      ${filtro}
      ORDER BY v.criado_em DESC
      LIMIT @limite OFFSET @deslocamento
    `)
    .all({ status, limite, deslocamento })
    .map(linha => ({ ...mapearVenda(linha), clienteNome: linha.cliente_nome, clienteEmail: linha.cliente_email }));
}

function contarTodos({ status = null } = {}) {
  const filtro = status ? 'WHERE status = @status' : '';
  const linha = obter().prepare(`SELECT COUNT(*) AS total FROM vendas ${filtro}`).get({ status });
  return linha ? linha.total : 0;
}

function atualizarStatus(id, status) {
  const info = obter()
    .prepare('UPDATE vendas SET status = ?, atualizado_em = ? WHERE id = ?')
    .run(status, new Date().toISOString(), id);
  return info.changes > 0;
}

/** Totais gerais da loja (receita, pedidos, ticket medio). */
function resumoFinanceiro() {
  const linha = obter()
    .prepare(`
      SELECT
        COUNT(*)                                        AS pedidos,
        COALESCE(SUM(total_centavos), 0)                AS receita,
        COALESCE(SUM(desconto_centavos), 0)             AS descontos
      FROM vendas
      WHERE status = 'pago'
    `)
    .get();

  const pedidos = linha ? linha.pedidos : 0;
  const receita = linha ? linha.receita : 0;

  return {
    pedidos,
    receitaCentavos: receita,
    descontosCentavos: linha ? linha.descontos : 0,
    ticketMedioCentavos: pedidos > 0 ? Math.round(receita / pedidos) : 0
  };
}

/** Receita por dia nos ultimos N dias (para o grafico do painel). */
function receitaPorDia(dias = 30) {
  const desde = new Date(Date.now() - dias * 24 * 60 * 60 * 1000).toISOString();
  return obter()
    .prepare(`
      SELECT substr(criado_em, 1, 10) AS dia,
             COUNT(*)                 AS pedidos,
             COALESCE(SUM(total_centavos), 0) AS receita
      FROM vendas
      WHERE status = 'pago' AND criado_em >= @desde
      GROUP BY dia
      ORDER BY dia ASC
    `)
    .all({ desde })
    .map(linha => ({ dia: linha.dia, pedidos: linha.pedidos, receitaCentavos: linha.receita }));
}

/** Produtos mais vendidos por unidades. */
function produtosMaisVendidos(limite = 5) {
  return obter()
    .prepare(`
      SELECT i.produto_id                              AS produtoId,
             i.produto_nome                            AS nome,
             SUM(i.quantidade)                         AS unidades,
             COALESCE(SUM(i.subtotal_centavos), 0)     AS receita
      FROM venda_itens i
      JOIN vendas v ON v.id = i.venda_id
      WHERE v.status = 'pago'
      GROUP BY i.produto_id, i.produto_nome
      ORDER BY unidades DESC
      LIMIT @limite
    `)
    .all({ limite })
    .map(linha => ({ produtoId: linha.produtoId, nome: linha.nome, unidades: linha.unidades, receitaCentavos: linha.receita }));
}

/* -------------------------------------------------------------------------- */
/* Relatorios (recortes por periodo)                                          */
/* -------------------------------------------------------------------------- */

/*
 * Todas as consultas abaixo recebem uma janela [desde, ate) em ISO. Como
 * "criado_em" e gravado em ISO/UTC, a comparacao de texto funciona como
 * comparacao de data — e o indice em criado_em e usado normalmente.
 */

/** Resumo financeiro de um periodo (somente pedidos pagos). */
function resumoNoPeriodo(desde, ate) {
  const linha = obter()
    .prepare(`
      SELECT
        COUNT(*)                          AS pedidos,
        COALESCE(SUM(total_centavos), 0)  AS receita,
        COALESCE(SUM(desconto_centavos), 0) AS descontos,
        COUNT(DISTINCT usuario_id)        AS clientes
      FROM vendas
      WHERE status = 'pago' AND criado_em >= @desde AND criado_em < @ate
    `)
    .get({ desde, ate });

  const pedidos = linha ? linha.pedidos : 0;
  const receita = linha ? linha.receita : 0;

  return {
    pedidos,
    receitaCentavos: receita,
    descontosCentavos: linha ? linha.descontos : 0,
    clientes: linha ? linha.clientes : 0,
    ticketMedioCentavos: pedidos > 0 ? Math.round(receita / pedidos) : 0
  };
}

/** Quantos pedidos de cada status existem no periodo (inclui nao pagos). */
function contagemPorStatusNoPeriodo(desde, ate) {
  return obter()
    .prepare(`
      SELECT status, COUNT(*) AS total
      FROM vendas
      WHERE criado_em >= @desde AND criado_em < @ate
      GROUP BY status
    `)
    .all({ desde, ate })
    .reduce((acumulado, linha) => ({ ...acumulado, [linha.status]: linha.total }), {});
}

/** Receita e pedidos por dia no periodo (apenas pagos). */
function receitaPorDiaNoPeriodo(desde, ate) {
  return obter()
    .prepare(`
      SELECT substr(criado_em, 1, 10) AS dia,
             COUNT(*)                 AS pedidos,
             COALESCE(SUM(total_centavos), 0) AS receita
      FROM vendas
      WHERE status = 'pago' AND criado_em >= @desde AND criado_em < @ate
      GROUP BY dia
      ORDER BY dia ASC
    `)
    .all({ desde, ate })
    .map(linha => ({ dia: linha.dia, pedidos: linha.pedidos, receitaCentavos: linha.receita }));
}

/** Produtos mais vendidos no periodo, ordenados por receita. */
function topProdutosNoPeriodo(desde, ate, limite = 10) {
  return obter()
    .prepare(`
      SELECT i.produto_id                          AS produtoId,
             i.produto_nome                        AS nome,
             SUM(i.quantidade)                     AS unidades,
             COALESCE(SUM(i.subtotal_centavos), 0) AS receita
      FROM venda_itens i
      JOIN vendas v ON v.id = i.venda_id
      WHERE v.status = 'pago' AND v.criado_em >= @desde AND v.criado_em < @ate
      GROUP BY i.produto_id, i.produto_nome
      ORDER BY receita DESC
      LIMIT @limite
    `)
    .all({ desde, ate, limite })
    .map(linha => ({
      produtoId: linha.produtoId,
      nome: linha.nome,
      unidades: linha.unidades,
      receitaCentavos: linha.receita
    }));
}

/** Vendas por metodo de pagamento no periodo. */
function porMetodoNoPeriodo(desde, ate) {
  return obter()
    .prepare(`
      SELECT metodo_pagamento AS metodo,
             COUNT(*)         AS pedidos,
             COALESCE(SUM(total_centavos), 0) AS receita
      FROM vendas
      WHERE status = 'pago' AND criado_em >= @desde AND criado_em < @ate
      GROUP BY metodo_pagamento
      ORDER BY receita DESC
    `)
    .all({ desde, ate })
    .map(linha => ({ metodo: linha.metodo, pedidos: linha.pedidos, receitaCentavos: linha.receita }));
}

/** Vendas por categoria de produto no periodo. */
function porCategoriaNoPeriodo(desde, ate) {
  return obter()
    .prepare(`
      SELECT p.categoria                            AS categoria,
             SUM(i.quantidade)                      AS unidades,
             COALESCE(SUM(i.subtotal_centavos), 0)  AS receita
      FROM venda_itens i
      JOIN vendas v ON v.id = i.venda_id
      JOIN produtos p ON p.id = i.produto_id
      WHERE v.status = 'pago' AND v.criado_em >= @desde AND v.criado_em < @ate
      GROUP BY p.categoria
      ORDER BY receita DESC
    `)
    .all({ desde, ate })
    .map(linha => ({ categoria: linha.categoria, unidades: linha.unidades, receitaCentavos: linha.receita }));
}

/** Total de unidades vendidas no periodo. */
function unidadesNoPeriodo(desde, ate) {
  const linha = obter()
    .prepare(`
      SELECT COALESCE(SUM(i.quantidade), 0) AS unidades
      FROM venda_itens i
      JOIN vendas v ON v.id = i.venda_id
      WHERE v.status = 'pago' AND v.criado_em >= @desde AND v.criado_em < @ate
    `)
    .get({ desde, ate });
  return linha ? linha.unidades : 0;
}

/** Desempenho dos cupons no periodo. */
function cuponsNoPeriodo(desde, ate) {
  return obter()
    .prepare(`
      SELECT cupom_codigo AS codigo,
             COUNT(*)     AS pedidos,
             COALESCE(SUM(desconto_centavos), 0) AS desconto
      FROM vendas
      WHERE status = 'pago' AND cupom_codigo IS NOT NULL
        AND criado_em >= @desde AND criado_em < @ate
      GROUP BY cupom_codigo
      ORDER BY desconto DESC
    `)
    .all({ desde, ate })
    .map(linha => ({ codigo: linha.codigo, pedidos: linha.pedidos, descontoCentavos: linha.desconto }));
}

/* -------------------------------------------------------------------------- */
/* Financeiro (o dinheiro, nao o desempenho)                                  */
/* -------------------------------------------------------------------------- */

/*
 * Diferente das consultas de relatorio, que olham so os pedidos PAGOS, as daqui
 * olham TODOS os status — e o que permite responder "quanto ainda esta a
 * receber" e "quanto foi devolvido". O recorte e sempre [desde, ate) por
 * criado_em, igual ao resto.
 */

/** Totais por status no periodo, com valor (nao so contagem). */
function totaisPorStatusNoPeriodo(desde, ate) {
  return obter()
    .prepare(`
      SELECT status,
             COUNT(*)                            AS pedidos,
             COALESCE(SUM(total_centavos), 0)    AS total,
             COALESCE(SUM(desconto_centavos), 0) AS descontos
      FROM vendas
      WHERE criado_em >= @desde AND criado_em < @ate
      GROUP BY status
    `)
    .all({ desde, ate })
    .reduce((acumulado, linha) => {
      acumulado[linha.status] = {
        pedidos: linha.pedidos,
        totalCentavos: linha.total,
        descontosCentavos: linha.descontos
      };
      return acumulado;
    }, {});
}

/** Receita por provedor de pagamento no periodo (somente pagos). */
function porProvedorNoPeriodo(desde, ate) {
  return obter()
    .prepare(`
      SELECT provedor_pagamento                  AS provedor,
             COUNT(*)                            AS pedidos,
             COALESCE(SUM(total_centavos), 0)    AS receita
      FROM vendas
      WHERE status = 'pago' AND criado_em >= @desde AND criado_em < @ate
      GROUP BY provedor_pagamento
      ORDER BY receita DESC
    `)
    .all({ desde, ate })
    .map(linha => ({ provedor: linha.provedor, pedidos: linha.pedidos, receitaCentavos: linha.receita }));
}

/**
 * Extrato de pagamentos do periodo, do mais recente para o mais antigo.
 * Ordena por pago_em quando existe (pix/cartao) e cai para criado_em quando
 * ainda nao ha pagamento (boleto pendente) — assim o extrato fica em ordem
 * cronologica de dinheiro, nao de cadastro.
 */
function listarPagamentosNoPeriodo({ desde, ate, status = null, limite = 25, deslocamento = 0 }) {
  const filtro = status ? 'AND v.status = @status' : '';

  const itens = obter()
    .prepare(`
      SELECT v.*, u.nome AS cliente_nome, u.email AS cliente_email
      FROM vendas v
      JOIN usuarios u ON u.id = v.usuario_id
      WHERE v.criado_em >= @desde AND v.criado_em < @ate ${filtro}
      ORDER BY COALESCE(v.pago_em, v.criado_em) DESC
      LIMIT @limite OFFSET @deslocamento
    `)
    .all({ desde, ate, status, limite, deslocamento })
    .map(linha => ({ ...mapearVenda(linha), clienteNome: linha.cliente_nome, clienteEmail: linha.cliente_email }));

  const contagem = obter()
    .prepare(`SELECT COUNT(*) AS total FROM vendas v WHERE v.criado_em >= @desde AND v.criado_em < @ate ${filtro}`)
    .get({ desde, ate, status });

  return { itens, total: contagem ? contagem.total : 0 };
}

module.exports = {
  mapearVenda,
  mapearItem,
  inserirVenda,
  inserirItem,
  definirInstrucoesPagamento,
  buscarPorId,
  buscarPorNumero,
  buscarCompleto,
  listarItens,
  listarDoUsuario,
  contarDoUsuario,
  totalGastoDoUsuario,
  listarTodos,
  contarTodos,
  atualizarStatus,
  resumoFinanceiro,
  receitaPorDia,
  produtosMaisVendidos,
  resumoNoPeriodo,
  contagemPorStatusNoPeriodo,
  receitaPorDiaNoPeriodo,
  topProdutosNoPeriodo,
  porMetodoNoPeriodo,
  porCategoriaNoPeriodo,
  unidadesNoPeriodo,
  cuponsNoPeriodo,
  totaisPorStatusNoPeriodo,
  porProvedorNoPeriodo,
  listarPagamentosNoPeriodo
};
