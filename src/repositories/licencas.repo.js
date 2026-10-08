/*
 * repositories/licencas.repo.js
 * -----------------------------------------------------------------------------
 * Licencas entregues apos a compra. Cada unidade comprada gera UMA licenca com
 * uma chave unica. O status segue o ciclo: ativa -> resgatada (usada pelo
 * cliente) ou revogada (estorno/abuso, pelo admin).
 */
'use strict';

const { obter } = require('../db/conexao');

function mapear(linha) {
  if (!linha) return null;
  return {
    id: linha.id,
    chave: linha.chave,
    vendaId: linha.venda_id,
    vendaItemId: linha.venda_item_id,
    usuarioId: linha.usuario_id,
    produtoId: linha.produto_id,
    planoId: linha.plano_id,
    status: linha.status,
    expiraEm: linha.expira_em,
    resgatadaEm: linha.resgatada_em,
    criadaEm: linha.criada_em
  };
}

function inserir(licenca) {
  obter()
    .prepare(`
      INSERT INTO licencas (
        id, chave, venda_id, venda_item_id, usuario_id, produto_id, plano_id,
        status, expira_em, resgatada_em, criada_em
      ) VALUES (
        @id, @chave, @vendaId, @vendaItemId, @usuarioId, @produtoId, @planoId,
        @status, @expiraEm, NULL, @criadaEm
      )
    `)
    .run({
      id: licenca.id,
      chave: licenca.chave,
      vendaId: licenca.vendaId,
      vendaItemId: licenca.vendaItemId,
      usuarioId: licenca.usuarioId,
      produtoId: licenca.produtoId,
      planoId: licenca.planoId,
      status: licenca.status || 'ativa',
      expiraEm: licenca.expiraEm ?? null,
      criadaEm: licenca.criadaEm
    });
  return licenca.id;
}

function buscarPorId(id) {
  if (!id) return null;
  return mapear(obter().prepare('SELECT * FROM licencas WHERE id = ?').get(id));
}

function buscarPorChave(chave) {
  if (!chave) return null;
  return mapear(obter().prepare('SELECT * FROM licencas WHERE chave = ?').get(String(chave).toUpperCase()));
}

function listarDoUsuario(usuarioId, { produtoId = null, status = null } = {}) {
  const condicoes = ['usuario_id = @usuarioId'];
  const parametros = { usuarioId };

  if (produtoId) {
    condicoes.push('produto_id = @produtoId');
    parametros.produtoId = produtoId;
  }
  if (status) {
    condicoes.push('status = @status');
    parametros.status = status;
  }

  return obter()
    .prepare(`SELECT * FROM licencas WHERE ${condicoes.join(' AND ')} ORDER BY criada_em DESC`)
    .all(parametros)
    .map(mapear);
}

function listarDaVenda(vendaId) {
  return obter().prepare('SELECT * FROM licencas WHERE venda_id = ? ORDER BY rowid ASC').all(vendaId).map(mapear);
}

/** Marca a licenca como usada pelo cliente. */
function resgatar(id) {
  const info = obter()
    .prepare(`
      UPDATE licencas
      SET status = 'resgatada', resgatada_em = ?
      WHERE id = ? AND status = 'ativa'
    `)
    .run(new Date().toISOString(), id);
  return info.changes > 0;
}

function revogar(id) {
  const info = obter()
    .prepare("UPDATE licencas SET status = 'revogada' WHERE id = ? AND status <> 'revogada'")
    .run(id);
  return info.changes > 0;
}

/** Revoga todas as licencas de um pedido (usado em estorno). */
function revogarDaVenda(vendaId) {
  return obter().prepare("UPDATE licencas SET status = 'revogada' WHERE venda_id = ?").run(vendaId).changes;
}

/** Uma licenca ativa (nao expirada) do usuario para o produto? */
function possuiAtiva(usuarioId, produtoId) {
  const linha = obter()
    .prepare(`
      SELECT COUNT(*) AS total
      FROM licencas
      WHERE usuario_id = @usuarioId
        AND produto_id = @produtoId
        AND status IN ('ativa', 'resgatada')
        AND (expira_em IS NULL OR expira_em > @agora)
    `)
    .get({ usuarioId, produtoId, agora: new Date().toISOString() });
  return (linha ? linha.total : 0) > 0;
}

function contarPorStatus() {
  return obter()
    .prepare('SELECT status, COUNT(*) AS total FROM licencas GROUP BY status')
    .all()
    .reduce((acumulado, linha) => ({ ...acumulado, [linha.status]: linha.total }), {});
}

function listarTodas({ limite = 50, deslocamento = 0 } = {}) {
  return obter()
    .prepare(`
      SELECT l.*, u.email AS usuario_email, p.nome AS produto_nome
      FROM licencas l
      JOIN usuarios u ON u.id = l.usuario_id
      JOIN produtos p ON p.id = l.produto_id
      ORDER BY l.criada_em DESC
      LIMIT @limite OFFSET @deslocamento
    `)
    .all({ limite, deslocamento })
    .map(linha => ({
      ...mapear(linha),
      usuarioEmail: linha.usuario_email,
      produtoNome: linha.produto_nome
    }));
}

module.exports = {
  mapear,
  inserir,
  buscarPorId,
  buscarPorChave,
  listarDoUsuario,
  listarDaVenda,
  resgatar,
  revogar,
  revogarDaVenda,
  possuiAtiva,
  contarPorStatus,
  listarTodas
};
