/*
 * scripts/reiniciar.js
 * -----------------------------------------------------------------------------
 * Apaga o banco e recria tudo do zero (schema + dados iniciais).
 *
 * ATENCAO: isso remove TODOS os pedidos, clientes e chaves. Pede confirmacao
 * explicita, porque nao ha como desfazer.
 *
 *   npm run db:reset        (pergunta antes)
 *   npm run db:reset -- --sim   (sem perguntar, para scripts)
 */
'use strict';

const fs = require('fs');
const readline = require('readline');
const config = require('../src/config');

const arquivo = config.banco.arquivo;

if (arquivo === ':memory:') {
  console.error('O banco esta configurado em memoria; nao ha arquivo para apagar.');
  process.exit(1);
}

// O modo WAL cria dois arquivos auxiliares que precisam sair junto.
const arquivos = [arquivo, `${arquivo}-wal`, `${arquivo}-shm`];

function apagarTudo() {
  let removidos = 0;
  for (const caminho of arquivos) {
    if (fs.existsSync(caminho)) {
      fs.rmSync(caminho);
      console.log(`  removido: ${caminho}`);
      removidos += 1;
    }
  }

  if (!removidos) console.log('  (nada para remover)');
}

function recriar() {
  // Import tardio: so faz sentido depois que os arquivos antigos sumiram.
  const { semear } = require('../src/db/semear');
  const { fechar } = require('../src/db/conexao');

  const resultado = semear();
  console.log('');
  console.log('Banco recriado:');
  console.log(`  Produtos .... ${resultado.produtos}`);
  console.log(`  Cupons ...... ${resultado.cupons}`);
  console.log(`  Usuarios .... ${resultado.usuarios}`);
  console.log(`  Pedidos ..... ${resultado.pedidos}`);
  fechar();
}

function perguntar() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question(
    `Isso vai APAGAR ${arquivo} e todos os dados. Continuar? (digite "sim") `,
    (resposta) => {
      rl.close();
      if (resposta.trim().toLowerCase() !== 'sim') {
        console.log('Cancelado. Nada foi alterado.');
        process.exit(0);
      }
      apagarTudo();
      recriar();
      console.log('');
      console.log('Contas: demo@loja.com / demo123  |  admin@loja.com / admin123');
      process.exit(0);
    }
  );
}

const semPerguntar = process.argv.includes('--sim');

if (semPerguntar) {
  console.log(`Apagando ${arquivo}...`);
  apagarTudo();
  recriar();
  process.exit(0);
} else {
  perguntar();
}
