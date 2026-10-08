/*
 * testes/build.test.js
 * -----------------------------------------------------------------------------
 * O build do front e a politica de cache que ele viabiliza.
 *
 * Sao tres coisas que precisam ser verdade ao mesmo tempo, e cada teste aqui
 * cobre uma delas:
 *
 *   1. O build produz arquivos MINIFICADOS e com hash no nome.
 *   2. O HTML gerado aponta SO para arquivos que existem de fato.
 *   3. A politica de cache so libera `immutable` para quem tem hash — e o que
 *      torna o cache longo seguro.
 *
 * O build roda em pasta temporaria (o parametro que `scripts/build.js` aceita
 * existe para isso), entao a suite nunca toca no `dist/` de verdade.
 */
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { build, listarRecursos, prefixoComum, nomeComHash } = require('../scripts/build');
const { cabecalhoCache, UM_ANO_SEGUNDOS } = require('../src/utils/cache');

const RAIZ = path.resolve(__dirname, '..');

let temporaria;
let saida;

before(() => {
  temporaria = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-build-'));
  saida = path.join(temporaria, 'dist');
  build(saida);
});

after(() => {
  fs.rmSync(temporaria, { recursive: true, force: true });
});

/** Le o HTML gerado de uma pagina. */
const htmlDe = (pagina) => fs.readFileSync(path.join(saida, 'public', pagina), 'utf8');

/** Nomes dos arquivos em `dist/public/assets/`. */
const assetsGerados = () => fs.readdirSync(path.join(saida, 'public', 'assets'));

/* -------------------------------------------------------------------------- */
/* Politica de cache                                                          */
/* -------------------------------------------------------------------------- */

test('arquivo com hash de conteudo no nome recebe cache longo', () => {
  assert.equal(cabecalhoCache('comum.9f3a2b1c.js'), `immutable, max-age=${UM_ANO_SEGUNDOS}`);
  assert.equal(cabecalhoCache('pagina.9f3a2b1c.css'), `immutable, max-age=${UM_ANO_SEGUNDOS}`);
  assert.equal(cabecalhoCache('fonte.a1b2c3d4.woff2'), `immutable, max-age=${UM_ANO_SEGUNDOS}`);
});

test('recebe caminho inteiro, nao so o nome do arquivo', () => {
  // O `setHeaders` do express.static entrega o caminho completo do disco.
  const caminho = path.join('C:', 'projeto', 'dist', 'public', 'assets', 'comum.9f3a2b1c.js');
  assert.equal(cabecalhoCache(caminho), `immutable, max-age=${UM_ANO_SEGUNDOS}`);
});

test('tudo que nao tem hash revalida', () => {
  // Sem hash, um max-age longo seria uma promessa nao cumprida: e o defeito
  // exato que ja prendeu JavaScript velho no navegador por 24h.
  for (const nome of ['index.html', 'api.js', 'base.css', 'favicon.svg', 'manifest.json']) {
    assert.equal(cabecalhoCache(nome), 'no-cache', `${nome} deveria revalidar`);
  }
});

test('entrada invalida revalida em vez de derrubar o servidor', () => {
  for (const invalido of [undefined, null, '', 0, {}]) {
    assert.equal(cabecalhoCache(invalido), 'no-cache');
  }
});

test('so as extensoes conhecidas aceitam cache longo', () => {
  // Um `.zip.9f3a2b1c.html` tem hash no nome, mas nao e asset versionado pelo
  // build: o cache longo so vale para o que ele renomeia.
  assert.equal(cabecalhoCache('coisas.9f3a2b1c.json'), 'no-cache');
  assert.equal(cabecalhoCache('coisas.9f3a2b1c.html'), 'no-cache');
});

/* -------------------------------------------------------------------------- */
/* O build                                                                    */
/* -------------------------------------------------------------------------- */

test('o build gera assets e todos com hash no nome', () => {
  const arquivos = assetsGerados();
  assert.ok(arquivos.length > 0, 'o build deveria gerar assets');

  for (const nome of arquivos) {
    assert.match(nome, /^(comum|pagina)\.[0-9a-f]{8}\.(js|css)$/, `${nome} deveria ter hash no nome`);
    assert.ok(
      fs.existsSync(path.join(saida, 'public', 'assets', nome)),
      `${nome} foi listado mas nao existe no disco`
    );
  }
});

test('todo script e stylesheet do HTML gerado aponta para arquivo que existe', () => {
  /*
   * Este e o teste que pega o build quebrado de verdade. Um erro de reescrita
   * nao derruba o build: ele produz um HTML que abre sem estilo e sem script,
   * e o problema so apareceria no navegador, em producao.
   *
   * Sao checadas as TAGs `<script src>` e `<link rel="stylesheet" href>` — as
   * mesmas que o build reescreve. Ficam de fora: link de navegacao (`/login`),
   * que e rota e nao arquivo, e recurso externo (a fonte do Google), que o
   * build nunca toca.
   */
  const paginas = fs.readdirSync(path.join(RAIZ, 'public')).filter((n) => n.endsWith('.html'));
  const ehLocal = (url) => url.startsWith('/') && !/^\/[/]/.test(url);

  for (const pagina of paginas) {
    const html = htmlDe(pagina);
    const tags = [...html.matchAll(/<(?:script|link)\b[^>]*>/gi)].map((m) => m[0]);
    const recursos = tags.filter((tag) =>
      /<script\b/i.test(tag) || /rel\s*=\s*"[^"]*\bstylesheet\b/i.test(tag));

    assert.ok(recursos.length > 0, `${pagina} nao referencia nenhum recurso local`);

    for (const tag of recursos) {
      const url = (tag.match(/(?:src|href)\s*=\s*"([^"]+)"/i) || [])[1];
      assert.ok(url, `tag sem atributo em ${pagina}: ${tag}`);
      if (!ehLocal(url)) continue;

      const destino = path.join(saida, 'public', decodeURIComponent(url));
      assert.ok(fs.existsSync(destino), `${pagina} aponta para ${url}, que nao existe no dist`);
    }
  }
});

