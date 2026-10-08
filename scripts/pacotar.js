/*
 * scripts/pacotar.js
 * -----------------------------------------------------------------------------
 * Monta o pacote de deploy em `dist/deploy/` e, no Windows, fecha tudo em
 * `dist/nexus-gg-deploy.zip`.
 *
 * A montagem e por LISTA BRANCA: so entram os itens nomeados abaixo. Nada mais
 * e copiado, e nao existe regra de exclusao — exclusao e o que falha em
 * silencio quando alguem cria um arquivo novo. `.env`, `dados/`,
 * `node_modules/` e o `Projeto Vendas.zip` antigo (pacote contaminado que esta
 * na raiz) ficam de fora por construcao, nao por esquecimento.
 *
 * Cada item declara o caminho de origem e o de destino, sempre com a mesma
 * forma. Nao existe destino implicito: um item sem `para` cai no proprio nome
 * de origem, e foi exatamente essa omissao que achatou `src/` na raiz do
 * pacote numa versao anterior deste arquivo. Os dois caminhos ficam visiveis
 * lado a lado na lista, e `conferirEstrutura` falha se algum deles nao bater.
 *
 * O que entra:
 *   server.js                    ponto de entrada
 *   src/                         backend (rotas, servicos, repositorios)
 *   scripts/migrar.js            util no servidor para aplicar migracao
 *   scripts/semear.js              pendente sem derrubar a loja
 *   scripts/reiniciar.js
 *   dist/public/                 front ja minificado, com hash no nome
 *   package.json                 sem devDependencies nem scripts de maquina
 *   package-lock.json            para o `npm ci` instalar exatamente estas versoes
 *   .env.example                 modelo de configuracao
 *   INSTRUCOES.txt               o que fazer com o pacote
 *
 * O front vai para `dist/public/` e NAO para `public/`: e o mesmo caminho que o
 * servidor procura quando NODE_ENV=production (ver src/app.js). Manter o
 * contrato tem uma vantagem: a propria existencia do diretorio prova que o
 * build rodou, e e isso que permite o aviso do boot dizer a verdade. Achatar
 * para `public/` deixaria o servidor sem como distinguir "buildado" de
 * "esqueci de buildar".
 *
 * `build.js` e `pacotar.js` NAO entram: so rodam na maquina de desenvolvimento,
 * e o esbuild nem esta instalado no servidor.
 *
 * Uso:
 *   node scripts/pacotar.js
 * A saida e sempre `dist/`, porque e ali que o build ja escreveu.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { build } = require('./build');

const RAIZ = path.resolve(__dirname, '..');
const SAIDA = path.join(RAIZ, 'dist');
const PASTA_DEPLOY = path.join(SAIDA, 'deploy');
const NOME_ZIP = 'nexus-gg-deploy.zip';

/* Scripts que fazem sentido no servidor. */
const SCRIPTS_DE_BANCO = ['migrar.js', 'semear.js', 'reiniciar.js'];

/*
 * Lista branca. `de` e lido da raiz do projeto; `para` e onde vai dentro do
 * pacote. Os dois sao sempre escritos na mao, para o destino ficar legivel ao
 * lado da origem.
 */
const CONTEUDO = [
  { de: 'server.js', para: 'server.js', arquivo: true },
  { de: 'src', para: 'src', arquivo: false },
  ...SCRIPTS_DE_BANCO.map((nome) => ({
    de: path.join('scripts', nome),
    para: path.join('scripts', nome),
    arquivo: true
  })),
  { de: path.join('dist', 'public'), para: path.join('dist', 'public'), arquivo: false },
  { de: 'package.json', para: 'package.json', arquivo: true, transformar: prepararPackageJson },
  { de: 'package-lock.json', para: 'package-lock.json', arquivo: true },
  { de: '.env.example', para: '.env.example', arquivo: true },
  { de: 'INSTRUCOES.txt', para: 'INSTRUCOES.txt', arquivo: true, conteudo: instrucoes }
];

