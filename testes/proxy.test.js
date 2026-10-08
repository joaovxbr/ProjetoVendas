/*
 * testes/proxy.test.js
 * -----------------------------------------------------------------------------
 * TRUST_PROXY e a identificacao do IP do cliente. Um erro aqui fura o rate
 * limit (IP forjado) ou junta todos os clientes no IP do proxy.
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const express = require('express');

const { interpretarTrustProxy } = require('../src/utils/proxy');
const { ipDe } = require('../src/middlewares/contexto');
const { ipDaRequisicao } = require('../src/utils/validacao');

test('TRUST_PROXY vazio usa loopback como padrao seguro', () => {
  assert.equal(interpretarTrustProxy(undefined), 'loopback');
  assert.equal(interpretarTrustProxy('   '), 'loopback');
});

test('TRUST_PROXY aceita desligado, true (1 salto), numero e lista', () => {
  assert.equal(interpretarTrustProxy('false'), false);
  assert.equal(interpretarTrustProxy('0'), false);
  assert.equal(interpretarTrustProxy('true'), 1);
  assert.equal(interpretarTrustProxy('2'), 2);
  assert.equal(interpretarTrustProxy('loopback, 10.0.0.0/8 ,::1'), 'loopback,10.0.0.0/8,::1');
});

test('TRUST_PROXY invalido derruba o boot com mensagem clara', () => {
  assert.throws(() => interpretarTrustProxy('99'), /fora do intervalo/);
  assert.throws(() => interpretarTrustProxy('qualquer-coisa'), /TRUST_PROXY invalido/);
  assert.throws(() => interpretarTrustProxy('10.0.0.0/99'), /TRUST_PROXY invalido/);
});

/** Sobe um app minimo e devolve o IP que o projeto enxergaria. */
async function ipVisto(trustProxy, cabecalhos) {
  const app = express();
  app.set('trust proxy', trustProxy);
  app.get('/', (req, res) => res.json({ contexto: ipDe(req), auditoria: ipDaRequisicao(req) }));

  const servidor = app.listen(0, '127.0.0.1');
  await once(servidor, 'listening');
  try {
    const resposta = await fetch(`http://127.0.0.1:${servidor.address().port}/`, { headers: cabecalhos });
    return await resposta.json();
  } finally {
    servidor.close();
  }
}

test('sem proxy confiavel, X-Forwarded-For forjado nao muda o IP registrado', async () => {
  const ip = await ipVisto(false, { 'X-Forwarded-For': '203.0.113.7' });
  assert.equal(ip.contexto, '127.0.0.1');
  assert.equal(ip.auditoria, '127.0.0.1');
});

test('atras de proxy confiavel, o IP real vem do X-Forwarded-For', async () => {
  const ip = await ipVisto('loopback', { 'X-Forwarded-For': '203.0.113.7' });
  assert.equal(ip.contexto, '203.0.113.7');
  assert.equal(ip.auditoria, '203.0.113.7');
});

test('com 1 salto, so o ultimo endereco da cadeia e aceito', async () => {
  // O cliente forja "6.6.6.6"; o proxy anexa o IP real que viu (203.0.113.7).
  const ip = await ipVisto(1, { 'X-Forwarded-For': '6.6.6.6, 203.0.113.7' });
  assert.equal(ip.contexto, '203.0.113.7');
});
