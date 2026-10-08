/*
 * routes/admin.routes.js
 * -----------------------------------------------------------------------------
 * Painel administrativo. TODAS as rotas exigem papel "admin" (aplicado no
 * router.use logo abaixo, para que nenhuma rota nova esqueca a guarda).
 *
 *   GET    /api/admin/painel                        numeros gerais
 *   GET    /api/admin/diagnostico                   estado tecnico
 *   GET    /api/admin/pedidos                       lista de pedidos
 *   GET    /api/admin/pedidos/:id                   detalhe + historico
 *   PATCH  /api/admin/pedidos/:id/status            muda o status
 *   GET    /api/admin/usuarios                      lista de clientes
 *   PATCH  /api/admin/usuarios/:id/papel            promove/rebaixa
 *   PATCH  /api/admin/usuarios/:id/ativo            ativa/desativa
 *   POST   /api/admin/produtos                      cria produto
 *   GET    /api/admin/produtos/:id                  detalhe (para edicao)
 *   PATCH  /api/admin/produtos/:id                  edita produto
 *   PATCH  /api/admin/produtos/:id/ativo            liga/desliga na vitrine
 *   GET    /api/admin/cupons                        lista cupons
 *   POST   /api/admin/cupons                        cria cupom
 *   PATCH  /api/admin/cupons/:codigo                edita cupom
 *   DELETE /api/admin/cupons/:codigo                remove cupom
 *   GET    /api/admin/avaliacoes                    moderacao
 *   DELETE /api/admin/avaliacoes/:id                remove avaliacao
 *   GET    /api/admin/licencas                      todas as chaves
 *   PATCH  /api/admin/licencas/:id/revogar          revoga uma chave
 *   GET    /api/admin/estoque                       resumo do estoque por plano
 *   GET    /api/admin/estoque/chaves                chaves do pool (filtros)
 *   GET    /api/admin/estoque/movimentos            historico de movimentos
 *   POST   /api/admin/estoque/gerar                 entrada de chaves
 *   POST   /api/admin/estoque/descartar             saida manual
 *   POST   /api/admin/estoque/chaves/descartar      remove chaves escolhidas do pool
 *   POST   /api/admin/estoque/chaves/excluir        apaga chaves nunca vendidas
 *   POST   /api/admin/estoque/ajustar               define a quantidade
 *   PATCH  /api/admin/estoque/minimo                ponto de reposicao
 *   GET    /api/admin/relatorios                    relatorios do periodo
 *   GET    /api/admin/financeiro                    caixa do periodo (recebido, a receber, devolvido)
 *   GET    /api/admin/financeiro/pagamentos         extrato de pagamentos (paginado)
 *   GET    /api/admin/eventos                       SSE de atualizacao em tempo real
 *   GET    /api/admin/auditoria                     trilha de auditoria
 *   GET    /api/admin/configuracoes                 ajustes da loja
 *   PATCH  /api/admin/configuracoes                 salva ajustes
 *   GET    /api/admin/gateways                      provedores, formas e metodo padrao
 *   PATCH  /api/admin/gateways/metodo-padrao        define a forma de pagamento padrao
 *   GET    /api/admin/gateways/eventos              notificacoes de pagamento recebidas
 *   GET    /api/admin/gateways/:gateway             configuracao de um provedor
 *   PATCH  /api/admin/gateways/:gateway             salva a configuracao do provedor
 *   POST   /api/admin/gateways/:gateway/testar      diagnostico do provedor
 *   GET    /api/admin/indicadores                   extras (favoritos, etc)
 */
'use strict';

const express = require('express');
const adminService = require('../services/admin.service');
const metricasService = require('../services/metricas.service');
const catalogoService = require('../services/catalogo.service');
const estoqueService = require('../services/estoque.service');
const relatorioService = require('../services/relatorio.service');
const financeiroService = require('../services/financeiro.service');
const gatewayService = require('../services/gateway.service');
const produtosRepo = require('../repositories/produtos.repo');
const registroGateways = require('../gateways');

