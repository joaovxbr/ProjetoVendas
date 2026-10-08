/*
 * repositories/estoque.repo.js
 * -----------------------------------------------------------------------------
 * O pool de chaves de licenca (estoque_chaves) e o seu livro-caixa
 * (estoque_movimentos). Nada aqui decide regra de negocio: o repositorio so
 * le/escreve linhas. Quem valida "tem estoque?" e o servico.
 *
 * Conceitos:
 *   disponivel  -> esta no pool, pode ser vendida
 *   vendida     -> saiu numa compra e foi entregue ao cliente
 *   descartada  -> removida do pool pelo admin (chave ruim, lote vencido...)
 *   revogada    -> pertencia a um pedido estornado; nao volta para venda
 *
 * As chaves sao consumidas em FIFO (as mais antigas primeiro). Isso e o que a
 * maioria das lojas de chave faz: usa o lote mais velho para nao deixar chave
 * encalhada no estoque.
 */
'use strict';

const { obter } = require('../db/conexao');
const { agoraISO } = require('../utils/datas');

/* -------------------------------------------------------------------------- */
/* Mapeamento                                                                 */
/* -------------------------------------------------------------------------- */

function mapear(linha) {
  if (!linha) return null;
  return {
    id: linha.id,
    produtoId: linha.produto_id,
    planoId: linha.plano_id,
    chave: linha.chave,
    status: linha.status,
    vendaId: linha.venda_id,
    vendaItemId: linha.venda_item_id,
    lote: linha.lote || '',
    criadaEm: linha.criada_em,
    vendidaEm: linha.vendida_em
  };
}

function mapearMovimento(linha) {
  if (!linha) return null;
  return {
    id: linha.id,
    produtoId: linha.produto_id,
    planoId: linha.plano_id,
    tipo: linha.tipo,
    quantidade: linha.quantidade,
    motivo: linha.motivo || '',
    atorId: linha.ator_id,
    criadoEm: linha.criado_em,
    // Campos de conveniencia preenchidos pelos JOINs (podem vir undefined).
    atorNome: linha.ator_nome || null,
    atorEmail: linha.ator_email || null,
    produtoNome: linha.produto_nome || null,
    planoNome: linha.plano_nome || null
  };
}

/* -------------------------------------------------------------------------- */
/* Escrita: entradas                                                          */
/* -------------------------------------------------------------------------- */

/** Insere uma chave. Devolve false se a chave ja existir (UNIQUE). */
function inserir(chave) {
  try {
    obter()
      .prepare(`
        INSERT INTO estoque_chaves (
          id, produto_id, plano_id, chave, status, venda_id, venda_item_id,
          lote, criada_em, vendida_em
        ) VALUES (
          @id, @produtoId, @planoId, @chave, 'disponivel', NULL, NULL,
          @lote, @criadaEm, NULL
        )
      `)
      .run({
        id: chave.id,
        produtoId: chave.produtoId,
        planoId: chave.planoId,
        chave: chave.chave,
        lote: chave.lote || '',
        criadaEm: chave.criadaEm || agoraISO()
      });
    return true;
  } catch (erro) {
    // UNIQUE(chave): chave repetida nao e erro fatal, so nao entra de novo.
    if (erro && /UNIQUE/i.test(erro.message || '')) return false;
    throw erro;
  }
}

/**
 * Insere varias chaves numa unica transacao. Chaves duplicadas sao ignoradas.
 * @returns {{ inseridas: number, duplicadas: number }}
 */
function inserirVarias(chaves) {
  const db = obter();
  let inseridas = 0;
  let duplicadas = 0;

  db.transaction(() => {
    chaves.forEach(chave => {
      if (inserir(chave)) inseridas += 1;
      else duplicadas += 1;
    });
  })();

  return { inseridas, duplicadas };
}

/** Uma chave (texto) ja existe no pool, em qualquer status? */
function existeChave(chave) {
  const linha = obter()
    .prepare('SELECT 1 AS achou FROM estoque_chaves WHERE chave = ? LIMIT 1')
    .get(String(chave));
  return Boolean(linha);
}

