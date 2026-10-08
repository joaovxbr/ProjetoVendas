/*
 * scripts/build.js
 * -----------------------------------------------------------------------------
 * Build do front-end: gera `dist/public/` com o JavaScript e o CSS minificados,
 * concatenados por pagina e com hash de conteudo no nome.
 *
 * Por que concatenar e nao empacotar: os arquivos em `public/js/` sao 13 IIFE
 * que so conversam por `window.*` (Api, UI, Carrinho, AdminUI, Admin...). Nao ha
 * um unico `import`/`export` no projeto, entao nao existe grafo de modulos para
 * resolver — empacotar so arriscaria mudar o `this` de topo e a ordem de
 * execucao. Aqui cada arquivo e minificado ISOLADAMENTE, como script, e os
 * resultados sao concatenados na mesma ordem em que o HTML ja carregava. O que
 * o visitante ve e identico ao que ele via antes, so que menor.
 *
 * Por que hash no nome: e o que permite `Cache-Control: immutable` de um ano
 * sem risco de servir JavaScript velho (ver src/utils/cache.js). O HTML de
 * entrada continua `no-cache`, entao um deploy novo entrega um HTML que aponta
 * para arquivos novos.
 *
 * O HTML de saida NAO e minificado: os comentarios dele sao documentacao da
 * tela e a diferenca depois de gzip e irrelevante. O que muda no HTML sao
 * apenas os `src`/`href` de JS e CSS locais.
 *
 * As listas de arquivos NAO sao hardcoded: sao lidas dos proprios HTMLs, que
 * usam caminhos literais como `/js/api.js`. Incluir um script novo numa pagina
 * nao exige mexer neste arquivo.
 *
 * Uso:
 *   node scripts/build.js [pasta-de-saida]
 * A pasta e opcional (padrao `dist`). Os testes passam uma pasta temporaria para
 * nao mexer no `dist/` de verdade.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { transformSync } = require('esbuild');

const RAIZ = path.resolve(__dirname, '..');
const ORIGEM = path.join(RAIZ, 'public');
const SAIDA_PADRAO = path.join(RAIZ, 'dist');

/* Pasta de saida dos arquivos com hash dentro de `public/`. */
const PASTA_ASSETS = 'assets';

/* Quantos caracteres de hex do hash vao no nome. 8 = 4 bilhoes de variacoes. */
const TAMANHO_HASH = 8;

/*
 * URLs que NAO sao arquivos do projeto e por isso nao entram no processamento:
 * CDN de fonte, links externos. O resto (`/js/...`, `/css/...`, `/img/...`) e
 * arquivo local e precisa existir.
 */
const RECURSOS_EXTERNOS = /^([a-z]+:)?\/\//i;

/* -------------------------------------------------------------------------- */
/* Leitura dos HTMLs                                                          */
/* -------------------------------------------------------------------------- */

// Tags inteiras: a reescrita precisa da tag crua para trocar so o atributo.
const TAG_SCRIPT = /<script\b[^>]*>/gi;
const TAG_LINK = /<link\b[^>]*>/gi;
const ATRIBUTO_SRC = /\bsrc\s*=\s*"([^"]+)"/i;
const ATRIBUTO_HREF = /\bhref\s*=\s*"([^"]+)"/i;

const ehRecursoExterno = (url) => !url.startsWith('/') || RECURSOS_EXTERNOS.test(url);

/**
 * Extrai, de um HTML, os arquivos locais de JS e de CSS na ordem em que aparecem.
 *
 * So entram os `<link rel="stylesheet">`: o `link` do favicon aponta para
 * `/img/favicon.svg` e nao e CSS.
 *
 * @param {string} html Conteudo do arquivo.
 * @returns {{js: string[], css: string[]}} Caminhos sem a barra inicial.
 */