const { requireAdmin } = require('../middlewares/sessao');
const { assincrono } = require('../middlewares/contexto');
const { exigirCorpo, exigirUuidParam, paginacao } = require('../middlewares/validar');
const { lerInteiro, lerTexto } = require('../utils/validacao');
const { NaoEncontrado, ErroValidacao } = require('../utils/erros');
const eventos = require('../utils/eventos');
const limites = require('../middlewares/limites');

const router = express.Router();

// Porta de entrada: sem admin, nada aqui responde.
router.use(requireAdmin);

/**
 * Valida o parametro :gateway contra o catalogo. Ids de gateway sao slugs
 * (ex.: "mercadopago"), nao UUIDs — por isso um validador proprio.
 */
function exigirGatewayValido(req, res, next) {
  const id = String(req.params.gateway || '').trim().toLowerCase();
  if (!registroGateways.existe(id)) {
    return next(new NaoEncontrado('Gateway nao encontrado'));
  }
  req.gatewayId = id;
  next();
}

/* -------------------------------------------------------------------------- */
/* Painel e diagnostico                                                       */
/* -------------------------------------------------------------------------- */

router.get('/painel', assincrono((req, res) => {
  res.json(adminService.painel({ dias: Math.min(lerInteiro(req.query.dias, 30), 365) }));
}));

router.get('/diagnostico', assincrono((req, res) => {
  res.json(metricasService.diagnostico());
}));

router.get('/indicadores', assincrono((req, res) => {
  res.json(adminService.indicadores());
}));

/* -------------------------------------------------------------------------- */
/* Pedidos                                                                    */
/* -------------------------------------------------------------------------- */

router.get('/pedidos', paginacao({ limitePadrao: 50 }), assincrono((req, res) => {
  res.json(adminService.listarPedidos({
    status: req.query.status || null,
    limite: req.paginacao.limite,
    deslocamento: req.paginacao.deslocamento
  }));
}));

router.get('/pedidos/:id', exigirUuidParam('id'), assincrono((req, res) => {
  res.json(adminService.detalharPedido(req.params.id));
}));

// body: { status, motivo? }
router.patch('/pedidos/:id/status', exigirUuidParam('id'), exigirCorpo, assincrono(async (req, res) => {
  const pedido = await adminService.mudarStatusPedido(
    req.params.id,
    lerTexto(req.body.status).toLowerCase(),
    req.usuario,
    { motivo: lerTexto(req.body.motivo), ip: req.ipCliente }
  );
  res.json({ pedido, mensagem: 'Status atualizado' });
}));

/* -------------------------------------------------------------------------- */
/* Usuarios                                                                   */
/* -------------------------------------------------------------------------- */

router.get('/usuarios', paginacao({ limitePadrao: 50 }), assincrono((req, res) => {
  res.json(adminService.listarUsuarios({
    busca: req.query.busca || '',
    limite: req.paginacao.limite,
    deslocamento: req.paginacao.deslocamento
  }));
}));

// Ficha completa do cliente (painel lateral): pedidos, chaves e gasto.
router.get('/usuarios/:id', exigirUuidParam('id'), assincrono((req, res) => {
  res.json(adminService.detalharUsuario(req.params.id));
}));

// body: { papel: 'cliente' | 'admin' }
router.patch('/usuarios/:id/papel', exigirUuidParam('id'), exigirCorpo, assincrono((req, res) => {
  res.json(adminService.mudarPapel(req.params.id, lerTexto(req.body.papel).toLowerCase(), req.usuario, { ip: req.ipCliente }));
}));

// body: { ativo: true | false }
router.patch('/usuarios/:id/ativo', exigirUuidParam('id'), exigirCorpo, assincrono((req, res) => {
  const ativo = req.body.ativo === true || req.body.ativo === 'true' || req.body.ativo === 1;
  res.json(adminService.mudarAtivo(req.params.id, ativo, req.usuario, { ip: req.ipCliente }));
}));

