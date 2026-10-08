/*
 * api.js
 * -----------------------------------------------------------------------------
 * Utilitários compartilhados por todas as páginas. É um script comum (sem
 * módulos), carregado PRIMEIRO com "defer", e expõe um único objeto global:
 * window.Api.
 *
   *   Api.request(metodo, caminho, corpo?) -> Promise<{ ok, status, data, headers }>
   *   Api.get(caminho) / Api.post(caminho, corpo)
 *   Api.me()            -> Promise<usuario | null>
 *   Api.logout()        -> encerra a sessão e vai para /login.html
 *   Api.formatarPreco(n)-> "R$ 1.234,90"
 *   Api.escapar(texto)  -> texto seguro para montar HTML
 *   Api.toast(msg, tipo)-> aviso flutuante ('info' | 'success' | 'error')
 *   Api.FRETE_GRATIS_MIN, Api.FRETE_VALOR, Api.calcularFrete(subtotal)
 *   Api.observarReveal(raiz?) -> anima elementos .reveal ao entrarem na tela
 *   Api.aoRevalidar(fn, opts) -> revalida a tela ao voltar para a aba (e de tempos em tempos)
 *   Api.reduzMovimento() -> true se o usuário prefere menos movimento
 *
 * Princípios: nada aqui lança exceção para quem chama. Erros de HTTP e de rede
 * viram respostas { ok: false, ... } com uma mensagem amigável em data.erro.
 */