/* -------------------------------------------------------------------------- */
/* Escrita: saidas                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Consome N chaves disponiveis de um plano (FIFO) e as marca como vendidas.
 * DEVE ser chamado dentro de uma transacao ja aberta pelo checkout.
 * @returns {string[]|null} as chaves consumidas, ou null se nao houver saldo
 */
function consumir(produtoId, planoId, quantidade, { vendaId, vendaItemId }) {
  const db = obter();

  const linhas = db
    .prepare(`
      SELECT id, chave FROM estoque_chaves
      WHERE produto_id = @produtoId AND plano_id = @planoId AND status = 'disponivel'
      ORDER BY criada_em ASC, rowid ASC
      LIMIT @quantidade
    `)
    .all({ produtoId, planoId, quantidade });

  if (linhas.length < quantidade) return null;

  const marcar = db.prepare(`
    UPDATE estoque_chaves
    SET status = 'vendida', venda_id = @vendaId, venda_item_id = @vendaItemId, vendida_em = @vendidaEm
    WHERE id = @id AND status = 'disponivel'
  `);
  const vendidaEm = agoraISO();
  let afetadas = 0;

  for (const linha of linhas) {
    afetadas += marcar.run({ id: linha.id, vendaId, vendaItemId, vendidaEm }).changes;
  }

  // Se outra requisicao pegou a mesma chave no meio do caminho, abortamos.
  if (afetadas !== quantidade) return null;

  return linhas.map(linha => linha.chave);
}

/**
 * Descarta N chaves disponiveis de um plano (FIFO). Usado na reducao manual de
 * quantidade e no descarte de lote.
 * @returns {number} quantas chaves foram descartadas
 */
function descartarDisponiveis(produtoId, planoId, quantidade) {
  const db = obter();

  const linhas = db
    .prepare(`
      SELECT id FROM estoque_chaves
      WHERE produto_id = @produtoId AND plano_id = @planoId AND status = 'disponivel'
      ORDER BY criada_em ASC, rowid ASC
      LIMIT @quantidade
    `)
    .all({ produtoId, planoId, quantidade });

  if (!linhas.length) return 0;

  const marcar = db.prepare("UPDATE estoque_chaves SET status = 'descartada' WHERE id = ? AND status = 'disponivel'");
  let afetadas = 0;
  for (const linha of linhas) afetadas += marcar.run(linha.id).changes;
  return afetadas;
}

/** Marca chaves especificas como descartadas (por id). */
function descartarPorIds(ids) {
  if (!ids || !ids.length) return 0;
  const marcar = obter().prepare("UPDATE estoque_chaves SET status = 'descartada' WHERE id = ? AND status = 'disponivel'");
  let afetadas = 0;
  ids.forEach(id => {
    afetadas += marcar.run(id).changes;
  });
  return afetadas;
}

/**
 * Busca chaves especificas (por id). Ids inexistentes simplesmente nao voltam.
 * Usado para conferir a quem as chaves pertencem antes de mexer nelas.
 */
function buscarPorIds(ids) {
  if (!ids || !ids.length) return [];
  const buscar = obter().prepare('SELECT * FROM estoque_chaves WHERE id = ?');
  return ids.map(id => buscar.get(id)).filter(Boolean).map(mapear);
}

/**
 * Apaga de vez chaves especificas. So aceita chaves que nunca foram entregues
 * (disponivel/descartada): vendidas e revogadas sao historico de pedido.
 * @returns {{ disponiveis: number, descartadas: number }} quantas sairam de cada status
 */
function excluirPorIds(ids) {
  const resultado = { disponiveis: 0, descartadas: 0 };
  if (!ids || !ids.length) return resultado;
  const apagar = obter().prepare('DELETE FROM estoque_chaves WHERE id = ? AND status = ?');
  ids.forEach(id => {
    resultado.disponiveis += apagar.run(id, 'disponivel').changes;
    resultado.descartadas += apagar.run(id, 'descartada').changes;
  });
  return resultado;
}

