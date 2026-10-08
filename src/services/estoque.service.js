/*
 * services/estoque.service.js
 * -----------------------------------------------------------------------------
 * Regras do estoque de chaves. Aqui ficam as decisoes que o repositorio nao
 * deve tomar: validar se o produto/plano existem, quantas chaves ha disponiveis,
 * o que fazer quando o saldo zera e — o mais importante — o consumo atomico
 * durante a compra.
 *
 * MODELO MENTAL
 *   O estoque e a fonte da verdade. Uma chave so existe para vender se estiver
 *   no pool com status "disponivel". Quando o pool esvazia, a venda e BLOQUEADA
 *   (decisao do produto): melhor recusar a compra do que vender o que nao existe.
 *
 * Toda operacao que muda o saldo passa por aqui, registra um movimento no
 * livro-caixa e publica um evento — e o evento que faz o painel se atualizar
 * sozinho em todas as abas abertas.
 */
'use strict';

const produtosRepo = require('../repositories/produtos.repo');
const estoqueRepo = require('../repositories/estoque.repo');
const auditoriaRepo = require('../repositories/auditoria.repo');

const eventos = require('../utils/eventos');
const { ErroValidacao, NaoEncontrado, RegraNegocio, EstoqueInsuficiente } = require('../utils/erros');
const { exigirInteiro, exigirChaveLicenca, textoOpcional, lerInteiro, exigirArray, exigirUuid } = require('../utils/validacao');
const { transacao } = require('../db/conexao');
const { paraReais } = require('../utils/dinheiro');
const { novoId, gerarChaveLicenca } = require('../utils/seguranca');

// Limite por operacao. Evita que um "gerar 1 milhao" trave o processo sincrono.
const MAX_POR_OPERACAO = 500;

/*
 * As chaves do estoque usam o MESMO formato das licencas geradas internamente
 * (ABCD-1234-EF56-7890), validado por `exigirChaveLicenca`. Nao e capricho: se
 * aceitassemos formatos livres, a chave entraria no pool mas o cliente nao
 * conseguiria RESGATAR (o resgate valida o formato). Manter um formato so
 * garante que toda chave vendida e resgatavel.
 */
const MAX_CHAVES_INVALIDAS_MOSTRADAS = 5;

/* -------------------------------------------------------------------------- */
/* Auxiliares                                                                 */
/* -------------------------------------------------------------------------- */

/** Confere que produto e plano existem; devolve ambos. */
function validarAlvo(produtoId, planoId) {
  const produto = produtosRepo.buscarPorId(produtoId);
  if (!produto) throw new NaoEncontrado('Produto nao encontrado');

  const plano = produtosRepo.buscarPlanoQualquer(produtoId, planoId);
  if (!plano) throw new NaoEncontrado('Plano nao encontrado para este produto');

  return { produto, plano };
}

/** Normaliza e valida uma chave digitada/colada pelo admin. */
function normalizarChave(valor) {
  return exigirChaveLicenca(valor, 'chaves');
}

/** Le e valida uma quantidade (1..MAX_POR_OPERACAO). */
function lerQuantidade(valor, rotulo = 'Quantidade') {
  return exigirInteiro(valor, 'quantidade', { rotulo, min: 1, max: MAX_POR_OPERACAO });
}

/** Situacao de um plano: disponivel + se esta no ponto de reposicao. */
function situacaoDoPlano(produtoId, planoId, estoqueMinimo) {
  const disponivel = estoqueRepo.contarDisponiveis(produtoId, planoId);
  const minimo = Number(estoqueMinimo) || 0;
  return {
    disponivel,
    minimo,
    esgotado: disponivel === 0,
    baixo: disponivel > 0 && minimo > 0 && disponivel <= minimo,
    alerta: disponivel === 0 || (minimo > 0 && disponivel <= minimo)
  };
}

/** Publica o evento padrao de mudanca de estoque de um plano. */
function anunciar(produtoId, planoId, estoqueMinimo) {
  const situacao = situacaoDoPlano(produtoId, planoId, estoqueMinimo);
  eventos.publicar('estoque.atualizado', {
    produtoId,
    planoId,
    disponivel: situacao.disponivel,
    minimo: situacao.minimo,
    esgotado: situacao.esgotado,
    alerta: situacao.alerta
  });
  // A vitrine depende do estoque para mostrar/esconder o produto: avisamos o
  // catalogo tambem para que ele possa recarregar o que estiver aberto.
  eventos.publicar('catalogo.atualizado', { produtoId });
  return situacao;
}

