/*
 * db/semear.js
 * -----------------------------------------------------------------------------
 * Popula o banco com o catalogo inicial, cupons de exemplo, contas de
 * demonstracao e alguns dados de amostra para o painel nao nascer vazio.
 *
 * E IDEMPOTENTE: rodar varias vezes nao duplica nada. Produtos sao
 * identificados pelo slug, usuarios pelo e-mail e cupons pelo codigo.
 *
 *   npm run db:seed
 */
'use strict';

const { conectar } = require('./conexao');
const { migrar } = require('./migracoes');
const { CATALOGO, CUPONS } = require('./catalogo');
const produtosRepo = require('../repositories/produtos.repo');
const usuariosRepo = require('../repositories/usuarios.repo');
const cuponsRepo = require('../repositories/cupons.repo');
const avaliacoesRepo = require('../repositories/avaliacoes.repo');
const vendasRepo = require('../repositories/vendas.repo');
const licencasRepo = require('../repositories/licencas.repo');
const estoqueRepo = require('../repositories/estoque.repo');
const configuracoesRepo = require('../repositories/configuracoes.repo');
const gatewayService = require('../services/gateway.service');

const config = require('../config');
const logger = require('../utils/logger');
const { paraCentavos } = require('../utils/dinheiro');
const { agoraISO, daquiADias } = require('../utils/datas');
const { gerarHashSenha, gerarChaveLicenca, gerarCodigo, novoId, idEstavel } = require('../utils/seguranca');

/* -------------------------------------------------------------------------- */
/* Contas de demonstracao                                                     */
/* -------------------------------------------------------------------------- */

const CONTAS_DEMO = [
  {
    nome: 'Cliente Demo',
    email: 'demo@loja.com',
    senha: 'demo123',
    papel: 'cliente',
    descricao: 'conta usada pelo botao "Entrar com a conta demo" na tela de login'
  },
  {
    nome: 'Administrador',
    email: 'admin@loja.com',
    senha: 'admin123',
    papel: 'admin',
    descricao: 'acesso ao painel administrativo em /api/admin'
  },
  {
    nome: 'Marina Souza',
    email: 'marina@exemplo.com',
    senha: 'marina123',
    papel: 'cliente',
    descricao: 'cliente de amostra'
  },
  {
    nome: 'Rafael Lima',
    email: 'rafael@exemplo.com',
    senha: 'rafael123',
    papel: 'cliente',
    descricao: 'cliente de amostra'
  }
];

/* -------------------------------------------------------------------------- */
/* Semeadura                                                                  */
/* -------------------------------------------------------------------------- */

/** Cria o usuario se o e-mail ainda nao existir. */
function semearUsuario({ nome, email, senha, papel }) {
  const existente = usuariosRepo.buscarPorEmail(email);
  if (existente) return { usuario: existente, criado: false };

  const { salt, hash } = gerarHashSenha(senha);
  const usuario = usuariosRepo.criar({
    id: novoId(),
    nome,
    email,
    senhaSalt: salt,
    senhaHash: hash,
    papel
  });
  return { usuario, criado: true };
}

/** Insere o produto com seus planos se o slug ainda nao existir. */
function semearProduto(produto, indice) {
  const existente = produtosRepo.buscarPorSlug(produto.slug);
  if (existente) {
    // Backfill leve: catalogo anterior ao campo "descricaoLonga" fica com ele
    // vazio. Preenche so quando esta em branco — nunca sobrescreve o que o
    // admin ja escreveu no painel.
    if (produto.descricaoLonga && !existente.descricaoLonga) {
      produtosRepo.atualizar(existente.id, { descricaoLonga: produto.descricaoLonga });
      return { criado: false, atualizado: true };
    }
    return { criado: false };
  }

  const id = idEstavel(produto.slug);
  produtosRepo.criar({
    id,
    slug: produto.slug,
    nome: produto.nome,
    linha: produto.linha,
    nivel: produto.nivel,
    categoria: produto.categoria,
    descricao: produto.descricao,
    descricaoLonga: produto.descricaoLonga || '',
    recursos: produto.recursos,
    capa: produto.capa,
    imagem: produto.imagem || null,
    badge: produto.badge || null,
    plataforma: produto.plataforma || 'Windows',
    entrega: 'Automatica',
    destaque: produto.destaque === true,
    ativo: true,
    ordem: indice,
    notaBase: produto.notaBase ?? 0,
    totalBase: produto.totalBase ?? 0
  });

  produtosRepo.substituirPlanos(id, produto.planos.map((plano, posicao) => ({
    id: plano.id,
    nome: plano.nome,
    precoCentavos: paraCentavos(plano.preco),
    dias: plano.dias,
    ordem: posicao
  })));

  return { criado: true, id };
}

