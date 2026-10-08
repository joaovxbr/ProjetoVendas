/*
 * services/admin.service.js
 * -----------------------------------------------------------------------------
 * Operacoes administrativas: painel com numeros, gestao de pedidos, usuarios,
 * catalogo, cupons e configuracoes da loja.
 *
 * Toda acao sensivel passa por aqui (e nao direto pelo repositorio) para que
 * fique registrada na trilha de auditoria com o id de quem executou.
 */
'use strict';

const produtosRepo = require('../repositories/produtos.repo');
const vendasRepo = require('../repositories/vendas.repo');
const usuariosRepo = require('../repositories/usuarios.repo');
const licencasRepo = require('../repositories/licencas.repo');
const cuponsRepo = require('../repositories/cupons.repo');
const avaliacoesRepo = require('../repositories/avaliacoes.repo');
const favoritosRepo = require('../repositories/favoritos.repo');
const auditoriaRepo = require('../repositories/auditoria.repo');
const configuracoesRepo = require('../repositories/configuracoes.repo');
const { invalidarCache: invalidarCacheManutencao } = require('../middlewares/manutencao');

const catalogoService = require('./catalogo.service');
const checkoutService = require('./checkout.service');
const licencaService = require('./licenca.service');
const estoqueService = require('./estoque.service');
const configuracoesService = require('./configuracoes.service');

const { ErroValidacao, NaoEncontrado, Conflito, RegraNegocio } = require('../utils/erros');
const { paraCentavos, paraReais } = require('../utils/dinheiro');
const { exigirTexto, exigirSlug, normalizarSlug, textoOpcional, lerBooleano, exigirInteiro } = require('../utils/validacao');
const { idEstavel, novoId } = require('../utils/seguranca');
const { agoraISO } = require('../utils/datas');
const eventos = require('../utils/eventos');
const config = require('../config');

const STATUS_VENDA = ['pendente', 'pago', 'cancelado', 'reembolsado'];

/* -------------------------------------------------------------------------- */
/* Painel                                                                     */
/* -------------------------------------------------------------------------- */

/** Numeros gerais da loja para o dashboard. */
function painel({ dias = 30 } = {}) {
  const financeiro = vendasRepo.resumoFinanceiro();
  const estoque = estoqueService.resumo();

  return {
    financeiro: {
      pedidos: financeiro.pedidos,
      receitaCentavos: financeiro.receitaCentavos,
      receita: paraReais(financeiro.receitaCentavos),
      descontos: paraReais(financeiro.descontosCentavos),
      ticketMedioCentavos: financeiro.ticketMedioCentavos,
      ticketMedio: paraReais(financeiro.ticketMedioCentavos)
    },
    catalogo: {
      produtos: produtosRepo.contar({ incluirInativos: true }),
      ativos: produtosRepo.contar(),
      categorias: produtosRepo.listarCategorias().length
    },
    clientes: {
      total: usuariosRepo.contar(),
      porPapel: usuariosRepo.contarPorPapel()
    },
    licencas: licencasRepo.contarPorStatus(),
    // Estoque no mesmo resumo: e o que permite o painel mostrar os alertas de
    // reposicao sem uma segunda chamada.
    estoque: {
      disponivel: estoque.totais.disponivel,
      vendida: estoque.totais.vendida,
      descartada: estoque.totais.descartada,
      revogada: estoque.totais.revogada,
      total: estoque.totais.total,
      esgotados: estoque.resumoAlertas.esgotados,
      baixos: estoque.resumoAlertas.baixos,
      alertas: estoque.alertas.slice(0, 6).map(plano => ({
        produtoId: plano.produtoId,
        produto: plano.produtoNome,
        planoId: plano.planoId,
        plano: plano.planoNome,
        disponivel: plano.disponivel,
        minimo: plano.estoqueMinimo,
        esgotado: plano.esgotado
      }))
    },
    avaliacoes: avaliacoesRepo.contar(),
    pedidos: {
      total: vendasRepo.contarTodos(),
      pendentes: vendasRepo.contarTodos({ status: 'pendente' })
    },
    receitaPorDia: vendasRepo.receitaPorDia(dias),
    topProdutos: vendasRepo.produtosMaisVendidos(5).map(produto => ({
      ...produto,
      receita: paraReais(produto.receitaCentavos)
    })),
    ultimasAvaliacoes: avaliacoesRepo.listarRecentes(5)
  };
}

