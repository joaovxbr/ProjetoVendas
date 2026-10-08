/*
 * app.js
 * -----------------------------------------------------------------------------
 * Monta a aplicacao Express. Fica separado do server.js de proposito: assim os
 * testes podem importar o app sem abrir uma porta de rede.
 *
 * Ordem dos middlewares importa e segue esta logica:
 *   1. seguranca (helmet, cors, limites)
 *   2. parsing do corpo
 *   3. contexto (id da requisicao + logger)
 *   4. sessao (quem esta falando)
 *   5. API
 *   6. arquivos estaticos e paginas
 *   7. 404 e tratador de erros
 */
'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const cookieParser = require('cookie-parser');

const config = require('./config');
const apiRoutes = require('./routes');
const limites = require('./middlewares/limites');
const { contexto } = require('./middlewares/contexto');
const { carregarUsuario } = require('./middlewares/sessao');
const { naoEncontrado, tratadorDeErros } = require('./middlewares/erros');
const { SemPermissao } = require('./utils/erros');
const { cabecalhoCache } = require('./utils/cache');

/*
 * Em PRODUCAO o front servido vem de `dist/public/`, onde o build ja minificou,
 * renomeou com hash de conteudo e reescreveu o HTML. Em desenvolvimento o
 * servidor nao depende do build: ele serve `public/` direto, entao editar um
 * `.js` e recarregar ja mostra a mudanca, sem rodar nada.
 *
 * Se a producao subir sem o `dist`, o servidor NAO quebra: ele avisa no boot e
 * cai para `public/`, que funciona igual, so que sem minificacao e sem o cache
 * longo. Ver server.js, que escreve o aviso.
 */
const PASTA_PUBLICA_DESVIO = path.join(config.raiz, 'public');
const PASTA_BUILD = path.join(config.raiz, 'dist', 'public');
const TEM_BUILD = fs.existsSync(PASTA_BUILD);
const USANDO_BUILD = config.producao && TEM_BUILD;
const PASTA_PUBLICA = USANDO_BUILD ? PASTA_BUILD : PASTA_PUBLICA_DESVIO;

// Paginas servidas por URL "bonita" (sem .html).
const PAGINAS = ['login', 'produtos', 'termos', 'admin', 'conta'];

// Metodos que mudam estado: sao os que exigem verificacao de origem.
const METODOS_MUTANTES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Origens aceitas em requisicoes que mudam estado.
 *
 * Sao apenas duas fontes: a propria origem do site (derivada do Host da
 * requisicao) e o que estiver declarado em LOJA_URL/CORS_ORIGIN. Qualquer
 * outra origem e recusada.
 *
 * Em PRODUCAO a lista e fechada quando LOJA_URL (ou CORS_ORIGIN) foi
 * declarada: o cabecalho Host e controlado pelo cliente, entao nao serve como
 * fonte de confianca. O fallback pelo Host continua valendo em desenvolvimento
 * e tambem em producao sem LOJA_URL — nesse caso a loja funciona, e o aviso
 * fica no boot (ver server.js).
 */
function origensPermitidas(req) {
  const permitidas = new Set();

  try {
    permitidas.add(new URL(config.loja.url).origin);
  } catch { /* LOJA_URL invalida: ignora */ }

  for (const origem of config.cors.origens) {
    permitidas.add(String(origem).replace(/\/+$/, ''));
  }

  const listaFechada = config.producao && (config.loja.urlDeclarada || config.cors.origens.length > 0);

  if (!listaFechada) {
    const host = req.headers.host;
    if (host) {
      permitidas.add(`http://${host}`);
      permitidas.add(`https://${host}`);
    }
  }

  return permitidas;
}

/**
 * Defesa em profundidade contra CSRF.
 *
 * O cookie de sessao ja e SameSite=Lax, o que impede o navegador de anexa-lo
 * a uma requisicao cross-site. Esta verificacao fecha a porta que sobra: se a
 * requisicao trouxer um `Origin` que nao e o do site, ela e recusada — mesmo
 * que o navegador, por algum motivo, tenha enviado o cookie.
 *
 * Requisicoes SEM `Origin` passam: e o caso de webhooks (que se protegem por
 * assinatura) e de clientes server-side (curl, integracoes). Um navegador
 * moderno sempre envia `Origin` em requisicoes cross-site.
 */
function verificarOrigem(req, res, next) {
  if (!METODOS_MUTANTES.has(req.method)) return next();

  const origem = req.headers.origin;
  if (!origem) return next();

  if (origensPermitidas(req).has(String(origem).replace(/\/+$/, ''))) return next();

  return next(new SemPermissao('Origem nao autorizada para esta operacao'));
}