/* -------------------------------------------------------------------------- */
/* Catalogo                                                                   */
/* -------------------------------------------------------------------------- */

// Lista completa (inclui inativos) para a tela de gestao.
router.get('/produtos', paginacao({ limitePadrao: 50 }), assincrono((req, res) => {
  const produtos = produtosRepo.listar({
    categoria: req.query.categoria,
    busca: req.query.busca,
    incluirInativos: true,
    limite: req.paginacao.limite,
    deslocamento: req.paginacao.deslocamento,
    ordem: req.query.ordem
  });

  res.set('X-Total-Count', String(produtosRepo.contar({ incluirInativos: true, busca: req.query.busca, categoria: req.query.categoria })));
  res.json(produtos.map(produto => catalogoService.paraPublico(produto, { ativo: produto.ativo, ordem: produto.ordem })));
}));

// Detalhe de um produto (inclui inativos) — alimenta o formulario de edicao.
router.get('/produtos/:id', exigirUuidParam('id'), assincrono((req, res) => {
  const produto = catalogoService.buscarInterno(req.params.id);
  if (!produto) throw new NaoEncontrado('Produto nao encontrado');
  res.json(catalogoService.paraPublico(produto, { ativo: produto.ativo, ordem: produto.ordem }));
}));

// body: { nome, categoria, planos: [...], ... }
router.post('/produtos', limites.escrita, exigirCorpo, assincrono((req, res) => {
  res.status(201).json(adminService.criarProduto(req.body, req.usuario, { ip: req.ipCliente }));
}));

// body: campos parciais (planos substitui a lista inteira quando enviado)
router.patch('/produtos/:id', exigirUuidParam('id'), exigirCorpo, assincrono((req, res) => {
  res.json(adminService.atualizarProduto(req.params.id, req.body, req.usuario, { ip: req.ipCliente }));
}));

// body: { ativo: true | false }
router.patch('/produtos/:id/ativo', exigirUuidParam('id'), exigirCorpo, assincrono((req, res) => {
  const ativo = req.body.ativo === true || req.body.ativo === 'true' || req.body.ativo === 1;
  res.json(adminService.alternarAtivoProduto(req.params.id, ativo, req.usuario, { ip: req.ipCliente }));
}));

/* -------------------------------------------------------------------------- */
/* Cupons                                                                     */
/* -------------------------------------------------------------------------- */

router.get('/cupons', assincrono((req, res) => {
  res.json({ cupons: adminService.listarCupons() });
}));

// body: { codigo, tipo: 'percentual'|'fixo', valor, minimo?, maxUsos?, expiraEm? }
router.post('/cupons', limites.escrita, exigirCorpo, assincrono((req, res) => {
  res.status(201).json(adminService.criarCupom(req.body, req.usuario, { ip: req.ipCliente }));
}));

router.patch('/cupons/:codigo', exigirCorpo, assincrono((req, res) => {
  res.json(adminService.atualizarCupom(req.params.codigo, req.body, req.usuario, { ip: req.ipCliente }));
}));

router.delete('/cupons/:codigo', assincrono((req, res) => {
  res.json(adminService.removerCupom(req.params.codigo, req.usuario, { ip: req.ipCliente }));
}));

/* -------------------------------------------------------------------------- */
/* Avaliacoes e licencas                                                      */
/* -------------------------------------------------------------------------- */

router.get('/avaliacoes', assincrono((req, res) => {
  res.json({ avaliacoes: adminService.listarAvaliacoes({ limite: Math.min(lerInteiro(req.query.limite, 50), 200) }) });
}));

router.delete('/avaliacoes/:id', exigirUuidParam('id'), assincrono((req, res) => {
  res.json(adminService.removerAvaliacao(req.params.id, req.usuario, { ip: req.ipCliente }));
}));

