/*
 * services/avaliacao.service.js
 * -----------------------------------------------------------------------------
 * Avaliacoes de produto.
 *
 * Regra: so avalia quem tem licenca daquele produto ("compra verificada").
 * Isso e o que impede a loja de encher de nota 5 de gente que nunca comprou —
 * e e justamente o que o cliente espera ver em uma loja seria.
 */
'use strict';

const produtosRepo = require('../repositories/produtos.repo');
const avaliacoesRepo = require('../repositories/avaliacoes.repo');
const licencasRepo = require('../repositories/licencas.repo');
const auditoriaRepo = require('../repositories/auditoria.repo');
const atividadeService = require('./atividade.service');

const { NaoEncontrado, SemPermissao, ErroValidacao } = require('../utils/erros');
const { novoId } = require('../utils/seguranca');
const { exigirInteiro, textoOpcional } = require('../utils/validacao');
const config = require('../config');

function paraPublico(avaliacao) {
  if (!avaliacao) return null;
  return {
    id: avaliacao.id,
    produtoId: avaliacao.produtoId,
    nota: avaliacao.nota,
    comentario: avaliacao.comentario,
    autor: avaliacao.autorNome || null,
    criadoEm: avaliacao.criadoEm,
    atualizadoEm: avaliacao.atualizadoEm
  };
}

/**
 * Cria ou atualiza a avaliacao do usuario para um produto.
 * @throws {SemPermissao} quando o usuario nao possui o produto
 */
function avaliar(usuarioId, produtoId, { nota, comentario = '' }, { ip = null } = {}) {
  const produto = produtosRepo.buscarPorId(produtoId);
  if (!produto || !produto.ativo) throw new NaoEncontrado('Produto nao encontrado');

  if (!licencasRepo.possuiAtiva(usuarioId, produtoId)) {
    throw new SemPermissao('Voce so pode avaliar produtos que ja comprou');
  }

  const notaFinal = exigirInteiro(nota, 'nota', { rotulo: 'Nota', min: 1, max: 5 });
  const comentarioFinal = textoOpcional(comentario, 'comentario', {
    rotulo: 'Comentario',
    max: config.regras.comentarioMax
  });

  const existente = avaliacoesRepo.buscarDoUsuario(produtoId, usuarioId);

  const avaliacao = avaliacoesRepo.salvar({
    id: existente ? existente.id : novoId(),
    produtoId,
    usuarioId,
    vendaId: existente ? existente.vendaId : null,
    nota: notaFinal,
    comentario: comentarioFinal
  });

  auditoriaRepo.registrar({
    atorId: usuarioId,
    acao: existente ? 'avaliacao.atualizada' : 'avaliacao.criada',
    entidade: 'avaliacao',
    entidadeId: avaliacao.id,
    dados: { produtoId, nota: notaFinal },
    ip
  });

  // Recalcula a media exibida no produto (base historica + reais).
  const atualizado = produtosRepo.buscarPorId(produtoId);

  atividadeService.registrar(usuarioId, {
    tipo: 'avaliacao_publicada',
    titulo: existente ? 'Avaliação atualizada' : 'Avaliação publicada',
    descricao: `${atualizado ? atualizado.nome : 'Produto'} · ${notaFinal} de 5 estrelas.`,
    referenciaId: produtoId,
    ip
  });

  return {
    avaliacao: { ...paraPublico(avaliacoesRepo.buscarDoUsuario(produtoId, usuarioId)), autor: null },
    produto: { id: atualizado.id, avaliacao: atualizado.avaliacao, avaliacoes: atualizado.avaliacoes }
  };
}

/** Avaliacoes publicas de um produto. */
function doProduto(produtoId, { limite = 20, deslocamento = 0 } = {}) {
  const produto = produtosRepo.buscarPorId(produtoId);
  if (!produto) throw new NaoEncontrado('Produto nao encontrado');

  const avaliacoes = avaliacoesRepo.listarDoProduto(produtoId, { limite, deslocamento });

  return {
    produtoId,
    media: produto.avaliacao,
    total: produto.avaliacoes,
    itens: avaliacoes.map(paraPublico)
  };
}

/** Avaliacoes do proprio usuario (para o cliente editar a que ja fez). */
function minhas(usuarioId) {
  const licencas = licencasRepo.listarDoUsuario(usuarioId);
  const vistos = new Set();
  const resultado = [];

  for (const licenca of licencas) {
    if (vistos.has(licenca.produtoId)) continue;
    vistos.add(licenca.produtoId);

    const avaliacao = avaliacoesRepo.buscarDoUsuario(licenca.produtoId, usuarioId);
    const produto = produtosRepo.buscarPorId(licenca.produtoId);
    resultado.push({
      produtoId: licenca.produtoId,
      produto: produto ? produto.nome : null,
      podeAvaliar: true,
      avaliacao: avaliacao ? paraPublico(avaliacao) : null
    });
  }

  return resultado;
}

/** O usuario pode avaliar este produto? (usado para mostrar o formulario) */
function podeAvaliar(usuarioId, produtoId) {
  if (!usuarioId) return false;
  return licencasRepo.possuiAtiva(usuarioId, produtoId);
}

/** Remove a avaliacao (o proprio autor ou um admin). */
function remover(avaliacaoId, usuario, { ip = null } = {}) {
  const avaliacao = avaliacoesRepo.buscarPorId(avaliacaoId);
  if (!avaliacao) throw new NaoEncontrado('Avaliacao nao encontrada');

  if (avaliacao.usuarioId !== usuario.id && usuario.papel !== 'admin') {
    throw new SemPermissao('Voce nao pode remover esta avaliacao');
  }

  avaliacoesRepo.remover(avaliacaoId);
  auditoriaRepo.registrar({ atorId: usuario.id, acao: 'avaliacao.removida', entidade: 'avaliacao', entidadeId: avaliacaoId, ip });

  // O autor fica sabendo — inclusive quando quem removeu foi a moderação.
  const pelaModeracao = avaliacao.usuarioId !== usuario.id;
  atividadeService.registrar(avaliacao.usuarioId, {
    tipo: 'avaliacao_removida',
    titulo: pelaModeracao ? 'Avaliação removida pela moderação' : 'Avaliação removida',
    descricao: `${produtosRepo.buscarPorId(avaliacao.produtoId)?.nome || 'Produto'}`,
    referenciaId: avaliacaoId,
    ip
  });

  return { removida: true };
}

module.exports = { paraPublico, avaliar, doProduto, minhas, podeAvaliar, remover };