/**
 * Anuncia a mudanca de estoque de um plano consultando o minimo atual.
 * Usado pelo checkout depois de consumir chaves (fora da transacao).
 */
function anunciarPlano(produtoId, planoId) {
  const plano = produtosRepo.buscarPlanoQualquer(produtoId, planoId);
  return anunciar(produtoId, planoId, plano ? plano.estoqueMinimo : 0);
}

/* -------------------------------------------------------------------------- */
/* Entradas                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Adiciona chaves ao estoque de um plano.
 *
 * @param {object} dados
 * @param {string} dados.produtoId
 * @param {string} dados.planoId
 * @param {number} [dados.quantidade] quantas gerar (ignorado se vierem "chaves")
 * @param {string[]} [dados.chaves] chaves prontas, coladas pelo admin
 * @param {string} [dados.lote] rotulo do lote (ex.: "fornecedor-julho")
 * @param {object} ator usuario admin que executou
 * @returns {{ inseridas: number, duplicadas: number, disponivel: number }}
 */
function gerar(dados, ator, { ip = null } = {}) {
  const { produto, plano } = validarAlvo(dados.produtoId, dados.planoId);

  const lote = textoOpcional(dados.lote, 'lote', { rotulo: 'Lote', max: 60 });
  const listaInformada = dados.chaves !== undefined && dados.chaves !== null && dados.chaves !== '';

  let chaves;
  if (listaInformada) {
    const bruto = Array.isArray(dados.chaves)
      ? dados.chaves
      : String(dados.chaves).split(/[\r\n,;]+/);
    const limpas = bruto.map(item => String(item).trim()).filter(Boolean);
    if (!limpas.length) throw new ErroValidacao('Nenhuma chave valida foi informada');
    if (limpas.length > MAX_POR_OPERACAO) {
      throw new ErroValidacao(`No maximo ${MAX_POR_OPERACAO} chaves por vez`);
    }

    // Deduplica dentro do proprio lote e separa as invalidas para relatar todas
    // de uma vez (o admin cola uma lista inteira e precisa saber o que falhou).
    const vistos = new Set();
    const invalidas = [];
    chaves = [];

    limpas.forEach(item => {
      let chave;
      try {
        chave = normalizarChave(item);
      } catch {
        invalidas.push(String(item).slice(0, 40));
        return;
      }
      if (vistos.has(chave)) return;
      vistos.add(chave);
      chaves.push(chave);
    });

    if (invalidas.length) {
      throw new ErroValidacao(
        `${invalidas.length} chave(s) fora do formato ABCD-1234-EF56-7890`,
        {
          chaves: `Invalidas: ${invalidas.slice(0, MAX_CHAVES_INVALIDAS_MOSTRADAS).join(', ')}${
            invalidas.length > MAX_CHAVES_INVALIDAS_MOSTRADAS ? '...' : ''
          }`
        }
      );
    }
  } else {
    const quantidade = lerQuantidade(dados.quantidade);
    chaves = Array.from({ length: quantidade }, () => gerarChaveLicenca());
  }

  const linhas = chaves.map(chave => ({
    id: novoId(),
    produtoId: produto.id,
    planoId: plano.id,
    chave,
    lote
  }));

  const resultado = estoqueRepo.inserirVarias(linhas);

  if (resultado.inseridas > 0) {
    estoqueRepo.registrarMovimento({
      produtoId: produto.id,
      planoId: plano.id,
      tipo: 'entrada',
      quantidade: resultado.inseridas,
      motivo: lote ? `Entrada (lote ${lote})` : 'Entrada manual',
      atorId: ator ? ator.id : null
    });
    auditoriaRepo.registrar({
      atorId: ator ? ator.id : null,
      acao: 'estoque.entrada',
      entidade: 'estoque',
      entidadeId: `${produto.id}:${plano.id}`,
      dados: { produto: produto.nome, plano: plano.nome, inseridas: resultado.inseridas, duplicadas: resultado.duplicadas },
      ip
    });
  }

  const situacao = anunciar(produto.id, plano.id, plano.estoqueMinimo);

  return {
    inseridas: resultado.inseridas,
    duplicadas: resultado.duplicadas,
    disponivel: situacao.disponivel
  };
}

