/*
 * utils/dinheiro.js
 * -----------------------------------------------------------------------------
 * Dinheiro e tratado em CENTAVOS (inteiros) dentro do banco e da camada de
 * servico, para nunca acumular erro de ponto flutuante. A conversao para
 * reais acontece apenas na borda, quando a resposta e montada para o front.
 */
'use strict';

/** Converte reais (9.99) em centavos (999). Aceita string com virgula ou ponto. */
function paraCentavos(valor) {
  if (typeof valor === 'number') {
    return Number.isFinite(valor) ? Math.round(valor * 100) : NaN;
  }
  if (typeof valor === 'string') {
    const limpo = valor.trim().replace(/\s/g, '').replace(/\./g, '').replace(',', '.');
    if (!/^-?\d+(\.\d+)?$/.test(limpo)) return NaN;
    return Math.round(Number(limpo) * 100);
  }
  return NaN;
}

/** Converte centavos (999) em reais (9.99). */
function paraReais(centavos) {
  const numero = Number(centavos);
  return Number.isFinite(numero) ? Math.round(numero) / 100 : 0;
}

/** Arredonda um valor em reais para 2 casas (uso pontual fora do fluxo de centavos). */
function arredondar(valor) {
  const numero = Number(valor);
  return Number.isFinite(numero) ? Math.round(numero * 100) / 100 : 0;
}

/** Soma uma lista de valores em reais, arredondando o resultado. */
function somar(valores) {
  return arredondar(valores.reduce((total, valor) => total + (Number(valor) || 0), 0));
}

/** Aplica um percentual de desconto sobre centavos, arredondando para baixo. */
function aplicarPercentual(centavos, percentual) {
  const p = Math.min(Math.max(Number(percentual) || 0, 0), 100);
  return Math.floor((centavos * (100 - p)) / 100);
}

/** Formata centavos como moeda brasileira: 123490 -> "R$ 1.234,90". */
function formatarBRL(centavos) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' })
    .format(paraReais(centavos));
}

/** Garante que um desconto nunca ultrapasse o valor original. */
function limitarDesconto(desconto, base) {
  return Math.min(Math.max(Math.round(desconto) || 0, 0), Math.max(Math.round(base) || 0, 0));
}

module.exports = {
  paraCentavos,
  paraReais,
  arredondar,
  somar,
  aplicarPercentual,
  formatarBRL,
  limitarDesconto
};
