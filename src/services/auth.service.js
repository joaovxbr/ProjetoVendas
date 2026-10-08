/*
 * services/auth.service.js
 * -----------------------------------------------------------------------------
 * Cadastro, login, sessao e senhas. Concentra as decisoes de seguranca:
 *
 *  - Senhas nunca sao guardadas em texto puro (scrypt + salt por usuario).
 *  - O login nao revela se o e-mail existe: mesma mensagem e mesmo tempo de
 *    resposta nos dois casos.
 *  - Ao trocar/redefinir a senha, todas as outras sessoes sao derrubadas.
 *  - Tokens de recuperacao so existem em texto puro no link enviado; no banco
 *    fica o SHA-256.
 */
'use strict';

const config = require('../config');
const usuariosRepo = require('../repositories/usuarios.repo');
const sessoesRepo = require('../repositories/sessoes.repo');
const tokensRepo = require('../repositories/tokens.repo');
const auditoriaRepo = require('../repositories/auditoria.repo');
const atividadeService = require('./atividade.service');

const {
  gerarHashSenha,
  verificarSenha,
  verificarSenhaFicticia,
  gerarToken,
  hashToken,
  novoId
} = require('../utils/seguranca');
const { Conflito, NaoAutenticado, RegraNegocio, ErroValidacao } = require('../utils/erros');
const { agoraISO, daquiADias, daquiAMinutos } = require('../utils/datas');
const { exigirNome, exigirEmail, exigirSenha, normalizarEmail } = require('../utils/validacao');
const logger = require('../utils/logger');

/* -------------------------------------------------------------------------- */
/* Formatacao publica                                                         */
/* -------------------------------------------------------------------------- */

/** Dados do usuario que podem ir para o front (nunca hash/salt). */
function paraPublico(usuario) {
  if (!usuario) return null;
  return {
    id: usuario.id,
    nome: usuario.nome,
    email: usuario.email,
    papel: usuario.papel,
    criadoEm: usuario.criadoEm,
    ultimoLoginEm: usuario.ultimoLoginEm,
    preferencias: usuario.preferencias || {
      avisoLicenca: true,
      novidadesEmail: true,
      resumoCompras: true,
      tema: 'escuro'
    }
  };
}

/* -------------------------------------------------------------------------- */
/* Sessao                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Cria uma sessao e devolve o sid que vai no cookie.
 * @param {string} usuarioId
 * @param {boolean} persistente true = vale SESSAO_DIAS; false = expira em 24h
 */
function abrirSessao(usuarioId, { persistente = true, ip = null, userAgent = null } = {}) {
  const duracao = persistente ? config.sessao.duracaoMs : config.sessao.duracaoCurtaMs;
  const sid = gerarToken();

  sessoesRepo.criar({
    sid,
    usuarioId,
    expiraEm: new Date(Date.now() + duracao).toISOString(),
    persistente,
    ip,
    userAgent
  });

  return { sid, expiraEm: new Date(Date.now() + duracao).toISOString(), persistente };
}

function usuarioDaSessao(sid) {
  const sessao = sessoesRepo.buscar(sid);
  if (!sessao) return null;

  const usuario = usuariosRepo.buscarPorId(sessao.usuarioId);
  // Conta desativada ou removida: derruba a sessao na hora.
  if (!usuario || !usuario.ativo) {
    sessoesRepo.remover(sid);
    return null;
  }

  return { usuario, sessao };
}

function encerrarSessao(sid) {
  return sessoesRepo.remover(sid);
}

/** Encerra todas as sessoes do usuario (menos a atual, se informada). */
function encerrarTodas(usuarioId, { exceto = null } = {}) {
  return sessoesRepo.removerDoUsuario(usuarioId, { exceto });
}

/* -------------------------------------------------------------------------- */
/* Cadastro e login                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Cria uma conta e ja abre sessao.
 * @returns {{ usuario: object, sessao: object }}
 */
function registrar({ nome, email, senha, ip = null, userAgent = null }) {
  const nomeLimpo = exigirNome(nome, { min: config.regras.nomeMin, max: config.regras.nomeMax });
  const emailLimpo = exigirEmail(email, { max: config.regras.emailMax });
  const senhaLimpa = exigirSenha(senha, { min: config.regras.senhaMin, max: config.regras.senhaMax });

  if (usuariosRepo.buscarPorEmail(emailLimpo)) {
    throw new Conflito('E-mail ja cadastrado');
  }

  const { salt, hash } = gerarHashSenha(senhaLimpa);
  const papel = config.admin.emails.includes(emailLimpo) ? 'admin' : 'cliente';

  const usuario = usuariosRepo.criar({
    id: novoId(),
    nome: nomeLimpo,
    email: emailLimpo,
    senhaSalt: salt,
    senhaHash: hash,
    papel
  });

  const sessao = abrirSessao(usuario.id, { persistente: true, ip, userAgent });
  auditoriaRepo.registrar({ atorId: usuario.id, acao: 'usuario.registrado', entidade: 'usuario', entidadeId: usuario.id, ip });

  atividadeService.registrar(usuario.id, {
    tipo: 'cadastro',
    titulo: 'Conta criada',
    descricao: 'Bem-vindo à NEXUS.GG!',
    ip
  });

  return { usuario: paraPublico(usuario), sessao };
}