/* -------------------------------------------------------------------------- */
/* Pedidos                                                                    */
/* -------------------------------------------------------------------------- */

function listarPedidos({ status = null, limite = 50, deslocamento = 0 } = {}) {
  if (status && !STATUS_VENDA.includes(status)) {
    throw new ErroValidacao(`Status invalido. Use: ${STATUS_VENDA.join(', ')}`);
  }

  const pedidos = vendasRepo.listarTodos({ status, limite, deslocamento });

  return {
    quantidade: pedidos.length,
    total: vendasRepo.contarTodos({ status }),
    pedidos: pedidos.map(venda => ({
      id: venda.id,
      numero: venda.numero,
      cliente: { nome: venda.clienteNome, email: venda.clienteEmail },
      status: venda.status,
      metodoPagamento: venda.metodoPagamento,
      total: paraReais(venda.totalCentavos),
      desconto: paraReais(venda.descontoCentavos),
      cupom: venda.cupomCodigo,
      criadoEm: venda.criadoEm
    }))
  };
}

function detalharPedido(vendaId) {
  const pedido = checkoutService.obterPedido(vendaId);
  const venda = vendasRepo.buscarPorId(vendaId);
  const cliente = usuariosRepo.buscarPorId(venda.usuarioId);

  return {
    ...pedido,
    cliente: cliente ? { id: cliente.id, nome: cliente.nome, email: cliente.email } : null,
    licencas: licencasRepo.listarDaVenda(vendaId).map(licenca => ({
      chave: licenca.chave,
      status: licenca.status,
      produtoId: licenca.produtoId,
      planoId: licenca.planoId
    })),
    historico: auditoriaRepo.listarDaEntidade('venda', vendaId)
  };
}

/** Muda o status de um pedido aplicando as consequencias de cada transicao. */
async function mudarStatusPedido(vendaId, novoStatus, ator, { motivo = '', ip = null } = {}) {
  if (!STATUS_VENDA.includes(novoStatus)) {
    throw new ErroValidacao(`Status invalido. Use: ${STATUS_VENDA.join(', ')}`);
  }

  const venda = vendasRepo.buscarPorId(vendaId);
  if (!venda) throw new NaoEncontrado('Pedido nao encontrado');

  if (venda.status === novoStatus) {
    throw new RegraNegocio(`O pedido ja esta com status "${novoStatus}"`);
  }

  switch (novoStatus) {
    case 'pago':
      return checkoutService.confirmarPagamento(vendaId, { atorId: ator.id, ip }).pedido;
    case 'cancelado':
      return checkoutService.cancelar(vendaId, { motivo: motivo || 'cancelado pela administracao', atorId: ator.id, ip });
    case 'reembolsado':
      // Assincrono porque o estorno pode chamar o gateway de pagamento.
      return await checkoutService.reembolsar(vendaId, { motivo: motivo || 'reembolsado pela administracao', atorId: ator.id, ip });
    default:
      vendasRepo.atualizarStatus(vendaId, novoStatus);
      auditoriaRepo.registrar({ atorId: ator.id, acao: 'pedido.status_alterado', entidade: 'venda', entidadeId: vendaId, dados: { de: venda.status, para: novoStatus, motivo }, ip });
      return checkoutService.obterPedido(vendaId);
  }
}

/* -------------------------------------------------------------------------- */
/* Usuarios                                                                   */
/* -------------------------------------------------------------------------- */