/* -------------------------------------------------------------------------- */
/* Saidas manuais                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Remove N chaves disponiveis do estoque (FIFO). Serve para reduzir a
 * quantidade a mao ou descartar um lote ruim.
 */
function descartar(dados, ator, { ip = null } = {}) {
  const { produto, plano } = validarAlvo(dados.produtoId, dados.planoId);
  const quantidade = lerQuantidade(dados.quantidade);
  const motivo = textoOpcional(dados.motivo, 'motivo', { rotulo: 'Motivo', max: 120 }) || 'Descarte manual';

  const removidas = estoqueRepo.descartarDisponiveis(produto.id, plano.id, quantidade);
  if (removidas === 0) {
    throw new RegraNegocio('Nao ha chaves disponiveis para remover neste plano');
  }

  estoqueRepo.registrarMovimento({
    produtoId: produto.id,
    planoId: plano.id,
    tipo: 'descarte',
    quantidade: removidas,
    motivo,
    atorId: ator ? ator.id : null
  });
  auditoriaRepo.registrar({
    atorId: ator ? ator.id : null,
    acao: 'estoque.descarte',
    entidade: 'estoque',
    entidadeId: `${produto.id}:${plano.id}`,
    dados: { produto: produto.nome, plano: plano.nome, removidas, motivo },
    ip
  });

  const situacao = anunciar(produto.id, plano.id, plano.estoqueMinimo);
  return { removidas, disponivel: situacao.disponivel };
}

/** Le a lista de ids de chaves vinda do painel (uuid, sem repetidos, ate o teto). */
function lerIdsDeChaves(valor) {
  const lista = exigirArray(valor, 'ids', { min: 1, max: MAX_POR_OPERACAO, rotulo: 'Chaves' });
  return [...new Set(lista.map(id => exigirUuid(id, 'ids')))];
}

/**
 * Confere que todas as chaves informadas existem e pertencem ao plano. Evita
 * que um id de outro plano seja mexido por engano (ou de proposito).
 */
function exigirChavesDoPlano(produtoId, planoId, ids) {
  const chaves = estoqueRepo.buscarPorIds(ids);
  const doPlano = chaves.filter(c => c.produtoId === produtoId && c.planoId === planoId);
  if (doPlano.length !== ids.length) {
    throw new NaoEncontrado('Uma ou mais chaves nao foram encontradas neste plano');
  }
  return doPlano;
}

/** Trilha de auditoria comum as operacoes por chave. */
function auditarChaves(acao, { produto, plano, ator, ip, dados }) {
  auditoriaRepo.registrar({
    atorId: ator ? ator.id : null,
    acao,
    entidade: 'estoque',
    entidadeId: `${produto.id}:${plano.id}`,
    dados: { produto: produto.nome, plano: plano.nome, ...dados },
    ip
  });
}

/**
 * Remove do pool chaves escolhidas uma a uma (marca como descartadas). So as
 * disponiveis sao afetadas; as demais voltam contadas em "ignoradas".
 */
function descartarChaves(dados, ator, { ip = null } = {}) {
  const { produto, plano } = validarAlvo(dados.produtoId, dados.planoId);
  const ids = lerIdsDeChaves(dados.ids);
  const motivo = textoOpcional(dados.motivo, 'motivo', { rotulo: 'Motivo', max: 120 }) || 'Descarte manual (selecao)';

  const removidas = transacao(() => {
    const disponiveis = exigirChavesDoPlano(produto.id, plano.id, ids)
      .filter(c => c.status === 'disponivel')
      .map(c => c.id);
    if (!disponiveis.length) {
      throw new RegraNegocio('Nenhuma das chaves selecionadas esta disponivel para remover');
    }
    const total = estoqueRepo.descartarPorIds(disponiveis);
    estoqueRepo.registrarMovimento({
      produtoId: produto.id,
      planoId: plano.id,
      tipo: 'descarte',
      quantidade: total,
      motivo,
      atorId: ator ? ator.id : null
    });
    auditarChaves('estoque.descarte', { produto, plano, ator, ip, dados: { removidas: total, motivo } });
    return total;
  });

  const situacao = anunciar(produto.id, plano.id, plano.estoqueMinimo);
  return { removidas, ignoradas: ids.length - removidas, disponivel: situacao.disponivel };
}