/* -------------------------------------------------------------------------- */
/* Estoque inicial                                                            */
/* -------------------------------------------------------------------------- */

/*
 * Toda loja precisa nascer com chaves no estoque — sem elas, a venda fica
 * bloqueada (regra do projeto). Aqui geramos um pool inicial por plano.
 *
 * A semeadura de estoque e IDEMPOTENTE de um jeito diferente das outras: ela
 * so age em planos que ainda NAO tem chave nenhuma. Assim rodar `db:seed` de
 * novo nao duplica chaves nem desfaz o que o admin ja mexeu.
 */
const ESTOQUE_PADRAO = 40;
const ESTOQUE_MINIMO_PADRAO = 5;

/*
 * Planos que nascem propositalmente no limite, para o painel ja demonstrar os
 * alertas de reposicao sem precisar vender nada:
 *   - "baixo": disponivel abaixo do minimo
 *   - "esgotado": sem nenhuma chave
 */
const ESTOQUE_DE_DEMONSTRACAO = {
  'driver-updater|30d': { quantidade: 4, minimo: 6 },
  'stream-overlay-pack|vitalicio': { quantidade: 0, minimo: 3 }
};

/** Cria o estoque inicial dos planos que ainda nao tem chave. */
function semearEstoque(produtos) {
  let planos = 0;
  let chaves = 0;

  produtos.forEach(produto => {
    (produto.planos || []).forEach(plano => {
      const configuracao = ESTOQUE_DE_DEMONSTRACAO[`${produto.slug}|${plano.id}`]
        || { quantidade: ESTOQUE_PADRAO, minimo: ESTOQUE_MINIMO_PADRAO };

      // O ponto de reposicao e sempre (re)definido: e configuracao, nao dado.
      produtosRepo.definirEstoqueMinimo(produto.id, plano.id, configuracao.minimo);

      // Ja tem chave (de uma execucao anterior ou cadastrada pelo admin)? Nao mexe.
      if (estoqueRepo.contarChaves({ produtoId: produto.id, planoId: plano.id }) > 0) return;

      if (configuracao.quantidade > 0) {
        const linhas = Array.from({ length: configuracao.quantidade }, () => ({
          id: novoId(),
          produtoId: produto.id,
          planoId: plano.id,
          chave: gerarChaveLicenca(),
          lote: 'carga-inicial'
        }));

        const inseridas = estoqueRepo.inserirVarias(linhas).inseridas;
        chaves += inseridas;

        if (inseridas > 0) {
          estoqueRepo.registrarMovimento({
            produtoId: produto.id,
            planoId: plano.id,
            tipo: 'entrada',
            quantidade: inseridas,
            motivo: 'Carga inicial do catalogo',
            atorId: null
          });
        }
      }

      planos += 1;
    });
  });

  return { planos, chaves };
}

/**
 * True quando o estoque nunca foi inicializado neste banco.
 *
 * O criterio e "nao existe NENHUMA chave E nenhum movimento". Se o admin ja
 * tiver descartado ou revogado chaves de proposito, existe movimento registrado
 * e o backfill NAO roda de novo — o estoque zerado dele e respeitado.
 */
function estoqueNuncaInicializado() {
  const contagens = estoqueRepo.contarPorStatus();
  const total = Object.values(contagens).reduce((soma, quantidade) => soma + quantidade, 0);
  if (total > 0) return false;
  return estoqueRepo.listarMovimentos({ limite: 1 }).length === 0;
}

/**
 * Backfill do estoque para bancos que ja existiam antes da tabela de chaves.
 *
 * Por que existe: um banco criado antes desta versao tem catalogo, mas o pool
 * nasce vazio. Como o estoque e a fonte da verdade e a venda e bloqueada sem
 * chave, a loja inteira ficaria "esgotada" logo depois do deploy. Aqui geramos
 * a carga inicial usando exatamente a mesma rotina idempotente do seed.
 */