function listarUsuarios({ busca = '', limite = 50, deslocamento = 0 } = {}) {
  const usuarios = usuariosRepo.listar({ busca, limite, deslocamento });

  return {
    quantidade: usuarios.length,
    total: usuariosRepo.contar({ busca }),
    usuarios: usuarios.map(usuario => ({
      id: usuario.id,
      nome: usuario.nome,
      email: usuario.email,
      papel: usuario.papel,
      ativo: usuario.ativo,
      criadoEm: usuario.criadoEm,
      ultimoLoginEm: usuario.ultimoLoginEm,
      pedidos: vendasRepo.contarDoUsuario(usuario.id),
      gasto: paraReais(vendasRepo.totalGastoDoUsuario(usuario.id)),
      licencas: licencasRepo.listarDoUsuario(usuario.id).length
    }))
  };
}

function mudarPapel(usuarioId, papel, ator, { ip = null } = {}) {
  if (!['cliente', 'admin'].includes(papel)) {
    throw new ErroValidacao('Papel invalido. Use "cliente" ou "admin"');
  }
  const usuario = usuariosRepo.buscarPorId(usuarioId);
  if (!usuario) throw new NaoEncontrado('Usuario nao encontrado');

  // Evita que o admin se rebaixe e perca o acesso sem querer.
  if (usuario.id === ator.id && papel !== 'admin') {
    throw new RegraNegocio('Voce nao pode remover o seu proprio acesso de administrador');
  }

  usuariosRepo.definirPapel(usuarioId, papel);
  auditoriaRepo.registrar({ atorId: ator.id, acao: 'usuario.papel_alterado', entidade: 'usuario', entidadeId: usuarioId, dados: { de: usuario.papel, para: papel }, ip });

  return { id: usuarioId, papel };
}

function mudarAtivo(usuarioId, ativo, ator, { ip = null } = {}) {
  const usuario = usuariosRepo.buscarPorId(usuarioId);
  if (!usuario) throw new NaoEncontrado('Usuario nao encontrado');

  if (usuario.id === ator.id) {
    throw new RegraNegocio('Voce nao pode desativar a sua propria conta');
  }

  usuariosRepo.definirAtivo(usuarioId, ativo);
  // Conta desativada nao pode continuar com sessao aberta.
  if (!ativo) require('../repositories/sessoes.repo').removerDoUsuario(usuarioId);

  auditoriaRepo.registrar({ atorId: ator.id, acao: ativo ? 'usuario.ativado' : 'usuario.desativado', entidade: 'usuario', entidadeId: usuarioId, ip });
  return { id: usuarioId, ativo: !!ativo };
}

/**
 * Ficha completa do cliente (alimenta o painel lateral de "Clientes"):
 * dados cadastrais, resumo financeiro, pedidos e chaves.
 */
function detalharUsuario(usuarioId) {
  const usuario = usuariosRepo.buscarPorId(usuarioId);
  if (!usuario) throw new NaoEncontrado('Usuario nao encontrado');

  const pedidos = vendasRepo.listarDoUsuario(usuarioId, { limite: 50 });
  const licencas = licencasRepo.listarDoUsuario(usuarioId);

  return {
    id: usuario.id,
    nome: usuario.nome,
    email: usuario.email,
    papel: usuario.papel,
    ativo: usuario.ativo,
    criadoEm: usuario.criadoEm,
    ultimoLoginEm: usuario.ultimoLoginEm,
    resumo: {
      pedidos: vendasRepo.contarDoUsuario(usuarioId),
      gastoCentavos: vendasRepo.totalGastoDoUsuario(usuarioId),
      gasto: paraReais(vendasRepo.totalGastoDoUsuario(usuarioId)),
      licencas: licencas.length,
      licencasAtivas: licencas.filter(licenca => licenca.status === 'ativa').length
    },
    pedidos: pedidos.map(venda => ({
      id: venda.id,
      numero: venda.numero,
      status: venda.status,
      totalCentavos: venda.totalCentavos,
      total: paraReais(venda.totalCentavos),
      criadoEm: venda.criadoEm,
      itens: (venda.itens || []).map(item => ({
        produtoId: item.produtoId,
        nome: item.produtoNome,
        plano: item.planoNome,
        quantidade: item.quantidade
      }))
    })),
    licencas: licencas.map(licenca => ({
      id: licenca.id,
      chave: licenca.chave,
      produtoId: licenca.produtoId,
      planoId: licenca.planoId,
      status: licenca.status,
      criadaEm: licenca.criadaEm,
      expiraEm: licenca.expiraEm
    }))
  };
}

