/*
 * services/gateway.service.js
 * -----------------------------------------------------------------------------
 * Regras dos gateways de pagamento. E aqui que mora a inteligencia:
 *
 *   - garantirCatalogo()      cria a linha de cada gateway no banco (idempotente)
 *   - listarParaAdmin()       devolve a config com os SEGREDOS MASCARADOS
 *   - salvar()                valida e grava (cifrando as credenciais)
 *   - metodosDisponiveis()    o que a vitrine pode oferecer AGORA
 *   - resolverMetodo()        decide qual gateway cobra cada forma de pagamento
 *   - testar()                diagnostico de configuracao/conexao
 *
 * Duas regras que protegem a loja:
 *   1. Ligar um gateway em PRODUCAO sem as credenciais completas e bloqueado.
 *   2. Segredo nunca sai daqui em texto puro: a API devolve so a mascara.
 */
'use strict';

const cripto = require('../utils/cripto');
const gatewaysRepo = require('../repositories/gateways.repo');
const pagamentosRepo = require('../repositories/pagamentos.repo');
const configuracoesRepo = require('../repositories/configuracoes.repo');
const auditoriaRepo = require('../repositories/auditoria.repo');
const registro = require('../gateways');
const base = require('../gateways/base');
const config = require('../config');

const { ErroValidacao, NaoEncontrado, RegraNegocio } = require('../utils/erros');
const { lerBooleano } = require('../utils/validacao');
const { novoId } = require('../utils/seguranca');
const logger = require('../utils/logger');

const MODOS = ['sandbox', 'producao'];

/*
 * Ajuste de loja (tabela `configuracoes`) com a FORMA DE PAGAMENTO padrao —
 * ou seja, qual metodo o checkout assume quando o cliente nao escolhe. Fica
 * no painel (aba Gateways) em vez do .env: e uma decisao de operacao, nao de
 * deploy. O `PAGAMENTO_METODO_PADRAO` continua valendo como fallback.
 */
const CHAVE_METODO_PADRAO = 'metodo_pagamento_padrao';

/*
 * Prioridade padrao. Os gateways REAIS ficam acima do simulador: assim, no
 * momento em que o admin liga (por exemplo) o Mercado Pago, ele passa a cobrar
 * no lugar do simulador sem que ninguem precise reordenar nada. O simulador
 * fica com prioridade 0 — e o ultimo da fila, so entra quando mais nada serve.
 */
function prioridadePadrao(id) {
  if (id === 'simulado') return 0;
  const indice = registro.IDS.indexOf(id);
  return (registro.IDS.length - indice) * 10;
}

/* -------------------------------------------------------------------------- */
/* Catalogo no banco                                                          */
/* -------------------------------------------------------------------------- */

/** Garante uma linha para cada gateway do catalogo. Idempotente. */
function garantirCatalogo() {
  let criados = 0;
  for (const definicao of registro.GATEWAYS) {
    const antes = gatewaysRepo.buscar(definicao.id);
    gatewaysRepo.garantir(definicao.id, {
      ativo: definicao.padrao.ativo,
      modo: definicao.padrao.modo,
      metodos: definicao.padrao.metodos,
      prioridade: prioridadePadrao(definicao.id)
    });
    if (!antes) criados += 1;
  }
  return { criados, total: registro.GATEWAYS.length };
}

/* -------------------------------------------------------------------------- */
/* Leitura                                                                    */
/* -------------------------------------------------------------------------- */

/** Credenciais em CLARO de um gateway. Uso interno (cobranca). */
function credenciaisDe(id) {
  const linha = gatewaysRepo.buscar(id);
  if (!linha) return {};
  return cripto.decifrar(linha.credenciaisCifradas) || {};
}

/**
 * Versao para o painel: troca cada segredo pela mascara. Chaves publicas
 * (public_key, publishable_key) sao exibidas inteiras — elas nao sao secretas.
 */
function credenciaisMascaradas(definicao, credenciais) {
  const saida = {};
  for (const campo of definicao.campos) {
    const valor = String((credenciais && credenciais[campo.chave]) || '');
    saida[campo.chave] = {
      preenchido: !!valor,
      valor: campo.segredo ? cripto.mascarar(valor) : valor
    };
  }
  return saida;
}

