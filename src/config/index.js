/*
 * config/index.js
 * -----------------------------------------------------------------------------
 * Le e valida as variaveis de ambiente UMA vez, no boot. Todo o resto da
 * aplicacao importa daqui em vez de ler process.env espalhado pelo codigo:
 * assim existe um unico lugar para saber quais configuracoes o sistema aceita
 * e quais sao os valores padrao.
 */
'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { interpretarTrustProxy } = require('../utils/proxy');

const RAIZ = path.resolve(__dirname, '..', '..');

// Carrega o .env antes de qualquer leitura (silencioso se o arquivo nao existir).
require('dotenv').config({ path: path.join(RAIZ, '.env') });

/* -------------------------------------------------------------------------- */
/* Conversores tolerantes                                                     */
/* -------------------------------------------------------------------------- */

function texto(chave, padrao) {
  const valor = process.env[chave];
  if (typeof valor !== 'string') return padrao;
  const limpo = valor.trim();
  return limpo === '' ? padrao : limpo;
}

function inteiro(chave, padrao, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
  const bruto = Number.parseInt(texto(chave, ''), 10);
  if (!Number.isFinite(bruto)) return padrao;
  return Math.min(Math.max(bruto, min), max);
}

function booleano(chave, padrao) {
  const valor = texto(chave, '').toLowerCase();
  if (['1', 'true', 'sim', 'yes', 'on'].includes(valor)) return true;
  if (['0', 'false', 'nao', 'no', 'off'].includes(valor)) return false;
  return padrao;
}

// "a, b ,c" -> ['a','b','c'] (sem vazios e sem repetidos)
function lista(chave) {
  const bruto = texto(chave, '');
  if (!bruto) return [];
  return [...new Set(bruto.split(',').map(item => item.trim()).filter(Boolean))];
}

function umaDasOpcoes(chave, opcoes, padrao) {
  const valor = texto(chave, padrao).toLowerCase();
  return opcoes.includes(valor) ? valor : padrao;
}

/* -------------------------------------------------------------------------- */
/* Montagem da configuracao                                                   */
/* -------------------------------------------------------------------------- */

const ambiente = umaDasOpcoes('NODE_ENV', ['development', 'test', 'production'], 'development');
const producao = ambiente === 'production';

/*
 * SEGREDO_APP e a chave-mestra do sistema:
 *   - deriva a chave AES-256 que CIFRA as credenciais dos gateways de pagamento;
 *   - assina os ids de sessao e os tokens de recuperacao de senha.
 *
 * Se ele nao existir, gerar um valor aleatorio "resolve" o boot e cria um
 * problema muito pior: as credenciais salvas com a chave anterior viram lixo
 * cifrado (o AES-GCM nao tem como decifrar) e o admin perde silenciosamente os
 * acessos dos provedores. Por isso, em producao, o processo NAO SOBE sem um
 * segredo explicito. Fora de producao o valor aleatorio continua valendo, para
 * nao atrapalhar quem so quer rodar o projeto.
 */
const SEGREDO_PLACEHOLDER = 'troque-este-segredo-em-producao';

let segredoApp = texto('SEGREDO_APP', '');
const segredoAusente = !segredoApp || segredoApp === SEGREDO_PLACEHOLDER;

if (segredoAusente && producao) {
  throw new Error(
    'SEGREDO_APP nao definido (ou ainda com o valor de exemplo).\n' +
    'Em producao o servidor se recusa a subir sem ele: essa chave cifra as\n' +
    'credenciais dos gateways de pagamento, e um valor aleatorio a cada boot\n' +
    'tornaria as credenciais ja salvas impossiveis de decifrar.\n' +
    'Gere um segredo forte e coloque no .env:\n' +
    '  node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"'
  );
}

if (segredoAusente) {
  segredoApp = crypto.randomBytes(32).toString('hex');
}

