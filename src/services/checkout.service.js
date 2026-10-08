/*
 * services/checkout.service.js
 * -----------------------------------------------------------------------------
 * O coracao da loja: transforma um carrinho em pedido pago com licencas
 * entregues. O fluxo foi desenhado para nunca cobrar sem registrar nem
 * registrar sem cobrar:
 *
 *   1. valida itens e precos (somente leitura)
 *   2. grava o pedido como PENDENTE (ja existe rastro)
 *   3. chama o provedor de pagamento
 *   4. aprovado  -> marca como PAGO e emite as licencas
 *      pendente  -> guarda as instrucoes (boleto) e espera confirmacao
 *      recusado  -> marca como CANCELADO
 *
 * Precos sao SEMPRE recalculados a partir do catalogo. O cliente envia apenas
 * ids e quantidades; qualquer valor vindo do navegador e ignorado.
 */
'use strict';

const config = require('../config');
const conexao = require('../db/conexao');
const produtosRepo = require('../repositories/produtos.repo');
const vendasRepo = require('../repositories/vendas.repo');
const licencasRepo = require('../repositories/licencas.repo');
const auditoriaRepo = require('../repositories/auditoria.repo');

const cupomService = require('./cupom.service');
const pagamentoService = require('./pagamento.service');
const gatewayService = require('./gateway.service');
const estoqueService = require('./estoque.service');
const atividadeService = require('./atividade.service');

const { ErroValidacao, NaoEncontrado, RegraNegocio, Indisponivel } = require('../utils/erros');
const { gerarCodigo, novoId } = require('../utils/seguranca');
const { agoraISO, formatarBR, daquiADias } = require('../utils/datas');
const { paraReais } = require('../utils/dinheiro');
const { lerInteiro } = require('../utils/validacao');
const logger = require('../utils/logger');
const eventos = require('../utils/eventos');

/* -------------------------------------------------------------------------- */
/* Validacao dos itens                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Resolve cada item do carrinho contra o catalogo, recalculando precos.
 * @returns {Array<{produto, plano, quantidade, subtotalCentavos}>}
 */
function resolverItens(itens) {
  if (!Array.isArray(itens) || itens.length === 0) {
    throw new ErroValidacao('Seu carrinho esta vazio');
  }
  if (itens.length > config.regras.maxItensPorPedido) {
    throw new ErroValidacao(`Um pedido pode ter no maximo ${config.regras.maxItensPorPedido} itens`);
  }

  // O mesmo produto nao pode aparecer duas vezes com planos diferentes.
  const vistos = new Set();
  const linhas = [];

  for (const item of itens) {
    if (!item || typeof item !== 'object') {
      throw new ErroValidacao('Item de carrinho invalido');
    }

    const produtoId = String(item.produtoId || '');
    if (!produtoId) throw new ErroValidacao('Item sem produto informado');

    const produto = produtosRepo.buscarPorId(produtoId);
    if (!produto || !produto.ativo) {
      throw new NaoEncontrado('Um dos produtos do carrinho nao esta mais disponivel');
    }

    const planoId = String(item.planoId || '');
    const plano = produtosRepo.buscarPlano(produto.id, planoId);
    if (!plano) {
      throw new ErroValidacao(`Escolha um plano valido para ${produto.nome}`, {
        planoId: 'Plano indisponivel'
      });
    }

    const quantidade = lerInteiro(item.quantidade, 1);
    if (!Number.isInteger(quantidade) || quantidade < 1 || quantidade > config.regras.maxQuantidadePorItem) {
      throw new ErroValidacao(`Quantidade invalida (de 1 a ${config.regras.maxQuantidadePorItem})`);
    }

    const chave = `${produto.id}:${plano.id}`;
    if (vistos.has(chave)) {
      throw new ErroValidacao(`O produto ${produto.nome} aparece duas vezes no carrinho`);
    }
    vistos.add(chave);

    linhas.push({
      produto,
      plano,
      quantidade,
      subtotalCentavos: plano.precoCentavos * quantidade
    });
  }

  return linhas;
}

