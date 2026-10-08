/*
 * routes/index.js
 * -----------------------------------------------------------------------------
 * Ponto unico onde a API e montada. Tudo aqui fica sob /api.
 */
'use strict';

const express = require('express');
const metricasService = require('../services/metricas.service');
const configuracoesService = require('../services/configuracoes.service');
const { bloquearManutencao } = require('../middlewares/manutencao');
const { assincrono } = require('../middlewares/contexto');
const { naoEncontradoApi } = require('../middlewares/erros');

const authRoutes = require('./auth.routes');
const produtosRoutes = require('./produtos.routes');
const vendasRoutes = require('./vendas.routes');
const licencasRoutes = require('./licencas.routes');
const cuponsRoutes = require('./cupons.routes');
const avaliacoesRoutes = require('./avaliacoes.routes');
const favoritosRoutes = require('./favoritos.routes');
const contaRoutes = require('./conta.routes');
const pagamentosRoutes = require('./pagamentos.routes');
const adminRoutes = require('./admin.routes');

const router = express.Router();

/* -------------------------------------------------------------------------- */
/* Diagnostico (nunca bloqueado por manutencao)                               */
/* -------------------------------------------------------------------------- */

// Identificacao da loja. Formato mantido do front atual.
router.get('/status', (req, res) => {
  res.json(metricasService.status());
});

// Health check para monitoramento / orquestradores.
router.get('/saude', (req, res) => {
  const saude = metricasService.saude();
  res.status(saude.status === 'ok' ? 200 : 503).json(saude);
});

/*
 * Ajustes publicos da vitrine (aviso do topo, destaque, suporte, manutencao).
 * Fica ANTES do bloqueio de proposito: e justamente o que a loja le para
 * mostrar a tela de manutencao e para saber quando voltar ao ar.
 */
router.get('/loja/ajustes', assincrono((req, res) => {
  const admin = Boolean(req.usuario && req.usuario.papel === 'admin');
  res.json(configuracoesService.publicas({ admin }));
}));

/* -------------------------------------------------------------------------- */
/* A partir daqui o modo manutencao vale                                      */
/* -------------------------------------------------------------------------- */

router.use(bloquearManutencao);

router.use('/auth', authRoutes);
router.use('/produtos', produtosRoutes);
router.use('/vendas', vendasRoutes);
router.use('/licencas', licencasRoutes);
router.use('/cupons', cuponsRoutes);
router.use('/avaliacoes', avaliacoesRoutes);
router.use('/favoritos', favoritosRoutes);
router.use('/conta', contaRoutes);
router.use('/pagamentos', pagamentosRoutes);
router.use('/admin', adminRoutes);

// Rota de API inexistente: responde JSON, nunca HTML.
router.use(naoEncontradoApi);

module.exports = router;