const INSTRUCOES = `NEXUS.GG - pacote de deploy
==============================================================================

O QUE E ISTO
  O servidor pronto para subir: backend em src/, front ja minificado e com
  hash de conteudo no nome, e a lista exata de dependencias que ele usa.

O QUE FALTA (de proposito)
  O arquivo .env NAO vem aqui: ele tem o segredo da sessao e as credenciais de
  pagamento. Copie o .env.example, preencha e sobe. Ele nunca deve ser
  versionado nem travels num pacote.

ESTRUTURA
  server.js         ponto de entrada
  src/              backend
  scripts/          migrar, semear, reiniciar (o build nao vem: ja rodou)
  dist/public/      front compilado — e daqui que o servidor serve em producao
  package.json      sem devDependencies

PASSO A PASSO NO SERVIDOR
  1. Envie o pacote e descompacte.
  2. Copie o .env.example para .env e preencha. O minimo para subir:
       SEGREDO_APP   = openssl rand -hex 32
       LOJA_URL      = https://seu-dominio.com
       NODE_ENV      = production
  3. Instale APENAS o que roda em producao:
       npm ci --omit=dev
  4. Suba:
       npm start

  Confira o boot. Deve aparecer:
       Front servido do build (dist/public): minificado e com cache longo
  Se aparecer "[front] Producao sem dist/public", o pacote veio sem o build: o
  front esta sem minificar e sem cache longo.

  Um proxy com TLS na frente (Nginx, Caddy) e obrigatorio: o cookie de sessao
  viaja em claro em http, e o painel administrativo nao deve responder fora
  de https.

DEPOIS DE CADA MUDANCA NO FRONT
  O front deste pacote ja vem compilado. Para publicar alteracao de tela, rode
  o build na sua maquina e envie o pacote inteiro de novo:

       npm install
       npm run build
       npm run pack

  O backend (src/) e o banco nao precisam de build: e codigo puro, copiado
  como esta.

COMO DESFAZER UM DEPLOY
  Extraia a versao anterior por cima e reinicie. O banco (dados/) nunca e
  tocado pelo deploy, e as migracoes rodam sozinhas no boot — sao aditivas e
  nao apagam dado.
`;

/**
 * Remove do `package.json` o que so serve na maquina de desenvolvimento.
 *
 * O pacote vai para o servidor com `npm ci --omit=dev`, entao as devDependencies
 * ja nem chegam a ser instaladas. O que sobra sao os scripts de build e teste,
 * que ali nao tem utilidade e, se alguem rodar por engano, quebraria por
 * ausencia do esbuild.
 *
 * @param {string} fonte Conteudo do package.json original.
 * @returns {string} package.json enxuto.
 */
function prepararPackageJson(fonte) {
  const pkg = JSON.parse(fonte);
  delete pkg.devDependencies;

  for (const nome of ['build', 'pack', 'dev', 'test']) delete pkg.scripts[nome];

  return `${JSON.stringify(pkg, null, 2)}\n`;
}

/**
 * @returns {string} Texto das instrucoes que acompanham o pacote.
 */
function instrucoes() {
  return INSTRUCOES;
}

/**
 * Copia uma pasta inteira, recriando a arvore.
 *
 * @param {string} de Pasta de origem.
 * @param {string} para Pasta de destino.
 * @returns {number} Quantidade de arquivos escritos.
 */
function copiarPasta(de, para) {
  fs.mkdirSync(para, { recursive: true });
  let total = 0;
  for (const entrada of fs.readdirSync(de, { withFileTypes: true })) {
    const origem = path.join(de, entrada.name);
    const destino = path.join(para, entrada.name);
    if (entrada.isDirectory()) total += copiarPasta(origem, destino);
    else { fs.copyFileSync(origem, destino); total += 1; }
  }
  return total;
}

/**
 * Copia um item da lista branca.
 *
 * @param {{de: string, para: string, arquivo: boolean, transformar?: Function, conteudo?: Function}} item
 * @param {string} pastaDestino
 * @returns {number} Quantidade de arquivos escritos.
 */
function copiarItem(item, pastaDestino) {
  /* Arquivo com `conteudo` e GERADO aqui (as instrucoes). Os demais sao lidos do
     projeto, e um deles faltando e erro de verdade: o pacote subiria quebrado. */
  if (item.arquivo && !item.conteudo && !fs.existsSync(path.join(RAIZ, item.de))) {
    throw new Error(`Item obrigatorio ausente: ${item.de}`);
  }

  const destino = path.join(pastaDestino, item.para);

  if (item.arquivo) {
    fs.mkdirSync(path.dirname(destino), { recursive: true });
    const conteudo = item.conteudo ? item.conteudo() : fs.readFileSync(path.join(RAIZ, item.de), 'utf8');
    fs.writeFileSync(destino, item.transformar ? item.transformar(conteudo) : conteudo, 'utf8');
    return 1;
  }

  return copiarPasta(path.join(RAIZ, item.de), destino);
}

