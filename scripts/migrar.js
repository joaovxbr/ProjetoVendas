/*
 * scripts/migrar.js
 * -----------------------------------------------------------------------------
 * Aplica as migracoes pendentes e sai. Uso:
 *
 *   npm run db:migrate
 */
'use strict';

const { conectar, fechar } = require('../src/db/conexao');
const { migrar, situacao } = require('../src/db/migracoes');
const config = require('../src/config');

function principal() {
  console.log(`Banco: ${config.banco.arquivo}\n`);

  conectar();
  const aplicadas = migrar();

  console.log(aplicadas > 0
    ? `${aplicadas} migracao(oes) aplicada(s).`
    : 'Nada a fazer: o banco ja esta atualizado.');

  console.log('\nHistorico:');
  for (const migracao of situacao()) {
    const marca = migracao.aplicada ? '[x]' : '[ ]';
    console.log(`  ${marca} ${String(migracao.id).padStart(3)}  ${migracao.nome}`);
  }

  fechar();
}

try {
  principal();
  process.exit(0);
} catch (erro) {
  console.error('Falha ao migrar:', erro.message);
  process.exit(1);
}
