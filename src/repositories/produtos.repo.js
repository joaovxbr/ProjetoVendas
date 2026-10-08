/*
 * repositories/produtos.repo.js
 * -----------------------------------------------------------------------------
 * Catalogo: produtos + planos + agregados de avaliacao.
 *
 * Duas decisoes que valem explicacao:
 *
 * 1. Produtos sem plano ativo nao aparecem na listagem (INNER JOIN em "planos").
 *    Isso evita mostrar um card que nao pode ser comprado.
 *
 * 2. A nota exibida combina duas fontes: a media historica semeada
 *    (nota_base/total_base) e as avaliacoes reais gravadas na tabela
 *    "avaliacoes". Somar as duas permite lancar a loja com prova social sem
 *    inventar avaliacoes falsas no banco.
 */
'use strict';

const { obter } = require('../db/conexao');
const { agoraISO } = require('../utils/datas');
const { normalizarTexto } = require('../utils/validacao');

/* -------------------------------------------------------------------------- */
/* Mapeamento                                                                 */
/* -------------------------------------------------------------------------- */

function mapearProduto(linha) {
  if (!linha) return null;
  return {
    id: linha.id,
    slug: linha.slug,
    nome: linha.nome,
    linha: linha.linha,
    nivel: linha.nivel,
    categoria: linha.categoria,
    descricao: linha.descricao,
    descricaoLonga: linha.descricao_longa,
    recursos: JSON.parse(linha.recursos || '[]'),
    capa: JSON.parse(linha.capa || '{}'),
    imagem: linha.imagem,
    badge: linha.badge,
    plataforma: linha.plataforma,
    entrega: linha.entrega,
    destaque: linha.destaque === 1,
    ativo: linha.ativo === 1,
    ordem: linha.ordem,
    notaBase: Number(linha.nota_base) || 0,
    totalBase: Number(linha.total_base) || 0,
    criadoEm: linha.criado_em,
    atualizadoEm: linha.atualizado_em
  };
}

function mapearPlano(linha) {
  if (!linha) return null;
  return {
    id: linha.id,
    nome: linha.nome,
    precoCentavos: linha.preco_centavos,
    dias: linha.dias,
    ordem: linha.ordem,
    ativo: linha.ativo === 1,
    // Ponto de reposicao usado pelo alerta de estoque baixo (0 = sem alerta).
    estoqueMinimo: linha.estoque_minimo ?? 0
  };
}

// Texto usado na busca: tudo que o cliente pode digitar para achar o produto.
function montarBusca(produto) {
  return normalizarTexto([
    produto.nome,
    produto.linha,
    produto.nivel,
    produto.categoria,
    produto.descricao,
    produto.descricaoLonga,
    ...(produto.recursos || [])
  ].join(' '));
}

/* -------------------------------------------------------------------------- */
/* Consultas                                                                  */
/* -------------------------------------------------------------------------- */

/*
 * Junta preco minimo/maximo e a soma das avaliacoes reais.
 *
 * O LEFT JOIN em "pr" e proposital: um produto recem-criado ainda nao tem
 * planos e precisa continuar sendo encontravel por id (o admin cadastra o
 * produto e so depois os planos). Quem esconde produto sem plano e a listagem
 * publica, nao a consulta por id.
 */
const SELECT_BASE = `
  SELECT p.*,
         pr.preco_min,
         pr.preco_max,
         COALESCE(a.total, 0) AS avaliacoes_reais,
         COALESCE(a.soma, 0)  AS notas_reais
  FROM produtos p
  LEFT JOIN (
    SELECT produto_id,
           MIN(preco_centavos) AS preco_min,
           MAX(preco_centavos) AS preco_max
    FROM planos
    WHERE ativo = 1
    GROUP BY produto_id
  ) pr ON pr.produto_id = p.id
  LEFT JOIN (
    SELECT produto_id, COUNT(*) AS total, SUM(nota) AS soma
    FROM avaliacoes
    GROUP BY produto_id
  ) a ON a.produto_id = p.id
`;

// Nota media considerando base historica + avaliacoes reais.
const NOTA_EFETIVA = `
  CASE WHEN (p.total_base + COALESCE(a.total, 0)) = 0 THEN 0
       ELSE (p.nota_base * p.total_base + COALESCE(a.soma, 0)) * 1.0
            / (p.total_base + COALESCE(a.total, 0))
  END
`;

