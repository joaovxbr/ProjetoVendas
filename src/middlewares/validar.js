/*
 * middlewares/validar.js
 * -----------------------------------------------------------------------------
 * Validacoes que acontecem ANTES do handler da rota: formato de parametros de
 * URL, presenca de corpo e formato do JSON.
 *
 * A validacao de regra de negocio (campo por campo) fica nos servicos, que
 * conhecem o contexto. Aqui cuidamos apenas do que da para checar so olhando
 * a requisicao.
 */
'use strict';

const { ErroValidacao } = require('../utils/erros');
const { UUID_REGEX, lerInteiro } = require('../utils/validacao');

/** Exige que o corpo seja um objeto JSON (nao array, nao vazio). */
function exigirCorpo(req, res, next) {
  const corpo = req.body;
  if (!corpo || typeof corpo !== 'object' || Array.isArray(corpo)) {
    return next(new ErroValidacao('Envie um corpo JSON com os dados da operacao'));
  }
  next();
}

/** Aceita id em formato UUID ou slug (o catalogo usa os dois). */
function validarIdOuSlug(req, res, next) {
  const valor = String(req.params.id || '').trim();
  if (!valor || valor.length > 120) {
    return next(new ErroValidacao('Identificador invalido'));
  }
  next();
}

/** Exige UUID no parametro :id. */
function exigirUuidParam(nome = 'id') {
  return (req, res, next) => {
    const valor = String(req.params[nome] || '').trim();
    if (!UUID_REGEX.test(valor)) {
      return next(new ErroValidacao(`Parametro "${nome}" invalido`));
    }
    next();
  };
}

/**
 * Le e valida os parametros de paginacao da query string.
 * Deixa o resultado em req.paginacao para o handler usar.
 */
function paginacao({ limitePadrao = 20, limiteMax = 100 } = {}) {
  return (req, res, next) => {
    const limite = Math.min(Math.max(lerInteiro(req.query.limite, limitePadrao), 1), limiteMax);
    const pagina = Math.max(lerInteiro(req.query.pagina, 1), 1);

    req.paginacao = { limite, pagina, deslocamento: (pagina - 1) * limite };
    next();
  };
}

/**
 * Normaliza o campo "lembrar" do login: so o valor false explicito desliga o
 * cookie persistente (o front manda true por padrao).
 */
function lerLembrar(valor) {
  return valor !== false && valor !== 'false' && valor !== 0 && valor !== '0';
}

module.exports = { exigirCorpo, validarIdOuSlug, exigirUuidParam, paginacao, lerLembrar };
