/*
 * gateways/base.js
 * -----------------------------------------------------------------------------
 * Pecas comuns a TODOS os gateways. Nenhum gateway fala com a rede por conta
 * propria: usa o `requisitar` daqui, que ja embute tempo limite e traducao de
 * erro. Nenhum gateway inventa o formato de retorno: todos devolvem o mesmo
 * envelope, definido em `resultado`.
 *
 * Envelope de retorno (o contrato que o checkout conhece):
 *   {
 *     id,                    identificador da cobranca no gateway
 *     metodo,                'pix' | 'cartao' | 'boleto'
 *     status,                'aprovado' | 'pendente' | 'recusado'
 *     valorCentavos,
 *     aprovadoEm?,           ISO, quando aprovado
 *     instrucoes?,           dados para o cliente (pix copia-e-cola, linha
 *                            digitavel, vencimento...)
 *     simuladoLocal,         true quando NAO houve chamada externa
 *     referencia             numero do pedido
 *   }
 */
'use strict';

const crypto = require('crypto');
const { novoId, compararSeguro } = require('../utils/seguranca');
const { agoraISO, daquiADias, formatarDataBR } = require('../utils/datas');
const { Indisponivel } = require('../utils/erros');

/* -------------------------------------------------------------------------- */
/* Identificadores e simulacao local                                          */
/* -------------------------------------------------------------------------- */

/** Id de cobranca com prefixo do gateway: "mp_3f8a...". */
function gerarIdGateway(prefixo) {
  const limpo = novoId().replace(/-/g, '').slice(0, 20);
  return `${prefixo}_${limpo}`;
}

// "Copia e cola" de mentira, so para a tela ter o que mostrar.
function gerarPixCopiaECola(valorCentavos, referencia) {
  const base = `00020126580014BR.GOV.BCB.PIX0136${referencia}5204000053039865802BR5913NEXUS.GG6009SAO PAULO62070503***6304`;
  const sufixo = valorCentavos.toString(36).toUpperCase().padStart(4, '0');
  return `${base}${sufixo}`;
}

function gerarLinhaDigitavel(referencia) {
  const digitos = String(referencia).replace(/\D/g, '').padEnd(20, '0').slice(0, 20);
  const blocos = digitos.match(/.{5}/g) || ['00000', '00000', '00000', '00000'];
  return `34191.09008 ${blocos[0]}.${blocos[1]} 00000.00000 ${blocos[2]} 8 ${digitos.slice(-14)}`;
}

/**
 * Resultado deterministico quando NAO ha credenciais (ou o gateway e o proprio
 * simulador). Mantem exatamente o comportamento historico do sistema:
 * Pix e cartao aprovam na hora; boleto fica pendente.
 *
 * @param {{gatewayId:string, prefixo:string, valorCentavos:number, metodo:string, referencia:string}} dados
 */
function simularLocal({ prefixo, valorCentavos, metodo, referencia }) {
  const id = gerarIdGateway(prefixo);

  if (metodo === 'boleto') {
    const vencimento = daquiADias(3);
    return {
      id,
      metodo,
      status: 'pendente',
      valorCentavos,
      instrucoes: {
        linhaDigitavel: gerarLinhaDigitavel(referencia),
        vencimento,
        vencimentoFormatado: formatarDataBR(vencimento),
        aviso: 'O pedido e liberado automaticamente apos a confirmacao do pagamento.'
      }
    };
  }

  if (metodo === 'pix') {
    return {
      id,
      metodo,
      status: 'aprovado',
      valorCentavos,
      aprovadoEm: agoraISO(),
      instrucoes: {
        copiaECola: gerarPixCopiaECola(valorCentavos, referencia),
        aviso: 'Pagamento confirmado na hora (ambiente de simulacao).'
      }
    };
  }

  return {
    id,
    metodo,
    status: 'aprovado',
    valorCentavos,
    aprovadoEm: agoraISO(),
    instrucoes: {
      autorizacao: id.toUpperCase(),
      aviso: 'Cobranca aprovada em ambiente de simulacao.'
    }
  };
}

/* -------------------------------------------------------------------------- */
/* Credenciais                                                                */
/* -------------------------------------------------------------------------- */

/**
 * O gateway tem TUDO que precisa para operar de verdade? Sem isso, caimos na
 * simulacao local em vez de fazer uma chamada que so pode dar erro.
 *
 * @param {object} credenciais
 * @param {Array<{chave:string, obrigatorio:boolean}>} campos
 * @returns {{ok:boolean, faltando:string[]}}
 */
function conferirCredenciais(credenciais, campos = []) {
  const dados = credenciais && typeof credenciais === 'object' ? credenciais : {};
  const faltando = campos
    .filter(campo => campo.obrigatorio)
    .map(campo => campo.chave)
    .filter(chave => !String(dados[chave] ?? '').trim());

  return { ok: faltando.length === 0, faltando };
}

/* -------------------------------------------------------------------------- */
/* HTTP                                                                       */
/* -------------------------------------------------------------------------- */

const TEMPO_LIMITE_PADRAO = 15000;

