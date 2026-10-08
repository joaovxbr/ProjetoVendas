/*
 * utils/cripto.js
 * -----------------------------------------------------------------------------
 * Cifragem simetrica das credenciais de pagamento guardadas no banco.
 *
 * Por que existe: as chaves de API de Mercado Pago, InfinityPay e companhia dao
 * acesso ao DINHEIRO da loja. Guarda-las em texto puro no SQLite significa que
 * qualquer vazamento do arquivo do banco (backup copiado, disco roubado, dump
 * enviado por engano) entrega a conta inteira. Aqui elas ficam cifradas com
 * AES-256-GCM, que alem de confidencialidade garante INTEGRIDADE: um byte
 * alterado no texto cifrado faz a decifragem falhar em vez de devolver lixo.
 *
 * A chave e derivada de SEGREDO_APP (SHA-256 sobre um "dominio" fixo). Isso
 * significa que trocar SEGREDO_APP torna as credenciais antigas ilegiveis — o
 * que e o comportamento correto: o admin precisa recadastra-las.
 *
 * Formato do texto cifrado:  v1:<iv b64>:<tag b64>:<dados b64>
 * O prefixo de versao permite trocar o algoritmo no futuro sem quebrar o que
 * ja esta gravado.
 */
'use strict';

const crypto = require('crypto');
const config = require('../config');
const logger = require('./logger');

const VERSAO = 'v1';
const TAMANHO_IV = 12; // recomendado para GCM
const ALGORITMO = 'aes-256-gcm';

/** Deriva a chave de 32 bytes a partir do segredo da aplicacao. */
function chaveMestra() {
  return crypto
    .createHash('sha256')
    .update(`nexus:credenciais:${config.sessao.segredo}`)
    .digest();
}

/**
 * Cifra um objeto (serializado em JSON) e devolve o texto no formato versionado.
 * @param {object} objeto
 * @returns {string}
 */
function cifrar(objeto) {
  const iv = crypto.randomBytes(TAMANHO_IV);
  const cipher = crypto.createCipheriv(ALGORITMO, chaveMestra(), iv);
  const dados = Buffer.concat([
    cipher.update(JSON.stringify(objeto ?? {}), 'utf8'),
    cipher.final()
  ]);
  const tag = cipher.getAuthTag();

  return [
    VERSAO,
    iv.toString('base64'),
    tag.toString('base64'),
    dados.toString('base64')
  ].join(':');
}

/**
 * Decifra um texto produzido por `cifrar`.
 *
 * Nunca lanca: devolve `null` quando o texto esta corrompido, foi cifrado com
 * outro SEGREDO_APP ou tem formato desconhecido. Quem chama decide o que fazer
 * (o normal e tratar como "sem credenciais configuradas").
 *
 * @param {string} texto
 * @returns {object|null}
 */
function decifrar(texto) {
  if (typeof texto !== 'string' || !texto) return null;

  const partes = texto.split(':');
  if (partes.length !== 4 || partes[0] !== VERSAO) return null;

  try {
    const iv = Buffer.from(partes[1], 'base64');
    const tag = Buffer.from(partes[2], 'base64');
    const dados = Buffer.from(partes[3], 'base64');

    const decipher = crypto.createDecipheriv(ALGORITMO, chaveMestra(), iv);
    decipher.setAuthTag(tag);

    const claro = Buffer.concat([decipher.update(dados), decipher.final()]).toString('utf8');
    const objeto = JSON.parse(claro);
    return objeto && typeof objeto === 'object' ? objeto : null;
  } catch (erro) {
    logger.warn('Falha ao decifrar credenciais (segredo trocado ou dado corrompido)', {
      erro: erro.message
    });
    return null;
  }
}

/**
 * Mascara um segredo para exibicao: mantem um pedaco do comeco e do fim.
 * "APP_USR-1234567890abcdef" -> "APP_••••cdef"
 *
 * Valores curtos viram apenas "••••", para nao entregar o segredo inteiro
 * quando ele e pequeno.
 */
function mascarar(valor) {
  const texto = String(valor ?? '');
  if (!texto) return '';
  if (texto.length <= 8) return '••••';
  return `${texto.slice(0, 4)}••••${texto.slice(-4)}`;
}

module.exports = { cifrar, decifrar, mascarar };