function garantirEstoqueInicial() {
  const produtos = produtosRepo.listar({ limite: 1000, incluirInativos: true });
  if (!produtos.length) return { planos: 0, chaves: 0 };
  return semearEstoque(produtos);
}

/**
 * Um pedido de amostra ja pago, com licencas emitidas. Serve para que a area
 * do cliente e o painel administrativo tenham dados reais desde o primeiro
 * acesso.
 *
 * As chaves saem do MESMO pool que o checkout usa — nada de inventar licenca
 * por fora, senao o estoque contaria uma historia e o pedido outra.
 */
function semearPedidoExemplo(usuario, produtos) {
  if (vendasRepo.contarDoUsuario(usuario.id) > 0) return { criado: false };

  const escolhidos = produtos.slice(0, 2).filter(produto => produto.planos.length > 0);
  if (!escolhidos.length) return { criado: false };

  const linhas = escolhidos.map(produto => ({
    produto,
    plano: produto.planos[0],
    quantidade: 1
  }));

  const subtotal = linhas.reduce((soma, linha) => soma + linha.plano.precoCentavos * linha.quantidade, 0);
  const vendaId = novoId();
  const agora = agoraISO();

  conectar().transaction(() => {
    vendasRepo.inserirVenda({
      id: vendaId,
      numero: gerarCodigo('NX'),
      usuarioId: usuario.id,
      status: 'pago',
      subtotalCentavos: subtotal,
      descontoCentavos: 0,
      totalCentavos: subtotal,
      cupomCodigo: null,
      metodoPagamento: 'pix',
      provedorPagamento: 'simulado',
      pagamentoId: `sim_${novoId().slice(0, 12)}`,
      pagamentoStatus: 'aprovado',
      pagoEm: agora,
      criadoEm: agora,
      atualizadoEm: agora
    });

    for (const linha of linhas) {
      const itemId = novoId();
      vendasRepo.inserirItem({
        id: itemId,
        vendaId,
        produtoId: linha.produto.id,
        produtoNome: linha.produto.nome,
        planoId: linha.plano.id,
        planoNome: linha.plano.nome,
        precoCentavos: linha.plano.precoCentavos,
        quantidade: linha.quantidade,
        subtotalCentavos: linha.plano.precoCentavos * linha.quantidade
      });

      // Consome do pool. Se por algum motivo nao houver chave, o pedido de
      // amostra simplesmente nao e criado (nao ha como emitir licenca).
      const chaves = estoqueRepo.consumir(linha.produto.id, linha.plano.id, linha.quantidade, {
        vendaId,
        vendaItemId: itemId
      });
      if (!chaves) return;

      chaves.forEach(chave => {
        licencasRepo.inserir({
          id: novoId(),
          chave,
          vendaId,
          vendaItemId: itemId,
          usuarioId: usuario.id,
          produtoId: linha.produto.id,
          planoId: linha.plano.id,
          status: 'ativa',
          expiraEm: linha.plano.dias ? daquiADias(linha.plano.dias) : null,
          criadaEm: agora
        });
      });

      estoqueRepo.registrarMovimento({
        produtoId: linha.produto.id,
        planoId: linha.plano.id,
        tipo: 'saida',
        quantidade: chaves.length,
        motivo: 'Pedido de amostra',
        atorId: null
      });
    }
  })();

  return { criado: true };
}

/** Avaliacoes de amostra, uma por cliente/produto (a tabela tem UNIQUE). */
function semearAvaliacoes(usuarios, produtos) {
  const COMENTARIOS = [
    { nota: 5, texto: 'Ganhei uns 40 FPS no meu setup. Instalação simples e sem enrolação.' },
    { nota: 5, texto: 'Entrega foi instantânea, a chave apareceu na hora. Recomendo.' },
    { nota: 4, texto: 'Funciona bem. Só senti falta de mais perfis prontos para jogos antigos.' },
    { nota: 5, texto: 'Melhor custo-benefício que achei. Suporte respondeu rápido no Discord.' },
    { nota: 4, texto: 'Bom, mas demorei um pouco para achar as configurações certas.' }
  ];

  let criadas = 0;
  let indice = 0;

  for (const usuario of usuarios) {
    for (const produto of produtos.slice(0, 3)) {
      if (avaliacoesRepo.buscarDoUsuario(produto.id, usuario.id)) continue;
      const base = COMENTARIOS[indice % COMENTARIOS.length];
      avaliacoesRepo.salvar({
        id: novoId(),
        produtoId: produto.id,
        usuarioId: usuario.id,
        vendaId: null,
        nota: base.nota,
        comentario: base.texto
      });
      criadas += 1;
      indice += 1;
    }
  }

  return criadas;
}