/** Quais campos obrigatorios estao faltando. */
function faltandoDe(definicao, credenciais) {
  return base.conferirCredenciais(credenciais, definicao.campos).faltando;
}

/**
 * Monta a visao de um gateway para o painel: metadados + config + credenciais
 * mascaradas + estado efetivo (vai operar de verdade ou em demonstracao?).
 */
function paraAdmin(definicao, linha) {
  const credenciais = cripto.decifrar(linha.credenciaisCifradas) || {};
  const faltando = faltandoDe(definicao, credenciais);
  const somenteSimulacao = !!definicao.somenteSimulacao;

  return {
    id: definicao.id,
    nome: definicao.nome,
    descricao: definicao.descricao,
    site: definicao.site,
    docs: definicao.docs,
    cor: definicao.cor,
    somenteSimulacao,
    metodosSuportados: definicao.metodos,
    campos: definicao.campos,
    ativo: linha.ativo,
    modo: linha.modo,
    metodos: linha.metodos,
    prioridade: linha.prioridade,
    atualizadoEm: linha.atualizadoEm,
    credenciais: credenciaisMascaradas(definicao, credenciais),
    credenciaisCompletas: faltando.length === 0,
    faltando,
    // "real" = vai falar com o gateway de verdade. "demonstracao" = simula.
    modoEfetivo: somenteSimulacao || faltando.length ? 'demonstracao' : 'real'
  };
}

/** Todos os gateways para a tela de Pagamentos do admin. */
function listarParaAdmin() {
  const linhas = new Map(gatewaysRepo.listar().map(linha => [linha.id, linha]));

  return registro.GATEWAYS.map(definicao => {
    const linha = linhas.get(definicao.id) || {
      id: definicao.id,
      ativo: definicao.padrao.ativo,
      modo: definicao.padrao.modo,
      metodos: definicao.padrao.metodos,
      credenciaisCifradas: '',
      prioridade: prioridadePadrao(definicao.id),
      atualizadoEm: null
    };
    return paraAdmin(definicao, linha);
  });
}

/** Um gateway especifico para o painel. */
function obterParaAdmin(id) {
  const definicao = registro.buscar(id);
  if (!definicao) throw new NaoEncontrado('Gateway nao encontrado');
  const linha = gatewaysRepo.buscar(id) || {
    id,
    ativo: definicao.padrao.ativo,
    modo: definicao.padrao.modo,
    metodos: definicao.padrao.metodos,
    credenciaisCifradas: '',
    prioridade: prioridadePadrao(id),
    atualizadoEm: null
  };
  return paraAdmin(definicao, linha);
}

/* -------------------------------------------------------------------------- */
/* Metodos disponiveis (visao do cliente)                                     */
/* -------------------------------------------------------------------------- */

/** Gateways ligados que aceitam um metodo, do maior para o menor prioridade. */
function candidatos(metodo) {
  return gatewaysRepo
    .listar()
    .filter(linha => linha.ativo && linha.metodos.includes(metodo))
    .filter(linha => !!registro.modulo(linha.id))
    .sort((a, b) => b.prioridade - a.prioridade);
}

/**
 * Decide quem cobra um metodo.
 * @param {string} metodo
 * @param {{gatewayId?:string}} [opcoes]
 * @returns {{gatewayId:string, definicao:object, credenciais:object, modo:string, efetivoReal:boolean, metodos:object}}
 */
