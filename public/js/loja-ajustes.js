/*
 * loja-ajustes.js — aplica na vitrine o que o admin salva em "Configurações":
 *   - aviso no topo   -> faixa acima do cabeçalho (o cliente pode fechar)
 *   - destaque da home -> chamada no topo da página inicial ([data-destaque-home])
 *   - suporte          -> links de e-mail e Discord ([data-suporte])
 *   - manutenção       -> tela cheia para clientes; faixa de alerta para admins
 *
 * Lê /api/loja/ajustes (rota que continua no ar durante a manutenção) ao abrir,
 * ao voltar para a aba e a cada 20 s, então uma mudança no painel aparece sem
 * recarregar. Depende de Api (api.js).
 */
(function () {
  'use strict';

  var Api = window.Api;
  if (!Api) return;
  var esc = Api.escapar;

  var INTERVALO_MS = 20000;
  var CHAVE_AVISO_FECHADO = 'nexus:aviso-topo-fechado';
  var URL_SEGURA = /^https?:\/\//i;

  var SVG = {
    megafone: '<path d="M3 10v4a1 1 0 0 0 1 1h3l5 4V5L7 9H4a1 1 0 0 0-1 1Z"/><path d="M16 8.5a5 5 0 0 1 0 7"/><path d="M19 6a8.5 8.5 0 0 1 0 12"/>',
    ferramenta: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4l-5.8 5.8a1.8 1.8 0 0 0 2.5 2.5l5.8-5.8a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4Z"/>',
    email: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="m4 7 8 6 8-6"/>',
    chat: '<path d="M4 5h16v11H9.5L5 20v-4H4Z"/><path d="M8.5 10.5h.01M12 10.5h.01M15.5 10.5h.01"/>',
    x: '<path d="M6 6l12 12M18 6 6 18"/>'
  };

  function icone(nome) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"' +
      ' stroke-linejoin="round" aria-hidden="true" focusable="false">' + SVG[nome] + '</svg>';
  }

  var estado = { dados: null, ultimo: null, bloqueada: false, inertes: [] };

  /* Aviso fechado pelo cliente: vale para a sessão e só para aquele texto. */
  function avisoFechado(texto) {
    try { return sessionStorage.getItem(CHAVE_AVISO_FECHADO) === texto; } catch (erro) { return false; }
  }

  function lembrarAvisoFechado(texto) {
    try { sessionStorage.setItem(CHAVE_AVISO_FECHADO, texto); } catch (erro) { /* sem storage: só some agora */ }
  }

  /* Faixas acima do cabeçalho ------------------------------------------- */

  function faixaAvisoHtml(texto) {
    return '<div class="lj-faixa lj-faixa--aviso" role="region" aria-label="Aviso da loja">' +
      '<div class="container lj-faixa__barra">' +
        '<p class="lj-faixa__conteudo"><span class="lj-faixa__icone">' + icone('megafone') + '</span>' +
          '<span class="lj-faixa__txt">' + esc(texto) + '</span></p>' +
        '<button class="lj-faixa__fechar" type="button" data-fechar-aviso aria-label="Fechar aviso">' + icone('x') + '</button>' +
      '</div>' +
    '</div>';
  }

  function faixaAdminHtml() {
    return '<div class="lj-faixa lj-faixa--alerta" role="status">' +
      '<div class="container lj-faixa__barra">' +
        '<p class="lj-faixa__conteudo"><span class="lj-faixa__icone">' + icone('ferramenta') + '</span>' +
          '<span class="lj-faixa__txt"><strong>Modo manutenção ligado.</strong> Só administradores veem a loja agora.</span></p>' +
        '<a class="lj-faixa__link" href="/admin#/configuracoes">Desligar</a>' +
      '</div>' +
    '</div>';
  }

  function pintarFaixas(d, adminEmManutencao) {
    var cabecalho = document.querySelector('.site-header');
    if (!cabecalho) return; // páginas sem o cabeçalho da loja (ex.: conta)

    var aviso = d.avisoTopo && !avisoFechado(d.avisoTopo) ? faixaAvisoHtml(d.avisoTopo) : '';
    var html = (adminEmManutencao ? faixaAdminHtml() : '') + aviso;

    var area = document.getElementById('lj-faixas');
    if (!area) {
      area = document.createElement('div');
      area.id = 'lj-faixas';
      cabecalho.parentNode.insertBefore(area, cabecalho);
    }
    if (area.getAttribute('data-html') === html) return;
    area.innerHTML = html;
    area.setAttribute('data-html', html);
  }

  /* Destaque da home e suporte ------------------------------------------- */

  function pintarDestaque(texto) {
    document.querySelectorAll('[data-destaque-home]').forEach(function (el) {
      el.hidden = !texto;
      var alvo = el.querySelector('[data-destaque-texto]');
      if (alvo && alvo.textContent !== texto) alvo.textContent = texto;
    });
  }

  function linksSuporteHtml(s) {
    var links = [];
    if (s.email) {
      links.push('<a class="lj-suporte__link" href="mailto:' + esc(s.email) + '">' + icone('email') +
        '<span>' + esc(s.email) + '</span></a>');
    }
    if (s.discord && URL_SEGURA.test(s.discord)) {
      links.push('<a class="lj-suporte__link" href="' + esc(s.discord) + '" target="_blank" rel="noopener noreferrer">' +
        icone('chat') + '<span>Discord</span><span class="visually-hidden"> (abre em nova aba)</span></a>');
    }
    return links.join('');
  }

  function pintarSuporte(s) {
    var html = linksSuporteHtml(s);
    document.querySelectorAll('[data-suporte]').forEach(function (el) {
      var bloco = el.closest('[data-suporte-bloco]') || el;
      bloco.hidden = !html;
      if (el.getAttribute('data-html') === html) return;
      el.innerHTML = html;
      el.setAttribute('data-html', html);
    });
  }

  /* Tela de manutenção ---------------------------------------------------- */

  function telaManutencaoHtml(m, s) {
    var suporte = linksSuporteHtml(s);
    var voltar = encodeURIComponent(window.location.pathname || '/');
    return '<div class="lj-manutencao__caixa">' +
      '<span class="lj-manutencao__icone">' + icone('ferramenta') + '</span>' +
      '<h1 class="lj-manutencao__titulo" id="lj-manutencao-titulo">Loja em manutenção</h1>' +
      '<p class="lj-manutencao__txt" id="lj-manutencao-txt">' + esc(m.texto) + '</p>' +
      (suporte
        ? '<div class="lj-manutencao__suporte"><p>Precisa de ajuda agora?</p>' +
            '<div class="lj-suporte lj-suporte--chips">' + suporte + '</div></div>'
        : '') +
      '<div class="lj-manutencao__acoes">' +
        '<button class="btn btn--primary" type="button" data-manutencao-tentar>Tentar de novo</button>' +
        '<a class="btn btn--ghost" href="/login?next=' + voltar + '">Sou administrador</a>' +
      '</div>' +
      '<p class="lj-manutencao__nota" data-manutencao-status role="status" aria-live="polite">' +
        'A página volta sozinha assim que a loja estiver no ar.</p>' +
    '</div>';
  }

  // O resto da página sai do alcance do teclado e do leitor de tela.
  function travarPagina(tela) {
    estado.inertes = Array.prototype.filter.call(document.body.children, function (el) {
      return el !== tela && !el.hasAttribute('inert') && el.id !== 'toast-root';
    });
    estado.inertes.forEach(function (el) { el.setAttribute('inert', ''); });
    document.documentElement.classList.add('no-scroll');
  }

  function mostrarManutencao(m, s) {
    var tela = document.getElementById('lj-manutencao');
    var html = telaManutencaoHtml(m, s);
    if (!tela) {
      tela = document.createElement('div');
      tela.id = 'lj-manutencao';
      tela.className = 'lj-manutencao';
      tela.setAttribute('role', 'alertdialog');
      tela.setAttribute('aria-modal', 'true');
      tela.setAttribute('aria-labelledby', 'lj-manutencao-titulo');
      tela.setAttribute('aria-describedby', 'lj-manutencao-txt');
      document.body.appendChild(tela);
      travarPagina(tela);
    }
    if (tela.getAttribute('data-html') !== html) {
      tela.innerHTML = html;
      tela.setAttribute('data-html', html);
    }
    if (!estado.bloqueada) tela.querySelector('[data-manutencao-tentar]').focus();
    estado.bloqueada = true;
  }

  // A loja voltou: recarrega, porque o que a página pediu durante a
  // manutenção (produtos, carrinho...) voltou com erro 503.
  function liberarLoja() {
    estado.bloqueada = false;
    window.location.reload();
  }

  /* Aplicação ------------------------------------------------------------ */

  function aplicar(d) {
    var chave = JSON.stringify(d);
    if (chave === estado.ultimo) return;
    estado.ultimo = chave;
    estado.dados = d;

    var m = d.manutencao || {};
    var suporte = d.suporte || {};
    pintarFaixas(d, Boolean(m.ativo && m.liberado));
    pintarDestaque(String(d.destaqueHome || ''));
    pintarSuporte(suporte);

    if (m.ativo && !m.liberado) mostrarManutencao(m, suporte);
    else if (estado.bloqueada) liberarLoja();
  }

  function carregar() {
    return Api.get('/api/loja/ajustes').then(function (r) {
      // Falha de rede: mantém o que já está na tela.
      if (r.ok && r.data && typeof r.data === 'object') aplicar(r.data);
    });
  }

  function tentarDeNovo(botao) {
    botao.disabled = true;
    carregar().then(function () {
      botao.disabled = false;
      var status = document.querySelector('[data-manutencao-status]');
      if (estado.bloqueada && status) status.textContent = 'Ainda em manutenção. Tentamos de novo sozinhos em instantes.';
    });
  }

  function fecharAviso() {
    if (!estado.dados) return;
    lembrarAvisoFechado(estado.dados.avisoTopo);
    var m = estado.dados.manutencao || {};
    pintarFaixas(estado.dados, Boolean(m.ativo && m.liberado));
  }

  document.addEventListener('click', function (evento) {
    var alvo = evento.target.closest && evento.target.closest('[data-fechar-aviso],[data-manutencao-tentar]');
    if (!alvo) return;
    if (alvo.hasAttribute('data-fechar-aviso')) fecharAviso();
    else tentarDeNovo(alvo);
  });

  Api.aoRevalidar(carregar, { intervaloMs: INTERVALO_MS });
})();