/** Numero de pedido legivel e unico (tenta algumas vezes antes de desistir). */
function gerarNumeroUnico() {
  for (let tentativa = 0; tentativa < 10; tentativa += 1) {
    const numero = gerarCodigo('NX');
    if (!vendasRepo.buscarPorNumero(numero)) return numero;
  }
  // Fallback praticamente impossivel de acontecer: usa o timestamp.
  return `NX-${Date.now().toString(36).toUpperCase()}`;
}

/* -------------------------------------------------------------------------- */
/* Emissao de licencas                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Emite uma licenca por unidade comprada, CONSUMINDO as chaves do estoque.
 *
 * As chaves nao sao mais inventadas aqui: elas ja existem no pool
 * (estoque_chaves) e sao reservadas para este pedido. Se o pool nao cobrir a
 * quantidade, `consumir` lanca EstoqueInsuficiente e a transacao inteira e
 * desfeita — o pedido nao avanca com chave faltando.
 *
 * A validade NAO comeca a contar na compra: fica nula ate o cliente ativar a
 * chave. Assim quem compra um plano de 30 dias e so usa duas semanas depois
 * nao perde o periodo.
 *
 * Precisa rodar DENTRO de uma transacao (o consumo e o registro da licenca
 * andam juntos).
 */
function emitirLicencas(vendaId, usuarioId, linhas, itemIds) {
  const agora = agoraISO();
  const emitidas = [];

  linhas.forEach((linha, indice) => {
    const vendaItemId = itemIds[indice];

    const chaves = estoqueService.consumir(linha.produto.id, linha.plano.id, linha.quantidade, {
      vendaId,
      vendaItemId,
      produtoNome: linha.produto.nome,
      planoNome: linha.plano.nome
    });

    chaves.forEach(chave => {
      const licenca = {
        id: novoId(),
        chave,
        vendaId,
        vendaItemId,
        usuarioId,
        produtoId: linha.produto.id,
        planoId: linha.plano.id,
        status: 'ativa',
        // Nula enquanto nao ativada; definida no resgate conforme o plano.
        expiraEm: null,
        criadaEm: agora
      };

      licencasRepo.inserir(licenca);
      emitidas.push({ ...licenca, produtoNome: linha.produto.nome, planoNome: linha.plano.nome });
    });
  });

  return emitidas;
}

/**
 * Confere se o estoque cobre todas as linhas ANTES de gravar/cobrar. Falha cedo
 * com EstoqueInsuficiente para nao criar pedido que nao pode ser atendido.
 */
function conferirEstoque(linhas) {
  linhas.forEach(linha => {
    estoqueService.garantirDisponibilidade(linha.produto.id, linha.plano.id, linha.quantidade, {
      produtoNome: linha.produto.nome,
      planoNome: linha.plano.nome
    });
  });
}

/* -------------------------------------------------------------------------- */
/* Formatacao publica do pedido                                               */
/* -------------------------------------------------------------------------- */

/**
 * Converte o pedido interno no formato consumido pelo front.
 * Mantem os campos que a tela de sucesso ja usava: id, total, itens[].nome,
 * itens[].plano e itens[].chaves.
 */