const TOTAL_EFETIVO = '(p.total_base + COALESCE(a.total, 0))';

// Whitelist de ordenacoes: a chave vem do cliente, o SQL vem daqui.
//
// `recentes` desempata por `ordem DESC` porque dois produtos criados no mesmo
// milissegundo empatam em `criado_em`, e `proximaOrdem()` garante que o mais
// novo tem a maior ordem — ou seja, e um desempate correto (e estavel, ao
// contrario do que aconteceria deixando o SQLite escolher). O `nome ASC` no
// fim fecha o caso de ordens iguais.
const ORDENACOES = {
  relevancia: `p.destaque DESC, p.ordem ASC, p.nome ASC`,
  'menor-preco': `pr.preco_min ASC, p.nome ASC`,
  'maior-preco': `pr.preco_min DESC, p.nome ASC`,
  avaliacao: `${NOTA_EFETIVA} DESC, ${TOTAL_EFETIVO} DESC`,
  recentes: `p.criado_em DESC, p.ordem DESC, p.nome ASC`
};

/** Anexa os planos (uma consulta extra, nao N+1) e calcula precoMin/precoMax. */
function anexarPlanos(produtos) {
  if (!produtos.length) return produtos;

  const ids = produtos.map(produto => produto.id);
  const marcadores = ids.map(() => '?').join(', ');

  const agrupado = new Map();
  obter()
    .prepare(`
      SELECT produto_id, id, nome, preco_centavos, dias
      FROM planos
      WHERE produto_id IN (${marcadores}) AND ativo = 1
      ORDER BY ordem ASC, preco_centavos ASC
    `)
    .all(...ids)
    .forEach(linha => {
      if (!agrupado.has(linha.produto_id)) agrupado.set(linha.produto_id, []);
      agrupado.get(linha.produto_id).push({
        id: linha.id,
        nome: linha.nome,
        precoCentavos: linha.preco_centavos,
        dias: linha.dias
      });
    });

  return produtos.map(produto => {
    const lista = agrupado.get(produto.id) || [];
    const precos = lista.map(plano => plano.precoCentavos);
    return {
      ...produto,
      planos: lista,
      precoMinCentavos: precos.length ? Math.min(...precos) : 0,
      precoMaxCentavos: precos.length ? Math.max(...precos) : 0
    };
  });
}

// Aplica os agregados de avaliacao (base + reais) ao produto mapeado.
function anexarAvaliacoes(produto, linha) {
  const totalReal = Number(linha.avaliacoes_reais) || 0;
  const somaReal = Number(linha.notas_reais) || 0;
  const total = produto.totalBase + totalReal;
  const media = total === 0 ? 0 : (produto.notaBase * produto.totalBase + somaReal) / total;
  return {
    ...produto,
    avaliacao: Math.round(media * 10) / 10,
    avaliacoes: total
  };
}

/**
 * Lista produtos com filtros opcionais.
 * @param {object} opcoes
 * @param {string} [opcoes.categoria] comparada sem acento e sem caixa
 * @param {boolean} [opcoes.destaque]
 * @param {string} [opcoes.busca]
 * @param {string} [opcoes.ordem] relevancia | menor-preco | maior-preco | avaliacao | recentes
 * @param {number} [opcoes.limite]
 * @param {number} [opcoes.deslocamento]
 * @param {boolean} [opcoes.incluirInativos]
 */
function listar({ categoria, destaque, busca, ordem = 'relevancia', limite = 100, deslocamento = 0, incluirInativos = false } = {}) {
  const condicoes = [];
  const parametros = { limite, deslocamento };

  if (!incluirInativos) {
    condicoes.push('p.ativo = 1');
    // A vitrine so mostra o que da para comprar: produto sem plano fica fora.
    // O painel administrativo (incluirInativos) continua enxergando tudo.
    condicoes.push('pr.preco_min IS NOT NULL');
  }

  if (categoria && String(categoria).trim()) {
    condicoes.push('p.categoria_busca = @categoria');
    parametros.categoria = normalizarTexto(categoria);
  }
  if (destaque === true) condicoes.push('p.destaque = 1');
  if (busca && String(busca).trim()) {
    condicoes.push('p.busca LIKE @busca');
    parametros.busca = `%${normalizarTexto(busca)}%`;
  }

  const where = condicoes.length ? `WHERE ${condicoes.join(' AND ')}` : '';
  const orderBy = ORDENACOES[ordem] || ORDENACOES.relevancia;

  const linhas = obter()
    .prepare(`${SELECT_BASE} ${where} ORDER BY ${orderBy} LIMIT @limite OFFSET @deslocamento`)
    .all(parametros);

  const produtos = linhas.map(linha => anexarAvaliacoes(mapearProduto(linha), linha));
  return anexarPlanos(produtos);
}