function listarRecursos(html) {
  const js = [];
  for (const [tag] of html.matchAll(TAG_SCRIPT)) {
    const src = tag.match(ATRIBUTO_SRC);
    if (src && !ehRecursoExterno(src[1])) js.push(src[1].replace(/^\//, ''));
  }

  const css = [];
  for (const [tag] of html.matchAll(TAG_LINK)) {
    if (!/rel\s*=\s*"[^"]*\bstylesheet\b/i.test(tag)) continue;
    const href = tag.match(ATRIBUTO_HREF);
    if (href && !ehRecursoExterno(href[1])) css.push(href[1].replace(/^\//, ''));
  }

  return { js, css };
}

/* -------------------------------------------------------------------------- */
/* Prefixo comum                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Maior prefixo comum a todas as listas, na ordem em que aparecem.
 *
 * Os HTMLs comecam todos por `base.css`, `app.css` e `api.js`. Emitir esse
 * prefixo uma vez e reaproveitar nas paginas evita repetir ~43 KB de JS e
 * ~43 KB de CSS em cada pagina (o navegador so baixa uma vez por visita, mas o
 * pacote encolhe e o HTML fica menor).
 *
 * @param {string[][]} listas Uma lista de arquivos por pagina.
 * @returns {string[]} O prefixo comum.
 */
function prefixoComum(listas) {
  if (!listas.length) return [];
  const [primeira, ...resto] = listas;
  const comum = [];

  for (let i = 0; i < primeira.length; i += 1) {
    const candidato = primeira[i];
    if (resto.every((lista) => lista[i] === candidato)) comum.push(candidato);
    else break;
  }
  return comum;
}

/* -------------------------------------------------------------------------- */
/* Minificacao                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Minifica um arquivo como script/CSS isolado e devolve o codigo.
 *
 * Sem `format` o esbuild preserva os nomes declarados no topo — necessario
 * aqui, porque quem roda o build depende de globais como `window.AdminUI`.
 * Passar `format: 'iife'` renomeia `AdminUI` para `o` e quebraria a loja.
 *
 * @param {string} caminho Caminho absoluto do arquivo.
 * @returns {string} Codigo minificado.
 */
function minificar(caminho) {
  const fonte = fs.readFileSync(caminho, 'utf8');
  const loader = caminho.endsWith('.css') ? 'css' : 'js';
  return transformSync(fonte, { loader, minify: true }).code;
}

/**
 * Junta varios arquivos ja minificados, na ordem, separando por `;\n`.
 *
 * A separacao existe porque minificacao nao garante ponto-e-virgula no fim de
 * um arquivo: `var a=1` seguido de `(function(){})()` viraria uma chamada.
 *
 * @param {string[]} caminhos Caminhos absolutos, na ordem de entrada.
 * @returns {string} Codigo concatenado.
 */
function concatenar(caminhos) {
  return caminhos.map(minificar).join(';\n');
}

/* -------------------------------------------------------------------------- */
/* Nome com hash                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Insere o hash do conteudo antes da extensao: `app.js` -> `app.9f3a2b1c.js`.
 *
 * @param {string} nomeBase Nome sem extensao.
 * @param {string} extensao Com ponto inicial (ex.: `.css`).
 * @param {string} conteudo Conteudo final do arquivo.
 * @returns {string} Nome com hash.
 */
function nomeComHash(nomeBase, extensao, conteudo) {
  const hash = crypto.createHash('sha256').update(conteudo).digest('hex').slice(0, TAMANHO_HASH);
  return `${nomeBase}.${hash}${extensao}`;
}

/* -------------------------------------------------------------------------- */
/* Reescrita do HTML                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Troca as URLs locais de JS/CSS pelos nomes com hash gerados e remove as tags
 * que ficaram repetidas.
 *
 * Como os scripts de uma pagina viram um bundle so, as seis tags
 * `<script src="/js/api.js" defer>` viram seis tags apontando para o MESMO
 * arquivo. O navegador baixa uma vez, entao nao ha ganho de trafego — mas ficam
 * seis linhas mortas no HTML e a mesma URL listada seis vezes. A duplicata e
 * removida; a ordem de quem aparece primeiro e preservada e, como os bundles ja
 * estao concatenados na ordem original, a ordem de execucao nao muda.
 *
 * As tags sao substituidas INTEIRAS: `String.replace` com uma string como
 * segundo argumento tem regras proprias de `$&`/`$1` que corrompem o resultado.
 *
 * @param {string} html HTML de entrada.
 * @param {Map<string,string>} trocas URL antiga (com barra) -> URL nova.
 * @returns {string} HTML com as referencias apontando para `assets/`.
 */
function reescrever(html, trocas) {
  const urlDe = (tag) => (tag.match(ATRIBUTO_SRC) || tag.match(ATRIBUTO_HREF))?.[1];
  const feitas = new Set();
  let saida = html;

  for (const tag of [TAG_LINK, TAG_SCRIPT]) {
    saida = saida.replace(tag, (inteiro) => {
      const atual = urlDe(inteiro);
      const nova = trocas.get(atual);
      if (!nova) return inteiro;
      if (feitas.has(nova)) return '';
      feitas.add(nova);
      return inteiro.replace(atual, nova);
    });
  }
  return saida;
}

/* -------------------------------------------------------------------------- */
/* Copia de assets                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Copia recursivamente o que nao for JS, CSS ou HTML (hoje: `img/`).
 *
 * @param {string} de Pasta de origem.
 * @param {string} para Pasta de destino.
 * @param {Set<string>} ignorados Nomes de arquivo/pasta a pular.
 */
function copiarAssets(de, para, ignorados) {
  if (!fs.existsSync(de)) return;
  for (const entrada of fs.readdirSync(de, { withFileTypes: true })) {
    if (ignorados.has(entrada.name)) continue;
    const origem = path.join(de, entrada.name);
    const destino = path.join(para, entrada.name);
    if (entrada.isDirectory()) {
      fs.mkdirSync(destino, { recursive: true });
      copiarAssets(origem, destino, ignorados);
    } else {
      fs.mkdirSync(path.dirname(destino), { recursive: true });
      fs.copyFileSync(origem, destino);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Montagem                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Emite um bundle (comum ou de pagina) e monta o mapa que transforma CADA
 * arquivo de origem na URL do bundle.
 *
 * O mapa precisa ter uma entrada por arquivo e nao uma so pelo nome do bundle:
 * o HTML de entrada aponta para `/js/api.js`, `/js/ui.js` etc., e cada um
 * desses vira `comum.<hash>.js` ou `pagina.<hash>.js`.
 *
 * @param {string} nomeBase `comum` ou `pagina`.
 * @param {string} extensao `.js` ou `.css`.
 * @param {string[]} arquivos Arquivos, na ordem, em caminhos relativos a `public/`.
 * @param {string} pastaSaida Pasta `public/` de destino.
 * @returns {Map<string,string>} URL antiga (com barra) -> URL nova.
 */
function emitirBundle(nomeBase, extensao, arquivos, pastaSaida) {
  const trocas = new Map();
  if (!arquivos.length) return trocas;

  const conteudo = concatenar(arquivos.map((p) => path.join(ORIGEM, p)));
  const destino = path.join(pastaSaida, PASTA_ASSETS);
  fs.mkdirSync(destino, { recursive: true });
  fs.writeFileSync(path.join(destino, nomeComHash(nomeBase, extensao, conteudo)), conteudo, 'utf8');

  const urlBase = `/${PASTA_ASSETS}/${nomeComHash(nomeBase, extensao, conteudo)}`;
  for (const arquivo of arquivos) trocas.set(`/${arquivo}`, urlBase);

  return trocas;
}

/**
 * Monta o `dist/public/` inteiro.
 *
 * @param {string} pastaSaida Pasta de saida do build.
 * @returns {{paginas: number, arquivos: number, mapa: object}} Resumo.
 */
function construir(pastaSaida) {
  const publicSaida = path.join(pastaSaida, 'public');
  fs.rmSync(publicSaida, { recursive: true, force: true });
  fs.mkdirSync(publicSaida, { recursive: true });

  const paginas = fs.readdirSync(ORIGEM).filter((nome) => nome.endsWith('.html'));
  if (!paginas.length) throw new Error(`Nenhum HTML encontrado em ${ORIGEM}.`);

  const htmls = paginas.map((nome) => fs.readFileSync(path.join(ORIGEM, nome), 'utf8'));
  const recursos = htmls.map(listarRecursos);

  /*
   * O que toda pagina carrega em comum (hoje `base.css` + `app.css` e `api.js`)
   * sai em um bundle so. O que sobra e exclusivo de cada pagina.
   */
  const comumJs = prefixoComum(recursos.map((r) => r.js));
  const comumCss = prefixoComum(recursos.map((r) => r.css));
  const exclusivoJs = recursos.map((r) => r.js.slice(comumJs.length));
  const exclusivoCss = recursos.map((r) => r.css.slice(comumCss.length));

  const manifesto = {};
  const trocarComumJs = emitirBundle('comum', '.js', comumJs, publicSaida);
  const trocarComumCss = emitirBundle('comum', '.css', comumCss, publicSaida);

  /* Cada pagina ganha seus arquivos exclusivos. */
  paginas.forEach((nomePagina, indice) => {
    const trocas = new Map([...trocarComumJs, ...trocarComumCss]);

    for (const [velha, nova] of emitirBundle('pagina', '.js', exclusivoJs[indice], publicSaida)) {
      trocas.set(velha, nova);
    }
    for (const [velha, nova] of emitirBundle('pagina', '.css', exclusivoCss[indice], publicSaida)) {
      trocas.set(velha, nova);
    }

    /* Nenhum recurso local pode ficar de fora dos bundles: se sobrou algum,
       o HTML gerado apontaria para um arquivo que nao existe no dist. */
    for (const arquivo of [...recursos[indice].js, ...recursos[indice].css]) {
      if (!trocas.has(`/${arquivo}`)) throw new Error(`${nomePagina}: "${arquivo}" nao entrou em nenhum bundle.`);
    }

    const html = reescrever(fs.readFileSync(path.join(ORIGEM, nomePagina), 'utf8'), trocas);
    fs.writeFileSync(path.join(publicSaida, nomePagina), html, 'utf8');

    for (const [velha, nova] of trocas) manifesto[`${nomePagina}::${velha}`] = nova;
  });

  copiarAssets(ORIGEM, publicSaida, new Set(['js', 'css', 'index.html', 'admin.html', 'conta.html', 'login.html', 'produtos.html', 'termos.html']));

  fs.writeFileSync(
    path.join(pastaSaida, 'manifest.json'),
    JSON.stringify({ geradoEm: new Date().toISOString(), arquivos: manifesto }, null, 2),
    'utf8'
  );

  return {
    paginas: paginas.length,
    arquivos: fs.readdirSync(path.join(publicSaida, PASTA_ASSETS)).length,
    mapa: manifesto
  };
}

/* -------------------------------------------------------------------------- */
/* Execucao                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Executa o build.
 *
 * @param {string} [pastaSaida] Pasta de saida. Padrao: `dist`.
 * @returns {{paginas: number, arquivos: number, mapa: object}} Resumo.
 */
function build(pastaSaida = SAIDA_PADRAO) {
  return construir(path.resolve(RAIZ, pastaSaida));
}

module.exports = { build, listarRecursos, prefixoComum, nomeComHash, reescrever };

if (require.main === module) {
  const destino = process.argv[2] || SAIDA_PADRAO;
  const resumo = build(destino);
  const destinoFinal = path.resolve(RAIZ, destino);
  console.log(`Build concluido em ${path.relative(RAIZ, destinoFinal)}/public`);
  console.log(`  ${resumo.paginas} paginas, ${resumo.arquivos} arquivos em assets/`);
  console.log('  mapa de arquivos: dist/manifest.json');
}