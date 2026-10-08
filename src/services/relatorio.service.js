/*
 * services/relatorio.service.js
 * -----------------------------------------------------------------------------
 * Relatorios do painel: tudo o que o admin precisa para entender como a loja
 * esta indo em um periodo. Nada aqui escreve no banco — e so leitura e
 * agregacao.
 *
 * A janela de tempo e sempre [desde, ate) em ISO/UTC, que e como "criado_em" e
 * gravado. O cliente escolhe um preset (7/30/90/365 dias) ou um intervalo
 * explicito (YYYY-MM-DD).
 *
 * Alem dos numeros do periodo atual, devolvemos a COMPARACAO com o periodo
 * anterior de mesmo tamanho. Sem isso, um relatorio so mostra o retrato; com a
 * comparacao, ele mostra a tendencia — que e o que interessa.
 */
'use strict';

const vendasRepo = require('../repositories/vendas.repo');
const usuariosRepo = require('../repositories/usuarios.repo');
const licencasRepo = require('../repositories/licencas.repo');
const estoqueService = require('./estoque.service');

const { ErroValidacao } = require('../utils/erros');
const { paraReais } = require('../utils/dinheiro');
const { dayjs, formatarDataBR } = require('../utils/datas');
const { lerInteiro } = require('../utils/validacao');

const PERIODOS = [7, 30, 90, 365];
const MAX_DIAS_NO_GRAFICO = 120;
const DATA_REGEX = /^\d{4}-\d{2}-\d{2}$/;

/* -------------------------------------------------------------------------- */
/* Janela de tempo                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Monta a janela [desde, ate) a partir dos filtros.
 * @param {{periodo?: number, desde?: string, ate?: string}} filtros
 */
function montarJanela(filtros = {}) {
  const temIntervalo = filtros.desde || filtros.ate;

  if (temIntervalo) {
    if (filtros.desde && !DATA_REGEX.test(String(filtros.desde))) {
      throw new ErroValidacao('Data inicial invalida. Use o formato AAAA-MM-DD');
    }
    if (filtros.ate && !DATA_REGEX.test(String(filtros.ate))) {
      throw new ErroValidacao('Data final invalida. Use o formato AAAA-MM-DD');
    }

    const inicio = filtros.desde ? dayjs(`${filtros.desde}T00:00:00.000Z`) : dayjs().subtract(29, 'day').startOf('day');
    const fim = filtros.ate ? dayjs(`${filtros.ate}T00:00:00.000Z`).add(1, 'day') : dayjs().add(1, 'day').startOf('day');

    if (fim.isBefore(inicio) || fim.isSame(inicio)) {
      throw new ErroValidacao('A data final deve ser posterior a data inicial');
    }

    const dias = Math.max(fim.diff(inicio, 'day'), 1);
    return { desde: inicio.toISOString(), ate: fim.toISOString(), dias, rotulo: `${inicio.format('DD/MM/YYYY')} a ${fim.subtract(1, 'day').format('DD/MM/YYYY')}` };
  }

  const periodo = PERIODOS.includes(Number(filtros.periodo)) ? Number(filtros.periodo) : 30;
  const fim = dayjs().add(1, 'day').startOf('day');
  const inicio = fim.subtract(periodo, 'day');

  return {
    desde: inicio.toISOString(),
    ate: fim.toISOString(),
    dias: periodo,
    rotulo: periodo === 1 ? 'Hoje' : `Últimos ${periodo} dias`
  };
}

/** Variacao percentual de "atual" sobre "anterior" (1 casa decimal). */
function variacao(atual, anterior) {
  if (!anterior) return atual > 0 ? 100 : 0;
  return Math.round(((atual - anterior) / anterior) * 1000) / 10;
}

/** Fatia de um valor sobre o total, em % (1 casa). */
function fatia(valor, total) {
  if (!total) return 0;
  return Math.round((valor / total) * 1000) / 10;
}

/**
 * Preenche os dias sem venda com zero, para o grafico nao ter buracos.
 * Em janelas longas devolve os dados crus (um ponto por dia fica ilegivel).
 */
function preencherDias(linhas, desde, ate) {
  const comReceita = linhas.map(linha => ({
    dia: linha.dia,
    diaFormatado: dayjs(linha.dia).format('DD/MM'),
    pedidos: linha.pedidos,
    receitaCentavos: linha.receitaCentavos,
    receita: paraReais(linha.receitaCentavos)
  }));

  const inicio = dayjs(desde);
  const ultimoDia = dayjs(new Date(ate).getTime() - 1);
  const totalDias = Math.max(ultimoDia.diff(inicio, 'day') + 1, 1);

  if (totalDias > MAX_DIAS_NO_GRAFICO) return comReceita;

  const porDia = new Map(comReceita.map(item => [item.dia, item]));
  const saida = [];

  for (let indice = 0; indice < totalDias; indice += 1) {
    const momento = inicio.add(indice, 'day');
    const chave = momento.format('YYYY-MM-DD');
    saida.push(
      porDia.get(chave) || {
        dia: chave,
        diaFormatado: momento.format('DD/MM'),
        pedidos: 0,
        receitaCentavos: 0,
        receita: 0
      }
    );
  }

  return saida;
}