function paraPublico(venda, itens, licencas = []) {
  if (!venda) return null;

  const porItem = new Map();
  licencas.forEach(licenca => {
    if (!porItem.has(licenca.vendaItemId)) porItem.set(licenca.vendaItemId, []);
    porItem.get(licenca.vendaItemId).push(licenca);
  });

  const itensPublicos = itens.map(item => ({
    produtoId: item.produtoId,
    nome: item.produtoNome,
    planoId: item.planoId,
    plano: item.planoNome,
    preco: paraReais(item.precoCentavos),
    quantidade: item.quantidade,
    subtotal: paraReais(item.subtotalCentavos),
    chaves: (porItem.get(item.id) || []).map(licenca => licenca.chave)
  }));

  return {
    id: venda.id,
    numero: venda.numero,
    cliente: venda.clienteNome || null,
    data: formatarBR(venda.criadoEm),
    status: venda.status,
    itens: itensPublicos,
    subtotal: paraReais(venda.subtotalCentavos),
    desconto: paraReais(venda.descontoCentavos),
    total: paraReais(venda.totalCentavos),
    cupom: venda.cupomCodigo,
    metodoPagamento: venda.metodoPagamento,
    provedorPagamento: venda.provedorPagamento,
    pagamentoStatus: venda.pagamentoStatus,
    /*
     * Instrucoes de pagamento (Pix copia-e-cola, linha digitavel do boleto,
     * link do gateway) so fazem sentido enquanto o pedido esta pendente —
     * depois de pago, some da resposta. Ficam guardadas no pedido, entao o
     * cliente consegue reabrir o boleto em /conta mesmo dias depois.
     */
    instrucoesPagamento: venda.status === 'pendente' ? (venda.instrucoesPagamento || null) : null,
    pagoEm: venda.pagoEm,
    criadoEm: venda.criadoEm,
    // Lista achatada de chaves: comodo para "copiar tudo" de uma vez.
    chaves: itensPublicos.flatMap(item => item.chaves)
  };
}

/** Monta o pedido publico completo a partir do id (usado em varias rotas). */
function obterPedido(vendaId) {
  const venda = vendasRepo.buscarPorId(vendaId);
  if (!venda) throw new NaoEncontrado('Pedido nao encontrado');

  return paraPublico(venda, vendasRepo.listarItens(vendaId), licencasRepo.listarDaVenda(vendaId));
}

/* -------------------------------------------------------------------------- */
/* Finalizacao                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Decide a forma de pagamento quando o cliente nao escolheu nenhuma: usa a
 * padrao configurada NO PAINEL (aba Gateways), com o `PAGAMENTO_METODO_PADRAO`
 * do .env como fallback; senao, a primeira disponivel. Nunca devolve algo que
 * ninguem cobra.
 */
function escolherMetodo(metodoPagamento) {
  const informado = String(metodoPagamento || '').toLowerCase();
  if (informado) return informado;

  // `metodosDisponiveis().padrao` ja resolve painel > .env e so devolve uma
  // forma que algum gateway ativo aceita (ou null se nao houver nenhum).
  const disponiveis = gatewayService.metodosDisponiveis();
  return disponiveis.padrao || gatewayService.metodoPadrao();
}

/**
 * Finaliza a compra.
 *
 * @param {object} entrada
 * @param {object} entrada.usuario           usuario logado
 * @param {Array}  entrada.itens             [{ produtoId, planoId, quantidade }]
 * @param {string} [entrada.cupomCodigo]
 * @param {string} [entrada.metodoPagamento] pix | cartao | boleto
 * @param {string} [entrada.gatewayId]       forca um gateway especifico
 * @param {object} [entrada.pagador]         { nome, email, documento }
 * @param {string} [entrada.cartaoToken]     token de cartao gerado no navegador
 * @param {string} [entrada.ip]
 * @returns {Promise<object>} pedido no formato publico
 */