function resolverMetodo(metodo, { gatewayId = null } = {}) {
  const alvo = String(metodo || '').toLowerCase();

  if (!registro.IDS_METODOS.includes(alvo)) {
    throw new ErroValidacao('Forma de pagamento indisponivel', {
      metodoPagamento: `Escolha entre: ${registro.IDS_METODOS.join(', ')}`
    });
  }

  if (gatewayId) {
    const definicao = registro.buscar(gatewayId);
    const linha = gatewaysRepo.buscar(gatewayId);
    if (!definicao || !linha) throw new NaoEncontrado('Gateway nao encontrado');
    if (!linha.ativo) throw new RegraNegocio(`O gateway ${definicao.nome} nao esta ativo`);
    if (!linha.metodos.includes(alvo)) {
      throw new ErroValidacao(`${definicao.nome} nao aceita ${alvo}`);
    }
    const credenciais = cripto.decifrar(linha.credenciaisCifradas) || {};
    return {
      gatewayId: definicao.id,
      definicao,
      credenciais,
      modo: linha.modo,
      efetivoReal: !definicao.somenteSimulacao && faltandoDe(definicao, credenciais).length === 0
    };
  }

  const escolhidos = candidatos(alvo);
  if (!escolhidos.length) {
    throw new RegraNegocio(`Nenhum gateway ativo aceita ${alvo} no momento`);
  }

  const linha = escolhidos[0];
  const definicao = registro.buscar(linha.id);
  const credenciais = cripto.decifrar(linha.credenciaisCifradas) || {};

  return {
    gatewayId: definicao.id,
    definicao,
    credenciais,
    modo: linha.modo,
    efetivoReal: !definicao.somenteSimulacao && faltandoDe(definicao, credenciais).length === 0
  };
}

/* -------------------------------------------------------------------------- */
/* Forma de pagamento padrao (ajuste de loja)                                 */
/* -------------------------------------------------------------------------- */

/**
 * Nome legivel de uma forma de pagamento (para logs e diagnostico). Cai para
 * o proprio id se a forma nao existir no catalogo.
 */
function nomeMetodo(id) {
  const meta = registro.METODOS[id];
  return meta ? meta.nome : String(id || '');
}

/**
 * Forma de pagamento padrao da loja: a escolhida no painel; se nunca foi
 * escolhida, a do `.env`; se nem essa existir, a primeira conhecida.
 */
function metodoPadrao() {
  const salvo = String(configuracoesRepo.obterValor(CHAVE_METODO_PADRAO, '') || '').toLowerCase();
  if (registro.IDS_METODOS.includes(salvo)) return salvo;

  const doAmbiente = String(config.pagamento.metodoPadrao || '').toLowerCase();
  if (registro.IDS_METODOS.includes(doAmbiente)) return doAmbiente;

  return registro.IDS_METODOS[0];
}

/**
 * Define a forma de pagamento padrao pelo painel.
 *
 * Nao exige que exista gateway ativo aceitando o metodo: a escolha e uma
 * preferencia, e o checkout ja sabe cair para outra forma se nenhum gateway
 * ativo cobrir a preferida (ver `escolherMetodo`).
 */
function definirMetodoPadrao(metodo, ator, { ip = null } = {}) {
  const alvo = String(metodo || '').toLowerCase();

  if (!registro.IDS_METODOS.includes(alvo)) {
    throw new ErroValidacao('Forma de pagamento invalida', {
      metodo: `Escolha entre: ${registro.IDS_METODOS.join(', ')}`
    });
  }

  configuracoesRepo.definir(CHAVE_METODO_PADRAO, alvo);
  auditoriaRepo.registrar({
    atorId: ator ? ator.id : null,
    acao: 'gateway.metodo_padrao',
    entidade: 'configuracao',
    dados: { metodoPadrao: alvo },
    ip
  });

  return { metodoPadrao: alvo };
}

/** Metodos que a vitrine pode oferecer agora, com o gateway responsavel. */
function metodosDisponiveis() {
  const disponiveis = [];

  for (const idMetodo of registro.IDS_METODOS) {
    let resolvido = null;
    try {
      resolvido = resolverMetodo(idMetodo);
    } catch {
      resolvido = null;
    }
    if (!resolvido) continue;

    const meta = registro.METODOS[idMetodo];
    disponiveis.push({
      id: meta.id,
      nome: meta.nome,
      descricao: meta.descricao,
      icone: meta.icone,
      imediato: meta.imediato,
      gateway: {
        id: resolvido.gatewayId,
        nome: resolvido.definicao.nome,
        cor: resolvido.definicao.cor,
        modo: resolvido.modo,
        demonstracao: !resolvido.efetivoReal
      }
    });
  }

  // A forma padrao e a escolhida pelo admin, desde que esteja disponivel;
  // senao cai para a primeira que algum gateway ativo aceita.
  const preferida = metodoPadrao();
  const padrao = disponiveis.some(item => item.id === preferida)
    ? preferida
    : (disponiveis.length ? disponiveis[0].id : null);

  return { metodos: disponiveis, padrao };
}