/**
 * Executa toda a semeadura.
 * @returns {{ produtos:number, cupons:number, usuarios:number, avaliacoes:number, pedidos:number }}
 */
function semear({ silencioso = false } = {}) {
  // Garante o schema antes de escrever qualquer coisa.
  migrar();

  const resultado = { produtos: 0, cupons: 0, usuarios: 0, avaliacoes: 0, pedidos: 0, estoque: 0 };

  /* Gateways de pagamento ------------------------------------------------ */
  // Cada gateway ganha sua linha com a configuracao padrao (o simulador nasce
  // ligado, os reais nascem prontos porem desligados).
  gatewayService.garantirCatalogo();

  /* Catalogo ------------------------------------------------------------- */
  CATALOGO.forEach((produto, indice) => {
    if (semearProduto(produto, indice).criado) resultado.produtos += 1;
  });

  /* Cupons --------------------------------------------------------------- */
  for (const cupom of CUPONS) {
    if (cuponsRepo.buscar(cupom.codigo)) continue;
    cuponsRepo.criar({
      codigo: cupom.codigo,
      tipo: cupom.tipo,
      valor: cupom.valor,
      minimoCentavos: cupom.minimoCentavos,
      maxUsos: cupom.maxUsos,
      expiraEm: cupom.expiraEm,
      ativo: true,
      descricao: cupom.descricao
    });
    resultado.cupons += 1;
  }

  /* Usuarios ------------------------------------------------------------- */
  const usuariosCriados = [];
  for (const conta of CONTAS_DEMO) {
    // Um e-mail listado em ADMIN_EMAILS sempre vira administrador.
    const papel = config.admin.emails.includes(conta.email.toLowerCase()) ? 'admin' : conta.papel;
    const { usuario, criado } = semearUsuario({ ...conta, papel });
    if (criado) {
      resultado.usuarios += 1;
      usuariosCriados.push(usuario);
    }
  }

  /* Configuracoes da loja ------------------------------------------------ */
  if (!configuracoesRepo.obterValor('suporte_discord', null)) {
    configuracoesRepo.definirVarias({
      aviso_topo: '',
      modo_manutencao: 'false',
      suporte_email: 'suporte@nexus.gg',
      suporte_discord: 'https://discord.gg/nexus'
    });
  }

  // Lista ja com os planos anexados: usada pelo estoque e pelos dados de amostra.
  const produtos = produtosRepo.listar({ limite: 100 });

  /* Estoque -------------------------------------------------------------- */
  // Precisa vir ANTES do pedido de amostra, que consome chaves do pool.
  resultado.estoque = semearEstoque(produtos).chaves;

  /* Dados de amostra ----------------------------------------------------- */
  const clienteDemo = usuariosRepo.buscarPorEmail('demo@loja.com');

  if (clienteDemo && !silencioso) {
    if (semearPedidoExemplo(clienteDemo, produtos).criado) resultado.pedidos += 1;
  }

  // Avaliacoes de quem acabou de ser criado (nao repovoa o que ja existe).
  if (usuariosCriados.length) {
    resultado.avaliacoes = semearAvaliacoes(usuariosCriados, produtos);
  }

  if (!silencioso) {
    logger.info('Semeadura concluida', {
      produtos: resultado.produtos,
      cupons: resultado.cupons,
      usuarios: resultado.usuarios,
      avaliacoes: resultado.avaliacoes,
      pedidos: resultado.pedidos,
      estoque: resultado.estoque
    });
  }

  return resultado;
}

/** True quando o catalogo ainda esta vazio (usado no boot automatico). */
function bancoVazio() {
  return produtosRepo.contar({ incluirInativos: true }) === 0;
}

module.exports = { semear, bancoVazio, CONTAS_DEMO, estoqueNuncaInicializado, garantirEstoqueInicial };
