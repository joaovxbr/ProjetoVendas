/*
 * utils/validacao.js
 * -----------------------------------------------------------------------------
 * Validacao e normalizacao de entrada. Regra geral do projeto:
 *
 *   - "normalizar*" apenas limpa o valor (nunca lanca);
 *   - "ler*" tenta converter e devolve um padrao quando nao consegue;
 *   - "exigir*" valida e LANCA ErroValidacao quando o valor nao serve.
 *
 * Os erros carregam "detalhes" no formato { campo: "mensagem" }, o que permite
 * ao front destacar exatamente o input com problema.
 */
'use strict';

const { ErroValidacao } = require('./erros');

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const CARACTERES_CONTROLE = /[\u0000-\u001F\u007F]/;
const SLUG_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHAVE_LICENCA_REGEX = /^[A-Z0-9]{4}(?:-[A-Z0-9]{4}){3}$/;

/* -------------------------------------------------------------------------- */
/* Normalizacao (nunca lanca)                                                 */
/* -------------------------------------------------------------------------- */

/** Minusculas, sem acentos e sem espacos nas pontas. "Otimização" -> "otimizacao". */
function normalizarTexto(valor) {
  return String(valor ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

/** E-mail sempre em minusculas e sem espacos. */
function normalizarEmail(valor) {
  return typeof valor === 'string' ? valor.trim().toLowerCase() : '';
}

/** "FPS Booster Pro!" -> "fps-booster-pro" */
function normalizarSlug(valor) {
  return normalizarTexto(valor)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Colapsa espacos internos: "Ana   Maria " -> "Ana Maria". */
function normalizarNome(valor) {
  return String(valor ?? '').trim().replace(/\s+/g, ' ');
}

/* -------------------------------------------------------------------------- */
/* Leitura tolerante (nunca lanca)                                            */
/* -------------------------------------------------------------------------- */

/** Devolve o valor apenas se for string; senao, ''. */
function lerTexto(valor) {
  return typeof valor === 'string' ? valor : '';
}

/** Aceita 2, "2", " 2 " -> 2. Qualquer outra coisa vira o padrao. */
function lerInteiro(valor, padrao = null) {
  if (valor === undefined || valor === null || valor === '') return padrao;
  if (typeof valor === 'number') return Number.isInteger(valor) ? valor : padrao;
  if (typeof valor === 'string' && /^-?\d+$/.test(valor.trim())) return Number.parseInt(valor.trim(), 10);
  return padrao;
}

/** Aceita true/false, "true"/"false", 1/0, "sim"/"nao". */
function lerBooleano(valor, padrao = false) {
  if (typeof valor === 'boolean') return valor;
  if (typeof valor === 'number') return valor !== 0;
  if (typeof valor === 'string') {
    const limpo = valor.trim().toLowerCase();
    if (['1', 'true', 'sim', 'yes', 'on'].includes(limpo)) return true;
    if (['0', 'false', 'nao', 'no', 'off', ''].includes(limpo)) return false;
  }
  return padrao;
}

/** Aceita array, string unica ou lista separada por virgula. */
function lerLista(valor) {
  if (Array.isArray(valor)) return valor.filter(item => item !== undefined && item !== null);
  if (typeof valor === 'string') {
    return valor.split(',').map(item => item.trim()).filter(Boolean);
  }
  return [];
}

/* -------------------------------------------------------------------------- */
/* Validacoes (lancam ErroValidacao)                                          */
/* -------------------------------------------------------------------------- */

function falhar(campo, mensagem) {
  throw new ErroValidacao(mensagem, { [campo]: mensagem });
}

/** Texto obrigatorio, com limites de tamanho. */
function exigirTexto(valor, campo, { rotulo = campo, min = 1, max = 5000 } = {}) {
  const texto = String(valor ?? '').trim();
  if (texto.length < min) {
    falhar(campo, min <= 1 ? `Informe ${rotulo}` : `${rotulo} deve ter pelo menos ${min} caracteres`);
  }
  if (texto.length > max) {
    falhar(campo, `${rotulo} deve ter no maximo ${max} caracteres`);
  }
  if (CARACTERES_CONTROLE.test(texto)) {
    falhar(campo, `${rotulo} contem caracteres invalidos`);
  }
  return texto;
}

/** Texto opcional: devolve '' quando ausente, sem exigir tamanho minimo. */
function textoOpcional(valor, campo, { rotulo = campo, max = 5000 } = {}) {
  if (valor === undefined || valor === null || valor === '') return '';
  const texto = String(valor).trim();
  if (texto.length > max) falhar(campo, `${rotulo} deve ter no maximo ${max} caracteres`);
  if (CARACTERES_CONTROLE.test(texto)) falhar(campo, `${rotulo} contem caracteres invalidos`);
  return texto;
}

/** Nome de pessoa: normalizado, entre 2 e 60 caracteres. */
function exigirNome(valor, { campo = 'nome', min = 2, max = 60 } = {}) {
  const nome = normalizarNome(valor);
  if (nome.length < min) falhar(campo, `Informe seu nome (minimo de ${min} caracteres)`);
  if (nome.length > max) falhar(campo, `Nome invalido (maximo de ${max} caracteres)`);
  if (CARACTERES_CONTROLE.test(nome)) falhar(campo, 'Nome contem caracteres invalidos');
  return nome;
}

/** E-mail: normalizado, formato conferido, tamanho maximo de 254. */
function exigirEmail(valor, { campo = 'email', max = 254 } = {}) {
  const email = normalizarEmail(valor);
  if (!email || email.length > max || !EMAIL_REGEX.test(email)) {
    falhar(campo, 'Informe um e-mail valido');
  }
  return email;
}

/** Senha: apenas confere tamanho (nao impoe composicao, para nao frustrar o usuario). */
function exigirSenha(valor, { campo = 'senha', min = 6, max = 128 } = {}) {
  const senha = lerTexto(valor);
  if (senha.length < min) falhar(campo, `A senha deve ter pelo menos ${min} caracteres`);
  if (senha.length > max) falhar(campo, `A senha deve ter no maximo ${max} caracteres`);
  return senha;
}

/** Inteiro dentro de uma faixa. */
function exigirInteiro(valor, campo, { rotulo = campo, min = 0, max = Number.MAX_SAFE_INTEGER, padrao } = {}) {
  const numero = lerInteiro(valor, padrao === undefined ? undefined : padrao);
  if (numero === undefined || numero === null || !Number.isInteger(numero)) {
    falhar(campo, `${rotulo} deve ser um numero inteiro`);
  }
  if (numero < min || numero > max) {
    falhar(campo, `${rotulo} deve estar entre ${min} e ${max}`);
  }
  return numero;
}

/** Valor restrito a uma lista de opcoes conhecidas. */
function exigirOpcao(valor, opcoes, campo, padrao) {
  const limpo = String(valor ?? '').trim().toLowerCase();
  if (!limpo && padrao !== undefined) return padrao;
  if (!opcoes.includes(limpo)) {
    falhar(campo, `${campo} deve ser um destes valores: ${opcoes.join(', ')}`);
  }
  return limpo;
}

/** UUID v4 (ids de produto, venda, usuario). */
function exigirUuid(valor, campo = 'id') {
  const texto = String(valor ?? '').trim();
  if (!UUID_REGEX.test(texto)) falhar(campo, `${campo} invalido`);
  return texto;
}

/** Slug no formato kebab-case. */
function exigirSlug(valor, campo = 'slug') {
  const slug = normalizarSlug(valor);
  if (!slug || !SLUG_REGEX.test(slug) || slug.length > 80) falhar(campo, 'Slug invalido');
  return slug;
}

/** Chave de licenca no formato ABCD-1234-EF56-7890. */
function exigirChaveLicenca(valor, campo = 'chave') {
  const chave = String(valor ?? '').trim().toUpperCase().replace(/\s/g, '');
  if (!CHAVE_LICENCA_REGEX.test(chave)) falhar(campo, 'Chave de licenca invalida');
  return chave;
}

/** Array com quantidade controlada de itens. */
function exigirArray(valor, campo, { min = 1, max = 100, rotulo = campo } = {}) {
  if (!Array.isArray(valor)) falhar(campo, `${rotulo} deve ser uma lista`);
  if (valor.length < min) falhar(campo, `${rotulo} precisa ter pelo menos ${min} item(ns)`);
  if (valor.length > max) falhar(campo, `${rotulo} pode ter no maximo ${max} itens`);
  return valor;
}

/** Aceita apenas chaves conhecidas em um objeto (ignora o resto silenciosamente). */
function apenasChaves(objeto, permitidas) {
  if (!objeto || typeof objeto !== 'object') return {};
  const saida = {};
  for (const chave of permitidas) {
    if (objeto[chave] !== undefined) saida[chave] = objeto[chave];
  }
  return saida;
}

/**
 * Endereco de IP do request, normalizado. Usa req.ip (que respeita o
 * `trust proxy`) e nunca o X-Forwarded-For cru, que o cliente pode forjar.
 */
function ipDaRequisicao(req) {
  return String(req.ip || req.socket?.remoteAddress || '').replace(/^::ffff:/, '').slice(0, 45) || null;
}

/** User-agent truncado, so para auditoria. */
function agenteDaRequisicao(req) {
  const ua = req.headers['user-agent'];
  return typeof ua === 'string' ? ua.slice(0, 255) : null;
}

module.exports = {
  EMAIL_REGEX,
  UUID_REGEX,
  CHAVE_LICENCA_REGEX,
  normalizarTexto,
  normalizarEmail,
  normalizarSlug,
  normalizarNome,
  lerTexto,
  lerInteiro,
  lerBooleano,
  lerLista,
  exigirTexto,
  textoOpcional,
  exigirNome,
  exigirEmail,
  exigirSenha,
  exigirInteiro,
  exigirOpcao,
  exigirUuid,
  exigirSlug,
  exigirChaveLicenca,
  exigirArray,
  apenasChaves,
  ipDaRequisicao,
  agenteDaRequisicao
};