/**
 * Confere as credenciais e abre sessao.
 * @throws {NaoAutenticado} mensagem generica, sem dizer qual campo errou
 */
function autenticar({ email, senha, lembrar = true, ip = null, userAgent = null }) {
  const emailLimpo = normalizarEmail(email);
  const senhaTexto = typeof senha === 'string' ? senha : '';

  if (!emailLimpo || !senhaTexto) {
    throw new ErroValidacao('Informe e-mail e senha');
  }
  // Senha absurdamente longa: descarta antes de gastar CPU com scrypt.
  if (senhaTexto.length > config.regras.senhaMax) {
    throw new NaoAutenticado('E-mail ou senha invalidos');
  }

  const usuario = usuariosRepo.buscarPorEmail(emailLimpo);

  // Sem usuario, ainda assim gastamos o mesmo tempo de CPU de proposito.
  const confere = usuario ? verificarSenha(senhaTexto, usuario.senhaSalt, usuario.senhaHash) : verificarSenhaFicticia(senhaTexto);

  if (!usuario || !confere) {
    auditoriaRepo.registrar({ acao: 'login.falhou', entidade: 'usuario', entidadeId: usuario ? usuario.id : null, dados: { email: emailLimpo }, ip });
    throw new NaoAutenticado('E-mail ou senha invalidos');
  }

  if (!usuario.ativo) {
    throw new NaoAutenticado('Esta conta esta desativada. Fale com o suporte.');
  }

  usuariosRepo.registrarLogin(usuario.id);
  const sessao = abrirSessao(usuario.id, { persistente: lembrar !== false, ip, userAgent });
  auditoriaRepo.registrar({ atorId: usuario.id, acao: 'login.sucesso', entidade: 'usuario', entidadeId: usuario.id, ip });

  atividadeService.registrar(usuario.id, {
    tipo: 'login',
    titulo: 'Entrada na conta',
    descricao: 'Novo acesso realizado com sucesso.',
    ip
  });

  return { usuario: paraPublico(usuariosRepo.buscarPorId(usuario.id)), sessao };
}

/* -------------------------------------------------------------------------- */
/* Senhas                                                                     */
/* -------------------------------------------------------------------------- */

function trocarSenha(usuarioId, senhaAtual, novaSenha, { sidAtual = null, ip = null } = {}) {
  const usuario = usuariosRepo.buscarPorId(usuarioId);
  if (!usuario) throw new NaoAutenticado();

  if (!verificarSenha(String(senhaAtual || ''), usuario.senhaSalt, usuario.senhaHash)) {
    throw new ErroValidacao('A senha atual nao confere', { senhaAtual: 'Senha incorreta' });
  }

  const nova = exigirSenha(novaSenha, { min: config.regras.senhaMin, max: config.regras.senhaMax });
  if (nova === senhaAtual) {
    throw new RegraNegocio('A nova senha precisa ser diferente da atual');
  }

  const { salt, hash } = gerarHashSenha(nova);
  usuariosRepo.atualizarSenha(usuarioId, salt, hash);

  // Trocar a senha derruba os outros dispositivos, mas mantem o atual logado.
  const derrubadas = sessoesRepo.removerDoUsuario(usuarioId, { exceto: sidAtual });
  auditoriaRepo.registrar({ atorId: usuarioId, acao: 'senha.trocada', entidade: 'usuario', entidadeId: usuarioId, dados: { sessoesEncerradas: derrubadas }, ip });

  atividadeService.registrar(usuarioId, {
    tipo: 'senha_alterada',
    titulo: 'Senha alterada',
    descricao: derrubadas
      ? `Sua senha foi alterada e ${derrubadas} sessão(ões) em outros aparelhos foram encerradas.`
      : 'Sua senha foi alterada.',
    ip
  });

  return { sessoesEncerradas: derrubadas };
}

/**
 * Gera um token de recuperacao. O retorno traz o token em texto puro apenas
 * quando NAO estamos em producao (ou quando nao ha provedor de e-mail
 * configurado), para que o fluxo seja testavel sem servidor de e-mail.
 *
 * Em producao, ligue o envio por e-mail e remova o campo do retorno.
 */