async function finalizar({
  usuario,
  itens,
  cupomCodigo = null,
  metodoPagamento = null,
  gatewayId = null,
  pagador = null,
  cartaoToken = null,
  ip = null
}) {
  /* 1. Valida tudo antes de escrever qualquer coisa ---------------------- */
  const linhas = resolverItens(itens);
  // Estoque e a fonte da verdade: sem chave suficiente, a venda e bloqueada
  // aqui, antes mesmo de existir um pedido no banco.
  conferirEstoque(linhas);

  const subtotalCentavos = linhas.reduce((soma, linha) => soma + linha.subtotalCentavos, 0);

  let descontoCentavos = 0;
  let cupomAplicado = null;
  if (cupomCodigo) {
    const resultado = cupomService.validar(cupomCodigo, subtotalCentavos);
    descontoCentavos = resultado.descontoCentavos;
    cupomAplicado = resultado.cupom.codigo;
  }

  const totalCentavos = Math.max(subtotalCentavos - descontoCentavos, 0);

  /*
   * 1b. Decide QUEM cobra antes de gravar o pedido. Se nenhum gateway ativo
   * aceita a forma escolhida, falhamos agora — melhor do que criar um pedido
   * que nunca poderia ser pago.
   */
  const metodo = escolherMetodo(metodoPagamento);
  const resolvido = gatewayService.resolverMetodo(metodo, { gatewayId });

  /* 2. Grava o pedido como pendente -------------------------------------- */
  const vendaId = novoId();
  const numero = gerarNumeroUnico();
  const agora = agoraISO();
  const itemIds = linhas.map(() => novoId());

  conexao.transacao(() => {
    vendasRepo.inserirVenda({
      id: vendaId,
      numero,
      usuarioId: usuario.id,
      status: 'pendente',
      subtotalCentavos,
      descontoCentavos,
      totalCentavos,
      cupomCodigo: cupomAplicado,
      metodoPagamento: metodo,
      provedorPagamento: resolvido.gatewayId,
      pagamentoId: null,
      pagamentoStatus: 'processando',
      pagoEm: null,
      criadoEm: agora,
      atualizadoEm: agora
    });

    linhas.forEach((linha, indice) => {
      vendasRepo.inserirItem({
        id: itemIds[indice],
        vendaId,
        produtoId: linha.produto.id,
        produtoNome: linha.produto.nome,
        planoId: linha.plano.id,
        planoNome: linha.plano.nome,
        precoCentavos: linha.plano.precoCentavos,
        quantidade: linha.quantidade,
        subtotalCentavos: linha.subtotalCentavos
      });
    });
  });

  /* 3. Cobra ------------------------------------------------------------- */
  let pagamento;
  try {
    pagamento = await pagamentoService.cobrar({
      valorCentavos: totalCentavos,
      metodo,
      referencia: numero,
      descricao: `${config.loja.nome} - pedido ${numero}`,
      // Dados do comprador: alguns gateways exigem nome/e-mail/documento.
      pagador: pagador || { nome: usuario.nome, email: usuario.email },
      cartaoToken,
      gatewayId: resolvido.gatewayId
    });
  } catch (erro) {
    // Pagamento indisponivel: o pedido fica cancelado, nunca "pago no escuro".
    conexao.transacao(() => {
      conexao.executar(
        "UPDATE vendas SET status = 'cancelado', pagamento_status = 'erro', atualizado_em = @agora WHERE id = @id",
        { agora: agoraISO(), id: vendaId }
      );
    });
    logger.error('Falha ao processar pagamento', { vendaId, erro: erro.message });
    throw erro;
  }

  /* 4. Aprovado, pendente ou recusado ------------------------------------ */
  const aprovado = pagamentoService.estaAprovado(pagamento.status);

  conexao.transacao(() => {
    conexao.executar(`
      UPDATE vendas
      SET status = @status,
          pagamento_id = @pagamentoId,
          pagamento_status = @pagamentoStatus,
          pago_em = @pagoEm,
          atualizado_em = @atualizadoEm
      WHERE id = @id
    `, {
      id: vendaId,
      status: aprovado ? 'pago' : 'pendente',
      pagamentoId: pagamento.id,
      pagamentoStatus: pagamento.status,
      pagoEm: aprovado ? agoraISO() : null,
      atualizadoEm: agoraISO()
    });

    if (aprovado) {
      emitirLicencas(vendaId, usuario.id, linhas, itemIds);
      // O cupom so e consumido quando o pagamento confirma.
      if (cupomAplicado) cupomService.consumir(cupomAplicado);
    }
  });

  /* 5. Avisa quem estiver ouvindo (painel aberto) ------------------------ */
  // Fora da transacao: o evento so faz sentido depois que o commit aconteceu.
  if (aprovado) {
    linhas.forEach(linha => estoqueService.anunciarPlano(linha.produto.id, linha.plano.id));
  }
  eventos.publicar('venda.atualizada', { vendaId, numero, status: aprovado ? 'pago' : 'pendente' });

  auditoriaRepo.registrar({
    atorId: usuario.id,
    acao: aprovado ? 'pedido.pago' : 'pedido.criado',
    entidade: 'venda',
    entidadeId: vendaId,
    dados: { numero, totalCentavos, metodo, itens: linhas.length, cupom: cupomAplicado },
    ip
  });

  // Historico do cliente: um pedido sempre entra; o pagamento aprovado entra
  // como um segundo marco, porque sao dois momentos distintos para quem compra.
  const descricaoItens = linhas.length === 1
    ? `${linhas[0].produto.nome} · ${linhas[0].plano.nome}`
    : `${linhas.length} itens`;

  atividadeService.registrar(usuario.id, {
    tipo: 'pedido_criado',
    titulo: `Pedido ${numero} realizado`,
    descricao: `${descricaoItens} · ${paraReais(totalCentavos)}`,
    referenciaId: vendaId,
    ip
  });

  if (aprovado) {
    atividadeService.registrar(usuario.id, {
      tipo: 'pedido_pago',
      titulo: `Pagamento do pedido ${numero} aprovado`,
      descricao: 'Suas chaves já estão disponíveis na área da conta.',
      referenciaId: vendaId,
      ip
    });
  }

  /*
   * Guarda as instrucoes no proprio pedido. Sem isso, quem fecha o carrinho com
   * boleto perde a linha digitavel para sempre — ela so existia nesta resposta.
   */
  if (!aprovado && pagamento.instrucoes) {
    vendasRepo.definirInstrucoesPagamento(vendaId, pagamento.instrucoes);
  }

  const pedido = obterPedido(vendaId);

  // Instrucoes de pagamento so fazem sentido enquanto o pedido nao foi pago.
  if (!aprovado) {
    pedido.mensagem = 'Pedido registrado. Assim que o pagamento for confirmado, as chaves sao liberadas.';
  }

  return pedido;
}