/* -------------------------------------------------------------------------- */
/* Relatorio                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Monta o relatorio completo do periodo pedido.
 * @param {{periodo?: number, desde?: string, ate?: string}} filtros
 */
function relatorio(filtros = {}) {
  const janela = montarJanela(filtros);

  // Periodo anterior de mesmo tamanho, para a comparacao de tendencia.
  const inicioAnterior = dayjs(janela.desde).subtract(janela.dias, 'day').toISOString();
  const anterior = vendasRepo.resumoNoPeriodo(inicioAnterior, janela.desde);
  const atual = vendasRepo.resumoNoPeriodo(janela.desde, janela.ate);

  const receitaPorDia = preencherDias(vendasRepo.receitaPorDiaNoPeriodo(janela.desde, janela.ate), janela.desde, janela.ate);

  const topProdutos = vendasRepo.topProdutosNoPeriodo(janela.desde, janela.ate, 10).map(item => ({
    produtoId: item.produtoId,
    nome: item.nome,
    unidades: item.unidades,
    receitaCentavos: item.receitaCentavos,
    receita: paraReais(item.receitaCentavos),
    participacao: fatia(item.receitaCentavos, atual.receitaCentavos)
  }));

  const porMetodo = vendasRepo.porMetodoNoPeriodo(janela.desde, janela.ate).map(item => ({
    metodo: item.metodo,
    pedidos: item.pedidos,
    receitaCentavos: item.receitaCentavos,
    receita: paraReais(item.receitaCentavos),
    participacao: fatia(item.receitaCentavos, atual.receitaCentavos)
  }));

  const porCategoria = vendasRepo.porCategoriaNoPeriodo(janela.desde, janela.ate).map(item => ({
    categoria: item.categoria,
    unidades: item.unidades,
    receitaCentavos: item.receitaCentavos,
    receita: paraReais(item.receitaCentavos),
    participacao: fatia(item.receitaCentavos, atual.receitaCentavos)
  }));

  const estoque = estoqueService.resumo();

  return {
    janela: {
      dias: janela.dias,
      desde: janela.desde,
      ate: janela.ate,
      desdeFormatado: formatarDataBR(janela.desde),
      ateFormatado: formatarDataBR(new Date(new Date(janela.ate).getTime() - 1).toISOString()),
      rotulo: janela.rotulo
    },
    financeiro: {
      pedidos: atual.pedidos,
      receitaCentavos: atual.receitaCentavos,
      receita: paraReais(atual.receitaCentavos),
      descontosCentavos: atual.descontosCentavos,
      descontos: paraReais(atual.descontosCentavos),
      ticketMedioCentavos: atual.ticketMedioCentavos,
      ticketMedio: paraReais(atual.ticketMedioCentavos),
      unidades: vendasRepo.unidadesNoPeriodo(janela.desde, janela.ate)
    },
    comparativo: {
      receitaAnteriorCentavos: anterior.receitaCentavos,
      receitaAnterior: paraReais(anterior.receitaCentavos),
      variacaoReceita: variacao(atual.receitaCentavos, anterior.receitaCentavos),
      pedidosAnterior: anterior.pedidos,
      variacaoPedidos: variacao(atual.pedidos, anterior.pedidos),
      ticketMedioAnteriorCentavos: anterior.ticketMedioCentavos,
      ticketMedioAnterior: paraReais(anterior.ticketMedioCentavos),
      variacaoTicketMedio: variacao(atual.ticketMedioCentavos, anterior.ticketMedioCentavos)
    },
    clientes: {
      compradores: atual.clientes,
      compradoresAnterior: anterior.clientes,
      novos: usuariosRepo.contarCriadosEntre(janela.desde, janela.ate),
      total: usuariosRepo.contar()
    },
    pedidosPorStatus: vendasRepo.contagemPorStatusNoPeriodo(janela.desde, janela.ate),
    receitaPorDia,
    topProdutos,
    porMetodo,
    porCategoria,
    cupons: vendasRepo.cuponsNoPeriodo(janela.desde, janela.ate).map(item => ({
      codigo: item.codigo,
      pedidos: item.pedidos,
      descontoCentavos: item.descontoCentavos,
      desconto: paraReais(item.descontoCentavos)
    })),
    licencas: licencasRepo.contarPorStatus(),
    estoque: {
      disponivel: estoque.totais.disponivel,
      vendida: estoque.totais.vendida,
      descartada: estoque.totais.descartada,
      revogada: estoque.totais.revogada,
      total: estoque.totais.total,
      esgotados: estoque.resumoAlertas.esgotados,
      baixos: estoque.resumoAlertas.baixos,
      alertas: estoque.alertas.slice(0, 10).map(plano => ({
        produto: plano.produtoNome,
        plano: plano.planoNome,
        disponivel: plano.disponivel,
        minimo: plano.estoqueMinimo,
        esgotado: plano.esgotado
      }))
    }
  };
}

module.exports = { PERIODOS, montarJanela, relatorio };