router.get('/licencas', paginacao({ limitePadrao: 50 }), assincrono((req, res) => {
  res.json({
    licencas: adminService.listarLicencas({
      limite: req.paginacao.limite,
      deslocamento: req.paginacao.deslocamento
    })
  });
}));

// body: { motivo? }
router.patch('/licencas/:id/revogar', exigirUuidParam('id'), assincrono((req, res) => {
  res.json(adminService.revogarLicenca(req.params.id, req.usuario, {
    motivo: lerTexto(req.body && req.body.motivo) || 'revogada pela administracao',
    ip: req.ipCliente
  }));
}));

/* -------------------------------------------------------------------------- */
/* Estoque                                                                    */
/* -------------------------------------------------------------------------- */

// Resumo por plano + alertas de reposicao (a tela de Estoque inteira).
router.get('/estoque', assincrono((req, res) => {
  res.json(estoqueService.resumo({ incluirInativos: req.query.inativos !== 'false' }));
}));

// Chaves do pool, com filtros por produto/plano/status e busca por chave.
router.get('/estoque/chaves', paginacao({ limitePadrao: 100, limiteMax: 500 }), assincrono((req, res) => {
  res.json(estoqueService.listarChaves({
    produtoId: req.query.produtoId || null,
    planoId: req.query.planoId || null,
    status: req.query.status || null,
    busca: req.query.busca || null,
    limite: req.paginacao.limite,
    deslocamento: req.paginacao.deslocamento
  }));
}));

// Historico de entradas, saidas, descartes e revogacoes.
router.get('/estoque/movimentos', paginacao({ limitePadrao: 100, limiteMax: 500 }), assincrono((req, res) => {
  res.json({
    movimentos: estoqueService.listarMovimentos({
      produtoId: req.query.produtoId || null,
      planoId: req.query.planoId || null,
      tipo: req.query.tipo || null,
      limite: req.paginacao.limite,
      deslocamento: req.paginacao.deslocamento
    })
  });
}));

// body: { produtoId, planoId, quantidade? , chaves?: string[]|string, lote? }
router.post('/estoque/gerar', limites.escrita, exigirCorpo, assincrono((req, res) => {
  const resultado = estoqueService.gerar(req.body, req.usuario, { ip: req.ipCliente });
  res.status(201).json({
    ...resultado,
    mensagem: resultado.inseridas === 0
      ? 'Nenhuma chave nova: todas ja estavam no estoque'
      : `${resultado.inseridas} chave(s) adicionada(s) ao estoque`
  });
}));

// body: { produtoId, planoId, quantidade, motivo? }
router.post('/estoque/descartar', limites.escrita, exigirCorpo, assincrono((req, res) => {
  const resultado = estoqueService.descartar(req.body, req.usuario, { ip: req.ipCliente });
  res.json({ ...resultado, mensagem: `${resultado.removidas} chave(s) removida(s) do estoque` });
}));

// body: { produtoId, planoId, ids: [uuid], motivo? } — remove chaves escolhidas do pool
router.post('/estoque/chaves/descartar', limites.escrita, exigirCorpo, assincrono((req, res) => {
  const resultado = estoqueService.descartarChaves(req.body, req.usuario, { ip: req.ipCliente });
  res.json({ ...resultado, mensagem: `${resultado.removidas} chave(s) removida(s) do estoque` });
}));

// body: { produtoId, planoId, ids: [uuid] } — apaga de vez chaves nunca vendidas
router.post('/estoque/chaves/excluir', limites.escrita, exigirCorpo, assincrono((req, res) => {
  const resultado = estoqueService.excluirChaves(req.body, req.usuario, { ip: req.ipCliente });
  res.json({ ...resultado, mensagem: `${resultado.excluidas} chave(s) excluida(s) definitivamente` });
}));

// body: { produtoId, planoId, alvo } — define a quantidade disponivel
router.post('/estoque/ajustar', limites.escrita, exigirCorpo, assincrono((req, res) => {
  res.json(estoqueService.ajustarPara(req.body, req.usuario, { ip: req.ipCliente }));
}));