/* -------------------------------------------------------------------------- */
/* Escrita                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Normaliza o bloco de credenciais que veio do painel.
 *
 * Convencao (protege contra apagar segredo por acidente):
 *   - string nao vazia  -> grava
 *   - null              -> limpa o campo
 *   - '' / undefined    -> mantem o que ja estava
 */
function mesclarCredenciais(definicao, atuais, enviadas) {
  if (definicao.somenteSimulacao) return {};
  if (!enviadas || typeof enviadas !== 'object') return atuais;

  const proximo = { ...atuais };
  for (const campo of definicao.campos) {
    if (!(campo.chave in enviadas)) continue;
    const valor = enviadas[campo.chave];

    if (valor === null) {
      delete proximo[campo.chave];
      continue;
    }
    if (typeof valor !== 'string') continue;

    const limpo = valor.trim();
    if (!limpo) continue; // mascara/placeholder nao sobrescreve
    if (limpo.length > 500) throw new ErroValidacao(`Credencial ${campo.rotulo} longa demais`);
    proximo[campo.chave] = limpo;
  }
  return proximo;
}

/**
 * Salva a configuracao de um gateway.
 *
 * @param {string} id
 * @param {object} dados { ativo?, modo?, metodos?, prioridade?, credenciais?, limparCredenciais? }
 * @param {object} ator  usuario admin
 */
function salvar(id, dados, ator, { ip = null } = {}) {
  const definicao = registro.buscar(id);
  if (!definicao) throw new NaoEncontrado('Gateway nao encontrado');

  const linha = gatewaysRepo.buscar(id) || gatewaysRepo.garantir(id, {
    ativo: definicao.padrao.ativo,
    modo: definicao.padrao.modo,
    metodos: definicao.padrao.metodos,
    prioridade: prioridadePadrao(id)
  });

  /* Credenciais ---------------------------------------------------------- */
  let credenciais = cripto.decifrar(linha.credenciaisCifradas) || {};
  if (dados.limparCredenciais === true || dados.limparCredenciais === 'true') {
    credenciais = {};
  } else {
    credenciais = mesclarCredenciais(definicao, credenciais, dados.credenciais);
  }

  /* Campos simples ------------------------------------------------------- */
  const ativo = dados.ativo === undefined ? linha.ativo : lerBooleano(dados.ativo, linha.ativo);
  const modo = MODOS.includes(String(dados.modo || '').toLowerCase())
    ? String(dados.modo).toLowerCase()
    : linha.modo;

  const metodos = dados.metodos === undefined
    ? linha.metodos
    : registro.filtrarMetodos(id, Array.isArray(dados.metodos) ? dados.metodos : [dados.metodos]);

  let prioridade = linha.prioridade;
  if (dados.prioridade !== undefined) {
    const numero = Number(dados.prioridade);
    if (!Number.isFinite(numero) || numero < 0 || numero > 999) {
      throw new ErroValidacao('Prioridade deve ser um numero entre 0 e 999');
    }
    prioridade = Math.round(numero);
  }

  /* Regras de seguranca -------------------------------------------------- */

  // Nao faz sentido ativo e sem forma de pagamento escolhida.
  if (ativo && !metodos.length) {
    throw new RegraNegocio('Escolha ao menos uma forma de pagamento antes de ativar o gateway');
  }

  // Producao exige credenciais completas: e o que impede a loja de "aceitar"
  // pagamentos que na verdade nunca seriam cobrados.
  const faltando = faltandoDe(definicao, credenciais);
  if (ativo && modo === 'producao' && faltando.length) {
    throw new RegraNegocio(
      `Para operar em producao, preencha: ${faltando.join(', ')}`,
      { credenciais: 'Credenciais obrigatorias ausentes' }
    );
  }

  /* Persistencia --------------------------------------------------------- */
  gatewaysRepo.atualizar(id, { ativo, modo, metodos, prioridade });
  gatewaysRepo.definirCredenciais(id, Object.keys(credenciais).length ? cripto.cifrar(credenciais) : '');

  // Auditoria: registra QUE mudou, nunca o VALOR do segredo.
  auditoriaRepo.registrar({
    atorId: ator ? ator.id : null,
    acao: 'gateway.atualizado',
    entidade: 'gateway',
    entidadeId: id,
    dados: {
      ativo,
      modo,
      metodos,
      prioridade,
      credenciaisAlteradas: Object.keys(credenciais)
    },
    ip
  });

  logger.info('Gateway atualizado', { gateway: id, ativo, modo, metodos });

  return obterParaAdmin(id);
}

