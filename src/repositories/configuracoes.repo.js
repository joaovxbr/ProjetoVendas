/*
 * repositories/configuracoes.repo.js
 * -----------------------------------------------------------------------------
 * Ajustes da loja editaveis em tempo de execucao (pares chave/valor). E o que
 * permite ao admin mudar o aviso do topo ou ligar o modo manutencao sem
 * reiniciar a aplicacao nem mexer no .env.
 */
'use strict';

const { obter } = require('../db/conexao');
const { agoraISO } = require('../utils/datas');

/** Ajustes conhecidos e seus valores padrao. */
const PADROES = {
  aviso_topo: '',
  modo_manutencao: 'false',
  texto_manutencao: 'Estamos em manutencao. Voltamos em instantes.',
  destaque_home: '',
  suporte_email: 'suporte@nexus.gg',
  suporte_discord: ''
};

function mapear(linha) {
  if (!linha) return null;
  return { chave: linha.chave, valor: linha.valor, atualizadoEm: linha.atualizado_em };
}

function definir(chave, valor) {
  obter()
    .prepare(`
      INSERT INTO configuracoes (chave, valor, atualizado_em)
      VALUES (@chave, @valor, @atualizadoEm)
      ON CONFLICT (chave) DO UPDATE SET valor = excluded.valor, atualizado_em = excluded.atualizado_em
    `)
    .run({ chave, valor: String(valor), atualizadoEm: agoraISO() });
  return { chave, valor: String(valor) };
}

function obterValor(chave, padrao = null) {
  const linha = obter().prepare('SELECT valor FROM configuracoes WHERE chave = ?').get(chave);
  if (!linha) return padrao !== null ? padrao : PADROES[chave] ?? null;
  return linha.valor;
}

/** Todos os ajustes, com os padroes preenchidos para o que nunca foi salvo. */
function listarTodas() {
  const salvas = obter().prepare('SELECT * FROM configuracoes').all().map(mapear);
  const mapa = Object.fromEntries(salvas.map(item => [item.chave, item.valor]));
  return { ...PADROES, ...mapa };
}

function definirVarias(objeto) {
  const entradas = Object.entries(objeto || {});
  if (!entradas.length) return listarTodas();

  const db = obter();
  const comando = db.prepare(`
    INSERT INTO configuracoes (chave, valor, atualizado_em)
    VALUES (@chave, @valor, @atualizadoEm)
    ON CONFLICT (chave) DO UPDATE SET valor = excluded.valor, atualizado_em = excluded.atualizado_em
  `);

  db.transaction(() => {
    const agora = agoraISO();
    for (const [chave, valor] of entradas) {
      comando.run({ chave, valor: String(valor), atualizadoEm: agora });
    }
  })();

  return listarTodas();
}

module.exports = { PADROES, definir, obterValor, listarTodas, definirVarias };