function solicitarRecuperacao(email, { ip = null } = {}) {
  const emailLimpo = normalizarEmail(email);
  const usuario = usuariosRepo.buscarPorEmail(emailLimpo);

  // Resposta identica exista ou nao a conta: nao vaza quem tem cadastro.
  const resposta = {
    mensagem: 'Se este e-mail estiver cadastrado, enviaremos as instrucoes de recuperacao.'
  };

  if (!usuario || !usuario.ativo) {
    if (!config.producao) resposta.token = null;
    return resposta;
  }

  tokensRepo.invalidarDoUsuario(usuario.id);

  const token = gerarToken();
  const minutos = config.regras.tokenRecuperacaoMin;
  tokensRepo.criar({ tokenHash: hashToken(token), usuarioId: usuario.id, expiraEm: daquiAMinutos(minutos) });

  const link = `${config.loja.url}/login?token=${token}`;
  logger.info('Recuperacao de senha solicitada', { usuarioId: usuario.id, email: usuario.email });
  logger.info(`[dev] Link de recuperacao: ${link}`);

  auditoriaRepo.registrar({ atorId: usuario.id, acao: 'senha.recuperacao_solicitada', entidade: 'usuario', entidadeId: usuario.id, ip });

  if (!config.producao) {
    resposta.token = token;
    resposta.link = link;
    resposta.expiraEmMinutos = minutos;
  }

  return resposta;
}

/** Conclui a recuperacao: valida o token, troca a senha e derruba tudo. */
function redefinirSenha(token, novaSenha, { ip = null } = {}) {
  const tokenLimpo = String(token || '').trim();
  if (!tokenLimpo) throw new ErroValidacao('Token de recuperacao ausente', { token: 'Informe o token' });

  const registro = tokensRepo.buscar(hashToken(tokenLimpo));
  if (!registro) {
    throw new RegraNegocio('Link de recuperacao invalido ou expirado. Solicite um novo.');
  }

  const nova = exigirSenha(novaSenha, { min: config.regras.senhaMin, max: config.regras.senhaMax });
  const { salt, hash } = gerarHashSenha(nova);

  usuariosRepo.atualizarSenha(registro.usuarioId, salt, hash);
  tokensRepo.marcarUsado(registro.tokenHash);

  const derrubadas = sessoesRepo.removerDoUsuario(registro.usuarioId);
  auditoriaRepo.registrar({ atorId: registro.usuarioId, acao: 'senha.redefinida', entidade: 'usuario', entidadeId: registro.usuarioId, dados: { sessoesEncerradas: derrubadas }, ip });

  atividadeService.registrar(registro.usuarioId, {
    tipo: 'senha_recuperada',
    titulo: 'Senha recuperada',
    descricao: 'Sua senha foi redefinida pelo link de recuperação.',
    ip
  });

  return { mensagem: 'Senha redefinida com sucesso. Entre com a nova senha.', sessoesEncerradas: derrubadas };
}

/* -------------------------------------------------------------------------- */
/* Perfil                                                                     */
/* -------------------------------------------------------------------------- */

function atualizarPerfil(usuarioId, { nome, email }, { ip = null } = {}) {
  const usuario = usuariosRepo.buscarPorId(usuarioId);
  if (!usuario) throw new NaoAutenticado();

  // Guarda o que realmente mudou: vira a descricao da atividade e evita
  // registrar "perfil atualizado" quando o usuario salvou sem alterar nada.
  const mudancas = [];

  if (nome !== undefined) {
    const nomeLimpo = exigirNome(nome, { min: config.regras.nomeMin, max: config.regras.nomeMax });
    if (nomeLimpo !== usuario.nome) {
      usuariosRepo.atualizarNome(usuarioId, nomeLimpo);
      mudancas.push('nome');
    }
  }

  if (email !== undefined) {
    const emailLimpo = exigirEmail(email, { max: config.regras.emailMax });
    if (emailLimpo !== usuario.email) {
      if (usuariosRepo.buscarPorEmail(emailLimpo)) throw new Conflito('Este e-mail ja esta em uso');
      usuariosRepo.atualizarEmail(usuarioId, emailLimpo);
      mudancas.push('e-mail');
    }
  }

  if (mudancas.length) {
    auditoriaRepo.registrar({ atorId: usuarioId, acao: 'perfil.atualizado', entidade: 'usuario', entidadeId: usuarioId, dados: { mudancas }, ip });
    atividadeService.registrar(usuarioId, {
      tipo: 'perfil_atualizado',
      titulo: 'Perfil atualizado',
      descricao: `Alterou ${mudancas.join(' e ')}.`,
      ip
    });
  }

  return paraPublico(usuariosRepo.buscarPorId(usuarioId));
}

/** True quando o usuario logado e administrador. */
function ehAdmin(usuario) {
  return !!usuario && usuario.papel === 'admin';
}

module.exports = {
  paraPublico,
  abrirSessao,
  usuarioDaSessao,
  encerrarSessao,
  encerrarTodas,
  registrar,
  autenticar,
  trocarSenha,
  solicitarRecuperacao,
  redefinirSenha,
  atualizarPerfil,
  ehAdmin
};
