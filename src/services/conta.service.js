/*
 * services/conta.service.js
 * -----------------------------------------------------------------------------
 * Area do cliente: visao consolidada do que a pessoa tem na loja — pedidos,
 * chaves, favoritos e quanto ja gastou. Uma requisicao so, para a tela de
 * perfil nao precisar disparar cinco chamadas.
 */
'use strict';

const usuariosRepo = require('../repositories/usuarios.repo');
const produtosRepo = require('../repositories/produtos.repo');
const vendasRepo = require('../repositories/vendas.repo');
const licencasRepo = require('../repositories/licencas.repo');
const favoritosRepo = require('../repositories/favoritos.repo');
const avaliacoesRepo = require('../repositories/avaliacoes.repo');
const sessoesRepo = require('../repositories/sessoes.repo');

const authService = require('./auth.service');
const checkoutService = require('./checkout.service');
const licencaService = require('./licenca.service');
const atividadeService = require('./atividade.service');

const { NaoEncontrado } = require('../utils/erros');
const { paraReais } = require('../utils/dinheiro');
const { tempoRelativo } = require('../utils/datas');
const { lerBooleano, exigirOpcao } = require('../utils/validacao');

/*
 * Catalogo das preferencias do cliente. Fica no SERVIDOR de proposito: assim o
 * front monta os controles a partir desta lista e nao existe uma segunda copia
 * dos rotulos/descricoes para sair de sincronia quando uma preferencia muda.
 */
const OPCOES_PREFERENCIA = [
  {
    chave: 'avisoLicenca',
    tipo: 'booleano',
    titulo: 'Aviso de licença expirando',
    descricao: 'Mostra um aviso na loja quando uma das suas chaves estiver perto de vencer.'
  },
  {
    chave: 'novidadesEmail',
    tipo: 'booleano',
    titulo: 'Novidades e promoções',
    descricao: 'Quero receber lançamentos e cupons por e-mail.'
  },
  {
    chave: 'resumoCompras',
    tipo: 'booleano',
    titulo: 'Resumo de compras',
    descricao: 'Receber o resumo do pedido por e-mail a cada compra.'
  },
  {
    chave: 'tema',
    tipo: 'opcao',
    titulo: 'Aparência',
    descricao: 'Tema usado na loja e na sua conta.',
    opcoes: [
      { valor: 'escuro', rotulo: 'Escuro (padrão)' },
      { valor: 'claro', rotulo: 'Claro' }
    ]
  }
];

/** Painel resumido do cliente. */
function resumo(usuarioId, { sidAtual = null } = {}) {
  const usuario = usuariosRepo.buscarPorId(usuarioId);
  if (!usuario) throw new NaoEncontrado('Usuario nao encontrado');

  const pedidos = vendasRepo.listarDoUsuario(usuarioId, { limite: 5 });
  const licencas = licencasRepo.listarDoUsuario(usuarioId);
  const gastoCentavos = vendasRepo.totalGastoDoUsuario(usuarioId);

  return {
    usuario: authService.paraPublico(usuario),
    estatisticas: {
      pedidos: vendasRepo.contarDoUsuario(usuarioId),
      gastoCentavos,
      gasto: paraReais(gastoCentavos),
      licencas: licencas.length,
      licencasAtivas: licencas.filter(licenca => licenca.status === 'ativa').length,
      favoritos: favoritosRepo.contarDoUsuario(usuarioId),
      avaliacoes: avaliacoesRepo.contarDoUsuario(usuarioId),
      sessoesAtivas: sessoesRepo.contarDoUsuario(usuarioId)
    },
    pedidosRecentes: pedidos.map(venda => ({
      id: venda.id,
      numero: venda.numero,
      status: venda.status,
      total: paraReais(venda.totalCentavos),
      criadoEm: venda.criadoEm,
      quando: tempoRelativo(venda.criadoEm),
      itens: venda.itens.length
    })),
    // Passa o produto para a licenca sair com o nome real (senao a tela mostra
    // so "Licenca" na lista de chaves recentes).
    licencasRecentes: licencas.slice(0, 5).map(licenca =>
      licencaService.paraPublico(licenca, produtosRepo.buscarPorId(licenca.produtoId))
    ),
    favoritos: favoritosRepo.listarIds(usuarioId),
    atividades: atividadeService.resumo(usuarioId),
    preferencias: usuario.preferencias
  };
}

