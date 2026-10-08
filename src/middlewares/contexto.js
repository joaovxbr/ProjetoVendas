/*
 * middlewares/contexto.js
 * -----------------------------------------------------------------------------
 * Da a cada requisicao um id unico e um logger com esse id embutido, e mede
 * quanto tempo ela levou. O id volta no cabecalho X-Request-Id, o que permite
 * cruzar o que o cliente viu com o que ficou registrado no servidor.
 */
'use strict';

const logger = require('../utils/logger');
const { novoId } = require('../utils/seguranca');

/*
 * IP do cliente segundo o `trust proxy` do Express. O X-Forwarded-For so conta
 * quando chega por um proxy confiavel: lido direto do cabecalho, qualquer
 * cliente escolheria o IP que fica no log e na auditoria.
 */
function ipDe(req) {
  return String(req.ip || req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
}

function contexto(req, res, next) {
  const recebido = req.headers['x-request-id'];
  // Aceita o id do proxy, mas limita o tamanho e o alfabeto (evita log injection).
  req.id = typeof recebido === 'string' && /^[\w-]{1,64}$/.test(recebido) ? recebido : novoId();
  req.ipCliente = ipDe(req);

  res.set('X-Request-Id', req.id);
  req.log = logger.comContexto({ reqId: req.id });

  const inicio = process.hrtime.bigint();

  res.on('finish', () => {
    const duracaoMs = Number(process.hrtime.bigint() - inicio) / 1e6;

    // 4xx/5xx chamam mais atencao; o resto fica em debug para nao poluir.
    const nivel = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'debug';
    req.log[nivel]('requisicao', {
      metodo: req.method,
      rota: req.originalUrl.split('?')[0],
      status: res.statusCode,
      duracaoMs: Math.round(duracaoMs * 100) / 100,
      ip: req.ipCliente,
      usuarioId: req.usuario ? req.usuario.id : undefined
    });
  });

  next();
}

/**
 * Envolve um handler async para que qualquer rejeicao chegue ao middleware de
 * erros. Sem isso, um `await` que falha em Express 4 vira uma promise rejeitada
 * silenciosa e a requisicao fica pendurada.
 */
function assincrono(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

module.exports = { contexto, assincrono, ipDe };