/* -------------------------------------------------------------------------- */
/* Diagnostico                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Testa a configuracao de um gateway.
 *
 * Nao faz cobranca de teste (seria dinheiro de verdade): quando ha credenciais,
 * chama uma rota de LEITURA do provedor apenas para confirmar que elas valem.
 * Sem credenciais, o veredito e "operando em demonstracao".
 */
async function testar(id) {
  const definicao = registro.buscar(id);
  if (!definicao) throw new NaoEncontrado('Gateway nao encontrado');

  const linha = gatewaysRepo.buscar(id);
  const credenciais = linha ? (cripto.decifrar(linha.credenciaisCifradas) || {}) : {};
  const faltando = faltandoDe(definicao, credenciais);
  const somenteSimulacao = !!definicao.somenteSimulacao;

  if (somenteSimulacao) {
    return {
      id,
      ok: true,
      modoEfetivo: 'demonstracao',
      mensagem: 'Simulador interno sempre disponivel: aprovacao imediata para Pix e cartao, boleto pendente.'
    };
  }

  if (faltando.length) {
    return {
      id,
      ok: true,
      modoEfetivo: 'demonstracao',
      faltando,
      mensagem: `Faltam credenciais (${faltando.join(', ')}). O gateway vai operar em modo demonstracao ate serem preenchidas.`
    };
  }

  const modulo = registro.modulo(id);
  if (typeof modulo.testarConexao !== 'function') {
    return {
      id,
      ok: true,
      modoEfetivo: 'real',
      mensagem: 'Credenciais completas. Este gateway nao oferece teste de conexao; a primeira cobranca real confirma o acesso.'
    };
  }

  const modo = linha ? linha.modo : definicao.padrao.modo;

  try {
    const resultado = await modulo.testarConexao({ credenciais, modo, gateway: definicao });
    return {
      id,
      ok: resultado.ok !== false,
      modoEfetivo: 'real',
      mensagem: resultado.mensagem || (resultado.ok === false ? 'A conexao foi recusada.' : 'Conexao validada com sucesso.'),
      detalhe: resultado.detalhe || null
    };
  } catch (erro) {
    return {
      id,
      ok: false,
      modoEfetivo: 'real',
      mensagem: `Falha ao validar as credenciais: ${erro.message}`
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Eventos de webhook                                                         */
/* -------------------------------------------------------------------------- */

/** Grava a notificacao recebida (usado pela rota de webhook). */
function registrarEvento({ gatewayId, referencia, pagamentoId, status, valido, motivo, payload, ip }) {
  return pagamentosRepo.registrarEvento({
    id: novoId(),
    gatewayId,
    referencia,
    pagamentoId,
    status,
    valido,
    motivo,
    payload,
    ip
  });
}

function historicoEventos({ limite = 50, deslocamento = 0, gatewayId = null } = {}) {
  return {
    total: pagamentosRepo.contar({ gatewayId }),
    eventos: pagamentosRepo.listar({ limite, deslocamento, gatewayId })
  };
}

module.exports = {
  MODOS,
  CHAVE_METODO_PADRAO,
  garantirCatalogo,
  credenciaisDe,
  listarParaAdmin,
  obterParaAdmin,
  metodoPadrao,
  definirMetodoPadrao,
  nomeMetodo,
  metodosDisponiveis,
  resolverMetodo,
  salvar,
  testar,
  registrarEvento,
  historicoEventos,
  prioridadePadrao
};