/* -------------------------------------------------------------------------- */
/* Catalogo                                                                   */
/* -------------------------------------------------------------------------- */

const ICONES = ['raio', 'mira', 'teclado', 'camadas', 'vassoura', 'chip', 'sinal', 'escudo'];

function validarPlanos(planos, { obrigatorio = true } = {}) {
  if (planos === undefined) {
    if (obrigatorio) throw new ErroValidacao('Informe pelo menos um plano', { planos: 'Obrigatorio' });
    return null;
  }
  if (!Array.isArray(planos) || planos.length === 0) {
    throw new ErroValidacao('Informe pelo menos um plano', { planos: 'Informe ao menos um plano' });
  }
  if (planos.length > 8) {
    throw new ErroValidacao('Maximo de 8 planos por produto');
  }

  const ids = new Set();
  return planos.map((plano, indice) => {
    if (!plano || typeof plano !== 'object') {
      throw new ErroValidacao(`Plano ${indice + 1} invalido`);
    }

    const id = normalizarSlug(plano.id || plano.nome || `plano-${indice + 1}`);
    if (!id) throw new ErroValidacao(`Plano ${indice + 1} precisa de um identificador`);
    if (ids.has(id)) throw new ErroValidacao(`O plano "${id}" aparece duas vezes`);
    ids.add(id);

    // Aceita preco em reais ("preco") ou ja em centavos ("precoCentavos").
    let precoCentavos;
    if (plano.precoCentavos !== undefined) {
      precoCentavos = exigirInteiro(plano.precoCentavos, 'preco', { rotulo: 'Preco', min: 0, max: 100000000 });
    } else {
      precoCentavos = paraCentavos(plano.preco);
      if (!Number.isFinite(precoCentavos) || precoCentavos < 0) {
        throw new ErroValidacao(`Preco invalido no plano "${id}"`);
      }
    }

    const dias = plano.dias === null || plano.dias === undefined || plano.dias === ''
      ? null
      : exigirInteiro(plano.dias, 'dias', { rotulo: 'Dias', min: 1, max: 3650 });

    return {
      id,
      nome: exigirTexto(plano.nome, 'nome', { rotulo: 'Nome do plano', min: 1, max: 40 }),
      precoCentavos,
      dias,
      ordem: indice
    };
  });
}