// body: { produtoId, planoId, minimo }
router.patch('/estoque/minimo', exigirCorpo, assincrono((req, res) => {
  res.json({
    ...estoqueService.definirMinimo(req.body, req.usuario, { ip: req.ipCliente }),
    mensagem: 'Ponto de reposicao atualizado'
  });
}));

/* -------------------------------------------------------------------------- */
/* Relatorios                                                                 */
/* -------------------------------------------------------------------------- */

// query: ?periodo=7|30|90|365  ou  ?desde=AAAA-MM-DD&ate=AAAA-MM-DD
router.get('/relatorios', assincrono((req, res) => {
  res.json(relatorioService.relatorio({
    periodo: lerInteiro(req.query.periodo, 30),
    desde: req.query.desde || null,
    ate: req.query.ate || null
  }));
}));

/* -------------------------------------------------------------------------- */
/* Financeiro                                                                 */
/* -------------------------------------------------------------------------- */

/*
 * A area financeira: o dinheiro, nao o desempenho. /relatorios responde "como a
 * loja esta indo" (so pedidos pagos); aqui a resposta e "onde esta o dinheiro" —
 * recebido, a receber e devolvido, todos os status.
 */

// query: ?periodo=7|30|90|365  ou  ?desde=AAAA-MM-DD&ate=AAAA-MM-DD
router.get('/financeiro', assincrono((req, res) => {
  res.json(financeiroService.financeiro({
    periodo: lerInteiro(req.query.periodo, 30),
    desde: req.query.desde || null,
    ate: req.query.ate || null
  }));
}));

// Extrato de pagamentos. Aceita o mesmo recorte de periodo + ?status= + paginacao.
router.get('/financeiro/pagamentos', paginacao({ limitePadrao: 25, limiteMax: 100 }), assincrono((req, res) => {
  res.json(financeiroService.pagamentos({
    periodo: lerInteiro(req.query.periodo, 30),
    desde: req.query.desde || null,
    ate: req.query.ate || null,
    status: req.query.status || null,
    limite: req.paginacao.limite,
    deslocamento: req.paginacao.deslocamento
  }));
}));

/* -------------------------------------------------------------------------- */
/* Tempo real (Server-Sent Events)                                            */
/* -------------------------------------------------------------------------- */

/*
 * Canal unico de "algo mudou". O painel abre UMA conexao aqui e recarrega
 * apenas a tela afetada quando chega um evento. E por isso que a tela de
 * Estoque, a lista de Pedidos e o Painel ficam sincronizados sozinhos entre
 * abas e entre usuarios do painel.
 *
 * Nao passa por `assincrono` de proposito: a resposta NUNCA termina enquanto o
 * cliente estiver conectado.
 */
router.get('/eventos', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Evita que proxies (nginx) segurem o stream em buffer.
    'X-Accel-Buffering': 'no'
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  // Reconexao do EventSource em 3s quando a conexao cair.
  res.write('retry: 3000\n\n');
  res.write(`event: pronto\ndata: ${JSON.stringify({ em: new Date().toISOString() })}\n\n`);

  const cancelar = eventos.assinar(evento => {
    res.write(`data: ${JSON.stringify(evento)}\n\n`);
  });

  // Comentario periodico: mantem a conexao viva e detecta cliente sumido.
  const batimento = setInterval(() => {
    res.write(': ping\n\n');
  }, 25000);
  if (typeof batimento.unref === 'function') batimento.unref();

  req.on('close', () => {
    clearInterval(batimento);
    cancelar();
  });
});

/* -------------------------------------------------------------------------- */
/* Auditoria e configuracoes                                                  */
/* -------------------------------------------------------------------------- */