(function () {
  'use strict';

  /* ---------------------------------------------------------------------------
   * Constantes
   * ------------------------------------------------------------------------- */

  var MENSAGEM_FALHA_CONEXAO = 'Falha de conexão. Tente novamente.';
  var MENSAGEM_TEMPO_ESGOTADO = 'O servidor demorou para responder. Tente novamente.';
  var MENSAGEM_REQUISICAO_INVALIDA = 'Não foi possível enviar a solicitação.';

  var TEMPO_LIMITE_MS = 20000; // tempo máximo de espera por uma resposta
  var DURACAO_TOAST_MS = 3200; // tempo que cada aviso fica visível
  var MAX_TOASTS = 3;          // avisos empilhados ao mesmo tempo
  var TIPOS_TOAST = ['info', 'success', 'error'];

  var FRETE_GRATIS_MIN = 300;
  var FRETE_VALOR = 24.9;

  // Mensagens usadas quando o servidor responde com erro sem um JSON { erro }
  // (ex.: o limitador de requisições, que devolve texto puro).
  var MENSAGENS_POR_STATUS = {
    400: 'Não foi possível processar os dados enviados.',
    401: 'Faça login para continuar.',
    403: 'Você não tem permissão para esta ação.',
    404: 'Não encontramos o que você procurava.',
    409: 'Esta informação já está em uso.',
    413: 'Os dados enviados são grandes demais.',
    429: 'Muitas tentativas seguidas. Aguarde um instante e tente novamente.'
  };

  function mensagemPadrao(status) {
    if (MENSAGENS_POR_STATUS[status]) return MENSAGENS_POR_STATUS[status];
    if (status >= 500) return 'Nosso servidor encontrou um problema. Tente novamente em instantes.';
    return 'Não foi possível concluir a solicitação.';
  }

  // Cria sempre um objeto novo: quem chama pode alterá-lo sem afetar outros.
  function respostaDeFalha(mensagem) {
    return { ok: false, status: 0, data: { erro: mensagem } };
  }

  function ehObjetoSimples(valor) {
    return valor !== null && typeof valor === 'object' && !Array.isArray(valor);
  }

  /* ---------------------------------------------------------------------------
   * Requisições HTTP
   * ------------------------------------------------------------------------- */

  // Lê o corpo da resposta: JSON quando possível, texto caso contrário,
  // null quando vazio (inclusive 204 No Content).
  async function lerCorpo(resposta) {
    if (resposta.status === 204 || resposta.status === 205) return null;

    var texto = '';
    try {
      texto = await resposta.text();
    } catch (erro) {
      return null;
    }

    if (!texto) return null;

    try {
      return JSON.parse(texto);
    } catch (erro) {
      return texto;
    }
  }

  /**
   * Faz uma requisição à API do próprio site.
   * Nunca rejeita: erros HTTP chegam com ok: false e erros de rede com status 0.
   *
   * @param {string} metodo  'GET', 'POST', 'DELETE'...
   * @param {string} caminho ex.: '/api/produtos'
   * @param {*}      [corpo] objeto enviado como JSON (ignorado em GET/HEAD)
   * @returns {Promise<{ok: boolean, status: number, data: any, headers: Headers}>}
   */
  async function request(metodo, caminho, corpo) {
    var verbo = String(metodo || 'GET').toUpperCase();

    if (typeof caminho !== 'string' || !caminho) {
      return respostaDeFalha(MENSAGEM_REQUISICAO_INVALIDA);
    }

    var opcoes = {
      method: verbo,
      credentials: 'same-origin',
      headers: { Accept: 'application/json' }
    };

    var temCorpo = corpo !== undefined && corpo !== null && verbo !== 'GET' && verbo !== 'HEAD';
    if (temCorpo) {
      try {
        opcoes.body = JSON.stringify(corpo);
      } catch (erro) {
        return respostaDeFalha(MENSAGEM_REQUISICAO_INVALIDA);
      }
      opcoes.headers['Content-Type'] = 'application/json';
    }

    // Tempo limite: evita botões presos em "carregando" para sempre.
    var controlador = typeof AbortController === 'function' ? new AbortController() : null;
    var temporizador = null;
    if (controlador) {
      opcoes.signal = controlador.signal;
      temporizador = setTimeout(function () { controlador.abort(); }, TEMPO_LIMITE_MS);
    }

    try {
      var resposta;
      try {
        resposta = await fetch(caminho, opcoes);
      } catch (erro) {
        var expirou = erro && erro.name === 'AbortError';
        return respostaDeFalha(expirou ? MENSAGEM_TEMPO_ESGOTADO : MENSAGEM_FALHA_CONEXAO);
      }

      var data = await lerCorpo(resposta);

      // Em caso de erro, garante que data.erro seja sempre um texto amigável,
      // para que `resultado.data.erro` nunca quebre quem chama.
      if (!resposta.ok) {
        if (!ehObjetoSimples(data)) {
          data = { erro: mensagemPadrao(resposta.status) };
        } else if (typeof data.erro !== 'string' || !data.erro.trim()) {
          data.erro = mensagemPadrao(resposta.status);
        }
      }

      return { ok: resposta.ok, status: resposta.status, data: data, headers: resposta.headers };
    } finally {
      if (temporizador) clearTimeout(temporizador);
    }
  }

  function get(caminho) {
    return request('GET', caminho);
  }

  function post(caminho, corpo) {
    return request('POST', caminho, corpo);
  }

  /* ---------------------------------------------------------------------------
   * Sessão
   * ------------------------------------------------------------------------- */

  /**
   * Retorna o usuário logado ({ id, nome, email }) ou null.
   * @returns {Promise<object|null>}
   */
  async function me() {
    var resultado = await request('GET', '/api/auth/me');
    if (resultado.ok && resultado.data && ehObjetoSimples(resultado.data.usuario)) {
      return resultado.data.usuario;
    }
    return null;
  }

  /**
   * True quando o usuário tem papel de administrador.
   * Aceita também o valor legado "administrador" — o front nunca deve quebrar
   * por causa da grafia do papel.
   * @param {object|null} usuario
   * @returns {boolean}
   */
  function ehAdmin(usuario) {
    var papel = usuario && usuario.papel;
    return papel === 'admin' || papel === 'administrador';
  }

  /**
   * Encerra a sessão no servidor e leva o usuário para a tela de login.
   * O redirecionamento acontece mesmo se a requisição falhar.
   * @param {string} [destino] caminho interno para onde ir depois (padrão: /login.html)
   */
  async function logout(destino) {
    await request('POST', '/api/auth/logout');
    window.location.href = destino || '/login.html';
  }

  /* ---------------------------------------------------------------------------
   * Formatação e segurança
   * ------------------------------------------------------------------------- */

  var formatadorMoeda = null;

  // Fallback manual caso Intl não esteja disponível.
  function formatarManual(valor) {
    var negativo = valor < 0;
    var partes = Math.abs(valor).toFixed(2).split('.');
    var inteiro = partes[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    return (negativo ? '-' : '') + 'R$ ' + inteiro + ',' + partes[1];
  }

  /**
   * Formata um número como moeda brasileira: 1234.9 -> "R$ 1.234,90".
   * (O espaço após "R$" é não separável, para nunca quebrar linha ali.)
   */
  function formatarPreco(valor) {
    var numero = Number(valor);
    if (!Number.isFinite(numero)) numero = 0;

    try {
      if (!formatadorMoeda) {
        formatadorMoeda = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
      }
      return formatadorMoeda.format(numero);
    } catch (erro) {
      return formatarManual(numero);
    }
  }

  var ENTIDADES_HTML = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  };

  /**
   * Escapa um texto para ser inserido com segurança em HTML montado como
   * string (conteúdo ou valor de atributo entre aspas).
   */
  function escapar(valor) {
    if (valor === null || valor === undefined) return '';
    return String(valor).replace(/[&<>"']/g, function (caractere) {
      return ENTIDADES_HTML[caractere];
    });
  }

  /* ---------------------------------------------------------------------------
   * Frete
   * ------------------------------------------------------------------------- */

  /**
   * Frete grátis a partir de R$ 300; abaixo disso, R$ 24,90; sacola vazia, 0.
   * Arredonda o subtotal em centavos antes de comparar (evita 299.9999...).
   */
  function calcularFrete(subtotal) {
    var numero = Number(subtotal);
    if (!Number.isFinite(numero)) return 0;
    numero = Math.round(numero * 100) / 100;
    if (numero <= 0) return 0;
    return numero >= FRETE_GRATIS_MIN ? 0 : FRETE_VALOR;
  }

  /* ---------------------------------------------------------------------------
   * Movimento
   * ------------------------------------------------------------------------- */

  function reduzMovimento() {
    try {
      return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (erro) {
      return false;
    }
  }

  /* ---------------------------------------------------------------------------
   * Toasts (avisos flutuantes)
   * ------------------------------------------------------------------------- */

  // Guarda, para cada toast ativo, as funções que controlam seu temporizador.
  var controlesToast = new WeakMap();

  function obterRaizToast() {
    var raiz = document.getElementById('toast-root');
    if (!raiz) {
      if (!document.body) return null;
      raiz = document.createElement('div');
      raiz.id = 'toast-root';
      document.body.appendChild(raiz);
    }
    if (raiz.getAttribute('aria-live') !== 'polite') {
      raiz.setAttribute('aria-live', 'polite');
    }
    return raiz;
  }

  function dispensarToast(elemento) {
    if (!elemento || elemento.classList.contains('is-leaving')) return;

    var controle = controlesToast.get(elemento);
    if (controle) controle.cancelar();

    elemento.classList.add('is-leaving');

    var removido = false;
    function remover() {
      if (removido) return;
      removido = true;
      controlesToast.delete(elemento);
      if (elemento.parentNode) elemento.parentNode.removeChild(elemento);
    }

    elemento.addEventListener('animationend', function (evento) {
      if (evento.target === elemento) remover();
    });
    // Garantia caso a animação não rode (aba em segundo plano, CSS ausente...).
    setTimeout(remover, 450);
  }

  function criarTemporizador(elemento) {
    var restante = DURACAO_TOAST_MS;
    var inicio = 0;
    var id = null;

    function iniciar() {
      clearTimeout(id);
      inicio = Date.now();
      id = setTimeout(function () { dispensarToast(elemento); }, restante);
    }

    return {
      iniciar: iniciar,
      pausar: function () {
        clearTimeout(id);
        restante = Math.max(restante - (Date.now() - inicio), 0);
      },
      retomar: function () {
        restante = Math.max(restante, 1200); // tempo mínimo para reler
        iniciar();
      },
      reiniciar: function () {
        restante = DURACAO_TOAST_MS;
        iniciar();
      },
      cancelar: function () {
        clearTimeout(id);
      }
    };
  }

  /**
   * Mostra um aviso flutuante na parte de baixo da tela.
   * @param {string} mensagem
   * @param {'info'|'success'|'error'} [tipo='info']
   * @returns {HTMLElement|null} o elemento do toast
   */
  function toast(mensagem, tipo) {
    var tipoFinal = TIPOS_TOAST.indexOf(tipo) !== -1 ? tipo : 'info';
    var texto = mensagem === null || mensagem === undefined ? '' : String(mensagem);
    if (!texto.trim()) return null;

    var raiz = obterRaizToast();
    if (!raiz) {
      // Chamado antes de existir <body>: mostra assim que o documento carregar.
      document.addEventListener('DOMContentLoaded', function () {
        toast(texto, tipoFinal);
      }, { once: true });
      return null;
    }

    var ativos = Array.prototype.slice.call(raiz.querySelectorAll('.toast:not(.is-leaving)'));

    // Mesma mensagem já na tela (ex.: cliques repetidos): reaproveita o aviso.
    for (var i = 0; i < ativos.length; i++) {
      var existente = ativos[i];
      if (existente.getAttribute('data-tipo') === tipoFinal &&
          existente.getAttribute('data-texto') === texto) {
        var controleExistente = controlesToast.get(existente);
        if (controleExistente) controleExistente.reiniciar();
        return existente;
      }
    }

    // Limita a pilha: os mais antigos saem primeiro.
    while (ativos.length >= MAX_TOASTS) {
      dispensarToast(ativos.shift());
    }

    var elemento = document.createElement('div');
    elemento.className = 'toast' + (tipoFinal === 'info' ? '' : ' toast--' + tipoFinal);
    elemento.setAttribute('role', 'status');
    elemento.setAttribute('data-tipo', tipoFinal);
    elemento.setAttribute('data-texto', texto);

    var conteudo = document.createElement('span');
    conteudo.className = 'toast__texto';
    conteudo.textContent = texto;
    elemento.appendChild(conteudo);

    var temporizador = criarTemporizador(elemento);
    controlesToast.set(elemento, temporizador);

    // Passar o mouse pausa o tempo; clicar dispensa na hora.
    elemento.addEventListener('mouseenter', temporizador.pausar);
    elemento.addEventListener('mouseleave', temporizador.retomar);
    elemento.addEventListener('click', function () { dispensarToast(elemento); });

    raiz.appendChild(elemento);
    temporizador.iniciar();

    return elemento;
  }

  /* ---------------------------------------------------------------------------
   * Revelação ao rolar (.reveal -> .is-visible)
   * ------------------------------------------------------------------------- */

  var observadorReveal = null;
  var observados = new Set();

  function aoCruzarViewport(entradas, observador) {
    entradas.forEach(function (entrada) {
      if (!entrada.isIntersecting) return;
      entrada.target.classList.add('is-visible');
      observador.unobserve(entrada.target);
      observados.delete(entrada.target);
    });
  }

  /**
   * Observa todo .reveal ainda não visível dentro de `raiz` e adiciona
   * .is-visible quando ele entra na tela. Pode ser chamado quantas vezes for
   * preciso (ex.: depois de cada nova renderização): elementos já observados
   * ou já visíveis são ignorados.
   *
   * @param {Document|Element} [raiz=document]
   * @returns {IntersectionObserver|null} null quando os elementos foram
   *          revelados na hora (movimento reduzido ou navegador sem suporte)
   */
  function observarReveal(raiz) {
    var base = raiz && typeof raiz.querySelectorAll === 'function' ? raiz : document;

    var elementos = Array.prototype.slice.call(base.querySelectorAll('.reveal:not(.is-visible)'));
    if (base !== document && base.classList &&
        base.classList.contains('reveal') && !base.classList.contains('is-visible')) {
      elementos.push(base);
    }

    if (reduzMovimento() || typeof window.IntersectionObserver !== 'function') {
      elementos.forEach(function (el) { el.classList.add('is-visible'); });
      return null;
    }

    if (!observadorReveal) {
      observadorReveal = new IntersectionObserver(aoCruzarViewport, {
        threshold: 0.12,
        rootMargin: '0px 0px -8% 0px'
      });
    }

    // Limpa elementos removidos do DOM por renderizações anteriores.
    observados.forEach(function (el) {
      if (!el.isConnected) {
        observadorReveal.unobserve(el);
        observados.delete(el);
      }
    });

    elementos.forEach(function (el) {
      if (observados.has(el)) return;
      observados.add(el);
      observadorReveal.observe(el);
    });

    return observadorReveal;
  }

  /* ---------------------------------------------------------------------------
   * Revalidação de tela
   * ------------------------------------------------------------------------- */

  /**
   * Chama `callback` quando vale a pena revalidar a tela com o servidor:
   * quando a aba volta a ficar visível, quando a janela ganha foco, quando a
   * página volta do cache de navegação (bfcache) e, de tempos em tempos,
   * enquanto a aba estiver visível.
   *
   * Por que existe: as páginas públicas carregavam os dados UMA única vez, no
   * load. Quem deixasse a home aberta numa aba nunca via um produto
   * recém-cadastrado — a seção de destaques ficava congelada até um F5.
   *
   * Cuidados embutidos:
   *  - nunca chama com a aba escondida (economiza requisição e evita repintar
   *    o que ninguém está vendo);
   *  - nunca chama com uma revalidação em andamento (nada de requisições
   *    empilhadas quando o usuário alterna de aba rápido);
   *  - junta os eventos que chegam no mesmo instante (`visibilitychange`,
   *    `focus` e `pageshow` disparam juntos ao voltar para a aba) num único
   *    pedido, com um debounce curto;
   *  - ignora os mesmos eventos quando eles fazem parte do próprio
   *    carregamento (`pageshow`/`focus` chegam logo depois do registro) — senão
   *    toda visita faria a requisição duas vezes.
   *
   * O debounce é curto de propósito. Um intervalo mínimo longo parecia
   * econômico, mas engolia justamente o caso que importa: quem carrega a página
   * e volta para a aba poucos segundos depois não recebia atualização nenhuma.
   * Voltar para a aba é um pedido explícito do usuário por dado fresco.
   *
   * A primeira carga sai por aqui por padrão. Páginas que preferem fazê-la
   * sozinhas (para mostrar um estado de "carregando") passam `imediato: false`.
   *
   * @param {() => any} callback
   * @param {{ intervaloMs?: number, debounceMs?: number, imediato?: boolean }} [opcoes]
   *        `intervaloMs: 0` desliga a checagem periódica (só revalida ao voltar);
   *        `imediato: false` não chama o callback no registro.
   * @returns {() => void} função para parar de observar
   */
  function aoRevalidar(callback, opcoes) {
    opcoes = opcoes || {};
    var intervaloMs = opcoes.intervaloMs === undefined ? 60000 : opcoes.intervaloMs;
    var debounceMs = opcoes.debounceMs === undefined ? 200 : opcoes.debounceMs;
    var imediato = opcoes.imediato !== false;

    // Enquanto o carregamento inicial acontece, os eventos de volta ainda são
    // o próprio carregamento — não valem uma segunda requisição.
    var janelaDeCargaMs = 500;
    var registradoEm = Date.now();

    var emAndamento = false;
    var agendado = null;
    var temporizador = null;

    function visivel() {
      return document.visibilityState !== 'hidden';
    }

    function executar() {
      if (emAndamento || !visivel()) return;

      emAndamento = true;
      Promise.resolve()
        .then(callback)
        .catch(function () { /* cada tela trata o próprio erro */ })
        .then(function () { emAndamento = false; });
    }

    // Junta os eventos que chegam juntos numa única revalidação.
    function agendar() {
      if (Date.now() - registradoEm < janelaDeCargaMs) return;
      if (agendado) return;

      agendado = setTimeout(function () {
        agendado = null;
        executar();
      }, debounceMs);
    }

    function aoTrocarVisibilidade() {
      if (visivel()) agendar();
    }

    document.addEventListener('visibilitychange', aoTrocarVisibilidade);
    window.addEventListener('focus', agendar);
    window.addEventListener('pageshow', agendar);

    if (intervaloMs > 0) temporizador = setInterval(executar, intervaloMs);

    if (imediato) executar();

    return function parar() {
      document.removeEventListener('visibilitychange', aoTrocarVisibilidade);
      window.removeEventListener('focus', agendar);
      window.removeEventListener('pageshow', agendar);
      if (agendado) clearTimeout(agendado);
      if (temporizador) clearInterval(temporizador);
    };
  }

  /* ---------------------------------------------------------------------------
   * Exporta
   * ------------------------------------------------------------------------- */

  window.Api = {
    request: request,
    get: get,
    post: post,
    me: me,
    ehAdmin: ehAdmin,
    logout: logout,
    formatarPreco: formatarPreco,
    escapar: escapar,
    toast: toast,
    FRETE_GRATIS_MIN: FRETE_GRATIS_MIN,
    FRETE_VALOR: FRETE_VALOR,
    calcularFrete: calcularFrete,
    observarReveal: observarReveal,
    aoRevalidar: aoRevalidar,
    reduzMovimento: reduzMovimento
  };
})();