function montarDadosProduto(dados, { parcial = false } = {}) {
  const saida = {};

  if (dados.nome !== undefined || !parcial) {
    saida.nome = exigirTexto(dados.nome, 'nome', { rotulo: 'Nome', min: 2, max: 80 });
  }
  if (dados.categoria !== undefined || !parcial) {
    saida.categoria = exigirTexto(dados.categoria, 'categoria', { rotulo: 'Categoria', min: 2, max: 40 });
  }
  if (dados.slug !== undefined) {
    saida.slug = exigirSlug(dados.slug);
  } else if (saida.nome && !parcial) {
    saida.slug = normalizarSlug(saida.nome);
  }

  if (dados.linha !== undefined) saida.linha = textoOpcional(dados.linha, 'linha', { rotulo: 'Linha', max: 40 });
  if (dados.nivel !== undefined) saida.nivel = textoOpcional(dados.nivel, 'nivel', { rotulo: 'Nivel', max: 40 });
  if (dados.descricao !== undefined) saida.descricao = textoOpcional(dados.descricao, 'descricao', { rotulo: 'Descricao', max: 600 });
  if (dados.descricaoLonga !== undefined) saida.descricaoLonga = textoOpcional(dados.descricaoLonga, 'descricaoLonga', { rotulo: 'Descricao completa', max: 4000 });
  if (dados.badge !== undefined) saida.badge = textoOpcional(dados.badge, 'badge', { rotulo: 'Selo', max: 30 });
  if (dados.plataforma !== undefined) saida.plataforma = textoOpcional(dados.plataforma, 'plataforma', { rotulo: 'Plataforma', max: 40 }) || 'Windows';
  if (dados.entrega !== undefined) saida.entrega = textoOpcional(dados.entrega, 'entrega', { rotulo: 'Entrega', max: 40 }) || 'Automatica';

  if (dados.recursos !== undefined) {
    if (!Array.isArray(dados.recursos)) throw new ErroValidacao('Recursos deve ser uma lista');
    saida.recursos = dados.recursos
      .slice(0, 20)
      .map(recurso => textoOpcional(recurso, 'recursos', { rotulo: 'Recurso', max: 120 }))
      .filter(Boolean);
  }

  if (dados.capa !== undefined) {
    const icone = dados.capa && typeof dados.capa === 'object' ? dados.capa.icone : null;
    if (icone && !ICONES.includes(icone)) {
      throw new ErroValidacao(`Icone invalido. Use um destes: ${ICONES.join(', ')}`, { capa: 'Icone desconhecido' });
    }
    saida.capa = { icone: icone || 'raio' };
  }

  if (dados.imagem !== undefined) {
    const imagem = textoOpcional(dados.imagem, 'imagem', { rotulo: 'Imagem', max: 300 });
    // Caminho local ("/img/...") ou URL absoluta. Nada de javascript:/data:.
    if (imagem && !/^\/[^\s]*$/.test(imagem) && !/^https:\/\/[^\s]+$/.test(imagem)) {
      throw new ErroValidacao('A imagem deve ser um caminho iniciado por "/" ou uma URL https');
    }
    saida.imagem = imagem || null;
  }

  if (dados.destaque !== undefined) saida.destaque = lerBooleano(dados.destaque, false);
  if (dados.ativo !== undefined) saida.ativo = lerBooleano(dados.ativo, true);
  if (dados.ordem !== undefined) saida.ordem = exigirInteiro(dados.ordem, 'ordem', { rotulo: 'Ordem', min: 0, max: 9999 });

  return saida;
}

function criarProduto(dados, ator, { ip = null } = {}) {
  const base = montarDadosProduto(dados);
  const planos = validarPlanos(dados.planos);

  if (produtosRepo.buscarPorSlug(base.slug)) {
    throw new Conflito(`Ja existe um produto com o slug "${base.slug}"`);
  }

  const produto = produtosRepo.criar({
    id: idEstavel(base.slug),
    ...base,
    recursos: base.recursos || [],
    capa: base.capa || { icone: 'raio' },
    ordem: base.ordem ?? produtosRepo.proximaOrdem(),
    notaBase: 0,
    totalBase: 0
  });

  produtosRepo.substituirPlanos(produto.id, planos);
  auditoriaRepo.registrar({ atorId: ator.id, acao: 'produto.criado', entidade: 'produto', entidadeId: produto.id, dados: { slug: produto.slug }, ip });

  eventos.publicar('produto.atualizado', { produtoId: produto.id, acao: 'criado' });

  return catalogoService.paraPublico(produtosRepo.buscarPorId(produto.id));
}

function atualizarProduto(produtoId, dados, ator, { ip = null } = {}) {
  const existente = produtosRepo.buscarPorId(produtoId);
  if (!existente) throw new NaoEncontrado('Produto nao encontrado');

  const alteracoes = montarDadosProduto(dados, { parcial: true });

  if (alteracoes.slug && alteracoes.slug !== existente.slug && produtosRepo.buscarPorSlug(alteracoes.slug)) {
    throw new Conflito(`Ja existe um produto com o slug "${alteracoes.slug}"`);
  }

  const planos = validarPlanos(dados.planos, { obrigatorio: false });

  produtosRepo.atualizar(produtoId, alteracoes);
  if (planos) {
    // Planos que sumiram da lista deixam chaves orfas no estoque: descarta.
    const { removidos } = produtosRepo.substituirPlanos(produtoId, planos);
    removidos.forEach(planoId => estoqueService.descartarEstoqueDePlano(produtoId, planoId, { atorId: ator.id, ip }));
  }

  auditoriaRepo.registrar({ atorId: ator.id, acao: 'produto.atualizado', entidade: 'produto', entidadeId: produtoId, dados: { campos: Object.keys(alteracoes) }, ip });

  eventos.publicar('produto.atualizado', { produtoId, acao: 'atualizado' });

  return catalogoService.paraPublico(produtosRepo.buscarPorId(produtoId));
}