router.get('/auditoria', paginacao({ limitePadrao: 100, limiteMax: 500 }), assincrono((req, res) => {
  res.json(adminService.listarAuditoria({
    limite: req.paginacao.limite,
    deslocamento: req.paginacao.deslocamento,
    entidade: req.query.entidade || null,
    acao: req.query.acao || null
  }));
}));

router.get('/configuracoes', assincrono((req, res) => {
  res.json({ configuracoes: adminService.obterConfiguracoes() });
}));

router.patch('/configuracoes', exigirCorpo, assincrono((req, res) => {
  res.json({
    configuracoes: adminService.salvarConfiguracoes(req.body, req.usuario, { ip: req.ipCliente }),
    mensagem: 'Configuracoes salvas'
  });
}));

/* -------------------------------------------------------------------------- */
/* Gateways de pagamento                                                      */
/* -------------------------------------------------------------------------- */

/*
 * Configuracao dos PROVEDORES de pagamento (gateways). Nao confundir com
 * "pagamentos recebidos": a lista de pagamentos/pedidos vive em /pedidos, e as
 * notificacoes que os provedores enviam ficam em /gateways/eventos.
 *
 * Os segredos NUNCA saem em texto puro: `gatewayService.listarParaAdmin`
 * devolve cada credencial ja mascarada.
 */

router.get('/gateways', assincrono((req, res) => {
  res.json({
    gateways: gatewayService.listarParaAdmin(),
    // Forma de pagamento padrao da loja (escolhida no painel).
    metodoPadrao: gatewayService.metodoPadrao(),
    // Catalogo das FORMAS de pagamento (pix/cartao/boleto) com nome, icone e
    // descricao. O painel monta os seletores a partir daqui — assim uma forma
    // nova aparece na tela sem tocar no front.
    formas: Object.values(registroGateways.METODOS),
    // Provedores e as formas que cada um aceita.
    provedores: registroGateways.GATEWAYS.map(definicao => ({
      id: definicao.id,
      nome: definicao.nome,
      cor: definicao.cor,
      suportados: definicao.metodos
    })),
    // O que a vitrine oferece agora (com o gateway responsavel por cada forma).
    disponiveis: gatewayService.metodosDisponiveis()
  });
}));

// Define a forma de pagamento padrao. Vem ANTES de /:gateway, senao
// "metodo-padrao" seria lido como um id de gateway.
router.patch('/gateways/metodo-padrao', exigirCorpo, assincrono((req, res) => {
  const resultado = gatewayService.definirMetodoPadrao(
    req.body && req.body.metodo,
    req.usuario,
    { ip: req.ipCliente }
  );
  res.json({ ...resultado, mensagem: 'Forma de pagamento padrao atualizada' });
}));

// Historico de webhooks recebidos (notificacoes de pagamento). Tambem vem
// ANTES de /:gateway, senao "eventos" seria interpretado como um id de gateway.
router.get('/gateways/eventos', paginacao({ limitePadrao: 50, limiteMax: 200 }), assincrono((req, res) => {
  res.json(gatewayService.historicoEventos({
    limite: req.paginacao.limite,
    deslocamento: req.paginacao.deslocamento,
    gatewayId: req.query.gateway || null
  }));
}));

router.get('/gateways/:gateway', exigirGatewayValido, assincrono((req, res) => {
  res.json({ gateway: gatewayService.obterParaAdmin(req.gatewayId) });
}));

// body: { ativo?, modo?, metodos?, prioridade?, credenciais?, limparCredenciais? }
router.patch('/gateways/:gateway', exigirGatewayValido, exigirCorpo, assincrono((req, res) => {
  const gateway = gatewayService.salvar(req.gatewayId, req.body, req.usuario, { ip: req.ipCliente });
  res.json({ gateway, mensagem: 'Gateway atualizado' });
}));

// Diagnostico: confere se as credenciais permitem operar de verdade.
router.post('/gateways/:gateway/testar', exigirGatewayValido, assincrono(async (req, res) => {
  res.json(await gatewayService.testar(req.gatewayId));
}));

module.exports = router;