/**
 * Descarta TODAS as chaves disponiveis de um plano. Usado quando o plano some
 * do catalogo: sem plano, aquelas chaves nunca mais seriam vendidas, entao
 * deixar no pool so inflaria a contagem.
 */
function descartarPlano(produtoId, planoId) {
  return obter()
    .prepare("UPDATE estoque_chaves SET status = 'descartada' WHERE produto_id = ? AND plano_id = ? AND status = 'disponivel'")
    .run(produtoId, planoId).changes;
}

/** Marca como revogadas as chaves de um pedido estornado. */
function revogarDaVenda(vendaId) {
  return obter()
    .prepare("UPDATE estoque_chaves SET status = 'revogada' WHERE venda_id = ? AND status = 'vendida'")
    .run(vendaId).changes;
}

/* -------------------------------------------------------------------------- */
/* Escrita: livro-caixa                                                       */
/* -------------------------------------------------------------------------- */

function registrarMovimento(movimento) {
  obter()
    .prepare(`
      INSERT INTO estoque_movimentos (produto_id, plano_id, tipo, quantidade, motivo, ator_id, criado_em)
      VALUES (@produtoId, @planoId, @tipo, @quantidade, @motivo, @atorId, @criadoEm)
    `)
    .run({
      produtoId: movimento.produtoId,
      planoId: movimento.planoId,
      tipo: movimento.tipo,
      quantidade: movimento.quantidade,
      motivo: movimento.motivo || '',
      atorId: movimento.atorId || null,
      criadoEm: movimento.criadoEm || agoraISO()
    });
}

/* -------------------------------------------------------------------------- */
/* Consultas                                                                  */
/* -------------------------------------------------------------------------- */

/** Quantas chaves disponiveis este plano tem agora. */
function contarDisponiveis(produtoId, planoId) {
  const linha = obter()
    .prepare(`
      SELECT COUNT(*) AS total FROM estoque_chaves
      WHERE produto_id = ? AND plano_id = ? AND status = 'disponivel'
    `)
    .get(produtoId, planoId);
  return linha ? linha.total : 0;
}

/** Mapa "planoId" -> disponiveis, para todos os planos de UM produto. */
function disponiveisPorProduto(produtoId) {
  const linhas = obter()
    .prepare(`
      SELECT plano_id, COUNT(*) AS total FROM estoque_chaves
      WHERE produto_id = ? AND status = 'disponivel'
      GROUP BY plano_id
    `)
    .all(produtoId);
  return new Map(linhas.map(linha => [linha.plano_id, linha.total]));
}

/**
 * Mapa "produtoId|planoId" -> disponiveis, para VARIOS produtos numa consulta
 * so. E o que a vitrine usa para marcar "esgotado" sem fazer N consultas.
 */
function disponiveisDeProdutos(produtoIds) {
  const mapa = new Map();
  if (!produtoIds || !produtoIds.length) return mapa;

  const marcadores = produtoIds.map(() => '?').join(', ');
  obter()
    .prepare(`
      SELECT produto_id, plano_id, COUNT(*) AS total
      FROM estoque_chaves
      WHERE status = 'disponivel' AND produto_id IN (${marcadores})
      GROUP BY produto_id, plano_id
    `)
    .all(...produtoIds)
    .forEach(linha => mapa.set(`${linha.produto_id}|${linha.plano_id}`, linha.total));

  return mapa;
}

/** Contagem por status, opcionalmente de um plano so. */
function contarPorStatus({ produtoId = null, planoId = null } = {}) {
  const condicoes = [];
  const parametros = {};
  if (produtoId) {
    condicoes.push('produto_id = @produtoId');
    parametros.produtoId = produtoId;
  }
  if (planoId) {
    condicoes.push('plano_id = @planoId');
    parametros.planoId = planoId;
  }
  const where = condicoes.length ? `WHERE ${condicoes.join(' AND ')}` : '';

  return obter()
    .prepare(`SELECT status, COUNT(*) AS total FROM estoque_chaves ${where} GROUP BY status`)
    .all(parametros)
    .reduce((acumulado, linha) => ({ ...acumulado, [linha.status]: linha.total }), {});
}

