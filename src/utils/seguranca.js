/*
 * utils/seguranca.js
 * -----------------------------------------------------------------------------
 * Criptografia e geracao de identificadores. Nada aqui depende de bibliotecas
 * externas: tudo sai do modulo nativo "crypto".
 *
 * - Senhas: scrypt com salt aleatorio por usuario, comparadas em tempo constante.
 * - Sessoes/tokens: 32 bytes aleatorios em hexadecimal (64 caracteres).
 * - Chaves de licenca: 8 bytes aleatorios no formato ABCD-1234-EF56-7890.
 * - Ids de produto: derivados do slug, entao sobrevivem a reinicios e a
 *   reimportacoes do catalogo (carrinhos salvos no navegador continuam validos).
 */
'use strict';

const crypto = require('crypto');
const { v4: uuid } = require('uuid');

const TAMANHO_HASH_SENHA = 64;
const TAMANHO_SALT = 16;
const TAMANHO_SID = 32; // bytes -> 64 caracteres hex

/* -------------------------------------------------------------------------- */
/* Senhas                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Gera salt + hash scrypt para uma senha em texto puro.
 * @param {string} senha
 * @returns {{ salt: string, hash: string }}
 */
function gerarHashSenha(senha) {
  const salt = crypto.randomBytes(TAMANHO_SALT).toString('hex');
  const hash = crypto.scryptSync(String(senha), salt, TAMANHO_HASH_SENHA).toString('hex');
  return { salt, hash };
}

/**
 * Compara uma senha em texto puro com o hash guardado, em tempo constante.
 * @returns {boolean}
 */
function verificarSenha(senha, salt, hash) {
  if (typeof senha !== 'string' || typeof salt !== 'string' || typeof hash !== 'string') return false;

  let esperado;
  try {
    esperado = Buffer.from(hash, 'hex');
  } catch {
    return false;
  }
  if (esperado.length !== TAMANHO_HASH_SENHA) return false;

  let calculado;
  try {
    calculado = crypto.scryptSync(senha, salt, TAMANHO_HASH_SENHA);
  } catch {
    return false;
  }

  return crypto.timingSafeEqual(calculado, esperado);
}

/*
 * Hash descartavel usado quando o e-mail nao existe. Serve para que o login
 * demore o mesmo tanto nos dois casos e o tempo de resposta nao denuncie
 * quais e-mails estao cadastrados.
 */
const HASH_FICTICIO = gerarHashSenha(crypto.randomBytes(16).toString('hex'));

/** @returns {false} sempre */
function verificarSenhaFicticia(senha) {
  verificarSenha(typeof senha === 'string' ? senha : '', HASH_FICTICIO.salt, HASH_FICTICIO.hash);
  return false;
}

/* -------------------------------------------------------------------------- */
/* Tokens e identificadores                                                   */
/* -------------------------------------------------------------------------- */

/** Token opaco de 32 bytes (64 caracteres hex). Usado em sessoes e recuperacao. */
function gerarToken(bytes = TAMANHO_SID) {
  return crypto.randomBytes(bytes).toString('hex');
}

/** Id unico (UUID v4). */
function novoId() {
  return uuid();
}

/** Chave de licenca no formato ABCD-1234-EF56-7890. */
function gerarChaveLicenca() {
  return crypto
    .randomBytes(8)
    .toString('hex')
    .toUpperCase()
    .match(/.{4}/g)
    .join('-');
}

/** Codigo curto e legivel para pedidos e cupons (ex.: "NX-7F3K9Q"). */
function gerarCodigo(prefixo = 'NX', bytes = 4) {
  const aleatorio = crypto
    .randomBytes(bytes)
    .toString('hex')
    .toUpperCase()
    .replace(/[01IO]/g, '')
    .slice(0, 6);
  return prefixo ? `${prefixo}-${aleatorio}` : aleatorio;
}

/**
 * Id estavel derivado do slug: o mesmo produto sempre recebe o mesmo id,
 * mesmo depois de reiniciar o servidor ou recriar o banco.
 * @param {string} slug
 * @returns {string} UUID v4
 */
function idEstavel(slug) {
  const bytes = crypto.createHash('sha256').update(`loja:produto:${slug}`).digest().subarray(0, 16);
  return uuid({ random: bytes });
}

/** Compara dois textos em tempo constante (evita timing attack em tokens). */
function compararSeguro(a, b) {
  const bufA = Buffer.from(String(a ?? ''), 'utf8');
  const bufB = Buffer.from(String(b ?? ''), 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/** Hash SHA-256 em hexadecimal (usado para guardar tokens sem expo-los). */
function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

module.exports = {
  TAMANHO_SID,
  gerarHashSenha,
  verificarSenha,
  verificarSenhaFicticia,
  gerarToken,
  novoId,
  gerarChaveLicenca,
  gerarCodigo,
  idEstavel,
  compararSeguro,
  hashToken
};