/**
 * Chamada HTTP com tempo limite, usada por todos os gateways reais.
 *
 * Devolve { ok, status, dados } e NUNCA lanca por erro de rede: quem chama
 * decide. Uma falha de transporte vira `{ ok:false, status:0, erro }` para o
 * gateway poder lancar a AppError certa (Indisponivel), mantendo a semantica
 * do resto do sistema.
 *
 * Aceita corpo JSON (`corpo`) ou formulario (`formulario`), porque a Stripe
 * exige `application/x-www-form-urlencoded` e as demais APIs aceitam JSON.
 *
 * @param {string} url
 * @param {{metodo?:string, cabecalhos?:object, corpo?:any, formulario?:object, timeoutMs?:number}} [opcoes]
 */
async function requisitar(url, opcoes = {}) {
  const controlador = typeof AbortController === 'function' ? new AbortController() : null;
  const temporizador = controlador
    ? setTimeout(() => controlador.abort(), opcoes.timeoutMs || TEMPO_LIMITE_PADRAO)
    : null;

  // Formulario tem prioridade quando informado (Stripe); senao, JSON.
  let corpoEnviado;
  let tipoConteudo = null;
  if (opcoes.formulario !== undefined) {
    const params = new URLSearchParams();
    for (const [chave, valor] of Object.entries(opcoes.formulario)) {
      if (valor === undefined || valor === null) continue;
      params.append(chave, String(valor));
    }
    corpoEnviado = params.toString();
    tipoConteudo = 'application/x-www-form-urlencoded';
  } else if (opcoes.corpo !== undefined) {
    corpoEnviado = JSON.stringify(opcoes.corpo);
    tipoConteudo = 'application/json';
  }

  try {
    const resposta = await fetch(url, {
      method: opcoes.metodo || 'POST',
      headers: {
        Accept: 'application/json',
        ...(tipoConteudo ? { 'Content-Type': tipoConteudo } : {}),
        ...(opcoes.cabecalhos || {})
      },
      ...(corpoEnviado !== undefined ? { body: corpoEnviado } : {}),
      ...(controlador ? { signal: controlador.signal } : {})
    });

    const texto = await resposta.text();
    let dados = null;
    if (texto) {
      try { dados = JSON.parse(texto); } catch { dados = texto; }
    }

    return { ok: resposta.ok, status: resposta.status, dados };
  } catch (erro) {
    const expirou = erro && erro.name === 'AbortError';
    return {
      ok: false,
      status: 0,
      erro: expirou ? 'Tempo esgotado ao falar com o gateway' : (erro && erro.message) || 'Falha de rede'
    };
  } finally {
    if (temporizador) clearTimeout(temporizador);
  }
}

/** Atalho: transforma uma falha de transporte em Indisponivel. */
function exigirResposta(resposta, nomeGateway) {
  if (resposta.ok) return resposta.dados;
  const detalhe = resposta.erro
    || (resposta.dados && (resposta.dados.message || resposta.dados.erro))
    || `HTTP ${resposta.status}`;
  throw new Indisponivel(`${nomeGateway} recusou a cobranca: ${detalhe}`);
}

/* -------------------------------------------------------------------------- */
/* Assinaturas de webhook                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Compara duas assinaturas em tempo constante.
 * @returns {boolean}
 */
function assinaturaConfere(esperada, recebida) {
  return compararSeguro(String(esperada || ''), String(recebida || ''));
}

/**
 * HMAC-SHA256 generico: usado por Mercado Pago, Pagar.me e InfinityPay.
 *
 * @param {string} segredo
 * @param {string} mensagem   texto exato sobre o qual a assinatura e calculada
 * @returns {string} hex
 */
function hmacSha256(segredo, mensagem) {
  return crypto.createHmac('sha256', String(segredo)).update(mensagem).digest('hex');
}

/**
 * Formato do Mercado Pago: o cabecalho `x-signature` traz "ts=...,v1=...".
 * O manifesto assinado e `id:<data.id>;request-id:<x-request-id>;ts:<ts>;`.
 *
 * @returns {string} o valor de v1 (ou '')
 */
function extrairAssinaturaMercadoPago(cabecalho) {
  if (!cabecalho) return '';
  const partes = String(cabecalho).split(',');
  for (const parte of partes) {
    const [chave, valor] = parte.split('=');
    if (String(chave).trim() === 'v1') return String(valor || '').trim();
  }
  return '';
}

/**
 * Formato do Stripe: `t=<ts>,v1=<assinatura>` sobre `<ts>.<corpoBruto>`.
 */
function verificarAssinaturaStripe({ cabecalho, segredo, corpoBruto }) {
  if (!cabecalho || !segredo) return false;

  let timestamp = '';
  const assinaturas = [];
  for (const parte of String(cabecalho).split(',')) {
    const [chave, valor] = parte.split('=');
    if (String(chave).trim() === 't') timestamp = String(valor || '').trim();
    if (String(chave).trim() === 'v1') assinaturas.push(String(valor || '').trim());
  }
  if (!timestamp || !assinaturas.length) return false;

  const esperada = hmacSha256(segredo, `${timestamp}.${corpoBruto}`);
  return assinaturas.some(assinatura => assinaturaConfere(esperada, assinatura));
}

module.exports = {
  gerarIdGateway,
  gerarPixCopiaECola,
  gerarLinhaDigitavel,
  simularLocal,
  conferirCredenciais,
  requisitar,
  exigirResposta,
  assinaturaConfere,
  hmacSha256,
  extrairAssinaturaMercadoPago,
  verificarAssinaturaStripe
};
