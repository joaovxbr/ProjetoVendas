/*
 * services/financeiro.service.js
 * -----------------------------------------------------------------------------
 * A area FINANCEIRA do painel: onde esta o dinheiro da loja.
 *
 * A divisao com relatorio.service.js e proposital:
 *
 *   - relatorios -> DESEMPENHO ("a loja esta indo bem?"): tendencia, top
 *                   produtos, categorias, cupons. Olha so os pedidos pagos.
 *   - financeiro -> CAIXA ("quanto entrou e quanto falta entrar?"): recebido,
 *                   a receber, devolvido, por onde passou e o extrato.
 *                   Olha TODOS os status, porque dinheiro que ainda nao entrou
 *                   (pendente) e dinheiro que voltou (reembolsado) tambem sao
 *                   assunto financeiro.
 *
 * Nada aqui escreve no banco — e so leitura e agregacao.
 */
'use strict';

const vendasRepo = require('../repositories/vendas.repo');
const gatewayService = require('./gateway.service');
const registroGateways = require('../gateways');
const { montarJanela } = require('./relatorio.service');
const { paraReais } = require('../utils/dinheiro');
const { dayjs, formatarDataBR } = require('../utils/datas');
const { ErroValidacao } = require('../utils/erros');

const STATUS = ['pendente', 'pago', 'cancelado', 'reembolsado'];

/* -------------------------------------------------------------------------- */
/* Apoio                                                                      */
/* -------------------------------------------------------------------------- */

