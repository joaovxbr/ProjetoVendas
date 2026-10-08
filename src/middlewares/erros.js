/*
 * middlewares/erros.js
 * -----------------------------------------------------------------------------
 * Fim da linha: 404 para rota inexistente e um tratador central que converte
 * qualquer falha em uma resposta JSON no padrao { erro, codigo, detalhes? }.
 *
 * Regras:
 *  - erro esperado (AppError) -> status e mensagem proprios
 *  - corpo malformado/grande  -> 400 / 413
 *  - qualquer outra coisa     -> 500 generico (detalhe so no log, nunca no JSON)
 */
'use strict';

const { AppError } = require('../utils/erros');
const logger = require('../utils/logger');
const config = require('../config');

/** Rota inexistente (catch-all da aplicacao). */
function naoEncontrado(req, res) {
  res.status(404).json({
    erro: `Rota ${req.method} ${req.originalUrl} nao existe`,
    codigo: 'rota_inexistente'
  });
}

/** Rota de API inexistente: usada dentro de /api, sempre responde JSON. */
function naoEncontradoApi(req, res) {
  res.status(404).json({
    erro: `A rota ${req.method} /api${req.path} nao existe`,
    codigo: 'rota_inexistente'
  });
}

// eslint-disable-next-line no-unused-vars -- o Express identifica o handler pelo arity
function tratadorDeErros(err, req, res, next) {
  const log = req.log || logger;

  // A resposta ja comecou: nao ha o que fazer alem de encerrar a conexao.
  if (res.headersSent) return next(err);

  /* Corpo JSON malformado (express.json) ---------------------------------- */
  if (err.type === 'entity.parse.failed' || err instanceof SyntaxError) {
    return res.status(400).json({ erro: 'JSON invalido', codigo: 'json_invalido' });
  }

  /* Corpo acima do limite ------------------------------------------------ */
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ erro: 'Conteudo da requisicao muito grande', codigo: 'corpo_grande' });
  }

  /* Erros esperados da aplicacao ----------------------------------------- */
  if (err instanceof AppError) {
    if (err.status >= 500) log.error(err.message, { erro: err });
    else log.warn(err.message, { codigo: err.codigo, status: err.status });
    return res.status(err.status).json(err.paraJSON());
  }

  /* Erros do body-parser/urlencoded -------------------------------------- */
  if (err.status && err.status >= 400 && err.status < 500) {
    log.warn('Requisicao invalida', { erro: err.message, status: err.status });
    return res.status(err.status).json({
      erro: 'Requisicao invalida',
      codigo: 'requisicao_invalida'
    });
  }

  /* Violacao de constraint do SQLite ------------------------------------- */
  if (typeof err.code === 'string' && err.code.startsWith('SQLITE_CONSTRAINT')) {
    log.warn('Violacao de integridade', { erro: err.message, codigo: err.code });
    return res.status(409).json({
      erro: 'Esta operacao conflita com dados ja existentes',
      codigo: 'conflito'
    });
  }

  /* Qualquer outra coisa: bug. Nao vaza detalhe para o cliente. ---------- */
  log.error('Erro nao tratado', { erro: err });

  res.status(500).json({
    erro: 'Erro interno no servidor',
    codigo: 'erro_interno',
    // Em desenvolvimento, a mensagem real ajuda muito a depurar.
    ...(config.producao ? {} : { detalhe: err.message })
  });
}

module.exports = { naoEncontrado, naoEncontradoApi, tratadorDeErros };
