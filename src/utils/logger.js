/*
 * utils/logger.js
 * -----------------------------------------------------------------------------
 * Log estruturado e sem dependencias. Em desenvolvimento sai legivel no
 * terminal; em producao sai uma linha JSON por evento, pronta para ser
 * coletada por qualquer agregador (Loki, CloudWatch, Datadog...).
 *
 * Niveis: debug < info < warn < error < silent
 */
'use strict';

const config = require('../config');

const NIVEIS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };
const LIMITE = NIVEIS[config.log.nivel] ?? NIVEIS.info;

const CORES = {
  debug: '\x1b[90m',
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
  reset: '\x1b[0m'
};

function agora() {
  return new Date().toISOString();
}

// Deixa o log de uma linha so: quebras de linha atrapalham agregadores.
function achatar(valor) {
  return String(valor).replace(/\s+/g, ' ').trim();
}

function escrever(nivel, mensagem, contexto) {
  if (NIVEIS[nivel] < LIMITE) return;

  const registro = { hora: agora(), nivel, mensagem: achatar(mensagem) };
  if (contexto && typeof contexto === 'object') {
    for (const [chave, valor] of Object.entries(contexto)) {
      if (valor === undefined) continue;
      if (valor instanceof Error) {
        registro[chave] = valor.message;
        if (!config.producao) registro.stack = valor.stack;
      } else {
        registro[chave] = valor;
      }
    }
  }

  const destino = nivel === 'error' || nivel === 'warn' ? process.stderr : process.stdout;

  if (config.producao) {
    destino.write(`${JSON.stringify(registro)}\n`);
    return;
  }

  const cor = CORES[nivel] || '';
  const extras = Object.entries(registro)
    .filter(([chave]) => !['hora', 'nivel', 'mensagem', 'stack'].includes(chave))
    .map(([chave, valor]) => `${chave}=${typeof valor === 'object' ? JSON.stringify(valor) : valor}`)
    .join(' ');

  destino.write(
    `${cor}[${registro.hora.slice(11, 19)}] ${nivel.toUpperCase().padEnd(5)}${CORES.reset} ` +
    `${registro.mensagem}${extras ? ` \x1b[90m${extras}${CORES.reset}` : ''}\n`
  );

  if (registro.stack && nivel === 'error') destino.write(`\x1b[90m${registro.stack}\x1b[0m\n`);
}

module.exports = {
  debug: (mensagem, contexto) => escrever('debug', mensagem, contexto),
  info: (mensagem, contexto) => escrever('info', mensagem, contexto),
  warn: (mensagem, contexto) => escrever('warn', mensagem, contexto),
  error: (mensagem, contexto) => escrever('error', mensagem, contexto),
  // Logger derivado: acrescenta campos fixos a toda linha (ex.: requestId).
  comContexto: (base) => ({
    debug: (mensagem, contexto) => escrever('debug', mensagem, { ...base, ...contexto }),
    info: (mensagem, contexto) => escrever('info', mensagem, { ...base, ...contexto }),
    warn: (mensagem, contexto) => escrever('warn', mensagem, { ...base, ...contexto }),
    error: (mensagem, contexto) => escrever('error', mensagem, { ...base, ...contexto })
  })
};
