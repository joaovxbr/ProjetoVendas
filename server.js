/*
 * server.js
 * -----------------------------------------------------------------------------
 * Ponto de entrada: prepara o banco, sobe o servidor HTTP e trata o
 * encerramento gracioso. Toda a logica vive em src/ — aqui so fica a
 * orquestracao do boot.
 *
 *   npm start          -> sobe o servidor
 *   npm run dev        -> sobe com reinicio automatico
 *   npm run db:migrate -> so aplica as migracoes e sai
 *   npm run db:seed    -> so popula os dados iniciais e sai
 */
'use strict';

const config = require('./src/config');
const logger = require('./src/utils/logger');
const { criarApp, USANDO_BUILD } = require('./src/app');
const { conectar, fechar } = require('./src/db/conexao');
const { migrar } = require('./src/db/migracoes');
const { semear, bancoVazio, estoqueNuncaInicializado, garantirEstoqueInicial, CONTAS_DEMO } = require('./src/db/semear');
const gatewayService = require('./src/services/gateway.service');
const sessoesRepo = require('./src/repositories/sessoes.repo');
const usuariosRepo = require('./src/repositories/usuarios.repo');
const { verificarSenha } = require('./src/utils/seguranca');
const tokensRepo = require('./src/repositories/tokens.repo');

/* -------------------------------------------------------------------------- */
/* Preparacao                                                                 */
/* -------------------------------------------------------------------------- */

function prepararBanco() {
  conectar();

  const aplicadas = migrar();
  if (aplicadas > 0) {
    logger.info(`${aplicadas} migracao(oes) aplicada(s)`);
  }

  /*
   * Primeira execucao: banco sem catalogo. Semeia automaticamente para que a
   * loja ja funcione depois de "npm install && npm start", sem passo extra.
   */
  if (bancoVazio()) {
    logger.info('Banco vazio detectado. Populando catalogo inicial...');
    semear({ silencioso: true });
    logger.info('Catalogo inicial criado');
  } else if (estoqueNuncaInicializado()) {
    /*
     * Banco que ja existia antes do estoque de chaves: o catalogo esta la, mas o
     * pool nasceu vazio. Sem isso a loja ficaria toda "esgotada" e a venda seria
     * bloqueada. Gera a carga inicial uma unica vez.
     */
    const { chaves } = garantirEstoqueInicial();
    logger.info('Estoque inicial gerado para catalogo existente', { chaves });
  }

  // Garante uma linha de configuracao para cada gateway de pagamento.
  const gateways = gatewayService.garantirCatalogo();
  if (gateways.criados) {
    logger.info(`${gateways.criados} gateway(s) de pagamento registrado(s)`);
  }

  // Faxina de registros vencidos a cada boot.
  const sessoesRemovidas = sessoesRepo.limparExpiradas();
  const tokensRemovidos = tokensRepo.limparExpirados();
  if (sessoesRemovidas || tokensRemovidos) {
    logger.debug('Limpeza de registros vencidos', { sessoesRemovidas, tokensRemovidos });
  }
}

/*
 * Autoverificacao de seguranca no boot.
 *
 * Nao bloqueia o servidor (a unica checagem que derruba e a do SEGREDO_APP, e
 * ela vive na config): aqui o objetivo e fazer a configuracao errada APARECER
 * no log em vez de virar um problema silencioso em producao.
 */
function verificarSeguranca() {
  const avisos = [];

  if (config.producao) {
    if (!config.loja.urlDeclarada) {
      avisos.push(
        'LOJA_URL nao definida: a verificacao de origem das requisicoes de escrita ' +
        'esta aceitando o cabecalho Host como reserva. Defina LOJA_URL com o dominio real.'
      );
    } else if (config.loja.url.startsWith('http://')) {
      avisos.push(
        `LOJA_URL esta em HTTP (${config.loja.url}). Em producao use https:// — ` +
        'sem TLS o cookie de sessao viaja em claro.'
      );
    }
  }

  /*
   * Gateway marcado como producao sem credenciais completas: a regra de negocio
   * ja bloqueia isso no salvamento, mas um banco restaurado de backup poderia
   * trazer esse estado. Melhor gritar no boot do que descobrir na primeira venda.
   */
  let reais = 0;
  for (const gateway of gatewayService.listarParaAdmin()) {
    if (!gateway.ativo || gateway.somenteSimulacao) continue;
    if (gateway.credenciaisCompletas) reais += 1;
    if (gateway.modo === 'producao' && !gateway.credenciaisCompletas) {
      avisos.push(
        `${gateway.nome} esta ativo em PRODUCAO sem as credenciais completas ` +
        `(faltam: ${gateway.faltando.join(', ')}). Ele vai operar em demonstracao.`
      );
    }
  }

  /*
   * Sem provedor real a loja aprova compras sem cobrar. Em producao isso e um
   * problema (aviso); em desenvolvimento e o modo esperado do simulador, entao
   * vira so uma linha informativa — senao todo boot local "nasce com aviso".
   */
  if (!reais) {
    const mensagem =
      'Nenhum provedor de pagamento real esta configurado: a loja vende em ' +
      'modo demonstracao (as compras sao aprovadas sem cobranca).';
    if (config.producao) avisos.push(mensagem);
    else logger.info(`[pagamento] ${mensagem}`);
  }

  /*
   * Contas de demonstracao tem senha publica (README e console). Em producao,
   * uma delas ainda ativa com a senha de fabrica — em especial admin@loja.com —
   * e acesso administrativo aberto para qualquer um.
   */
  if (config.producao) {
    const expostas = CONTAS_DEMO.filter((conta) => {
      const usuario = usuariosRepo.buscarPorEmail(conta.email);
      return usuario && usuario.ativo && verificarSenha(conta.senha, usuario.senhaSalt, usuario.senhaHash);
    });
    if (expostas.length) {
      avisos.push(
        `Contas de demonstracao ativas com a senha padrao: ${expostas.map(c => c.email).join(', ')}. ` +
        'Troque as senhas ou desative essas contas no painel antes de abrir a loja.'
      );
    }
  }

  for (const aviso of avisos) logger.warn(`[seguranca] ${aviso}`);
  return avisos;
}