/**
 * Resumo de estoque por plano (a consulta que alimenta a tela de Estoque).
 * Parte de "planos" com LEFT JOIN no pool, entao planos SEM nenhuma chave
 * aparecem com disponivel = 0 — e e justamente esse o alerta que interessa.
 */
function resumoPorPlano({ incluirInativos = true } = {}) {
  const filtro = incluirInativos ? '' : 'WHERE pl.ativo = 1';
  return obter()
    .prepare(`
      SELECT
        p.id              AS produto_id,
        p.nome            AS produto_nome,
        p.slug            AS produto_slug,
        p.categoria       AS produto_categoria,
        pl.id             AS plano_id,
        pl.nome           AS plano_nome,
        pl.preco_centavos AS preco_centavos,
        pl.dias           AS dias,
        pl.ativo          AS plano_ativo,
        pl.estoque_minimo AS estoque_minimo,
        COALESCE(e.disponivel, 0) AS disponivel,
        COALESCE(e.vendida, 0)    AS vendida,
        COALESCE(e.descartada, 0) AS descartada,
        COALESCE(e.revogada, 0)   AS revogada
      FROM planos pl
      JOIN produtos p ON p.id = pl.produto_id
      LEFT JOIN (
        SELECT produto_id, plano_id,
               SUM(CASE WHEN status = 'disponivel' THEN 1 ELSE 0 END) AS disponivel,
               SUM(CASE WHEN status = 'vendida'    THEN 1 ELSE 0 END) AS vendida,
               SUM(CASE WHEN status = 'descartada' THEN 1 ELSE 0 END) AS descartada,
               SUM(CASE WHEN status = 'revogada'   THEN 1 ELSE 0 END) AS revogada
        FROM estoque_chaves
        GROUP BY produto_id, plano_id
      ) e ON e.produto_id = pl.produto_id AND e.plano_id = pl.id
      ${filtro}
      ORDER BY p.ordem ASC, p.nome ASC, pl.ordem ASC, pl.preco_centavos ASC
    `)
    .all()
    .map(linha => ({
      produtoId: linha.produto_id,
      produtoNome: linha.produto_nome,
      produtoSlug: linha.produto_slug,
      produtoCategoria: linha.produto_categoria,
      planoId: linha.plano_id,
      planoNome: linha.plano_nome,
      precoCentavos: linha.preco_centavos,
      dias: linha.dias,
      planoAtivo: linha.plano_ativo === 1,
      estoqueMinimo: linha.estoque_minimo,
      disponivel: linha.disponivel,
      vendida: linha.vendida,
      descartada: linha.descartada,
      revogada: linha.revogada,
      total: linha.disponivel + linha.vendida + linha.descartada + linha.revogada
    }));
}

/** Chaves que foram entregues numa venda especifica. */
function listarDaVenda(vendaId) {
  if (!vendaId) return [];
  return obter()
    .prepare('SELECT * FROM estoque_chaves WHERE venda_id = ? ORDER BY rowid ASC')
    .all(vendaId)
    .map(mapear);
}

/** Lista chaves com filtros (tela de Estoque -> detalhe do plano). */
function listarChaves({ produtoId = null, planoId = null, status = null, busca = null, limite = 100, deslocamento = 0 } = {}) {
  const condicoes = [];
  const parametros = { limite, deslocamento };

  if (produtoId) {
    condicoes.push('c.produto_id = @produtoId');
    parametros.produtoId = produtoId;
  }
  if (planoId) {
    condicoes.push('c.plano_id = @planoId');
    parametros.planoId = planoId;
  }
  if (status) {
    condicoes.push('c.status = @status');
    parametros.status = status;
  }
  if (busca && String(busca).trim()) {
    condicoes.push('c.chave LIKE @busca');
    parametros.busca = `%${String(busca).trim().toUpperCase()}%`;
  }

  const where = condicoes.length ? `WHERE ${condicoes.join(' AND ')}` : '';

  return obter()
    .prepare(`
      SELECT c.*, p.nome AS produto_nome, pl.nome AS plano_nome, v.numero AS venda_numero
      FROM estoque_chaves c
      JOIN produtos p ON p.id = c.produto_id
      LEFT JOIN planos pl ON pl.produto_id = c.produto_id AND pl.id = c.plano_id
      LEFT JOIN vendas v ON v.id = c.venda_id
      ${where}
      ORDER BY c.criada_em DESC, c.rowid DESC
      LIMIT @limite OFFSET @deslocamento
    `)
    .all(parametros)
    .map(linha => ({
      ...mapear(linha),
      produtoNome: linha.produto_nome,
      planoNome: linha.plano_nome,
      vendaNumero: linha.venda_numero
    }));
}

