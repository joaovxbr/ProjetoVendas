/*
 * middlewares/limites.js
 * -----------------------------------------------------------------------------
 * Protecao contra abuso. Sao tres baldes diferentes porque o custo de cada
 * tipo de rota e diferente:
 *
 *   geral   - todas as rotas /api, por IP (evita varredura e scraping)
 *   auth    - login/cadastro/recuperacao (evita forca bruta)
 *   escrita - POST/DELETE autenticados (evita spam de pedidos)
 */
'use strict';

const rateLimit = require('express-rate-limit');
const config = require('../config');

// Respostas de limite seguem o mesmo envelope de erro do resto da API.
function respostaLimite(mensagem) {
  return { erro: mensagem, codigo: 'limite_excedido' };
}

const base = {
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  /*
   * Com TRUST_PROXY desligado o X-Forwarded-For e ignorado DE PROPOSITO (o
   * operador declarou que nao ha proxy): o cabecalho so pode ter vindo do
   * proprio cliente, e o limite ja usa o IP da conexao. Avisar a cada
   * requisicao seria ruido que um atacante geraria a vontade.
   */
  validate: { xForwardedForHeader: config.trustProxy !== false },
  // Em testes nao queremos que a suite bata no limite.
  skip: () => config.testes
};

/** Balde geral: vale para todo /api, menos o health check. */
const geral = rateLimit({
  ...base,
  windowMs: 60 * 1000,
  limit: config.limites.geral,
  // Um monitor de disponibilidade consulta /api/saude com frequencia: se ele
  // gastasse a cota, seria bloqueado justamente durante um incidente.
  skip: (req) => config.testes || req.path === '/saude',
  message: respostaLimite('Muitas requisicoes. Aguarde um minuto e tente novamente.')
});

/** Balde de autenticacao: janela longa, poucas tentativas. */
function criarLimiteAuth(extras = {}) {
  return rateLimit({
    ...base,
    windowMs: 15 * 60 * 1000,
    limit: config.limites.auth,
    message: respostaLimite('Muitas tentativas. Aguarde 15 minutos e tente novamente.'),
    ...extras
  });
}

// No login, so conta o que falhou: quem acerta a senha nao gasta tentativa.
const login = criarLimiteAuth({ skipSuccessfulRequests: true });
const registro = criarLimiteAuth();
const recuperacao = criarLimiteAuth({ limit: Math.max(Math.floor(config.limites.auth / 2), 3) });

/** Balde de escrita: acoes que criam registros. */
const escrita = rateLimit({
  ...base,
  windowMs: 60 * 1000,
  limit: 60,
  keyGenerator: (req) => (req.usuario ? `u:${req.usuario.id}` : req.ip),
  message: respostaLimite('Voce fez muitas acoes seguidas. Aguarde um instante.')
});

/*
 * Balde do webhook.
 *
 * O webhook e a unica rota PUBLICA que grava dados escolhidos por quem chama
 * (todo aviso recebido vira uma linha em pagamentos_eventos, valido ou nao).
 * Sem um limite proprio, um atacante usaria a rota para encher o banco. O teto
 * e folgado para um gateway de verdade — que manda poucos avisos por minuto —
 * e apertado o bastante para o abuso nao compensar.
 */
const webhook = rateLimit({
  ...base,
  windowMs: 60 * 1000,
  limit: 120,
  message: respostaLimite('Muitas notificacoes de pagamento. Aguarde um instante.')
});

module.exports = { geral, login, registro, recuperacao, escrita, webhook };
