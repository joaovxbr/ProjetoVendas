/*
 * utils/proxy.js
 * -----------------------------------------------------------------------------
 * Interpreta TRUST_PROXY no formato que o Express aceita em `trust proxy`.
 *
 * O `trust proxy` decide de quem o X-Forwarded-For e aceito. Ele e a base do
 * req.ip — e, portanto, do rate limit e do IP gravado na auditoria. Errar para
 * um lado junta todos os clientes atras do IP do proxy (um usuario esgota a
 * cota de todos); errar para o outro deixa qualquer cliente escolher o proprio
 * IP com um cabecalho forjado (e furar o rate limit).
 *
 * Valores aceitos:
 *   (vazio)                -> "loopback": confia apenas em proxy na mesma
 *                             maquina (Nginx local, tunel de desenvolvimento).
 *                             Cliente que conecta direto nao consegue forjar.
 *   false | 0 | nao | off  -> desligado: o X-Forwarded-For e ignorado.
 *   true | sim | on        -> 1 salto (NUNCA o `true` cru do Express, que
 *                             confia em qualquer cabecalho e anula o limite).
 *   1..10                  -> numero de proxies na frente da aplicacao.
 *   lista                  -> IPs/CIDRs e/ou loopback, linklocal, uniquelocal
 *                             separados por virgula (ex.: "loopback,10.0.0.0/8").
 */
'use strict';

const net = require('net');

const PADRAO = 'loopback';
const MAX_SALTOS = 10;
const NOMES_RESERVADOS = new Set(['loopback', 'linklocal', 'uniquelocal']);
const DESLIGADO = new Set(['0', 'false', 'nao', 'no', 'off']);
const LIGADO = new Set(['true', 'sim', 'yes', 'on']);

/** IP, IP/prefixo ou um dos nomes reservados do Express. */
function enderecoValido(item) {
  if (NOMES_RESERVADOS.has(item)) return true;

  const [ip, prefixo, ...sobra] = item.split('/');
  const versao = net.isIP(ip);
  if (sobra.length || !versao) return false;
  if (prefixo === undefined) return true;
  if (!/^\d{1,3}$/.test(prefixo)) return false;
  return Number(prefixo) <= (versao === 4 ? 32 : 128);
}

/**
 * Converte o texto do .env no valor de `app.set('trust proxy', ...)`.
 * Lanca Error com mensagem clara quando o valor nao faz sentido: errar a
 * confianca no proxy em silencio e pior do que nao subir.
 * @param {string | undefined} bruto
 * @returns {false | number | string}
 */
function interpretarTrustProxy(bruto) {
  const valor = typeof bruto === 'string' ? bruto.trim().toLowerCase() : '';

  if (!valor) return PADRAO;
  if (DESLIGADO.has(valor)) return false;
  if (LIGADO.has(valor)) return 1;

  if (/^\d+$/.test(valor)) {
    const saltos = Number(valor);
    if (saltos <= MAX_SALTOS) return saltos;
    throw new Error(`TRUST_PROXY=${valor} fora do intervalo: use de 1 a ${MAX_SALTOS} proxies.`);
  }

  const itens = [...new Set(valor.split(',').map(item => item.trim()).filter(Boolean))];
  const invalidos = itens.filter(item => !enderecoValido(item));
  if (!itens.length || invalidos.length) {
    throw new Error(
      `TRUST_PROXY invalido (${invalidos.join(', ') || valor}). Use false, um numero ` +
      'de proxies (1, 2...) ou uma lista de IPs/CIDRs (ex.: loopback,10.0.0.0/8).'
    );
  }
  return itens.join(',');
}

module.exports = { interpretarTrustProxy, TRUST_PROXY_PADRAO: PADRAO };