/**
 * Apaga de vez chaves escolhidas. Vendidas/revogadas ficam (sao historico de
 * pedido) e voltam contadas em "ignoradas". Se alguma disponivel saiu do pool,
 * o livro-caixa registra a saida.
 */
function excluirChaves(dados, ator, { ip = null } = {}) {
  const { produto, plano } = validarAlvo(dados.produtoId, dados.planoId);
  const ids = lerIdsDeChaves(dados.ids);

  const resultado = transacao(() => {
    exigirChavesDoPlano(produto.id, plano.id, ids);
    const apagadas = estoqueRepo.excluirPorIds(ids);
    const total = apagadas.disponiveis + apagadas.descartadas;
    if (!total) {
      throw new RegraNegocio('So e possivel excluir chaves disponiveis ou descartadas');
    }
    if (apagadas.disponiveis > 0) {
      estoqueRepo.registrarMovimento({
        produtoId: produto.id,
        planoId: plano.id,
        tipo: 'descarte',
        quantidade: apagadas.disponiveis,
        motivo: 'Exclusao definitiva',
        atorId: ator ? ator.id : null
      });
    }
    auditarChaves('estoque.exclusao', { produto, plano, ator, ip, dados: { ...apagadas, excluidas: total } });
    return { ...apagadas, total };
  });

  const situacao = anunciar(produto.id, plano.id, plano.estoqueMinimo);
  return { excluidas: resultado.total, ignoradas: ids.length - resultado.total, disponivel: situacao.disponivel };
}

/**
 * Define o disponivel de um plano para um valor-alvo ("atualizacao de
 * quantidade"). Se o alvo for maior, gera a diferenca; se for menor, descarta.
 */
function ajustarPara(dados, ator, { ip = null } = {}) {
  const { produto, plano } = validarAlvo(dados.produtoId, dados.planoId);
  const alvo = exigirInteiro(dados.alvo, 'alvo', { rotulo: 'Quantidade desejada', min: 0, max: 1000000 });
  const atual = estoqueRepo.contarDisponiveis(produto.id, plano.id);

  if (alvo === atual) {
    return { disponivel: atual, ajuste: 0, direcao: 'nenhum' };
  }

  if (alvo > atual) {
    const diferenca = alvo - atual;
    if (diferenca > MAX_POR_OPERACAO) {
      throw new ErroValidacao(`Para aumentar, a diferenca maxima por vez e ${MAX_POR_OPERACAO}`);
    }
    gerar({ produtoId: produto.id, planoId: plano.id, quantidade: diferenca, lote: '' }, ator, { ip });
    return { disponivel: alvo, ajuste: diferenca, direcao: 'entrada' };
  }

  const diferenca = atual - alvo;
  descartar({ produtoId: produto.id, planoId: plano.id, quantidade: diferenca, motivo: 'Ajuste de quantidade' }, ator, { ip });
  return { disponivel: alvo, ajuste: diferenca, direcao: 'descarte' };
}

/** Define o ponto de reposicao (estoque_minimo) de um plano. */
function definirMinimo(dados, ator, { ip = null } = {}) {
  const { produto, plano } = validarAlvo(dados.produtoId, dados.planoId);
  const minimo = exigirInteiro(dados.minimo, 'minimo', { rotulo: 'Estoque minimo', min: 0, max: 1000000 });

  produtosRepo.definirEstoqueMinimo(produto.id, plano.id, minimo);
  auditoriaRepo.registrar({
    atorId: ator ? ator.id : null,
    acao: 'estoque.minimo_definido',
    entidade: 'estoque',
    entidadeId: `${produto.id}:${plano.id}`,
    dados: { produto: produto.nome, plano: plano.nome, minimo },
    ip
  });

  const situacao = anunciar(produto.id, plano.id, minimo);
  return { estoqueMinimo: minimo, disponivel: situacao.disponivel, alerta: situacao.alerta };
}

/**
 * Descarta todo o disponivel de um plano que saiu do catalogo. Sem o plano, as
 * chaves nunca seriam vendidas; mante-las no pool so distorceria a contagem.
 */
