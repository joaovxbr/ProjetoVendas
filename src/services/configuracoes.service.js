/*
 * services/configuracoes.service.js
 * -----------------------------------------------------------------------------
 * Regras dos ajustes da loja (tabela "configuracoes"):
 *
 *   - validar(dados): confere o que o admin salva (tamanho, e-mail, link) e
 *     devolve so as chaves conhecidas, ja limpas;
 *   - publicas({ admin }): a versao que a vitrine le para exibir o aviso do
 *     topo, o destaque da home, os canais de suporte e a tela de manutencao.
 *
 * A versao publica nunca devolve nada alem desses campos, e so devolve e-mail e
 * link que passam na validacao: um valor antigo invalido no banco nao vira um
 * link quebrado (ou perigoso) na loja.
 */
'use strict';

const configuracoesRepo = require('../repositories/configuracoes.repo');
const { EMAIL_REGEX, lerBooleano } = require('../utils/validacao');
const { ErroValidacao } = require('../utils/erros');

// So http(s): nada de javascript:, data: ou caminhos relativos no link do Discord.
const URL_REGEX = /^https?:\/\/[^\s/$.?#][^\s]*$/i;
// Quebras de linha e tab sao aceitas (texto da manutencao); o resto nao.
const CARACTERES_CONTROLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const TEXTO_MANUTENCAO_PADRAO = 'Estamos em manutencao. Voltamos em instantes.';

/** Limites iguais aos da tela do painel (admin-configuracoes.js). */
const REGRAS = {
  aviso_topo: { rotulo: 'Aviso no topo', max: 200 },
  destaque_home: { rotulo: 'Destaque da home', max: 200 },
  texto_manutencao: { rotulo: 'Mensagem de manutencao', max: 300, multilinha: true },
  suporte_email: { rotulo: 'E-mail de suporte', max: 120, formato: 'email' },
  suporte_discord: { rotulo: 'Convite do Discord', max: 200, formato: 'url' },
  modo_manutencao: { booleano: true }
};

function limparTexto(valor, regra) {
  const texto = String(valor ?? '').trim();
  // Campo de uma linha: quebras viram espaco (a faixa do topo tem uma linha so).
  return regra.multilinha ? texto.replace(/\r\n?/g, '\n') : texto.replace(/\s+/g, ' ');
}

/** Devolve a mensagem de erro do ajuste, ou '' quando o valor serve. */
function erroDoAjuste(texto, regra) {
  if (texto.length > regra.max) return `${regra.rotulo} deve ter no maximo ${regra.max} caracteres`;
  if (CARACTERES_CONTROLE.test(texto)) return `${regra.rotulo} contem caracteres invalidos`;
  if (!texto) return '';
  if (regra.formato === 'email' && !EMAIL_REGEX.test(texto)) return 'Informe um e-mail valido';
  if (regra.formato === 'url' && !URL_REGEX.test(texto)) return 'Use o link completo, comecando com https://';
  return '';
}

/**
 * Valida os ajustes enviados pelo painel.
 * @returns {Record<string, string>} so as chaves conhecidas, prontas para salvar
 * @throws {ErroValidacao} com detalhes { chave: mensagem } para a tela marcar o campo
 */
function validar(dados) {
  const permitidas = Object.keys(configuracoesRepo.PADROES);
  const limpas = {};
  const detalhes = {};

  for (const chave of permitidas) {
    if (!dados || dados[chave] === undefined) continue;
    const regra = REGRAS[chave] || { rotulo: chave, max: 500 };

    if (regra.booleano) {
      limpas[chave] = lerBooleano(dados[chave], false) ? 'true' : 'false';
      continue;
    }

    const texto = limparTexto(dados[chave], regra);
    const erro = erroDoAjuste(texto, regra);
    if (erro) detalhes[chave] = erro;
    else limpas[chave] = regra.formato === 'email' ? texto.toLowerCase() : texto;
  }

  if (Object.keys(detalhes).length) {
    throw new ErroValidacao('Revise os ajustes destacados', detalhes);
  }
  if (!Object.keys(limpas).length) {
    throw new ErroValidacao(`Informe ao menos um ajuste. Disponiveis: ${permitidas.join(', ')}`);
  }
  return limpas;
}

function textoValido(valor, regex) {
  const texto = String(valor ?? '').trim();
  return regex.test(texto) ? texto : '';
}

/**
 * Ajustes que a vitrine exibe. `liberado` diz se quem pediu continua vendo a
 * loja durante a manutencao (administradores).
 */
function publicas({ admin = false } = {}) {
  const todas = configuracoesRepo.listarTodas();

  return {
    avisoTopo: String(todas.aviso_topo ?? '').trim(),
    destaqueHome: String(todas.destaque_home ?? '').trim(),
    suporte: {
      email: textoValido(todas.suporte_email, EMAIL_REGEX),
      discord: textoValido(todas.suporte_discord, URL_REGEX)
    },
    manutencao: {
      ativo: lerBooleano(todas.modo_manutencao, false),
      texto: String(todas.texto_manutencao ?? '').trim() || TEXTO_MANUTENCAO_PADRAO,
      liberado: Boolean(admin)
    }
  };
}

module.exports = { REGRAS, URL_REGEX, validar, publicas };