/** Historico de compras, com filtro opcional por status. */
function historico(usuarioId, { status = null, limite = 20, deslocamento = 0 } = {}) {
  const vendas = vendasRepo.listarDoUsuario(usuarioId, { limite, deslocamento });
  const filtradas = status ? vendas.filter(venda => venda.status === status) : vendas;

  return {
    quantidade: filtradas.length,
    pedidos: filtradas.map(venda => checkoutService.paraPublico(
      venda,
      venda.itens,
      licencasRepo.listarDaVenda(venda.id)
    ))
  };
}

/** Sessoes abertas do usuario, marcando a atual ("sair dos outros aparelhos"). */
function dispositivos(usuarioId, sidAtual = null) {
  return sessoesRepo.listarDoUsuario(usuarioId).map(sessao => ({
    atual: sessao.sid === sidAtual,
    criadaEm: sessao.criadaEm,
    expiraEm: sessao.expiraEm,
    ip: sessao.ip,
    // So o comeco do user-agent: o suficiente para reconhecer o aparelho.
    dispositivo: sessao.userAgent ? sessao.userAgent.slice(0, 80) : 'Desconhecido'
  }));
}

/* -------------------------------------------------------------------------- */
/* Historico de atividades                                                    */
/* -------------------------------------------------------------------------- */

/** Linha do tempo do cliente, com filtro por tipo e busca. */
function atividades(usuarioId, { tipo = null, busca = null, limite = 30, deslocamento = 0 } = {}) {
  return atividadeService.listar(usuarioId, { tipo, busca, limite, deslocamento });
}

/** Apaga o historico do proprio usuario. */
function limparAtividades(usuarioId) {
  const resultado = atividadeService.limpar(usuarioId);
  return {
    ...resultado,
    mensagem: resultado.removidas
      ? `Histórico limpo (${resultado.removidas} registro(s)).`
      : 'Não havia nada para limpar.'
  };
}

/* -------------------------------------------------------------------------- */
/* Preferencias                                                               */
/* -------------------------------------------------------------------------- */

/** Preferencias atuais + o catalogo que o front usa para montar os controles. */
function preferencias(usuarioId) {
  const usuario = usuariosRepo.buscarPorId(usuarioId);
  if (!usuario) throw new NaoEncontrado('Usuario nao encontrado');

  return { preferencias: usuario.preferencias, opcoes: OPCOES_PREFERENCIA };
}

/**
 * Salva as preferencias informadas (patch parcial: o que nao vier, fica).
 * Registra uma atividade apenas se algo realmente mudou.
 */
function salvarPreferencias(usuarioId, dados = {}, { ip = null } = {}) {
  const usuario = usuariosRepo.buscarPorId(usuarioId);
  if (!usuario) throw new NaoEncontrado('Usuario nao encontrado');

  const atualizacao = {};
  const alteradas = [];

  OPCOES_PREFERENCIA.forEach(opcao => {
    if (dados[opcao.chave] === undefined) return;

    const atual = usuario.preferencias[opcao.chave];
    const valor = opcao.tipo === 'booleano'
      ? lerBooleano(dados[opcao.chave], atual)
      : exigirOpcao(dados[opcao.chave], opcao.opcoes.map(item => item.valor), opcao.chave, atual);

    if (valor !== atual) alteradas.push(opcao.titulo);
    atualizacao[opcao.chave] = valor;
  });

  const atualizado = usuariosRepo.atualizarPreferencias(usuarioId, atualizacao);

  if (alteradas.length) {
    atividadeService.registrar(usuarioId, {
      tipo: 'preferencias_atualizadas',
      titulo: 'Preferências atualizadas',
      descricao: `Alterou: ${alteradas.join(', ')}.`,
      ip
    });
  }

  return {
    preferencias: atualizado.preferencias,
    alteradas,
    mensagem: alteradas.length ? 'Preferências salvas' : 'Nenhuma alteração para salvar'
  };
}

module.exports = {
  OPCOES_PREFERENCIA,
  resumo,
  historico,
  dispositivos,
  atividades,
  limparAtividades,
  preferencias,
  salvarPreferencias
};