function contarChaves({ produtoId = null, planoId = null, status = null, busca = null } = {}) {
  const condicoes = [];
  const parametros = {};

  if (produtoId) {
    condicoes.push('produto_id = @produtoId');
    parametros.produtoId = produtoId;
  }
  if (planoId) {
    condicoes.push('plano_id = @planoId');
    parametros.planoId = planoId;
  }
  if (status) {
    condicoes.push('status = @status');
    parametros.status = status;
  }
  if (busca && String(busca).trim()) {
    condicoes.push('chave LIKE @busca');
    parametros.busca = `%${String(busca).trim().toUpperCase()}%`;
  }

  const where = condicoes.length ? `WHERE ${condicoes.join(' AND ')}` : '';
  const linha = obter().prepare(`SELECT COUNT(*) AS total FROM estoque_chaves ${where}`).get(parametros);
  return linha ? linha.total : 0;
}

/** Historico de movimentos (tela de Estoque -> movimentacoes). */
function listarMovimentos({ produtoId = null, planoId = null, tipo = null, limite = 100, deslocamento = 0 } = {}) {
  const condicoes = [];
  const parametros = { limite, deslocamento };

  if (produtoId) {
    condicoes.push('m.produto_id = @produtoId');
    parametros.produtoId = produtoId;
  }
  if (planoId) {
    condicoes.push('m.plano_id = @planoId');
    parametros.planoId = planoId;
  }
  if (tipo) {
    condicoes.push('m.tipo = @tipo');
    parametros.tipo = tipo;
  }

  const where = condicoes.length ? `WHERE ${condicoes.join(' AND ')}` : '';

  return obter()
    .prepare(`
      SELECT m.*, u.nome AS ator_nome, u.email AS ator_email, p.nome AS produto_nome, pl.nome AS plano_nome
      FROM estoque_movimentos m
      LEFT JOIN usuarios u ON u.id = m.ator_id
      JOIN produtos p ON p.id = m.produto_id
      LEFT JOIN planos pl ON pl.produto_id = m.produto_id AND pl.id = m.plano_id
      ${where}
      ORDER BY m.criado_em DESC, m.id DESC
      LIMIT @limite OFFSET @deslocamento
    `)
    .all(parametros)
    .map(mapearMovimento);
}

/** Totais gerais do estoque (cartoes do topo da tela). */
function totais() {
  const contagens = contarPorStatus();
  return {
    disponivel: contagens.disponivel || 0,
    vendida: contagens.vendida || 0,
    descartada: contagens.descartada || 0,
    revogada: contagens.revogada || 0,
    total: (contagens.disponivel || 0) + (contagens.vendida || 0) + (contagens.descartada || 0) + (contagens.revogada || 0)
  };
}

module.exports = {
  mapear,
  mapearMovimento,
  inserir,
  inserirVarias,
  existeChave,
  consumir,
  descartarDisponiveis,
  descartarPorIds,
  buscarPorIds,
  excluirPorIds,
  descartarPlano,
  revogarDaVenda,
  registrarMovimento,
  contarDisponiveis,
  disponiveisPorProduto,
  disponiveisDeProdutos,
  contarPorStatus,
  resumoPorPlano,
  listarDaVenda,
  listarChaves,
  contarChaves,
  listarMovimentos,
  totais
};