/* -------------------------------------------------------------------------- */
/* Boot                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Confere, no boot, de onde o front esta sendo servido.
 *
 * Em desenvolvimento isso e o comportamento esperado: `public/` direto, sem
 * build, para editar um arquivo e recarregar. Em producao o esperado e o
 * oposto, o `dist/public/`; quando ele nao existe o servidor NAO quebra (ele
 * cai para `public/`, que funciona igual, so que sem minificacao e sem o cache
 * longo) e o aviso e para que ninguem ache que a loja esta no ar otimizada
 * quando nao esta.
 */
function verificarFront() {
  if (!config.producao) return;
  if (USANDO_BUILD) {
    logger.info('Front servido do build (dist/public): minificado e com cache longo');
    return;
  }
  logger.warn(
    '[front] Producao sem dist/public. Rode "npm run build" antes de subir. ' +
    'Servindo de public/ sem minificar e sem cache longo — a loja funciona, ' +
    'mas cada visitante baixa os arquivos de novo a cada visita.'
  );
}

function iniciar() {
  prepararBanco();
  verificarSeguranca();
  verificarFront();

  const app = criarApp();

  const servidor = app.listen(config.porta, () => {
    const endereco = `http://localhost:${config.porta}`;
    logger.info(`${config.loja.nome} no ar em ${endereco}`, { ambiente: config.ambiente });
    if (!config.producao) {
      console.log('');
      console.log(`  ${config.loja.nome} - servidor iniciado`);
      console.log(`  Loja ......... ${endereco}`);
      console.log(`  API .......... ${endereco}/api/status`);
      console.log(`  Painel ....... ${endereco}/api/admin/painel`);
      console.log(`  Banco ........ ${config.banco.arquivo}`);
      console.log('');
      console.log('  Contas de demonstracao:');
      console.log('    Cliente ..... demo@loja.com / demo123');
      console.log('    Admin ....... admin@loja.com / admin123');
      console.log('');
    }
  });

  // Limpeza periodica: sessoes e tokens vencidos saem do banco de hora em hora.
  const faxina = setInterval(() => {
    try {
      const sessoes = sessoesRepo.limparExpiradas();
      const tokens = tokensRepo.limparExpirados();
      if (sessoes || tokens) logger.debug('Faxina periodica', { sessoes, tokens });
    } catch (erro) {
      logger.warn('Falha na faxina periodica', { erro: erro.message });
    }
  }, 60 * 60 * 1000);
  // Nao segura o processo aberto por causa do timer.
  faxina.unref();

  /* ---------------------------------------------------------------------- */
  /* Encerramento gracioso                                                  */
  /* ---------------------------------------------------------------------- */

  let encerrando = false;

  function encerrar(sinal) {
    if (encerrando) return;
    encerrando = true;
    logger.info(`Recebido ${sinal}. Encerrando...`);

    clearInterval(faxina);

    // Para de aceitar conexoes novas e espera as em andamento terminarem.
    servidor.close(() => {
      fechar();
      logger.info('Servidor encerrado com sucesso');
      process.exit(0);
    });

    // Rede de seguranca: se algo travar, sai a forca depois de 10s.
    setTimeout(() => {
      logger.warn('Encerramento forcado apos 10s');
      fechar();
      process.exit(1);
    }, 10000).unref();
  }

  process.on('SIGINT', () => encerrar('SIGINT'));
  process.on('SIGTERM', () => encerrar('SIGTERM'));

  process.on('unhandledRejection', (motivo) => {
    logger.error('Promise rejeitada sem tratamento', { erro: motivo instanceof Error ? motivo : String(motivo) });
  });

  process.on('uncaughtException', (erro) => {
    logger.error('Excecao nao capturada', { erro });
    encerrar('uncaughtException');
  });

  return servidor;
}

// Permite `require('./server')` em testes sem subir o servidor de verdade.
if (require.main === module) {
  iniciar();
}

module.exports = { iniciar, prepararBanco, verificarSeguranca, verificarFront };