function criarApp() {
  const app = express();

  // Nao anunciar a tecnologia do servidor.
  app.disable('x-powered-by');
  /*
   * De quem o X-Forwarded-* e aceito para descobrir o IP real (req.ip). Nunca
   * `true`: isso confiaria em qualquer cliente e anularia o rate limit. O valor
   * ja chega validado da config (ver utils/proxy.js).
   */
  app.set('trust proxy', config.trustProxy);
  // Escapa <, > e & no JSON: se algum dia um dado do usuario cair em HTML
  // montado por concatenacao, nao vira script executavel.
  app.set('json escape', true);

  /* ---------------------------------------------------------------------- */
  /* 1. Seguranca                                                           */
  /* ---------------------------------------------------------------------- */

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        // Sem upgrade: o projeto roda em http://localhost no desenvolvimento.
        upgradeInsecureRequests: null
      }
    },
    // Nao vazar a URL de origem para sites externos (ex.: ao seguir um link).
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    /*
     * HSTS: so em producao. Em desenvolvimento (http://localhost) o cabecalho
     * seria inofensivo, mas atrapalharia quem testa em rede local com http.
     */
    strictTransportSecurity: config.producao
      ? { maxAge: 15552000, includeSubDomains: true, preload: false }
      : false,
    // Permite que os navegadores carreguem os recursos do proprio site.
    crossOriginResourcePolicy: { policy: 'same-origin' }
  }));

  /*
   * Permissions-Policy: desliga no navegador APIs que a loja nao usa. Se algum
   * dia um XSS conseguir rodar script, ele nao tera camera, microfone nem
   * geolocalizacao a disposicao.
   */
  app.use((req, res, next) => {
    res.setHeader(
      'Permissions-Policy',
      'geolocation=(), microphone=(), camera=(), payment=(), usb=(), magnetometer=(), gyroscope=(), display-capture=()'
    );
    next();
  });

  /*
   * CORS desligado por padrao: o site e a API vivem na mesma origem, entao
   * liberar outros dominios so aumentaria a superficie de ataque. Para liberar
   * (ex.: um app mobile), preencha CORS_ORIGIN no .env.
   */
  const origens = config.cors.origens;
  app.use(cors({
    origin: origens.length ? origens : false,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    maxAge: 86400
  }));

  app.use(compression());

  /* ---------------------------------------------------------------------- */
  /* 2. Corpo da requisicao                                                  */
  /* ---------------------------------------------------------------------- */

  /*
   * `verify` guarda o corpo CRU da requisicao em req.corpoBruto. O webhook de
   * pagamento precisa exatamente dos bytes recebidos para conferir a
   * assinatura: re-serializar o JSON mudaria a ordem das chaves e invalidaria
   * o HMAC de um evento legitimo.
   */
  app.use(express.json({
    limit: '100kb',
    verify: (req, res, buffer) => { req.corpoBruto = buffer.toString('utf8'); }
  }));
  app.use(express.urlencoded({ extended: true, limit: '100kb' }));
  app.use(cookieParser());

  // Defesa em profundidade contra CSRF (ver comentario em verificarOrigem).
  app.use(verificarOrigem);

  /* ---------------------------------------------------------------------- */
  /* 3 e 4. Contexto e sessao                                               */
  /* ---------------------------------------------------------------------- */

  app.use(contexto);
  app.use(carregarUsuario);

  /* ---------------------------------------------------------------------- */
  /* 5. API                                                                 */
  /* ---------------------------------------------------------------------- */

  /*
   * Resposta de API nunca pode ser servida do cache do navegador.
   *
   * Sem um Cache-Control explicito o navegador fica livre para guardar o JSON e
   * responder de la (cache heuristico), o que ja mascarou dado novo: o produto
   * recem-cadastrado nao aparecia na home mesmo depois de recarregar.
   *
   * `no-store` e o mais forte dos "nao guarde": vale tambem para o cache de
   * disco e para o bfcache. O ETag continua existindo, mas nao ha o que
   * revalidar — a resposta sempre vem inteira e atual. E de proposito: esta e
   * uma loja, onde preco e estoque na tela precisam ser os do servidor.
   */
  app.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  /*
   * O limite geral vale para todo /api. O health check fica de fora (regra no
   * proprio limitador), para que um monitor externo nao consuma a cota dos
   * usuarios nem seja bloqueado justamente quando algo esta errado.
   */
  app.use('/api', limites.geral, apiRoutes);

  /* ---------------------------------------------------------------------- */
  /* 6. Arquivos estaticos e paginas                                        */
  /* ---------------------------------------------------------------------- */

  app.use(express.static(PASTA_PUBLICA, {
    index: 'index.html',
    etag: true,
    lastModified: true,
    /*
     * A politica mora em utils/cache.js e decide pelo NOME do arquivo:
     *
     *   - arquivo com hash de conteudo (`app.9f3a2b1c.js`) -> `immutable`,
     *     um ano. E seguro porque o nome muda junto com o conteudo: se o
     *     arquivo mudou, ele mudou de nome, e o HTML novo aponta para outro.
     *     E o que `immutable` promete — que o arquivo so pode mudar de nome.
     *
     *   - qualquer outra coisa (HTML, e os estaticos sem build) -> `no-cache`,
     *     que e "revalide antes de usar" e nao "nao guarde": o arquivo
     *     inalterado custa um 304 barato e o alterado chega na primeira
     *     visita seguinte.
     *
     * Antes, em producao, os `.js`/`.css` levavam `max-age=86400` e dava
     * errado pelo motivo oposto: o HTML novo chegava na hora e o JavaScript
     * novo ficava preso ate 24h. Era o pior dos dois mundos, porque nao havia
     * hash no nome para pagar a promessa do `max-age`.
     */
    setHeaders(res, caminho) {
      res.setHeader('Cache-Control', cabecalhoCache(path.basename(caminho)));
    }
  }));

  // /login, /produtos e /termos servem o .html correspondente.
  for (const pagina of PAGINAS) {
    app.get(`/${pagina}`, (req, res, next) => {
      // HTML nunca leva cache longo: e ele quem aponta para os assets.
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(path.join(PASTA_PUBLICA, `${pagina}.html`), (erro) => {
        if (erro) next(erro);
      });
    });
  }

  /* ---------------------------------------------------------------------- */
  /* 7. Fim da linha                                                        */
  /* ---------------------------------------------------------------------- */

  app.use(naoEncontrado);
  app.use(tratadorDeErros);

  return app;
}

module.exports = { criarApp, PASTA_PUBLICA, PAGINAS, USANDO_BUILD };
