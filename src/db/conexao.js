/*
 * db/conexao.js
 * -----------------------------------------------------------------------------
 * Conexao unica com o SQLite (better-sqlite3 e sincrono, o que combina com o
 * modelo de execucao do Express e elimina toda uma classe de bugs de
 * concorrencia). O arquivo do banco e criado na primeira execucao.
 *
 * PRAGMAs aplicados:
 *   journal_mode = WAL     leituras nao bloqueiam escritas (melhor concorrencia)
 *   foreign_keys = ON      o SQLite so valida chaves estrangeiras se pedirmos
 *   busy_timeout = 5000    espera ate 5s por um lock em vez de falhar na hora
 *   synchronous = NORMAL   bom equilibrio entre durabilidade e velocidade (WAL)
 */
'use strict';

const config = require('../config');
const logger = require('../utils/logger');

/*
 * O better-sqlite3 e um modulo NATIVO: o binario compilado depende da versao
 * exata do Node (ABI). Se o node_modules foi instalado com uma versao e o
 * servidor roda em outra, o carregamento do binario falha com um erro de ABI
 * bem confuso. Aqui traduzimos isso para uma instrucao acionavel.
 *
 * IMPORTANTE: o binario .node NAO e carregado no require do pacote — ele e
 * carregado de forma preguicosa quando o primeiro `new Database(...)` acontece.
 * Por isso o tratamento precisa cobrir tanto o require quanto a abertura.
 */
function traduzirErroDeAbi(erro) {
  const descompassoDeAbi =
    erro &&
    (erro.code === 'ERR_DLOPEN_FAILED' ||
      /NODE_MODULE_VERSION|was compiled against a different Node\.js version/i.test(erro.message || ''));

  // Nao e um problema de ABI: devolvemos null para quem chamou repassar o erro.
  if (!descompassoDeAbi) return null;

  const instrucoes = [
    '',
    '  O modulo nativo "better-sqlite3" foi compilado para OUTRA versao do Node.',
    `  Voce esta executando: ${process.version} (ABI ${process.versions.modules}).`,
    '',
    '  Como resolver:',
    '    1. Use sempre a mesma versao do Node para instalar e para rodar.',
    '    2. Rode:  npm run rebuild',
    '       (ou apague a pasta node_modules e rode "npm install" de novo)',
    '',
    '  Detalhe tecnico: ' + String(erro.message).split('\n')[0],
    ''
  ].join('\n');

  const novo = new Error(instrucoes);
  novo.code = 'SQLITE_ABI_INCOMPATIVEL';
  novo.causa = erro;
  return novo;
}

function carregarSqlite() {
  try {
    return require('better-sqlite3');
  } catch (erro) {
    throw traduzirErroDeAbi(erro) || erro;
  }
}

const Database = carregarSqlite();

/**
 * Instancia o banco tratando o erro de ABI (que so aparece aqui, no primeiro
 * uso real do binario nativo).
 * @param {string} arquivo
 */
function abrirConexao(arquivo) {
  try {
    return new Database(arquivo);
  } catch (erro) {
    throw traduzirErroDeAbi(erro) || erro;
  }
}

let instancia = null;

/**
 * Abre (ou reaproveita) a conexao com o banco.
 * @returns {import('better-sqlite3').Database}
 */
function conectar() {
  if (instancia) return instancia;

  instancia = abrirConexao(config.banco.arquivo);

  // Em arquivo, WAL da muito mais throughput; em memoria, o modo e ignorado.
  if (config.banco.arquivo !== ':memory:') {
    instancia.pragma('journal_mode = WAL');
  }
  instancia.pragma('foreign_keys = ON');
  instancia.pragma('busy_timeout = 5000');
  instancia.pragma('synchronous = NORMAL');

  logger.debug('Banco de dados aberto', { arquivo: config.banco.arquivo });
  return instancia;
}

/** Acesso rapido a conexao ja aberta. */
function obter() {
  return instancia || conectar();
}

/** Fecha a conexao (usado no encerramento gracioso e nos testes). */
function fechar() {
  if (!instancia) return;
  try {
    instancia.close();
  } catch (erro) {
    logger.warn('Falha ao fechar o banco', { erro });
  }
  instancia = null;
}

/**
 * Executa `fn` dentro de uma transacao. Se algo lancar, tudo e desfeito.
 * Aceita funcoes sincronas (better-sqlite3 nao suporta await dentro da transacao).
 *
 * @template T
 * @param {() => T} fn
 * @returns {T}
 */
function transacao(fn) {
  const db = obter();
  const envolvida = db.transaction(fn);
  return envolvida();
}

/** Atalho para consultas que devolvem uma unica linha (ou undefined). */
function um(sql, parametros = {}) {
  return obter().prepare(sql).get(parametros);
}

/** Atalho para consultas que devolvem varias linhas. */
function varios(sql, parametros = {}) {
  return obter().prepare(sql).all(parametros);
}

/** Atalho para comandos de escrita; devolve { changes, lastInsertRowid }. */
function executar(sql, parametros = {}) {
  return obter().prepare(sql).run(parametros);
}

module.exports = {
  conectar,
  obter,
  fechar,
  transacao,
  um,
  varios,
  executar
};
