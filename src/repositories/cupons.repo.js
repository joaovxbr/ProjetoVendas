/*
 * repositories/cupons.repo.js
 * -----------------------------------------------------------------------------
 * Cupons de desconto. O codigo e sempre guardado em MAIUSCULAS para que
 * "bemvindo10" e "BEMVINDO10" sejam o mesmo cupom.
 */
'use strict';

const { obter } = require('../db/conexao');
const { agoraISO } = require('../utils/datas');

function mapear(linha) {
  if (!linha) return null;
  return {
    codigo: linha.codigo,
    tipo: linha.tipo,
    valor: linha.valor,
    minimoCentavos: linha.minimo_centavos,
    maxUsos: linha.max_usos,
    usos: linha.usos,
    expiraEm: linha.expira_em,
    ativo: linha.ativo === 1,
    descricao: linha.descricao,
    criadoEm: linha.criado_em
  };
}

function criar(cupom) {
  obter()
    .prepare(`
      INSERT INTO cupons (codigo, tipo, valor, minimo_centavos, max_usos, usos, expira_em, ativo, descricao, criado_em)
      VALUES (@codigo, @tipo, @valor, @minimoCentavos, @maxUsos, 0, @expiraEm, @ativo, @descricao, @criadoEm)
    `)
    .run({
      codigo: String(cupom.codigo).toUpperCase(),
      tipo: cupom.tipo,
      valor: cupom.valor,
      minimoCentavos: cupom.minimoCentavos ?? 0,
      maxUsos: cupom.maxUsos ?? null,
      expiraEm: cupom.expiraEm ?? null,
      ativo: cupom.ativo === false ? 0 : 1,
      descricao: cupom.descricao || '',
      criadoEm: agoraISO()
    });
  return buscar(cupom.codigo);
}

function buscar(codigo) {
  if (!codigo) return null;
  return mapear(obter().prepare('SELECT * FROM cupons WHERE codigo = ?').get(String(codigo).toUpperCase()));
}

function listar({ incluirInativos = true } = {}) {
  const filtro = incluirInativos ? '' : 'WHERE ativo = 1';
  return obter().prepare(`SELECT * FROM cupons ${filtro} ORDER BY criado_em DESC`).all().map(mapear);
}

/** Consome um uso. O WHERE com max_usos impede corrida entre requisicoes. */
function registrarUso(codigo) {
  const info = obter()
    .prepare(`
      UPDATE cupons
      SET usos = usos + 1
      WHERE codigo = @codigo
        AND ativo = 1
        AND (max_usos IS NULL OR usos < max_usos)
    `)
    .run({ codigo: String(codigo).toUpperCase() });
  return info.changes > 0;
}

function atualizar(codigo, alteracoes) {
  const sets = [];
  const parametros = { codigo: String(codigo).toUpperCase() };

  if (alteracoes.ativo !== undefined) {
    sets.push('ativo = @ativo');
    parametros.ativo = alteracoes.ativo ? 1 : 0;
  }
  if (alteracoes.maxUsos !== undefined) {
    sets.push('max_usos = @maxUsos');
    parametros.maxUsos = alteracoes.maxUsos;
  }
  if (alteracoes.expiraEm !== undefined) {
    sets.push('expira_em = @expiraEm');
    parametros.expiraEm = alteracoes.expiraEm;
  }
  if (alteracoes.minimoCentavos !== undefined) {
    sets.push('minimo_centavos = @minimoCentavos');
    parametros.minimoCentavos = alteracoes.minimoCentavos;
  }
  if (alteracoes.valor !== undefined) {
    sets.push('valor = @valor');
    parametros.valor = alteracoes.valor;
  }
  if (alteracoes.descricao !== undefined) {
    sets.push('descricao = @descricao');
    parametros.descricao = alteracoes.descricao;
  }

  if (!sets.length) return buscar(codigo);
  obter().prepare(`UPDATE cupons SET ${sets.join(', ')} WHERE codigo = @codigo`).run(parametros);
  return buscar(codigo);
}

function remover(codigo) {
  return obter().prepare('DELETE FROM cupons WHERE codigo = ?').run(String(codigo).toUpperCase()).changes > 0;
}

module.exports = { mapear, criar, buscar, listar, registrarUso, atualizar, remover };
