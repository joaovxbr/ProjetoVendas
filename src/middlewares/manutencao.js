/*
 * middlewares/manutencao.js
 * -----------------------------------------------------------------------------
 * Modo manutencao ligado pelo painel (tabela "configuracoes"). Enquanto
 * estiver ativo, a API responde 503 para todo mundo, EXCETO:
 *   - administradores (que precisam entrar para desligar)
 *   - rotas de autenticacao (para o admin conseguir fazer login)
 *
 * O valor e lido do banco no maximo uma vez a cada 10 segundos: um ajuste que
 * muda raramente nao precisa de uma consulta por requisicao.
 */
'use strict';

const configuracoesRepo = require('../repositories/configuracoes.repo');
const { lerBooleano } = require('../utils/validacao');
const logger = require('../utils/logger');

const TTL_MS = 10 * 1000;

let cache = { ativo: false, texto: '', expiraEm: 0 };

function lerEstado() {
  if (Date.now() < cache.expiraEm) return cache;

  try {
    const ativo = lerBooleano(configuracoesRepo.obterValor('modo_manutencao', 'false'), false);
    const texto = configuracoesRepo.obterValor('texto_manutencao', 'Estamos em manutencao. Voltamos em instantes.');
    cache = { ativo, texto, expiraEm: Date.now() + TTL_MS };
  } catch (erro) {
    // Banco indisponivel: nao derruba a loja por causa do modo manutencao.
    logger.warn('Nao foi possivel ler o modo manutencao', { erro: erro.message });
    cache = { ativo: false, texto: '', expiraEm: Date.now() + TTL_MS };
  }

  return cache;
}

/** Forca a releitura no proximo acesso (chamado quando o admin salva ajustes). */
function invalidarCache() {
  cache.expiraEm = 0;
}

function bloquearManutencao(req, res, next) {
  const estado = lerEstado();
  if (!estado.ativo) return next();

  if (req.usuario && req.usuario.papel === 'admin') return next();
  if (req.path.startsWith('/auth')) return next();
  /*
   * Webhooks de pagamento continuam passando: uma cobranca ja feita precisa
   * poder ser confirmada mesmo com a loja em manutencao. Bloquear aqui faria o
   * cliente pagar e nao receber a chave — o pior desfecho possivel.
   */
  if (req.path.startsWith('/pagamentos/webhook')) return next();

  res.status(503).json({
    erro: estado.texto || 'Estamos em manutencao. Voltamos em instantes.',
    codigo: 'manutencao'
  });
}

module.exports = { bloquearManutencao, invalidarCache };
