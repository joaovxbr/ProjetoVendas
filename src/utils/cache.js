/*
 * src/utils/cache.js
 * -----------------------------------------------------------------------------
 * Politica de Cache-Control dos arquivos estaticos, em uma funcao pura (sem
 * Express) para poder ser testada sozinha e usada tanto pelo servidor quanto
 * pelos testes.
 *
 * A regra e uma so, e ela e o que torna o cache longo seguro:
 *
 *   arquivo COM hash de conteudo no nome  -> `immutable, max-age=31536000`
 *   qualquer outra coisa                  -> `no-cache`
 *
 * O nome com hash muda junto com o conteudo, entao o navegador nunca consegue
 * servir uma versao velha de um arquivo com hash: se o conteudo mudou, o nome
 * mudou, e o HTML novo aponta para outro arquivo. O `immutable` e uma promessa
 * que o nome pagada em conteudo consegue cumprir.
 *
 * Tudo que NAO tem hash continua `no-cache` (= "revalide antes de usar"), e nao
 * "nao guarde": o HTML e os arquivos servidos sem build continuam custando um
 * 304 barato, nunca um download, e a correcao de front vale no proximo
 * carregamento.
 *
 * Consequencia desejada de proposito: rodar em producao SEM build nao quebra
 * nada. Os arquivos passam a sair sem `max-age` — o comportamento antigo, que
 * funciona. O problema so apareceria na direcao contraria (hash no nome com
 * `no-cache`), que desperdica downloads sem nunca servir arquivo velho.
 */
'use strict';

/* Um ano, em segundos. O padrao de "asset com hash" em Cache-Control. */
const UM_ANO_SEGUNDOS = 31536000;

/*
 * Extensao que aceita cache longo porque o build sabe renomear o arquivo.
 * O build hoje so gera hash para .js e .css; as demais ficam aqui para quando
 * ele passar a emitir, por exemplo, fonte ou imagem com hash.
 */
const EXTENSOES_COM_HASH = new Set(['.js', '.css', '.svg', '.woff2']);

// 8+ caracteres hexadecimais antes da extensao: app.9f3a2b1c.js
const HASH_NO_NOME = /\.([0-9a-f]{8,})\.[a-z0-9]+$/i;

/**
 * Decide o `Cache-Control` de um arquivo estatico pelo nome dele.
 *
 * @param {string} nomeArquivo Nome do arquivo (caminho completo ou so o base).
 * @returns {string} Valor para o cabecalho Cache-Control.
 */
function cabecalhoCache(nomeArquivo) {
  if (typeof nomeArquivo !== 'string' || !nomeArquivo) return 'no-cache';

  const base = nomeArquivo.split(/[\\/]/).pop();
  const extensao = (base.match(/\.[a-z0-9]+$/i) || [''])[0].toLowerCase();

  if (EXTENSOES_COM_HASH.has(extensao) && HASH_NO_NOME.test(base)) {
    return `immutable, max-age=${UM_ANO_SEGUNDOS}`;
  }
  return 'no-cache';
}

module.exports = { cabecalhoCache, UM_ANO_SEGUNDOS, EXTENSOES_COM_HASH };