/** Quantos produtos batem com os filtros (para paginacao). */
function contar({ categoria, destaque, busca, incluirInativos = false } = {}) {
  const condicoes = [];
  const parametros = {};

  if (!incluirInativos) {
    condicoes.push('p.ativo = 1');
    condicoes.push('pr.preco_min IS NOT NULL');
  }
  if (categoria && String(categoria).trim()) {
    condicoes.push('p.categoria_busca = @categoria');
    parametros.categoria = normalizarTexto(categoria);
  }
  if (destaque === true) condicoes.push('p.destaque = 1');
  if (busca && String(busca).trim()) {
    condicoes.push('p.busca LIKE @busca');
    parametros.busca = `%${normalizarTexto(busca)}%`;
  }

  const where = condicoes.length ? `WHERE ${condicoes.join(' AND ')}` : '';
  const linha = obter()
    .prepare(`
      SELECT COUNT(*) AS total
      FROM produtos p
      LEFT JOIN (SELECT produto_id, MIN(preco_centavos) AS preco_min FROM planos WHERE ativo = 1 GROUP BY produto_id) pr
             ON pr.produto_id = p.id
      ${where}
    `)
    .get(parametros);

  return linha ? linha.total : 0;
}

/** Busca por id OU por slug (o front aceita os dois na mesma rota). */
function buscarPorIdOuSlug(valor) {
  if (!valor) return null;
  const linha = obter()
    .prepare(`${SELECT_BASE} WHERE (p.id = @valor OR p.slug = @valor)`)
    .get({ valor: String(valor) });

  if (!linha) return null;
  const produto = anexarAvaliacoes(mapearProduto(linha), linha);
  return anexarPlanos([produto])[0] || null;
}

function buscarPorId(id) {
  if (!id) return null;
  const linha = obter().prepare(`${SELECT_BASE} WHERE p.id = @id`).get({ id });
  if (!linha) return null;
  return anexarPlanos([anexarAvaliacoes(mapearProduto(linha), linha)])[0] || null;
}

function buscarPorSlug(slug) {
  if (!slug) return null;
  const linha = obter().prepare(`${SELECT_BASE} WHERE p.slug = @slug`).get({ slug });
  if (!linha) return null;
  return anexarPlanos([anexarAvaliacoes(mapearProduto(linha), linha)])[0] || null;
}

/** Um plano especifico de um produto (usado no checkout). */
function buscarPlano(produtoId, planoId) {
  if (!produtoId || !planoId) return null;
  const linha = obter()
    .prepare('SELECT * FROM planos WHERE produto_id = ? AND id = ? AND ativo = 1')
    .get(produtoId, planoId);
  return linha ? { ...mapearPlano(linha), produtoId: linha.produto_id } : null;
}

/**
 * Igual a buscarPlano, mas aceita plano inativo. Usado pela gestao de estoque:
 * o admin precisa poder repor chaves de um plano que esta desligado da vitrine
 * sem ter que reativa-lo antes.
 */
function buscarPlanoQualquer(produtoId, planoId) {
  if (!produtoId || !planoId) return null;
  const linha = obter()
    .prepare('SELECT * FROM planos WHERE produto_id = ? AND id = ?')
    .get(produtoId, planoId);
  return linha ? { ...mapearPlano(linha), produtoId: linha.produto_id } : null;
}

/** Todos os planos de um produto (inclusive inativos), com o minimo de estoque. */
function listarPlanos(produtoId) {
  if (!produtoId) return [];
  return obter()
    .prepare('SELECT * FROM planos WHERE produto_id = ? ORDER BY ordem ASC, preco_centavos ASC')
    .all(produtoId)
    .map(linha => ({ ...mapearPlano(linha), produtoId: linha.produto_id }));
}