function descartarEstoqueDePlano(produtoId, planoId, { atorId = null, ip = null } = {}) {
  const removidas = estoqueRepo.descartarPlano(produtoId, planoId);
  if (!removidas) return 0;

  estoqueRepo.registrarMovimento({
    produtoId,
    planoId,
    tipo: 'descarte',
    quantidade: removidas,
    motivo: 'Plano removido do catalogo',
    atorId
  });
  auditoriaRepo.registrar({
    atorId,
    acao: 'estoque.plano_removido',
    entidade: 'estoque',
    entidadeId: `${produtoId}:${planoId}`,
    dados: { removidas },
    ip
  });
  anunciar(produtoId, planoId, 0);
  return removidas;
}

/* -------------------------------------------------------------------------- */
/* Consumo no checkout                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Consome N chaves de um plano para uma venda. DEVE ser chamado dentro da
 * transacao pos-pagamento: ou todas as chaves entram, ou nada entra.
 *
 * @returns {string[]} as chaves entregues
 * @throws {EstoqueInsuficiente} quando o saldo nao cobre a quantidade
 */
function consumir(produtoId, planoId, quantidade, { vendaId, vendaItemId, atorId = null, planoNome = null, produtoNome = null } = {}) {
  const chaves = estoqueRepo.consumir(produtoId, planoId, quantidade, { vendaId, vendaItemId });

  if (!chaves) {
    // Chegamos aqui quando o estoque acabou entre a validacao e a cobranca
    // (duas compras simultaneas, por exemplo). A transacao do checkout sera
    // desfeita e o pedido nao avanca.
    throw new EstoqueInsuficiente(
      produtoNome ? `"${produtoNome}" ficou sem estoque durante a compra` : 'Estoque insuficiente durante a compra',
      { planoId }
    );
  }

  estoqueRepo.registrarMovimento({
    produtoId,
    planoId,
    tipo: 'saida',
    quantidade: chaves.length,
    motivo: vendaId ? `Venda ${vendaId.slice(0, 8)}` : 'Venda',
    atorId
  });

  return chaves;
}

/**
 * Devolve ao estoque as chaves de um pedido estornado. Uma chave ja entregue
 * NAO volta a ser vendavel (o cliente a viu), entao o status vira "revogada":
 * sai da conta de disponivel, mas fica registrada para auditoria.
 */
function revogarDaVenda(vendaId, { atorId = null } = {}) {
  const chaves = estoqueRepo.listarDaVenda(vendaId);
  if (!chaves.length) return 0;

  const afetadas = estoqueRepo.revogarDaVenda(vendaId);
  if (!afetadas) return 0;

  const porPlano = new Map();
  chaves.forEach(chave => {
    const atual = porPlano.get(chave.planoId) || { produtoId: chave.produtoId, quantidade: 0 };
    atual.quantidade += 1;
    porPlano.set(chave.planoId, atual);
  });

  porPlano.forEach((info, planoId) => {
    estoqueRepo.registrarMovimento({
      produtoId: info.produtoId,
      planoId,
      tipo: 'revogacao',
      quantidade: info.quantidade,
      motivo: 'Estorno de pedido',
      atorId
    });
    const plano = produtosRepo.buscarPlanoQualquer(info.produtoId, planoId);
    anunciar(info.produtoId, planoId, plano ? plano.estoqueMinimo : 0);
  });

  return afetadas;
}

/* -------------------------------------------------------------------------- */
/* Consultas                                                                  */
/* -------------------------------------------------------------------------- */

/** Converte uma linha do resumo no formato que o painel consome (reais). */
function paraPublicoResumo(linha) {
  const minimo = Number(linha.estoqueMinimo) || 0;
  return {
    produtoId: linha.produtoId,
    produtoNome: linha.produtoNome,
    produtoSlug: linha.produtoSlug,
    produtoCategoria: linha.produtoCategoria,
    planoId: linha.planoId,
    planoNome: linha.planoNome,
    preco: paraReais(linha.precoCentavos),
    precoCentavos: linha.precoCentavos,
    dias: linha.dias,
    planoAtivo: linha.planoAtivo,
    estoqueMinimo: minimo,
    disponivel: linha.disponivel,
    vendida: linha.vendida,
    descartada: linha.descartada,
    revogada: linha.revogada,
    total: linha.total,
    esgotado: linha.disponivel === 0,
    baixo: linha.disponivel > 0 && minimo > 0 && linha.disponivel <= minimo,
    alerta: linha.disponivel === 0 || (minimo > 0 && linha.disponivel <= minimo)
  };
}

/**
 * Resumo completo do estoque, ja ordenado com os alertas primeiro. E a carga
 * que alimenta a tela de Estoque inteira numa unica chamada.
 */
