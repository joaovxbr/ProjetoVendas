/*
 * services/metricas.service.js
 * -----------------------------------------------------------------------------
 * Diagnostico do servico: o que esta no ar, quanto tempo, com que schema e
 * quantos registros. E o que alimenta GET /api/status e o health check.
 */
'use strict';

const os = require('os');
const pkg = require('../../package.json');
const config = require('../config');
const conexao = require('../db/conexao');
const { situacao } = require('../db/migracoes');
const produtosRepo = require('../repositories/produtos.repo');
const usuariosRepo = require('../repositories/usuarios.repo');
const vendasRepo = require('../repositories/vendas.repo');
const licencasRepo = require('../repositories/licencas.repo');
const gatewayService = require('./gateway.service');
const { agoraISO, formatarBR } = require('../utils/datas');
const { paraReais } = require('../utils/dinheiro');

/** Status publico (nao expoe nada sensivel). */
function status() {
  return {
    loja: config.loja.nome,
    status: 'ok',
    versao: pkg.version,
    ambiente: config.ambiente,
    hora: formatarBR(agoraISO()),
    horaISO: agoraISO()
  };
}

/** Health check: confirma que o processo responde E que o banco esta acessivel. */
function saude() {
  const inicio = process.hrtime.bigint();

  let banco = 'ok';
  let erro = null;
  try {
    conexao.obter().prepare('SELECT 1 AS ok').get();
  } catch (falha) {
    banco = 'indisponivel';
    erro = falha.message;
  }

  const latenciaMs = Number(process.hrtime.bigint() - inicio) / 1e6;

  return {
    status: banco === 'ok' ? 'ok' : 'degradado',
    banco,
    latenciaBancoMs: Math.round(latenciaMs * 100) / 100,
    uptimeSegundos: Math.round(process.uptime()),
    erro
  };
}

/** Diagnostico completo, restrito a administradores. */
function diagnostico() {
  const memoria = process.memoryUsage();
  // A forma de pagamento padrao pode ter sido escolhida no painel (aba
  // Gateways), que sobrepoe o `.env` — por isso lemos do servico, nao da
  // configuracao do ambiente, para o diagnostico nao contradizer o painel.
  const formas = gatewayService.metodosDisponiveis();

  return {
    aplicacao: {
      nome: pkg.name,
      versao: pkg.version,
      ambiente: config.ambiente,
      node: process.version,
      uptimeSegundos: Math.round(process.uptime()),
      memoriaMB: {
        rss: Math.round(memoria.rss / 1024 / 1024),
        heapUsada: Math.round(memoria.heapUsed / 1024 / 1024)
      },
      sistema: {
        plataforma: os.platform(),
        cpus: os.cpus().length,
        cargaMedia: os.loadavg().map(valor => Math.round(valor * 100) / 100)
      }
    },
    banco: {
      arquivo: config.banco.arquivo,
      migracoes: situacao(),
      integridade: (() => {
        try {
          const resultado = conexao.um('PRAGMA integrity_check');
          return resultado ? Object.values(resultado)[0] : 'desconhecido';
        } catch (erro) {
          return `erro: ${erro.message}`;
        }
      })()
    },
    contadores: {
      produtos: produtosRepo.contar({ incluirInativos: true }),
      produtosAtivos: produtosRepo.contar(),
      usuarios: usuariosRepo.contar(),
      pedidos: vendasRepo.contarTodos(),
      pedidosPendentes: vendasRepo.contarTodos({ status: 'pendente' }),
      licencas: licencasRepo.contarPorStatus()
    },
    financeiro: (() => {
      const resumo = vendasRepo.resumoFinanceiro();
      return {
        receitaCentavos: resumo.receitaCentavos,
        receita: paraReais(resumo.receitaCentavos),
        ticketMedio: paraReais(resumo.ticketMedioCentavos)
      };
    })(),
    configuracao: {
      provedorPagamento: config.pagamento.provedor,
      // Escolha do painel (cai para o `.env` se nunca foi escolhida).
      metodoPadrao: gatewayService.nomeMetodo(gatewayService.metodoPadrao()),
      // Forma que o checkout usa de fato — difere da escolhida se ela nao
      // tiver provedor ligado.
      metodoNoCheckout: formas.padrao ? gatewayService.nomeMetodo(formas.padrao) : '',
      formasDisponiveis: formas.metodos.map(metodo => metodo.nome),
      origemExtraCors: config.cors.origens,
      nivelLog: config.log.nivel,
      trustProxy: config.trustProxy
    }
  };
}

module.exports = { status, saude, diagnostico };