/** Categorias com a contagem de produtos ativos, na ordem do catalogo. */
function listarCategorias() {
  return obter()
    .prepare(`
      SELECT p.categoria AS nome, COUNT(*) AS total
      FROM produtos p
      JOIN (SELECT produto_id FROM planos WHERE ativo = 1 GROUP BY produto_id) pr ON pr.produto_id = p.id
      WHERE p.ativo = 1
      GROUP BY p.categoria_busca, p.categoria
      ORDER BY MIN(p.ordem) ASC, p.categoria ASC
    `)
    .all();
}

/* -------------------------------------------------------------------------- */
/* Escrita                                                                    */
/* -------------------------------------------------------------------------- */

function criar(produto) {
  const agora = agoraISO();
  obter()
    .prepare(`
      INSERT INTO produtos (
        id, slug, nome, linha, nivel, categoria, categoria_busca, descricao, descricao_longa, recursos, capa, imagem, badge,
        plataforma, entrega, destaque, ativo, ordem, nota_base, total_base, busca,
        criado_em, atualizado_em
      ) VALUES (
        @id, @slug, @nome, @linha, @nivel, @categoria, @categoriaBusca, @descricao, @descricaoLonga, @recursos, @capa, @imagem, @badge,
        @plataforma, @entrega, @destaque, @ativo, @ordem, @notaBase, @totalBase, @busca,
        @criadoEm, @atualizadoEm
      )
    `)
    .run({
      id: produto.id,
      slug: produto.slug,
      nome: produto.nome,
      linha: produto.linha || '',
      nivel: produto.nivel || '',
      categoria: produto.categoria,
      categoriaBusca: normalizarTexto(produto.categoria),
      descricao: produto.descricao || '',
      descricaoLonga: produto.descricaoLonga || '',
      recursos: JSON.stringify(produto.recursos || []),
      capa: JSON.stringify(produto.capa || {}),
      imagem: produto.imagem || null,
      badge: produto.badge || null,
      plataforma: produto.plataforma || 'Windows',
      entrega: produto.entrega || 'Automatica',
      destaque: produto.destaque ? 1 : 0,
      ativo: produto.ativo === false ? 0 : 1,
      ordem: produto.ordem ?? 0,
      notaBase: produto.notaBase ?? 0,
      totalBase: produto.totalBase ?? 0,
      busca: montarBusca(produto),
      criadoEm: agora,
      atualizadoEm: agora
    });

  return buscarPorId(produto.id);
}

const CAMPOS_ATUALIZAVEIS = {
  nome: 'nome',
  linha: 'linha',
  nivel: 'nivel',
  categoria: 'categoria',
  descricao: 'descricao',
  descricaoLonga: 'descricao_longa',
  imagem: 'imagem',
  badge: 'badge',
  plataforma: 'plataforma',
  entrega: 'entrega',
  ordem: 'ordem'
};

/** Atualizacao parcial: so os campos informados sao tocados. */
function atualizar(id, alteracoes) {
  const sets = [];
  const parametros = { id, atualizadoEm: agoraISO() };

  for (const [chave, coluna] of Object.entries(CAMPOS_ATUALIZAVEIS)) {
    if (alteracoes[chave] === undefined) continue;
    sets.push(`${coluna} = @${chave}`);
    parametros[chave] = alteracoes[chave];
  }

  // Campos com tratamento proprio (JSON / booleanos)
  if (alteracoes.recursos !== undefined) {
    sets.push('recursos = @recursos');
    parametros.recursos = JSON.stringify(alteracoes.recursos);
  }
  if (alteracoes.capa !== undefined) {
    sets.push('capa = @capa');
    parametros.capa = JSON.stringify(alteracoes.capa);
  }
  if (alteracoes.destaque !== undefined) {
    sets.push('destaque = @destaque');
    parametros.destaque = alteracoes.destaque ? 1 : 0;
  }
  if (alteracoes.ativo !== undefined) {
    sets.push('ativo = @ativo');
    parametros.ativo = alteracoes.ativo ? 1 : 0;
  }
  if (alteracoes.notaBase !== undefined) {
    sets.push('nota_base = @notaBase');
    parametros.notaBase = alteracoes.notaBase;
  }
  if (alteracoes.totalBase !== undefined) {
    sets.push('total_base = @totalBase');
    parametros.totalBase = alteracoes.totalBase;
  }
  if (alteracoes.slug !== undefined) {
    sets.push('slug = @slug');
    parametros.slug = alteracoes.slug;
  }

  if (!sets.length) return buscarPorId(id);

  sets.push('atualizado_em = @atualizadoEm');

  // O texto de busca depende de varios campos: recalcula a partir do estado final.
  const atual = buscarPorId(id);
  if (!atual) return null;
  const final = { ...atual, ...alteracoes };
  sets.push('busca = @busca');
  parametros.busca = montarBusca(final);

  // A copia normalizada da categoria acompanha qualquer mudanca de categoria.
  sets.push('categoria_busca = @categoriaBusca');
  parametros.categoriaBusca = normalizarTexto(final.categoria);

  obter().prepare(`UPDATE produtos SET ${sets.join(', ')} WHERE id = @id`).run(parametros);
  return buscarPorId(id);
}

