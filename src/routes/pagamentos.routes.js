/*
 * routes/pagamentos.routes.js
 * -----------------------------------------------------------------------------
 * Rotas PUBLICAS de pagamento (nao exigem login):
 *
 *   GET  /api/pagamentos/metodos          o que a vitrine pode oferecer agora
 *   POST /api/pagamentos/webhook/:gateway notificacao do gateway
 *
 * O webhook e a unica porta pela qual um pagamento pendente vira pago sem um
 * admin clicando. Por isso ele e tratado com cuidado:
 *   - valida a ASSINATURA da notificacao (quando o gateway tem segredo);
 *   - registra TODO evento recebido, valido ou nao, para auditoria;
 *   - e idempotente: confirmar duas vezes o mesmo pedido nao faz efeito duplo.
 */
'use strict';

const express = require('express');
const gatewayService = require('../services/gateway.service');
const pagamentoService = require('../services/pagamento.service');
const checkoutService = require('../services/checkout.service');
const vendasRepo = require('../repositories/vendas.repo');
const registroGateways = require('../gateways');

const { assincrono } = require('../middlewares/contexto');
const limites = require('../middlewares/limites');
const { NaoEncontrado, RegraNegocio } = require('../utils/erros');
const logger = require('../utils/logger');

const router = express.Router();

function exigirGateway(req, res, next) {
  const id = String(req.params.gateway || '').trim().toLowerCase();
  if (!registroGateways.existe(id)) return next(new NaoEncontrado('Gateway nao encontrado'));
  req.gatewayId = id;
  next();
}

/* -------------------------------------------------------------------------- */
/* Metodos disponiveis                                                        */
/* -------------------------------------------------------------------------- */

router.get('/metodos', assincrono((req, res) => {
  res.json(gatewayService.metodosDisponiveis());
}));

/* -------------------------------------------------------------------------- */
/* Webhook                                                                    */
/* -------------------------------------------------------------------------- */

/*
 * Responde 200 mesmo quando a notificacao e invalida? NAO.
 *
 * Se respondessemos 200 para uma assinatura invalida, o gateway pararia de
 * reenviar — e um ataque de "engolir webhook" ficaria invisivel. Devolvemos
 * 400 e deixamos o reenvio acontecer.
 */
router.post('/webhook/:gateway', limites.webhook, exigirGateway, assincrono(async (req, res) => {
  const gatewayId = req.gatewayId;

  // Corpo exato recebido: a assinatura e calculada sobre ele, nao sobre o
  // objeto re-serializado (que poderia mudar a ordem das chaves).
  const corpoBruto = req.corpoBruto || JSON.stringify(req.body || {});

  const resultado = await pagamentoService.processarWebhook({
    gatewayId,
    corpoBruto,
    cabecalhos: req.headers,
    dados: req.body
  });

  // Registra SEMPRE (valido ou nao): e a trilha de auditoria do dinheiro.
  gatewayService.registrarEvento({
    gatewayId,
    referencia: resultado.referencia || null,
    pagamentoId: resultado.pagamentoId || null,
    status: resultado.status || 'recebido',
    valido: !!resultado.valido,
    motivo: resultado.motivo || '',
    payload: req.body,
    ip: req.ipCliente
  });

  if (!resultado.valido) {
    logger.warn('Webhook recusado', { gateway: gatewayId, motivo: resultado.motivo });
    return res.status(400).json({
      erro: 'Notificacao invalida',
      codigo: 'webhook_invalido',
      motivo: resultado.motivo || 'nao foi possivel validar a origem'
    });
  }

  /* Aplica o efeito no pedido ------------------------------------------- */
  let aplicado = 'ignorado';

  if (resultado.referencia) {
    const venda = vendasRepo.buscarPorNumero(resultado.referencia);

    if (venda) {
      /*
       * Duas notificacoes do mesmo pagamento podem chegar quase juntas (o
       * gateway reenvia quando demora a resposta). A leitura de `venda.status`
       * aqui pode estar desatualizada por milissegundos, entao uma RegraNegocio
       * vinda do checkout significa "outro aviso ja resolveu isso" — nao um
       * erro. Tratamos como sem mudanca para o gateway nao ficar reenviando.
       */
      try {
        if (resultado.status === 'aprovado' && venda.status === 'pendente') {
          // Idempotente: se ja estiver pago, confirmarPagamento nao faz nada.
          checkoutService.confirmarPagamento(venda.id, { atorId: null, ip: req.ipCliente });
          aplicado = 'confirmado';
        } else if (resultado.status === 'recusado' && venda.status === 'pendente') {
          checkoutService.cancelar(venda.id, { motivo: 'pagamento recusado pelo gateway', atorId: null, ip: req.ipCliente });
          aplicado = 'cancelado';
        } else {
          aplicado = 'sem_mudanca';
        }
      } catch (erro) {
        if (!(erro instanceof RegraNegocio)) throw erro;
        aplicado = 'sem_mudanca';
        logger.info('Webhook chegou depois de outro aviso', {
          gateway: gatewayId,
          referencia: resultado.referencia,
          motivo: erro.message
        });
      }
    }
  }

  logger.info('Webhook processado', { gateway: gatewayId, referencia: resultado.referencia, aplicado });

  res.json({ recebido: true, aplicado });
}));

module.exports = router;