/** Bloco de dinheiro: quantos pedidos e quanto valem (em centavos e em reais). */
function bloco(entrada) {
  const pedidos = entrada ? entrada.pedidos : 0;
  const valorCentavos = entrada ? entrada.totalCentavos : 0;
  return { pedidos, valorCentavos, valor: paraReais(valorCentavos) };
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

/** Nome legivel de um provedor (cai para o id se nao estiver no catalogo). */
function nomeProvedor(id) {
  const definicao = registroGateways.buscar(id);
  return definicao ? definicao.nome : String(id || '—');
}

/** Nome legivel de uma forma de pagamento (o pedido pode nao ter forma). */
function nomeForma(id) {
  return id ? gatewayService.nomeMetodo(id) : 'Sem forma definida';
}

/** Janela pronta para a tela (mesmo formato do relatorio). */
function janelaFormatada(janela) {
  return {
    dias: janela.dias,
    desde: janela.desde,
    ate: janela.ate,
    desdeFormatado: formatarDataBR(janela.desde),
    ateFormatado: formatarDataBR(new Date(new Date(janela.ate).getTime() - 1).toISOString()),
    rotulo: janela.rotulo
  };
}

/* -------------------------------------------------------------------------- */
/* Financeiro                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Retrato financeiro do periodo: o que entrou, o que esta a receber, o que foi
 * devolvido, por onde passou e a comparacao com o periodo anterior.
 * @param {{periodo?: number, desde?: string, ate?: string}} filtros
 */
function financeiro(filtros = {}) {
  const janela = montarJanela(filtros);

  // Periodo anterior de mesmo tamanho, para a comparacao de tendencia.
  const inicioAnterior = dayjs(janela.desde).subtract(janela.dias, 'day').toISOString();
  const porStatus = vendasRepo.totaisPorStatusNoPeriodo(janela.desde, janela.ate);
  const anterior = vendasRepo.totaisPorStatusNoPeriodo(inicioAnterior, janela.desde);

  const recebido = bloco(porStatus.pago);
  const recebidoAnterior = bloco(anterior.pago);
  const aReceber = bloco(porStatus.pendente);
  const reembolsado = bloco(porStatus.reembolsado);
  const cancelado = bloco(porStatus.cancelado);

  const ticketMedioCentavos = recebido.pedidos > 0
    ? Math.round(recebido.valorCentavos / recebido.pedidos)
    : 0;

  const descontosCentavos = porStatus.pago ? porStatus.pago.descontosCentavos : 0;

  // Receita por forma de pagamento. O nome legivel vem do catalogo de gateways,
  // nao de uma tabela no front — assim uma forma nova aparece sozinha.
  const porForma = vendasRepo.porMetodoNoPeriodo(janela.desde, janela.ate).map(item => ({
    id: item.metodo,
    nome: nomeForma(item.metodo),
    pedidos: item.pedidos,
    valorCentavos: item.receitaCentavos,
    valor: paraReais(item.receitaCentavos),
    participacao: fatia(item.receitaCentavos, recebido.valorCentavos)
  }));

  // Receita por provedor: responde "por onde o dinheiro entrou de verdade" —
  // o que o relatorio por forma de pagamento nao diz (duas formas podem passar
  // pelo mesmo provedor, e a mesma forma pode passar por provedores diferentes).
  const porProvedor = vendasRepo.porProvedorNoPeriodo(janela.desde, janela.ate).map(item => ({
    id: item.provedor,
    nome: item.provedor ? nomeProvedor(item.provedor) : 'Sem provedor',
    pedidos: item.pedidos,
    valorCentavos: item.receitaCentavos,
    valor: paraReais(item.receitaCentavos),
    participacao: fatia(item.receitaCentavos, recebido.valorCentavos)
  }));

  const pedidosPorStatus = STATUS.reduce((acumulado, status) => {
    acumulado[status] = porStatus[status] ? porStatus[status].pedidos : 0;
    return acumulado;
  }, {});

  return {
    janela: janelaFormatada(janela),
    resumo: {
      recebido,
      aReceber,
      reembolsado,
      cancelado,
      ticketMedioCentavos,
      ticketMedio: paraReais(ticketMedioCentavos),
      descontosCentavos,
      descontos: paraReais(descontosCentavos)
    },
    comparativo: {
      recebidoAnteriorCentavos: recebidoAnterior.valorCentavos,
      recebidoAnterior: recebidoAnterior.valor,
      variacaoRecebido: variacao(recebido.valorCentavos, recebidoAnterior.valorCentavos)
    },
    pedidosPorStatus,
    porForma,
    porProvedor
  };
}

/**
 * Extrato de pagamentos do periodo, do mais recente para o mais antigo.
 * Sem `status`, saem todos — e o que permite ver pendente e reembolsado
 * convivendo com o que ja entrou.
 * @param {{periodo?: number, desde?: string, ate?: string, status?: string, limite?: number, deslocamento?: number}} filtros
 */
function pagamentos(filtros = {}) {
  const alvo = filtros.status ? String(filtros.status).toLowerCase() : null;
  if (alvo && !STATUS.includes(alvo)) {
    throw new ErroValidacao(`Status invalido. Use: ${STATUS.join(', ')}`);
  }

  const janela = montarJanela({ periodo: filtros.periodo, desde: filtros.desde, ate: filtros.ate });

  const { itens, total } = vendasRepo.listarPagamentosNoPeriodo({
    desde: janela.desde,
    ate: janela.ate,
    status: alvo,
    limite: filtros.limite || 25,
    deslocamento: filtros.deslocamento || 0
  });

  return {
    janela: janelaFormatada(janela),
    quantidade: itens.length,
    total,
    pagamentos: itens.map(venda => ({
      id: venda.id,
      numero: venda.numero,
      cliente: { nome: venda.clienteNome, email: venda.clienteEmail },
      status: venda.status,
      metodoPagamento: venda.metodoPagamento,
      metodoNome: nomeForma(venda.metodoPagamento),
      provedor: venda.provedorPagamento,
      provedorNome: venda.provedorPagamento ? nomeProvedor(venda.provedorPagamento) : null,
      pagamentoStatus: venda.pagamentoStatus,
      totalCentavos: venda.totalCentavos,
      total: paraReais(venda.totalCentavos),
      desconto: paraReais(venda.descontoCentavos),
      criadoEm: venda.criadoEm,
      pagoEm: venda.pagoEm
    }))
  };
}

module.exports = { STATUS, financeiro, pagamentos };