/**
 * Confirma manualmente um pagamento pendente (boleto em ambiente simulado).
 * Em producao quem chama isso e o webhook do provedor, nao o cliente.
 */
function confirmarPagamento(vendaId, { ip = null, atorId = null } = {}) {
  const venda = vendasRepo.buscarPorId(vendaId);
  if (!venda) throw new NaoEncontrado('Pedido nao encontrado');

  if (venda.status === 'pago') {
    return { pedido: obterPedido(vendaId), jaEstavaPago: true };
  }
  if (venda.status !== 'pendente') {
    throw new RegraNegocio(`Nao e possivel confirmar um pedido com status "${venda.status}"`);
  }

  const itens = vendasRepo.listarItens(vendaId);

  // Reconstroi as linhas para emitir as licencas com os dados do catalogo.
  const linhas = itens.map(item => {
    const produto = produtosRepo.buscarPorId(item.produtoId);
    return {
      produto: produto || { id: item.produtoId, nome: item.produtoNome },
      plano: { id: item.planoId, nome: item.planoNome, precoCentavos: item.precoCentavos, dias: null },
      quantidade: item.quantidade,
      subtotalCentavos: item.subtotalCentavos
    };
  });

  // O boleto pode ficar dias pendente: o estoque que existia na compra pode ter
  // acabado. Reconfere antes de liberar as chaves.
  conferirEstoque(linhas);

  conexao.transacao(() => {
    conexao.executar(`
      UPDATE vendas
      SET status = 'pago', pagamento_status = 'aprovado', pago_em = @pagoEm,
          instrucoes_pagamento = NULL, atualizado_em = @agora
      WHERE id = @id
    `, { id: vendaId, pagoEm: agoraISO(), agora: agoraISO() });

    emitirLicencas(vendaId, venda.usuarioId, linhas, itens.map(item => item.id));
    if (venda.cupomCodigo) cupomService.consumir(venda.cupomCodigo);
  });

  linhas.forEach(linha => estoqueService.anunciarPlano(linha.produto.id, linha.plano.id));
  eventos.publicar('venda.atualizada', { vendaId, numero: venda.numero, status: 'pago' });

  auditoriaRepo.registrar({
    atorId,
    acao: 'pagamento.confirmado',
    entidade: 'venda',
    entidadeId: vendaId,
    dados: { numero: venda.numero },
    ip
  });

  atividadeService.registrar(venda.usuarioId, {
    tipo: 'pedido_pago',
    titulo: `Pagamento do pedido ${venda.numero} aprovado`,
    descricao: 'Suas chaves já estão disponíveis na área da conta.',
    referenciaId: vendaId,
    ip
  });

  return { pedido: obterPedido(vendaId), jaEstavaPago: false };
}

