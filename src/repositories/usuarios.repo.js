/*
 * repositories/usuarios.repo.js
 * -----------------------------------------------------------------------------
 * Acesso a tabela "usuarios". Nenhuma regra de negocio mora aqui: o repositorio
 * so sabe ler e escrever linhas e traduzir snake_case -> camelCase.
 */
'use strict';

const { obter } = require('../db/conexao');
const { agoraISO } = require('../utils/datas');

function mapear(linha) {
  if (!linha) return null;
  return {
    id: linha.id,
    nome: linha.nome,
    email: linha.email,
    senhaSalt: linha.senha_salt,
    senhaHash: linha.senha_hash,
    papel: linha.papel,
    ativo: linha.ativo === 1,
    criadoEm: linha.criado_em,
    atualizadoEm: linha.atualizado_em,
    ultimoLoginEm: linha.ultimo_login_em,
    // Preferencias da conta. Vem sempre preenchidas: as colunas tem DEFAULT.
    preferencias: {
      avisoLicenca: linha.pref_aviso_licenca === 1,
      novidadesEmail: linha.pref_novidades_email === 1,
      resumoCompras: linha.pref_resumo_compras === 1,
      tema: linha.pref_tema || 'escuro'
    }
  };
}

/** Insere um usuario e devolve o registro criado. */
function criar({ id, nome, email, senhaSalt, senhaHash, papel = 'cliente' }) {
  const agora = agoraISO();
  obter()
    .prepare(`
      INSERT INTO usuarios (id, nome, email, senha_salt, senha_hash, papel, ativo, criado_em, atualizado_em)
      VALUES (@id, @nome, @email, @senhaSalt, @senhaHash, @papel, 1, @criadoEm, @atualizadoEm)
    `)
    .run({ id, nome, email, senhaSalt, senhaHash, papel, criadoEm: agora, atualizadoEm: agora });

  return buscarPorId(id);
}

function buscarPorId(id) {
  if (!id) return null;
  return mapear(obter().prepare('SELECT * FROM usuarios WHERE id = ?').get(id));
}

function buscarPorEmail(email) {
  if (!email) return null;
  return mapear(obter().prepare('SELECT * FROM usuarios WHERE email = ?').get(String(email).toLowerCase()));
}

/** Substitui o hash da senha (troca de senha ou recuperacao). */
function atualizarSenha(id, senhaSalt, senhaHash) {
  const info = obter()
    .prepare('UPDATE usuarios SET senha_salt = ?, senha_hash = ?, atualizado_em = ? WHERE id = ?')
    .run(senhaSalt, senhaHash, agoraISO(), id);
  return info.changes > 0;
}

function atualizarNome(id, nome) {
  const info = obter()
    .prepare('UPDATE usuarios SET nome = ?, atualizado_em = ? WHERE id = ?')
    .run(nome, agoraISO(), id);
  return info.changes > 0;
}

function atualizarEmail(id, email) {
  const info = obter()
    .prepare('UPDATE usuarios SET email = ?, atualizado_em = ? WHERE id = ?')
    .run(String(email).toLowerCase(), agoraISO(), id);
  return info.changes > 0;
}

/** Marca o instante do ultimo login bem-sucedido. */
function registrarLogin(id) {
  obter().prepare('UPDATE usuarios SET ultimo_login_em = ? WHERE id = ?').run(agoraISO(), id);
}

/*
 * Preferencias: mapeia o nome amigavel (camelCase, usado no servico e no front)
 * para a coluna real. Um booleano vira 1/0; o tema vai como texto.
 */
const CAMPOS_PREFERENCIA = {
  avisoLicenca: 'pref_aviso_licenca',
  novidadesEmail: 'pref_novidades_email',
  resumoCompras: 'pref_resumo_compras',
  tema: 'pref_tema'
};

/**
 * Atualiza so as preferencias informadas (patch parcial).
 * Chave ausente = mantem o valor atual.
 */
function atualizarPreferencias(id, preferencias = {}) {
  const atribuicoes = [];
  const parametros = { id, atualizadoEm: agoraISO() };

  Object.keys(CAMPOS_PREFERENCIA).forEach(chave => {
    if (preferencias[chave] === undefined) return;
    atribuicoes.push(`${CAMPOS_PREFERENCIA[chave]} = @${chave}`);
    parametros[chave] = chave === 'tema' ? preferencias[chave] : (preferencias[chave] ? 1 : 0);
  });

  // Nada a mudar: devolve o registro como esta (evita um UPDATE inutil).
  if (!atribuicoes.length) return buscarPorId(id);

  obter()
    .prepare(`UPDATE usuarios SET ${atribuicoes.join(', ')}, atualizado_em = @atualizadoEm WHERE id = @id`)
    .run(parametros);

  return buscarPorId(id);
}

function definirPapel(id, papel) {
  const info = obter()
    .prepare('UPDATE usuarios SET papel = ?, atualizado_em = ? WHERE id = ?')
    .run(papel, agoraISO(), id);
  return info.changes > 0;
}

function definirAtivo(id, ativo) {
  const info = obter()
    .prepare('UPDATE usuarios SET ativo = ?, atualizado_em = ? WHERE id = ?')
    .run(ativo ? 1 : 0, agoraISO(), id);
  return info.changes > 0;
}

/** Lista paginada para o painel administrativo. */
function listar({ limite = 50, deslocamento = 0, busca = '' } = {}) {
  const termo = String(busca || '').trim().toLowerCase();
  const filtro = termo ? 'WHERE lower(nome) LIKE @termo OR email LIKE @termo' : '';
  return obter()
    .prepare(`
      SELECT * FROM usuarios
      ${filtro}
      ORDER BY criado_em DESC
      LIMIT @limite OFFSET @deslocamento
    `)
    .all({ termo: `%${termo}%`, limite, deslocamento })
    .map(mapear);
}

function contar({ busca = '' } = {}) {
  const termo = String(busca || '').trim().toLowerCase();
  const filtro = termo ? 'WHERE lower(nome) LIKE @termo OR email LIKE @termo' : '';
  const linha = obter().prepare(`SELECT COUNT(*) AS total FROM usuarios ${filtro}`).get({ termo: `%${termo}%` });
  return linha ? linha.total : 0;
}

/** Quantos usuarios existem por papel (usado nas metricas do admin). */
function contarPorPapel() {
  return obter()
    .prepare('SELECT papel, COUNT(*) AS total FROM usuarios GROUP BY papel')
    .all()
    .reduce((acumulado, linha) => ({ ...acumulado, [linha.papel]: linha.total }), {});
}

/** Clientes criados dentro de uma janela [desde, ate) — usado nos relatorios. */
function contarCriadosEntre(desde, ate) {
  const linha = obter()
    .prepare("SELECT COUNT(*) AS total FROM usuarios WHERE criado_em >= @desde AND criado_em < @ate")
    .get({ desde, ate });
  return linha ? linha.total : 0;
}

module.exports = {
  mapear,
  criar,
  buscarPorId,
  buscarPorEmail,
  atualizarSenha,
  atualizarNome,
  atualizarEmail,
  atualizarPreferencias,
  registrarLogin,
  definirPapel,
  definirAtivo,
  listar,
  contar,
  contarPorPapel,
  contarCriadosEntre
};