/**
 * Confere que nenhum segredo entrou no pacote.
 *
 * A lista branca ja garante isso, mas a checagem e o que impede que uma lista
 * branca editada no futuro vaze credencial num pacote pronto pra subir. Falha
 * alto: um pacote com `.env` dentro e um acidente que so se descobre tarde.
 *
 * O nome e comparado inteiro, sem `extname`: `path.extname('.env.example')`
 * devolve `.example`, e cortar a extensao transformaria o proprio modelo de
 * configuracao em falso positivo. A comparacao literal tambem barra
 * `.env.producao`, que carrega tanto segredo quanto `.env`.
 *
 * @param {string} pasta
 * @throws {Error} Se algum item proibido aparecer.
 */
function conferir(pasta) {
  const proibidos = new Set(['node_modules', 'dados', 'Projeto Vendas.zip']);

  for (const entrada of fs.readdirSync(pasta, { withFileTypes: true })) {
    const caminho = path.join(pasta, entrada.name);
    if (entrada.isDirectory()) { conferir(caminho); continue; }
    if (entrada.name === '.env' || proibidos.has(entrada.name)) {
      throw new Error(`Item proibido no pacote: ${path.relative(pasta, caminho)}`);
    }
  }
}

/**
 * Confere que cada item caiu onde a lista branca dizia.
 *
 * A lista branca diz o QUE entra; esta funcao diz o ONDE. Sem ela, um `para`
 * digitado errado produz um pacote que parece pronto e so quebra no servidor,
 * na hora do `npm start`.
 *
 * @param {string} pasta
 * @throws {Error} Se um item nao existir ou for do tipo errado.
 */
function conferirEstrutura(pasta) {
  for (const item of CONTEUDO) {
    const destino = path.join(pasta, item.para);
    const tipo = item.arquivo ? 'arquivo' : 'pasta';
    const existe = fs.existsSync(destino);
    const doTipoCerto = existe &&
      (item.arquivo ? fs.statSync(destino).isFile() : fs.statSync(destino).isDirectory());

    if (!doTipoCerto) {
      throw new Error(`Estrutura errada: "${item.de}" deveria estar em "${destino}" como ${tipo}.`);
    }
  }
}

/**
 * Fecha a pasta de deploy num .zip.
 *
 * @param {string} pasta
 * @returns {string|null} Caminho do zip, ou null se nao deu para compactar.
 */
function compactar(pasta) {
  const destino = path.join(SAIDA, NOME_ZIP);
  fs.rmSync(destino, { force: true });

  if (process.platform !== 'win32') {
    console.log(`  .zip nao gerado (so no Windows). A pasta ${path.relative(RAIZ, pasta)}/ esta pronta.`);
    return null;
  }

  try {
    /* Compress-Archive com caminho de pasta, e nao com wildcard: o wildcard
       inclui a propria pasta `deploy` na raiz do zip e o servidor receberia um
       nivel de pasta a mais para desembrulhar. */
    execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command',
        `Compress-Archive -Path '${pasta}\\*' -DestinationPath '${destino}' -Force`],
      { stdio: 'inherit' }
    );
    return destino;
  } catch (erro) {
    console.log(`  .zip nao gerado: ${erro.message}. A pasta ${path.relative(RAIZ, pasta)}/ esta pronta.`);
    return null;
  }
}

/**
 * Roda o build e monta o pacote de deploy.
 *
 * @returns {{paginas: number, arquivos: number, zip: string|null}} Resumo.
 */
function empacotar() {
  const resumo = build(SAIDA);
  console.log(`  build: ${resumo.paginas} paginas, ${resumo.arquivos} arquivos em dist/public/assets`);

  fs.rmSync(PASTA_DEPLOY, { recursive: true, force: true });
  fs.mkdirSync(PASTA_DEPLOY, { recursive: true });

  const arquivos = CONTEUDO.reduce((total, item) => total + copiarItem(item, PASTA_DEPLOY), 0);
  conferirEstrutura(PASTA_DEPLOY);
  conferir(PASTA_DEPLOY);

  return { paginas: resumo.paginas, arquivos, zip: compactar(PASTA_DEPLOY) };
}

module.exports = { empacotar, conferir, conferirEstrutura, prepararPackageJson, CONTEUDO };

if (require.main === module) {
  try {
    const { arquivos, zip } = empacotar();
    console.log(`Pacote pronto em dist/deploy/ (${arquivos} arquivos)`);
    if (zip) console.log(`  ${NOME_ZIP}`);
    console.log('  .env, dados/ e node_modules/ nao entram: preencha o .env no servidor.');
  } catch (erro) {
    console.error(`Falha ao empacotar: ${erro.message}`);
    process.exitCode = 1;
  }
}