/*
 * Cancela um pedido e revoga as licencas, se houver.
 *
 * SOMENTE pedido PENDENTE pode ser cancelado — e esta trava e a diferenca entre
 * uma loja e um vazamento de estoque. Um pedido pago ja entregou a chave ao
 * cliente; cancelar aqui devolveria a chave ao pool (revendavel) enquanto o
 * cliente continua com ela em maos. Para desfazer uma venda paga existe
 * `reembolsar`, que estorna no gateway ANTES de revogar.
 */
function cancelar(vendaId, { motivo = 'cancelado pelo cliente', ip = null, atorId = null } = {}) {
  const venda = vendasRepo.buscarPorId(vendaId);
  if (!venda) throw new NaoEncontrado('Pedido nao encontrado');

  if (venda.status === 'cancelado') {
    throw new RegraNegocio('Este pedido ja esta cancelado');
  }

  if (venda.status === 'pago') {
    throw new RegraNegocio(
      'Pedido pago nao pode ser cancelado: use o reembolso, que estorna o valor e revoga as licencas'
    );
  }

  if (venda.status !== 'pendente') {
    throw new RegraNegocio(`Nao e possivel cancelar um pedido com status "${venda.status}"`);
  }

  conexao.transacao(() => {
    conexao.executar(
      "UPDATE vendas SET status = 'cancelado', instrucoes_pagamento = NULL, atualizado_em = @agora WHERE id = @id",
      { agora: agoraISO(), id: vendaId }
    );
    licencasRepo.revogarDaVenda(vendaId);
    // Pedido pendente nao consumiu chave nenhuma (revogarDaVenda nao acha
    // nada); pedido pago ja consumiu e as chaves saem da conta de vendidas.
    estoqueService.revogarDaVenda(vendaId, { atorId });
  });

  eventos.publicar('venda.atualizada', { vendaId, numero: venda.numero, status: 'cancelado' });

  auditoriaRepo.registrar({ atorId, acao: 'pedido.cancelado', entidade: 'venda', entidadeId: vendaId, dados: { motivo }, ip });

  atividadeService.registrar(venda.usuarioId, {
    tipo: 'pedido_cancelado',
    titulo: `Pedido ${venda.numero} cancelado`,
    descricao: motivo,
    referenciaId: vendaId,
    ip
  });

  return obterPedido(vendaId);
}

