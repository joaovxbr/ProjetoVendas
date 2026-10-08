/*
 * services/licenca.service.js
 * -----------------------------------------------------------------------------
 * Ciclo de vida das chaves de licenca entregues ao cliente.
 *
 * Regra de validade: uma licenca nasce "ativa" e SEM data de expiracao. A
 * contagem dos dias do plano comeca no RESGATE, nao na compra — quem compra um
 * plano de 30 dias e demora duas semanas para usar nao perde o periodo.
 */
'use strict';

const produtosRepo = require('../repositories/produtos.repo');
const licencasRepo = require('../repositories/licencas.repo');
const auditoriaRepo = require('../repositories/auditoria.repo');
const atividadeService = require('./atividade.service');

const { NaoEncontrado, RegraNegocio, SemPermissao } = require('../utils/erros');
const { agoraISO, daquiADias, expirou, formatarDataBR } = require('../utils/datas');
const { exigirChaveLicenca } = require('../utils/validacao');

/** Converte a licenca interna no formato publico. */
function paraPublico(licenca, produto = null) {
  if (!licenca) return null;

  const ativada = licenca.status === 'resgatada';
  // Sem data de expiracao: ou e vitalicia, ou ainda nao foi ativada. Nos dois
  // casos nao esta expirada — por isso a checagem so vale quando ha data.
  const expirada = !!licenca.expiraEm && expirou(licenca.expiraEm);

  return {
    id: licenca.id,
    chave: licenca.chave,
    produtoId: licenca.produtoId,
    produto: produto ? produto.nome : null,
    planoId: licenca.planoId,
    status: licenca.status,
    ativada,
    expirada,
    // Sem expiracao: ou e vitalicia, ou ainda nao foi ativada.
    vitalicia: ativada && !licenca.expiraEm,
    expiraEm: licenca.expiraEm,
    expiraEmFormatado: licenca.expiraEm ? formatarDataBR(licenca.expiraEm) : null,
    ativadaEm: licenca.resgatadaEm,
    criadaEm: licenca.criadaEm
  };
}

/** Chaves do cliente, opcionalmente filtradas por produto ou status. */
function minhas(usuarioId, filtros = {}) {
  const licencas = licencasRepo.listarDoUsuario(usuarioId, {
    produtoId: filtros.produtoId || null,
    status: filtros.status || null
  });

  const cache = new Map();
  const resolverProduto = (produtoId) => {
    if (!cache.has(produtoId)) cache.set(produtoId, produtosRepo.buscarPorId(produtoId));
    return cache.get(produtoId);
  };

  const lista = licencas.map(licenca => paraPublico(licenca, resolverProduto(licenca.produtoId)));

  return {
    quantidade: lista.length,
    ativas: lista.filter(item => item.status === 'ativa').length,
    chaves: lista
  };
}

/**
 * Ativa (resgata) uma chave. A partir daqui os dias do plano comecam a contar.
 * @param {string} chave
 * @param {string} usuarioId
 */
function resgatar(chave, usuarioId, { ip = null } = {}) {
  const chaveLimpa = exigirChaveLicenca(chave);

  const licenca = licencasRepo.buscarPorChave(chaveLimpa);
  if (!licenca) throw new NaoEncontrado('Chave nao encontrada');

  if (licenca.usuarioId !== usuarioId) {
    throw new SemPermissao('Esta chave pertence a outra conta');
  }
  if (licenca.status === 'revogada') {
    throw new RegraNegocio('Esta licenca foi revogada. Fale com o suporte.');
  }
  if (licenca.status === 'resgatada') {
    throw new RegraNegocio('Esta chave ja foi ativada');
  }

  // Descobre quantos dias o plano concede (null = vitalicio).
  const plano = produtosRepo.buscarPlano(licenca.produtoId, licenca.planoId);
  const dias = plano ? plano.dias : null;

  const expiraEm = dias ? daquiADias(dias) : null;

  const conexao = require('../db/conexao');
  conexao.executar(`
    UPDATE licencas
    SET status = 'resgatada', resgatada_em = @agora, expira_em = @expiraEm
    WHERE id = @id AND status = 'ativa'
  `, { id: licenca.id, agora: agoraISO(), expiraEm });

  auditoriaRepo.registrar({
    atorId: usuarioId,
    acao: 'licenca.resgatada',
    entidade: 'licenca',
    entidadeId: licenca.id,
    dados: { produtoId: licenca.produtoId, dias },
    ip
  });

  const atualizada = licencasRepo.buscarPorId(licenca.id);

  atividadeService.registrar(usuarioId, {
    tipo: 'licenca_resgatada',
    titulo: 'Chave ativada',
    descricao: dias
      ? `${produtosRepo.buscarPorId(licenca.produtoId)?.nome || 'Licença'} · válida por ${dias} dias.`
      : `${produtosRepo.buscarPorId(licenca.produtoId)?.nome || 'Licença'} · licença vitalícia.`,
    referenciaId: licenca.id,
    ip
  });

  return paraPublico(atualizada, produtosRepo.buscarPorId(atualizada.produtoId));
}

/** Revoga uma chave (estorno, fraude, suporte). */
function revogar(licencaId, { atorId = null, motivo = 'revogada pela administracao', ip = null } = {}) {
  const licenca = licencasRepo.buscarPorId(licencaId);
  if (!licenca) throw new NaoEncontrado('Licenca nao encontrada');

  licencasRepo.revogar(licencaId);
  auditoriaRepo.registrar({ atorId, acao: 'licenca.revogada', entidade: 'licenca', entidadeId: licencaId, dados: { motivo }, ip });

  // O dono da chave precisa saber: uma revogacao nao pode ser silenciosa.
  atividadeService.registrar(licenca.usuarioId, {
    tipo: 'licenca_revogada',
    titulo: 'Chave revogada',
    descricao: `${produtosRepo.buscarPorId(licenca.produtoId)?.nome || 'Licença'} · ${motivo}`,
    referenciaId: licencaId,
    ip
  });

  return paraPublico(licencasRepo.buscarPorId(licencaId), produtosRepo.buscarPorId(licenca.produtoId));
}

/** O cliente ja possui licenca valida deste produto? (usado na avaliacao) */
function possui(usuarioId, produtoId) {
  return licencasRepo.possuiAtiva(usuarioId, produtoId);
}

/** Resumo para a area do cliente. */
function resumo(usuarioId) {
  const licencas = licencasRepo.listarDoUsuario(usuarioId);
  return {
    total: licencas.length,
    ativas: licencas.filter(licenca => licenca.status === 'ativa').length,
    ativadas: licencas.filter(licenca => licenca.status === 'resgatada').length,
    revogadas: licencas.filter(licenca => licenca.status === 'revogada').length
  };
}

module.exports = { paraPublico, minhas, resgatar, revogar, possui, resumo };
