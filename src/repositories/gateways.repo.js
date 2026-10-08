/*
 * repositories/gateways.repo.js
 * -----------------------------------------------------------------------------
 * Acesso a tabela `gateways`. Fala SO com o banco: nao decide se um gateway
 * pode ou nao ser ligado, nao cifra nem decifra credenciais — isso e papel do
 * servico. Aqui so entra e sai dado.
 *
 * As credenciais trafegam como TEXTO CIFRADO. Este repositorio nunca ve o JSON
 * em claro, o que reduz o risco de alguem logar um segredo por acidente.
 */
'use strict';

const { obter } = require('../db/conexao');
const { agoraISO } = require('../utils/datas');

function mapear(linha) {
  if (!linha) return null;
  let metodos = [];
  try {
    const bruto = JSON.parse(linha.metodos || '[]');
    metodos = Array.isArray(bruto) ? bruto.map(String) : [];
  } catch {
    metodos = [];
  }

  return {
    id: linha.id,
    ativo: !!linha.ativo,
    modo: linha.modo,
    metodos,
    credenciaisCifradas: linha.credenciais || '',
    prioridade: linha.prioridade,
    atualizadoEm: linha.atualizado_em
  };
}

/** Todas as linhas, na ordem de prioridade (maior primeiro). */
function listar() {
  return obter()
    .prepare('SELECT * FROM gateways ORDER BY prioridade DESC, id ASC')
    .all()
    .map(mapear);
}

/** Uma linha pelo id (ou null). */
function buscar(id) {
  return mapear(obter().prepare('SELECT * FROM gateways WHERE id = ?').get(String(id)));
}

/**
 * Cria a linha se ela ainda nao existir (idempotente).
 * Usado no seed/boot para garantir que todo gateway do catalogo tenha registro.
 */
function garantir(id, { ativo = false, modo = 'sandbox', metodos = [], prioridade = 0 } = {}) {
  obter()
    .prepare(`
      INSERT INTO gateways (id, ativo, modo, metodos, credenciais, prioridade, atualizado_em)
      VALUES (@id, @ativo, @modo, @metodos, '', @prioridade, @agora)
      ON CONFLICT (id) DO NOTHING
    `)
    .run({
      id: String(id),
      ativo: ativo ? 1 : 0,
      modo,
      metodos: JSON.stringify(Array.isArray(metodos) ? metodos : []),
      prioridade,
      agora: agoraISO()
    });
  return buscar(id);
}

/** Atualiza campos de configuracao (nunca as credenciais — ver definirCredenciais). */
function atualizar(id, campos = {}) {
  const atual = buscar(id);
  if (!atual) return null;

  const proximo = {
    ativo: campos.ativo === undefined ? atual.ativo : !!campos.ativo,
    modo: campos.modo === undefined ? atual.modo : campos.modo,
    metodos: campos.metodos === undefined ? atual.metodos : campos.metodos,
    prioridade: campos.prioridade === undefined ? atual.prioridade : campos.prioridade
  };

  obter()
    .prepare(`
      UPDATE gateways
      SET ativo = @ativo, modo = @modo, metodos = @metodos, prioridade = @prioridade, atualizado_em = @agora
      WHERE id = @id
    `)
    .run({
      id: String(id),
      ativo: proximo.ativo ? 1 : 0,
      modo: proximo.modo,
      metodos: JSON.stringify(proximo.metodos || []),
      prioridade: proximo.prioridade,
      agora: agoraISO()
    });

  return buscar(id);
}

/** Grava o texto CIFRADO das credenciais. Texto vazio limpa. */
function definirCredenciais(id, textoCifrado) {
  obter()
    .prepare('UPDATE gateways SET credenciais = @credenciais, atualizado_em = @agora WHERE id = @id')
    .run({ id: String(id), credenciais: String(textoCifrado || ''), agora: agoraISO() });
  return buscar(id);
}

/** Quantos gateways estao ligados (usado no diagnostico). */
function contarAtivos() {
  const linha = obter().prepare('SELECT COUNT(*) AS total FROM gateways WHERE ativo = 1').get();
  return linha ? linha.total : 0;
}

module.exports = { mapear, listar, buscar, garantir, atualizar, definirCredenciais, contarAtivos };