/** Estorna: devolve o dinheiro no gateway e revoga as licencas. */
async function reembolsar(vendaId, { motivo = 'reembolso solicitado', ip = null, atorId = null } = {}) {
  const venda = vendasRepo.buscarPorId(vendaId);
  if (!venda) throw new NaoEncontrado('Pedido nao encontrado');
  if (venda.status !== 'pago') {
    throw new RegraNegocio('So e possivel reembolsar pedidos pagos');
  }

  /*
   * 1. Estorna no gateway ANTES de marcar o pedido. Se o provedor recusar, o
   *    pedido continua "pago" — melhor do que anunciar um reembolso que o
   *    dinheiro nunca voltou. O gateway simulado sempre aprova.
   */
  const estorno = await pagamentoService.reembolsar({
    pagamentoId: venda.pagamentoId,
    valorCentavos: venda.totalCentavos,
    gatewayId: venda.provedorPagamento,
    metodo: venda.metodoPagamento
  });

  if (!estorno.ok) {
    throw new Indisponivel(`O gateway recusou o estorno: ${estorno.motivo || 'motivo desconhecido'}`);
  }

  /* 2. Marca o pedido e revoga as chaves. */
  conexao.transacao(() => {
    conexao.executar(
      "UPDATE vendas SET status = 'reembolsado', atualizado_em = @agora WHERE id = @id",
      { agora: agoraISO(), id: vendaId }
    );
    licencasRepo.revogarDaVenda(vendaId);
    // As chaves entregues saem do estoque como "revogadas": nao voltam a ser
    // vendidas (o cliente ja as viu), mas param de contar como vendidas.
    estoqueService.revogarDaVenda(vendaId, { atorId });
  });

  eventos.publicar('venda.atualizada', { vendaId, numero: venda.numero, status: 'reembolsado' });

  auditoriaRepo.registrar({
    atorId,
    acao: 'pedido.reembolsado',
    entidade: 'venda',
    entidadeId: vendaId,
    dados: { motivo, gateway: venda.provedorPagamento, estornoSimulado: !!estorno.simuladoLocal },
    ip
  });

  atividadeService.registrar(venda.usuarioId, {
    tipo: 'pedido_reembolsado',
    titulo: `Pedido ${venda.numero} reembolsado`,
    descricao: 'O valor foi estornado e as chaves foram revogadas.',
    referenciaId: vendaId,
    ip
  });

  return obterPedido(vendaId);
}

/* -------------------------------------------------------------------------- */
/* Consultas                                                                  */
/* -------------------------------------------------------------------------- */

/** Pedidos do cliente no formato que o front ja conhecia. */
function meusPedidos(usuarioId, { limite = 50, deslocamento = 0 } = {}) {
  const vendas = vendasRepo.listarDoUsuario(usuarioId, { limite, deslocamento });

  const itensPorVenda = new Map(vendas.map(venda => [venda.id, venda.itens]));
  const pedidos = vendas.map(venda => {
    const itens = itensPorVenda.get(venda.id) || [];
    return paraPublico(venda, itens, licencasRepo.listarDaVenda(venda.id));
  });

  const total = pedidos
    .filter(pedido => pedido.status === 'pago')
    .reduce((soma, pedido) => soma + pedido.total, 0);

  return {
    quantidade: pedidos.length,
    total: Math.round(total * 100) / 100,
    vendas: pedidos
  };
}

/** Busca um pedido garantindo que ele pertence ao usuario (ou que e admin). */
function pedidoDoUsuario(vendaId, usuario) {
  const venda = vendasRepo.buscarPorId(vendaId);
  if (!venda) throw new NaoEncontrado('Pedido nao encontrado');

  const dono = venda.usuarioId === usuario.id;
  if (!dono && usuario.papel !== 'admin') {
    // Mesma resposta de "nao existe": nao confirma a existencia do pedido alheio.
    throw new NaoEncontrado('Pedido nao encontrado');
  }

  return paraPublico(venda, vendasRepo.listarItens(vendaId), licencasRepo.listarDaVenda(vendaId));
}

module.exports = {
  resolverItens,
  emitirLicencas,
  paraPublico,
  obterPedido,
  finalizar,
  confirmarPagamento,
  cancelar,
  reembolsar,
  meusPedidos,
  pedidoDoUsuario
};