test('o HTML nao repete o mesmo script em varias tags', () => {
  /*
   * Os scripts de uma pagina viram um bundle, entao as seis tags apontariam
   * para o MESMO arquivo. O navegador baixa uma vez, mas ficam seis linhas
   * mortas e a mesma URL listada seis vezes. O build remove as repetidas.
   */
  for (const pagina of ['index.html', 'admin.html']) {
    const html = htmlDe(pagina);
    const scripts = [...html.matchAll(/<script\b[^>]*src\s*=\s*"([^"]+)"/gi)].map((m) => m[1]);

    assert.ok(scripts.length > 0, `${pagina} nao tem script`);
    assert.equal(
      new Set(scripts).size,
      scripts.length,
      `${pagina} repete script: ${scripts.join(', ')}`
    );
  }
});

test('os globais do front sobrevivem a minificacao', () => {
  /*
   * Os arquivos de `public/js` sao IIFE que so conversam por `window.*`. Se o
   * build usasse `format: 'iife'`, o esbuild renomearia `AdminUI` para `o` e a
   * loja inteira pararia de funcionar — sem erro de sintaxe, o que e pior.
   *
   * A busca e por `window.<Global> =`: e assim que o front declara as
   * dependencias entre paginas, e o que precisa sobreviver byte a byte.
   */
  const esperados = ['Api', 'UI', 'Carrinho', 'Admin', 'AdminUI'];
  const codigo = assetsGerados()
    .filter((n) => n.endsWith('.js'))
    .map((n) => fs.readFileSync(path.join(saida, 'public', 'assets', n), 'utf8'))
    .join('\n');

  for (const global of esperados) {
    assert.ok(
      codigo.includes(`window.${global}=`),
      `o global window.${global} sumiu na minificacao`
    );
  }
});

test('o build nao deixa recurso local de fora dos bundles', () => {
  // `construir` valida isso e falha alto; aqui se garante que a validacao cobre
  // as paginas de verdade, e nao so as duas primeiras.
  const manifesto = JSON.parse(fs.readFileSync(path.join(saida, 'manifest.json'), 'utf8'));
  const paginas = new Set(Object.keys(manifesto.arquivos).map((chave) => chave.split('::')[0]));

  for (const pagina of ['index.html', 'login.html', 'produtos.html', 'termos.html', 'admin.html', 'conta.html']) {
    assert.ok(paginas.has(pagina), `${pagina} ficou fora do manifesto`);
  }
});

test('o build e reproduzivel: mesmo conteudo, mesmo nome', () => {
  const conteudo = 'window.exemplo = 1;';
  assert.equal(nomeComHash('comum', '.js', conteudo), nomeComHash('comum', '.js', conteudo));
  assert.notEqual(nomeComHash('comum', '.js', conteudo), nomeComHash('comum', '.js', `${conteudo} `));
});

/* -------------------------------------------------------------------------- */
/* Leitura dos HTMLs (as listas nao sao hardcoded no build)                    */
/* -------------------------------------------------------------------------- */

test('as listas de recursos sao lidas do HTML, nao hardcoded', () => {
  const html = fs.readFileSync(path.join(RAIZ, 'public', 'index.html'), 'utf8');
  const recursos = listarRecursos(html);

  assert.ok(recursos.js.includes('js/api.js'), 'api.js deveria entrar na lista de scripts');
  assert.ok(recursos.css.includes('css/base.css'), 'base.css deveria entrar na lista de estilos');

  // O `link` do favicon aponta para SVG e nao e CSS: entrar na lista faria o
  // build tentar minificar um SVG como folha de estilo.
  assert.equal(
    recursos.css.some((c) => c.endsWith('.svg')),
    false,
    'o favicon nao e stylesheet'
  );
});

test('recurso externo nao entra na lista (fonte de CDN)', () => {
  const html = '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">';
  assert.deepEqual(listarRecursos(html), { js: [], css: [] });
});

test('o prefixo comum e o mais longo que todas as paginas compartilham', () => {
  const listas = [
    ['base.css', 'app.css', 'home.css'],
    ['base.css', 'app.css', 'login.css'],
    ['base.css', 'app.css']
  ];
  assert.deepEqual(prefixoComum(listas), ['base.css', 'app.css']);
});

test('sem prefixo comum, nada e extraido', () => {
  const listas = [['home.css'], ['login.css']];
  assert.deepEqual(prefixoComum(listas), []);
});