/**
 * Sincroniza os planos de um produto com a lista informada.
 *
 * Nao e mais "apaga tudo e insere de novo": planos existentes sao ATUALIZADOS no
 * lugar. Isso importa porque o estoque de chaves aponta para o par
 * (produto_id, plano_id) — se apagassemos o plano, as chaves ficariam orfas.
 * Mantendo a linha, uma simples troca de preco ou nome nao mexe no estoque.
 *
 * Planos que sumiram da lista sao removidos e seus ids devolvidos em
 * "removidos", para que a camada de servico descarte as chaves correspondentes.
 *
 * @returns {{ removidos: string[] }}
 */
function substituirPlanos(produtoId, planos) {
  const db = obter();
  const existentes = db
    .prepare('SELECT id FROM planos WHERE produto_id = ?')
    .all(produtoId)
    .map(linha => linha.id);
  const idsFinais = new Set(planos.map(plano => plano.id));

  const inserir = db.prepare(`
    INSERT INTO planos (produto_id, id, nome, preco_centavos, dias, ordem, ativo, estoque_minimo)
    VALUES (@produtoId, @id, @nome, @precoCentavos, @dias, @ordem, 1, @estoqueMinimo)
  `);
  // Nao toca em estoque_minimo: esse campo e gerido pela tela de Estoque, nao
  // pelo formulario de produto.
  const atualizar = db.prepare(`
    UPDATE planos
    SET nome = @nome, preco_centavos = @precoCentavos, dias = @dias, ordem = @ordem, ativo = 1
    WHERE produto_id = @produtoId AND id = @id
  `);
  const remover = db.prepare('DELETE FROM planos WHERE produto_id = ? AND id = ?');

  const removidos = [];

  db.transaction(() => {
    planos.forEach((plano, indice) => {
      const dados = {
        produtoId,
        id: plano.id,
        nome: plano.nome,
        precoCentavos: plano.precoCentavos,
        dias: plano.dias ?? null,
        ordem: plano.ordem ?? indice,
        estoqueMinimo: plano.estoqueMinimo ?? 0
      };
      if (existentes.includes(plano.id)) atualizar.run(dados);
      else inserir.run(dados);
    });

    existentes
      .filter(id => !idsFinais.has(id))
      .forEach(id => {
        remover.run(produtoId, id);
        removidos.push(id);
      });
  })();

  return { removidos };
}

/** Ultimo valor de "ordem" — usado para colocar um produto novo no fim da lista. */
function proximaOrdem() {
  const linha = obter().prepare('SELECT COALESCE(MAX(ordem), -1) + 1 AS proxima FROM produtos').get();
  return linha ? linha.proxima : 0;
}

/** Define o ponto de reposicao (estoque_minimo) de um plano. */
function definirEstoqueMinimo(produtoId, planoId, minimo) {
  const info = obter()
    .prepare('UPDATE planos SET estoque_minimo = ? WHERE produto_id = ? AND id = ?')
    .run(minimo, produtoId, planoId);
  return info.changes > 0;
}

module.exports = {
  mapearProduto,
  mapearPlano,
  montarBusca,
  listar,
  contar,
  buscarPorId,
  buscarPorSlug,
  buscarPorIdOuSlug,
  buscarPlano,
  buscarPlanoQualquer,
  listarPlanos,
  listarCategorias,
  criar,
  atualizar,
  substituirPlanos,
  definirEstoqueMinimo,
  proximaOrdem
};