/** Liga/desliga a visibilidade do produto na loja (soft delete). */
function alternarAtivoProduto(produtoId, ativo, ator, { ip = null } = {}) {
  const existente = produtosRepo.buscarPorId(produtoId);
  if (!existente) throw new NaoEncontrado('Produto nao encontrado');

  produtosRepo.atualizar(produtoId, { ativo: !!ativo });
  auditoriaRepo.registrar({ atorId: ator.id, acao: ativo ? 'produto.ativado' : 'produto.desativado', entidade: 'produto', entidadeId: produtoId, ip });

  eventos.publicar('produto.atualizado', { produtoId, acao: ativo ? 'ativado' : 'desativado' });

  return catalogoService.paraPublico(produtosRepo.buscarPorId(produtoId));
}

/* -------------------------------------------------------------------------- */
/* Cupons                                                                     */
/* -------------------------------------------------------------------------- */

function listarCupons() {
  return cuponsRepo.listar({ incluirInativos: true });
}

function criarCupom(dados, ator, { ip = null } = {}) {
  const codigo = String(dados.codigo || '').trim().toUpperCase();
  if (!/^[A-Z0-9-]{3,24}$/.test(codigo)) {
    throw new ErroValidacao('Codigo invalido: use de 3 a 24 caracteres (letras, numeros e hifen)');
  }
  if (cuponsRepo.buscar(codigo)) throw new Conflito('Ja existe um cupom com este codigo');

  const tipo = dados.tipo === 'fixo' ? 'fixo' : 'percentual';

  let valor;
  if (tipo === 'percentual') {
    valor = exigirInteiro(dados.valor, 'valor', { rotulo: 'Percentual', min: 1, max: 100 });
  } else {
    valor = dados.valorCentavos !== undefined
      ? exigirInteiro(dados.valorCentavos, 'valor', { rotulo: 'Valor', min: 1 })
      : paraCentavos(dados.valor);
    if (!Number.isFinite(valor) || valor < 1) throw new ErroValidacao('Valor do desconto invalido');
  }

  const minimoCentavos = dados.minimoCentavos !== undefined
    ? exigirInteiro(dados.minimoCentavos, 'minimo', { rotulo: 'Minimo', min: 0 })
    : (dados.minimo !== undefined ? Math.max(paraCentavos(dados.minimo) || 0, 0) : 0);

  const maxUsos = dados.maxUsos === null || dados.maxUsos === undefined || dados.maxUsos === ''
    ? null
    : exigirInteiro(dados.maxUsos, 'maxUsos', { rotulo: 'Maximo de usos', min: 1, max: 1000000 });

  const cupom = cuponsRepo.criar({
    codigo,
    tipo,
    valor,
    minimoCentavos,
    maxUsos,
    expiraEm: dados.expiraEm || null,
    ativo: dados.ativo === undefined ? true : lerBooleano(dados.ativo, true),
    descricao: textoOpcional(dados.descricao, 'descricao', { rotulo: 'Descricao', max: 120 })
  });

  auditoriaRepo.registrar({ atorId: ator.id, acao: 'cupom.criado', entidade: 'cupom', entidadeId: codigo, ip });
  return cupom;
}

function atualizarCupom(codigo, dados, ator, { ip = null } = {}) {
  if (!cuponsRepo.buscar(codigo)) throw new NaoEncontrado('Cupom nao encontrado');

  const alteracoes = {};
  if (dados.ativo !== undefined) alteracoes.ativo = lerBooleano(dados.ativo, true);
  if (dados.maxUsos !== undefined) {
    alteracoes.maxUsos = dados.maxUsos === null || dados.maxUsos === ''
      ? null
      : exigirInteiro(dados.maxUsos, 'maxUsos', { rotulo: 'Maximo de usos', min: 1 });
  }
  if (dados.expiraEm !== undefined) alteracoes.expiraEm = dados.expiraEm || null;
  if (dados.descricao !== undefined) alteracoes.descricao = textoOpcional(dados.descricao, 'descricao', { max: 120 });

  const cupom = cuponsRepo.atualizar(codigo, alteracoes);
  auditoriaRepo.registrar({ atorId: ator.id, acao: 'cupom.atualizado', entidade: 'cupom', entidadeId: codigo, ip });
  return cupom;
}

