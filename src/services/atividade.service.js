/*
 * services/atividade.service.js
 * -----------------------------------------------------------------------------
 * Historico de atividades do CLIENTE — a linha do tempo que aparece no painel
 * /conta ("o que eu fiz na loja").
 *
 * Diferenca em relacao a auditoria:
 *   - auditoria (tabela `auditoria`) = trilha do ADMIN. Registra quem mudou o
 *     que, para responsabilizar. Nao e exibida ao cliente.
 *   - atividades (tabela `atividades`) = o que a propria pessoa fez, exibido
 *     para ela. Por isso o texto ja fica pronto para mostrar.
 *
 * REGRA DE OURO: registrar atividade e um EXTRA. Se falhar, nao pode derrubar a
 * operacao principal (um login nao pode falhar porque o historico deu erro).
 * Todo o corpo de registrar() esta protegido.
 */
'use strict';

const atividadesRepo = require('../repositories/atividades.repo');
const { novoId } = require('../utils/seguranca');
const logger = require('../utils/logger');
const { lerInteiro } = require('../utils/validacao');

/*
 * Catalogo de tipos. Fica no servidor para que o front nao precise conhecer a
 * lista (e para o filtro da tela ser montado a partir de dados reais).
 * `icone` usa os nomes que a vitrine ja tem em ui.js / admin-ui.js.
 */
const TIPOS = {
  cadastro: { rotulo: 'Conta criada', icone: 'usuario', tom: 'ok' },
  login: { rotulo: 'Entrada na conta', icone: 'cadeado', tom: 'neutro' },
  perfil_atualizado: { rotulo: 'Perfil atualizado', icone: 'usuario', tom: 'neutro' },
  senha_alterada: { rotulo: 'Senha alterada', icone: 'escudo', tom: 'aviso' },
  senha_recuperada: { rotulo: 'Senha recuperada', icone: 'escudo', tom: 'aviso' },
  preferencias_atualizadas: { rotulo: 'Preferências atualizadas', icone: 'ajustes', tom: 'neutro' },
  pedido_criado: { rotulo: 'Pedido realizado', icone: 'carrinho', tom: 'info' },
  pedido_pago: { rotulo: 'Pagamento aprovado', icone: 'check', tom: 'ok' },
  pedido_cancelado: { rotulo: 'Pedido cancelado', icone: 'x', tom: 'erro' },
  pedido_reembolsado: { rotulo: 'Pedido reembolsado', icone: 'atualizar', tom: 'aviso' },
  licenca_resgatada: { rotulo: 'Chave ativada', icone: 'cadeado', tom: 'ok' },
  licenca_revogada: { rotulo: 'Chave revogada', icone: 'escudo', tom: 'erro' },
  avaliacao_publicada: { rotulo: 'Avaliação publicada', icone: 'estrela', tom: 'info' },
  avaliacao_removida: { rotulo: 'Avaliação removida', icone: 'estrela', tom: 'neutro' },
  favorito_adicionado: { rotulo: 'Adicionado aos favoritos', icone: 'coracao', tom: 'info' },
  favorito_removido: { rotulo: 'Removido dos favoritos', icone: 'coracao', tom: 'neutro' }
};

const LIMITE_MAX = 100;

/**
 * Registra uma atividade do cliente.
 *
 * Nunca lanca: o historico e um extra, entao uma falha aqui vira um aviso no log
 * e a operacao principal segue normalmente.
 *
 * @param {string} usuarioId
 * @param {{tipo: string, titulo: string, descricao?: string, referenciaId?: string, ip?: string}} dados
 * @returns {object|null} a atividade criada, ou null se nao foi possivel registrar
 */
function registrar(usuarioId, { tipo, titulo, descricao = '', referenciaId = null, ip = null } = {}) {
  try {
    if (!usuarioId || !tipo || !titulo) return null;

    return atividadesRepo.inserir({
      id: novoId(),
      usuarioId,
      tipo,
      titulo,
      descricao,
      referenciaId,
      ip
    });
  } catch (erro) {
    logger.warn('Nao foi possivel registrar a atividade', { usuarioId, tipo, erro: erro.message });
    return null;
  }
}

/** Enriquece a linha com o rotulo/icone/tom do catalogo. */
function paraPublico(atividade) {
  const meta = TIPOS[atividade.tipo] || { rotulo: atividade.tipo, icone: 'relogio', tom: 'neutro' };
  return {
    id: atividade.id,
    tipo: atividade.tipo,
    tipoRotulo: meta.rotulo,
    icone: meta.icone,
    tom: meta.tom,
    titulo: atividade.titulo,
    descricao: atividade.descricao,
    referenciaId: atividade.referenciaId,
    criadoEm: atividade.criadoEm
  };
}

/**
 * Historico paginado do usuario.
 * @returns {{atividades: object[], total: number, quantidade: number, tipos: object[]}}
 */
function listar(usuarioId, { tipo = null, busca = null, limite = 30, deslocamento = 0 } = {}) {
  const limiteLimpo = Math.min(Math.max(lerInteiro(limite, 30) || 30, 1), LIMITE_MAX);
  const deslocamentoLimpo = Math.max(lerInteiro(deslocamento, 0) || 0, 0);
  const tipoLimpo = tipo && TIPOS[tipo] ? tipo : null;

  const linhas = atividadesRepo.listarDoUsuario({
    usuarioId,
    tipo: tipoLimpo,
    busca,
    limite: limiteLimpo,
    deslocamento: deslocamentoLimpo
  });

  const total = atividadesRepo.contarDoUsuario({ usuarioId, tipo: tipoLimpo, busca });

  return {
    atividades: linhas.map(paraPublico),
    total,
    quantidade: linhas.length,
    // So os tipos que a pessoa realmente tem, com contagem — monta o filtro.
    tipos: tiposDoUsuario(usuarioId)
  };
}

/** Tipos presentes no historico do usuario, com rotulo e contagem. */
function tiposDoUsuario(usuarioId) {
  const contagens = atividadesRepo.contarPorTipo(usuarioId);
  return Object.keys(contagens)
    .map(tipo => ({
      tipo,
      rotulo: (TIPOS[tipo] && TIPOS[tipo].rotulo) || tipo,
      icone: (TIPOS[tipo] && TIPOS[tipo].icone) || 'relogio',
      total: contagens[tipo]
    }))
    .sort((a, b) => b.total - a.total);
}

/** Resumo curto: total, ultima atividade e os tipos mais frequentes. */
function resumo(usuarioId) {
  const total = atividadesRepo.contarDoUsuario({ usuarioId });
  const ultimas = atividadesRepo.listarDoUsuario({ usuarioId, limite: 1 });

  return {
    total,
    ultimaEm: ultimas.length ? ultimas[0].criadoEm : null,
    ultima: ultimas.length ? paraPublico(ultimas[0]) : null,
    tipos: tiposDoUsuario(usuarioId)
  };
}

/** Apaga o historico do usuario (acao do proprio dono). */
function limpar(usuarioId) {
  return { removidas: atividadesRepo.removerDoUsuario(usuarioId) };
}

module.exports = {
  TIPOS,
  registrar,
  paraPublico,
  listar,
  resumo,
  tiposDoUsuario,
  limpar
};