function resumo({ incluirInativos = true } = {}) {
  const planos = estoqueRepo.resumoPorPlano({ incluirInativos }).map(paraPublicoResumo);

  const alertas = planos.filter(plano => plano.alerta);
  const ordenados = [...planos].sort((a, b) => {
    // 1) alertas primeiro, 2) menos disponivel primeiro, 3) nome.
    if (a.alerta !== b.alerta) return a.alerta ? -1 : 1;
    if (a.disponivel !== b.disponivel) return a.disponivel - b.disponivel;
    return a.produtoNome.localeCompare(b.produtoNome, 'pt-BR');
  });

  return {
    totais: estoqueRepo.totais(),
    planos: ordenados,
    alertas,
    resumoAlertas: {
      esgotados: planos.filter(plano => plano.esgotado).length,
      baixos: planos.filter(plano => plano.baixo).length,
      saudaveis: planos.filter(plano => !plano.alerta).length
    }
  };
}

/** Somente os planos em alerta (esgotado ou no ponto de reposicao). */
function alertas() {
  return resumo().alertas;
}

/**
 * Disponibilidade por plano de UM produto (Map planoId -> quantidade).
 * Usado pela vitrine para marcar "esgotado" e pelo checkout para validar.
 */
function disponibilidade(produtoId) {
  return estoqueRepo.disponiveisPorProduto(produtoId);
}

/** Disponibilidade de varios produtos de uma vez (Map "produtoId|planoId"). */
function disponibilidadeDeVarios(produtoIds) {
  return estoqueRepo.disponiveisDeProdutos(produtoIds);
}

/** Chaves cruas do pool, com filtros e paginacao. */
function listarChaves(filtros = {}) {
  const limite = Math.min(Math.max(lerInteiro(filtros.limite, 100) || 100, 1), 500);
  const deslocamento = Math.max(lerInteiro(filtros.deslocamento, 0) || 0, 0);
  const status = ['disponivel', 'vendida', 'descartada', 'revogada'].includes(filtros.status) ? filtros.status : null;

  return {
    chaves: estoqueRepo.listarChaves({
      produtoId: filtros.produtoId || null,
      planoId: filtros.planoId || null,
      status,
      busca: filtros.busca || null,
      limite,
      deslocamento
    }),
    total: estoqueRepo.contarChaves({
      produtoId: filtros.produtoId || null,
      planoId: filtros.planoId || null,
      status,
      busca: filtros.busca || null
    }),
    limite,
    deslocamento
  };
}

/** Historico de movimentos (entradas, saidas, descartes, revogacoes). */
function listarMovimentos(filtros = {}) {
  const limite = Math.min(Math.max(lerInteiro(filtros.limite, 100) || 100, 1), 500);
  const deslocamento = Math.max(lerInteiro(filtros.deslocamento, 0) || 0, 0);
  const tipo = ['entrada', 'saida', 'descarte', 'revogacao'].includes(filtros.tipo) ? filtros.tipo : null;

  return estoqueRepo.listarMovimentos({
    produtoId: filtros.produtoId || null,
    planoId: filtros.planoId || null,
    tipo,
    limite,
    deslocamento
  });
}

/** Garante que o estoque de um plano cobre a quantidade pedida. */
function garantirDisponibilidade(produtoId, planoId, quantidade, { produtoNome = null, planoNome = null } = {}) {
  const disponivel = estoqueRepo.contarDisponiveis(produtoId, planoId);
  if (disponivel < quantidade) {
    throw new EstoqueInsuficiente(
      produtoNome
        ? `"${produtoNome}" (${planoNome || planoId}) esta sem estoque suficiente. Disponivel: ${disponivel}.`
        : 'Estoque insuficiente',
      { produtoId, planoId, disponivel, solicitado: quantidade }
    );
  }
  return disponivel;
}

module.exports = {
  MAX_POR_OPERACAO,
  gerar,
  descartar,
  descartarChaves,
  excluirChaves,
  ajustarPara,
  definirMinimo,
  descartarEstoqueDePlano,
  consumir,
  revogarDaVenda,
  resumo,
  alertas,
  disponibilidade,
  disponibilidadeDeVarios,
  listarChaves,
  listarMovimentos,
  garantirDisponibilidade,
  paraPublicoResumo,
  situacaoDoPlano,
  anunciar,
  anunciarPlano
};