function removerCupom(codigo, ator, { ip = null } = {}) {
  if (!cuponsRepo.remover(codigo)) throw new NaoEncontrado('Cupom nao encontrado');
  auditoriaRepo.registrar({ atorId: ator.id, acao: 'cupom.removido', entidade: 'cupom', entidadeId: codigo, ip });
  return { removido: true };
}

/* -------------------------------------------------------------------------- */
/* Avaliacoes e licencas                                                      */
/* -------------------------------------------------------------------------- */

function listarAvaliacoes({ limite = 50 } = {}) {
  return avaliacoesRepo.listarRecentes(limite);
}

function removerAvaliacao(avaliacaoId, ator, { ip = null } = {}) {
  const avaliacao = avaliacoesRepo.buscarPorId(avaliacaoId);
  if (!avaliacao) throw new NaoEncontrado('Avaliacao nao encontrada');

  avaliacoesRepo.remover(avaliacaoId);
  auditoriaRepo.registrar({ atorId: ator.id, acao: 'avaliacao.removida', entidade: 'avaliacao', entidadeId: avaliacaoId, ip });
  return { removida: true };
}

function listarLicencas({ limite = 50, deslocamento = 0 } = {}) {
  return licencasRepo.listarTodas({ limite, deslocamento });
}

function revogarLicenca(licencaId, ator, { motivo = '', ip = null } = {}) {
  return licencaService.revogar(licencaId, { atorId: ator.id, motivo, ip });
}

/* -------------------------------------------------------------------------- */
/* Auditoria e configuracoes                                                  */
/* -------------------------------------------------------------------------- */

function listarAuditoria({ limite = 100, deslocamento = 0, entidade = null, acao = null } = {}) {
  return {
    total: auditoriaRepo.contar(),
    eventos: auditoriaRepo.listar({ limite, deslocamento, entidade, acao })
  };
}

function obterConfiguracoes() {
  return configuracoesRepo.listarTodas();
}

function salvarConfiguracoes(dados, ator, { ip = null } = {}) {
  // Tamanho, e-mail e link conferidos aqui tambem: a tela nao e a unica porta.
  const limpas = configuracoesService.validar(dados);

  const resultado = configuracoesRepo.definirVarias(limpas);
  // Ligar/desligar a manutencao vale na hora, sem esperar o cache de 10s.
  invalidarCacheManutencao();
  auditoriaRepo.registrar({ atorId: ator.id, acao: 'configuracoes.atualizadas', entidade: 'configuracao', dados: limpas, ip });
  return resultado;
}

/** Indicadores extras: produtos mais desejados e clientes que mais compram. */
function indicadores() {
  return {
    favoritosPorProduto: produtosRepo
      .listar({ limite: 100 })
      .map(produto => ({ nome: produto.nome, favoritos: favoritosRepo.contarDoProduto(produto.id) }))
      .filter(item => item.favoritos > 0)
      .sort((a, b) => b.favoritos - a.favoritos)
      .slice(0, 5),
    licencas: licencasRepo.contarPorStatus()
  };
}

module.exports = {
  STATUS_VENDA,
  ICONES,
  painel,
  listarPedidos,
  detalharPedido,
  mudarStatusPedido,
  listarUsuarios,
  mudarPapel,
  mudarAtivo,
  detalharUsuario,
  validarPlanos,
  criarProduto,
  atualizarProduto,
  alternarAtivoProduto,
  listarCupons,
  criarCupom,
  atualizarCupom,
  removerCupom,
  listarAvaliacoes,
  removerAvaliacao,
  listarLicencas,
  revogarLicenca,
  listarAuditoria,
  obterConfiguracoes,
  salvarConfiguracoes,
  indicadores
};