// Caminho do banco: relativo a raiz do projeto, absoluto fica como esta.
const arquivoBanco = (() => {
  const bruto = texto('BANCO_ARQUIVO', './dados/nexus.db');
  if (bruto === ':memory:') return ':memory:';
  return path.isAbsolute(bruto) ? bruto : path.resolve(RAIZ, bruto);
})();

const config = Object.freeze({
  raiz: RAIZ,
  ambiente,
  producao,
  testes: ambiente === 'test',
  // Valor pronto para `app.set('trust proxy')` (ver utils/proxy.js).
  trustProxy: interpretarTrustProxy(process.env.TRUST_PROXY),

  porta: inteiro('PORT', 3000, { min: 0, max: 65535 }),

  loja: Object.freeze({
    nome: texto('LOJA_NOME', 'NEXUS.GG'),
    url: texto('LOJA_URL', 'http://localhost:3000').replace(/\/+$/, ''),
    /*
     * LOJA_URL foi declarada de proposito (e nao apenas herdada do padrao)?
     * Em producao isso decide se a lista de origens aceitas em requisicoes de
     * escrita e FECHADA (so o dominio declarado) ou se o cabecalho Host ainda
     * serve de reserva, para a loja nao cair por falta de configuracao.
     */
    urlDeclarada: Boolean(process.env.LOJA_URL && String(process.env.LOJA_URL).trim())
  }),

  banco: Object.freeze({
    arquivo: arquivoBanco,
    // ':memory:' nao tem pasta para criar.
    pasta: arquivoBanco === ':memory:' ? null : path.dirname(arquivoBanco)
  }),

  sessao: Object.freeze({
    nomeCookie: 'sid',
    // Cookie persistente ("lembrar-me"). Sem ele, a sessao morre com o navegador.
    duracaoMs: inteiro('SESSAO_DIAS', 7, { min: 1, max: 90 }) * 24 * 60 * 60 * 1000,
    // Sessao sem "lembrar-me": continua valida no servidor por este tempo.
    duracaoCurtaMs: 24 * 60 * 60 * 1000,
    segredo: segredoApp
  }),

  cors: Object.freeze({
    origens: lista('CORS_ORIGIN')
  }),

  admin: Object.freeze({
    emails: lista('ADMIN_EMAILS').map(email => email.toLowerCase())
  }),

  pagamento: Object.freeze({
    provedor: texto('PAGAMENTO_PROVEDOR', 'simulado').toLowerCase(),
    metodoPadrao: umaDasOpcoes('PAGAMENTO_METODO_PADRAO', ['pix', 'cartao', 'boleto'], 'pix')
  }),

  log: Object.freeze({
    nivel: umaDasOpcoes('LOG_NIVEL', ['debug', 'info', 'warn', 'error', 'silent'], producao ? 'info' : 'debug')
  }),

  limites: Object.freeze({
    geral: inteiro('RATE_LIMIT_GERAL', producao ? 300 : 1000, { min: 10, max: 100000 }),
    auth: inteiro('RATE_LIMIT_AUTH', producao ? 10 : 50, { min: 3, max: 1000 })
  }),

  // Regras de negocio que o suporte costuma querer ajustar sem mexer em codigo.
  regras: Object.freeze({
    maxItensPorPedido: 20,
    maxQuantidadePorItem: 10,
    nomeMin: 2,
    nomeMax: 60,
    emailMax: 254,
    senhaMin: 6,
    senhaMax: 128,
    comentarioMax: 600,
    // Recuperacao de senha
    tokenRecuperacaoMin: 15,
    // Licenca de plano temporario ganha alguns dias de folga para ativacao.
    diasFolgaAtivacao: 3
  })
});

// Garante que a pasta do banco exista (o SQLite nao cria diretorios sozinho).
if (config.banco.pasta && !fs.existsSync(config.banco.pasta)) {
  fs.mkdirSync(config.banco.pasta, { recursive: true });
}

module.exports = config;
