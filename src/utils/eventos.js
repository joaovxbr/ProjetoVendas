/*
 * utils/eventos.js
 * -----------------------------------------------------------------------------
 * Barramento de eventos em processo. Serve para o painel administrativo se
 * atualizar sozinho: quando algo muda no servidor (entrada de estoque, venda
 * concluida, produto editado), publicamos um evento e todas as abas do painel
 * abertas recebem via SSE (/api/admin/eventos) e recarregam a parte afetada.
 *
 * Por que um EventEmitter e nao um banco de eventos?
 *   - O painel so precisa do "agora". Nao ha valor em guardar historico aqui —
 *     quem guarda historico e a tabela de auditoria.
 *   - Fica tudo em memoria: simples, sem I/O, sem custo.
 *
 * O emissor e um singleton do modulo, entao todos os servicos e a rota SSE
 * enxergam o mesmo canal.
 */
'use strict';

const { EventEmitter } = require('node:events');

const CANAL = 'evento';

const emissor = new EventEmitter();
// Cada aba do painel aberta adiciona um ouvinte. O padrao do Node (10) e baixo
// demais para isso; 0 remove o limite.
emissor.setMaxListeners(0);

/**
 * Publica um evento para todos os ouvintes.
 * @param {string} tipo identificador curto, ex.: 'estoque.atualizado'
 * @param {object} [dados] carga util especifica do tipo
 */
function publicar(tipo, dados = {}) {
  const evento = { tipo, dados, em: new Date().toISOString() };
  emissor.emit(CANAL, evento);
  return evento;
}

/**
 * Escuta eventos. Devolve uma funcao para cancelar a inscricao.
 * @param {(evento: {tipo: string, dados: object, em: string}) => void} ouvinte
 * @returns {() => void}
 */
function assinar(ouvinte) {
  emissor.on(CANAL, ouvinte);
  return () => emissor.off(CANAL, ouvinte);
}

/** Quantos ouvintes existem agora (usado para diagnostico). */
function quantidadeDeOuvintes() {
  return emissor.listenerCount(CANAL);
}

module.exports = { CANAL, publicar, assinar, quantidadeDeOuvintes };
