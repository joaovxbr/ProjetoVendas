/*
 * gateways/index.js
 * -----------------------------------------------------------------------------
 * Registro dos gateways. Liga o catalogo (dados) aos modulos (integracao).
 *
 * A ideia e que o resto do sistema NUNCA importe um gateway especifico: pega o
 * modulo pelo id aqui. Assim, trocar/adicionar provedor nao encosta no
 * checkout nem nas rotas.
 */
'use strict';

const catalogo = require('./catalogo');

const MODULOS = {
  simulado: require('./simulado'),
  mercadopago: require('./mercadopago'),
  infinitypay: require('./infinitypay'),
  pagarme: require('./pagarme'),
  asaas: require('./asaas'),
  stripe: require('./stripe')
};

/** Modulo de integracao de um gateway (ou null). */
function modulo(id) {
  return MODULOS[String(id || '').toLowerCase()] || null;
}

/** Modulos cujo id existe no catalogo (garante catalogo e modulo em sincronia). */
function registrados() {
  return catalogo.IDS.filter(id => !!MODULOS[id]);
}

module.exports = {
  catalogo,
  MODULOS,
  modulo,
  registrados,
  METODOS: catalogo.METODOS,
  IDS_METODOS: catalogo.IDS_METODOS,
  GATEWAYS: catalogo.GATEWAYS,
  IDS: catalogo.IDS,
  existe: catalogo.existe,
  buscar: catalogo.buscar,
  filtrarMetodos: catalogo.filtrarMetodos
};
