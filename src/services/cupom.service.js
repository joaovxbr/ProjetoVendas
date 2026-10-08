/*
 * services/cupom.service.js
 * -----------------------------------------------------------------------------
 * Regras dos cupons de desconto. Toda validacao acontece no servidor: o
 * cliente manda apenas o codigo, nunca o valor do desconto.
 */
'use strict';

const cuponsRepo = require('../repositories/cupons.repo');
const { RegraNegocio, NaoEncontrado } = require('../utils/erros');
const { expirou } = require('../utils/datas');
const { limitarDesconto } = require('../utils/dinheiro');

/**
 * Verifica se um cupom pode ser usado em um pedido de `subtotalCentavos`.
 * @returns {{ cupom: object, descontoCentavos: number, totalCentavos: number }}
 * @throws {NaoEncontrado|RegraNegocio}
 */
function validar(codigo, subtotalCentavos) {
  const limpo = String(codigo || '').trim().toUpperCase();
  if (!limpo) throw new NaoEncontrado('Informe um codigo de cupom');

  const cupom = cuponsRepo.buscar(limpo);
  if (!cupom) throw new NaoEncontrado('Cupom nao encontrado');

  if (!cupom.ativo) {
    throw new RegraNegocio('Este cupom nao esta mais disponivel');
  }
  // expiraEm nulo significa "sem validade definida", nao "expirado".
  if (cupom.expiraEm && expirou(cupom.expiraEm)) {
    throw new RegraNegocio('Este cupom expirou');
  }
  if (cupom.maxUsos !== null && cupom.usos >= cupom.maxUsos) {
    throw new RegraNegocio('Este cupom atingiu o limite de usos');
  }
  if (subtotalCentavos < cupom.minimoCentavos) {
    const { formatarBRL } = require('../utils/dinheiro');
    throw new RegraNegocio(`Este cupom vale para pedidos a partir de ${formatarBRL(cupom.minimoCentavos)}`);
  }

  const descontoBruto = cupom.tipo === 'percentual'
    ? Math.floor((subtotalCentavos * cupom.valor) / 100)
    : cupom.valor;

  const descontoCentavos = limitarDesconto(descontoBruto, subtotalCentavos);

  return {
    cupom,
    descontoCentavos,
    totalCentavos: Math.max(subtotalCentavos - descontoCentavos, 0)
  };
}

/** Valida e ja consome um uso (chamado dentro da transacao do checkout). */
function consumir(codigo) {
  return cuponsRepo.registrarUso(codigo);
}

/** Lista publica: so o que o cliente pode ver (sem contagem interna de usos). */
function listarPublicos() {
  return cuponsRepo
    .listar({ incluirInativos: false })
    .filter(cupom => !cupom.expiraEm || !expirou(cupom.expiraEm))
    .filter(cupom => cupom.maxUsos === null || cupom.usos < cupom.maxUsos)
    .map(cupom => ({
      codigo: cupom.codigo,
      tipo: cupom.tipo,
      valor: cupom.valor,
      minimoCentavos: cupom.minimoCentavos,
      descricao: cupom.descricao
    }));
}

module.exports = { validar, consumir, listarPublicos };
