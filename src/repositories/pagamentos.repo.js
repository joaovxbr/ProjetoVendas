/*
 * repositories/pagamentos.repo.js
 * -----------------------------------------------------------------------------
 * Trilha das notificacoes (webhooks) recebidas dos gateways. Duas utilidades:
 *
 *   1. IDEMPOTENCIA — o mesmo webhook pode chegar varias vezes (os gateways
 *      reenviam quando nao recebem 200). Guardar o que chegou permite ignorar
 *      repeticao em vez de reprocessar.
 *   2. AUDITORIA — "o gateway avisou que esse pedido foi pago?" deixa de ser
 *      uma pergunta sem resposta.
 */
'use strict';

const { obter } = require('../db/conexao');
const { agoraISO } = require('../utils/datas');

function mapear(linha) {
  if (!linha) return null;
  return {
    id: linha.id,
    gatewayId: linha.gateway_id,
    referencia: linha.referencia,
    pagamentoId: linha.pagamento_id,
    status: linha.status,
    valido: !!linha.valido,
    motivo: linha.motivo,
    ip: linha.ip,
    criadoEm: linha.criado_em
  };
}

function registrarEvento({
  id,
  gatewayId,
  referencia = null,
  pagamentoId = null,
  status = 'recebido',
  valido = false,
  motivo = '',
  payload = null,
  ip = null
}) {
  obter()
    .prepare(`
      INSERT INTO pagamentos_eventos
        (id, gateway_id, referencia, pagamento_id, status, valido, motivo, payload, ip, criado_em)
      VALUES
        (@id, @gatewayId, @referencia, @pagamentoId, @status, @valido, @motivo, @payload, @ip, @agora)
    `)
    .run({
      id,
      gatewayId: String(gatewayId),
      referencia: referencia === null || referencia === undefined ? null : String(referencia),
      pagamentoId: pagamentoId === null || pagamentoId === undefined ? null : String(pagamentoId),
      status: String(status),
      valido: valido ? 1 : 0,
      motivo: String(motivo || '').slice(0, 300),
      payload: payload ? JSON.stringify(payload).slice(0, 4000) : null,
      ip,
      agora: agoraISO()
    });
  return true;
}

/** Eventos de um pedido (mais recentes primeiro). */
function listarPorReferencia(referencia, { limite = 20 } = {}) {
  return obter()
    .prepare('SELECT * FROM pagamentos_eventos WHERE referencia = ? ORDER BY criado_em DESC LIMIT ?')
    .all(String(referencia), limite)
    .map(mapear);
}

/** Historico geral, para a tela de auditoria do painel. */
function listar({ limite = 50, deslocamento = 0, gatewayId = null } = {}) {
  const where = gatewayId ? 'WHERE gateway_id = @gatewayId' : '';
  return obter()
    .prepare(`
      SELECT * FROM pagamentos_eventos
      ${where}
      ORDER BY criado_em DESC
      LIMIT @limite OFFSET @deslocamento
    `)
    .all({ limite, deslocamento, gatewayId })
    .map(mapear);
}

function contar({ gatewayId = null } = {}) {
  const where = gatewayId ? 'WHERE gateway_id = @gatewayId' : '';
  const linha = obter().prepare(`SELECT COUNT(*) AS total FROM pagamentos_eventos ${where}`).get({ gatewayId });
  return linha ? linha.total : 0;
}

module.exports = { mapear, registrarEvento, listarPorReferencia, listar, contar };
