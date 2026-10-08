/*
 * scripts/semear.js
 * -----------------------------------------------------------------------------
 * Popula o banco com catalogo, cupons e contas de demonstracao. Pode rodar
 * quantas vezes quiser: nada e duplicado.
 *
 *   npm run db:seed
 */
'use strict';

const { semear } = require('../src/db/semear');
const { fechar } = require('../src/db/conexao');
const config = require('../src/config');

function principal() {
  console.log(`Banco: ${config.banco.arquivo}\n`);

  const resultado = semear();

  console.log('Semeadura concluida:');
  console.log(`  Produtos criados .... ${resultado.produtos}`);
  console.log(`  Cupons criados ...... ${resultado.cupons}`);
  console.log(`  Usuarios criados .... ${resultado.usuarios}`);
  console.log(`  Avaliacoes criadas .. ${resultado.avaliacoes}`);
  console.log(`  Pedidos de exemplo .. ${resultado.pedidos}`);
  console.log('');
  console.log('Contas de demonstracao:');
  console.log('  demo@loja.com  / demo123   (cliente)');
  console.log('  admin@loja.com / admin123  (administrador)');

  fechar();
}

try {
  principal();
  process.exit(0);
} catch (erro) {
  console.error('Falha ao semear:', erro.message);
  process.exit(1);
}
