/*
 * ui.js — peças compartilhadas por todas as páginas:
 *   UI.icone(nome)          -> SVG em texto
 *   UI.capa(produto)        -> capa do produto (imagem ou capa gerada)
 *   UI.cartao(produto, op)  -> HTML do card (clique abre o modal do produto)
 *   UI.faixaPreco(produto)  -> "R$ 9,99 ~ R$ 59,99"
 *   UI.usuario()            -> usuário logado (ou null), já consultado uma vez
 *   UI.usuarioCarregado()   -> true depois que a consulta de sessão terminou
 * Também cuida do cabeçalho (usuário logado, menu mobile, link ativo).
 * Depende de window.Api (api.js).
 */
(function () {
  'use strict';

  var Api = window.Api;
  var esc = Api.escapar;

  var PATHS = {
    raio: '<path d="M13 2 4.5 13.5H11L10 22l8.5-11.5H12Z"/>',
    mira: '<circle cx="12" cy="12" r="7.5"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/>',
    teclado: '<rect x="2.5" y="6" width="19" height="12" rx="2.5"/><path d="M6.5 10h.01M10 10h.01M13.5 10h.01M17 10h.01M7.5 14h9"/>',
    camadas: '<path d="m12 3 9.5 5-9.5 5-9.5-5Z"/><path d="m2.5 13 9.5 5 9.5-5"/>',
    vassoura: '<path d="m14.5 3.5 6 6"/><path d="M17.5 6.5 12 12"/><path d="M12 12c-3-1-6 0-8 3.5L3 21l5.5-1c3.5-2 4.5-5 3.5-8Z"/>',
    chip: '<rect x="6" y="6" width="12" height="12" rx="2"/><rect x="9.5" y="9.5" width="5" height="5" rx="1"/><path d="M9.5 2.5V6M14.5 2.5V6M9.5 18v3.5M14.5 18v3.5M2.5 9.5H6M2.5 14.5H6M18 9.5h3.5M18 14.5h3.5"/>',
    sinal: '<path d="M4.5 10.5a11 11 0 0 1 15 0"/><path d="M8 14a6 6 0 0 1 8 0"/><path d="M12 18h.01"/>',
    escudo: '<path d="M12 3 20 6v6c0 4.8-3.4 8-8 9-4.6-1-8-4.2-8-9V6Z"/><path d="m9 12 2 2 4-4"/>',
    carrinho: '<path d="M3 4h2l2.4 11h10.9l2-8H6.2"/><circle cx="9.5" cy="19.5" r="1.3"/><circle cx="17.5" cy="19.5" r="1.3"/>',
    estrela: '<path fill="currentColor" stroke="none" d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9Z"/>',
    seta: '<path d="M5 12h14"/><path d="m13 6 6 6-6 6"/>',
    play: '<path fill="currentColor" stroke="none" d="M8 5.5v13a1 1 0 0 0 1.5.9l10.4-6.5a1 1 0 0 0 0-1.8L9.5 4.6A1 1 0 0 0 8 5.5Z"/>',
    check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
    x: '<path d="M6 6l12 12M18 6 6 18"/>',
    mais: '<path d="M12 5v14M5 12h14"/>',
    menos: '<path d="M5 12h14"/>',
    lixeira: '<path d="M4 7h16M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13"/>',
    copiar: '<rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3"/>',
    pacote: '<path d="m3 7.5 9-4.5 9 4.5v9L12 21l-9-4.5Z"/><path d="m3 7.5 9 4.5 9-4.5M12 12v9"/>',
    suporte: '<path d="M4 14v-2a8 8 0 0 1 16 0v2"/><rect x="3" y="13" width="4" height="6" rx="1.5"/><rect x="17" y="13" width="4" height="6" rx="1.5"/><path d="M19 19c0 1.5-2 2.5-5 2.5"/>',
    cadeado: '<rect x="5" y="11" width="14" height="10" rx="2.5"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
    atualizar: '<path d="M20 11a8 8 0 0 0-14.3-4.9L4 8"/><path d="M4 3.5V8h4.5"/><path d="M4 13a8 8 0 0 0 14.3 4.9L20 16"/><path d="M20 20.5V16h-4.5"/>',
    chat: '<path d="M4 5h16v11H9.5L5 20v-4H4Z"/><path d="M8.5 10.5h.01M12 10.5h.01M15.5 10.5h.01"/>',
    cartao: '<rect x="2.5" y="5" width="19" height="14" rx="2.5"/><path d="M2.5 10h19M6.5 15h4"/>',
    boleto: '<path d="M4 6v12M7 6v12M10 6v12M13 6v12M16 6v12M20 6v12"/>',
    busca: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>',
    menu: '<path d="M4 7h16M4 12h16M4 17h10"/>',
    tag: '<path d="M3 12.5V4h8.5L21 13.5 13.5 21Z"/><circle cx="7.5" cy="8" r="1.3"/>',
    relogio: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
    coracao: '<path d="M12 20.3 4.6 13a4.7 4.7 0 0 1 7.4-5.8 4.7 4.7 0 0 1 7.4 5.8Z"/>',
    usuario: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4-6 8-6s7 2 8 6"/>'
  };

  function icone(nome, classe) {
    return '<svg' + (classe ? ' class="' + classe + '"' : '') +
      ' viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
      (PATHS[nome] || PATHS.raio) + '</svg>';
  }

  /* Produtos ------------------------------------------------------------- */

  var registro = new Map(); // id -> produto (para o clique achar o objeto)

  function capa(p) {
    if (p.imagem) {
      return '<img src="' + esc(p.imagem) + '" alt="' + esc(p.nome) + '" loading="lazy" decoding="async">';
    }
    var icon = (p.capa && p.capa.icone) || 'raio';
    return '<div class="capa" role="img" aria-label="' + esc(p.nome) + '">' +
      '<span class="capa__icone">' + icone(icon) + '</span>' +
      '<p class="capa__linha">' + esc(p.linha || p.categoria) + '</p>' +
      '<p class="capa__nivel">' + esc(p.nivel || '') + '</p>' +
    '</div>';
  }

  function faixaPreco(p) {
    var min = Api.formatarPreco(p.precoMin);
    if (p.precoMin === p.precoMax) return min;
    return min + ' ~ ' + Api.formatarPreco(p.precoMax);
  }

  function formatarNumero(n) {
    return Number(n || 0).toLocaleString('pt-BR');
  }

  function cartao(p, opcoes) {
    opcoes = opcoes || {};
    registro.set(p.id, p);
    var planos = Array.isArray(p.planos) ? p.planos : [];
    var legenda = planos.length > 1 ? planos.length + ' planos disponíveis' : (planos[0] ? 'Licença ' + planos[0].nome.toLowerCase() : '');

    return '<article class="card-produto reveal" data-delay="' + (opcoes.atraso || 0) + '">' +
      '<div class="card-produto__midia">' + capa(p) + '</div>' +
      (p.badge ? '<span class="card-produto__badge">' + esc(p.badge) + '</span>' : '') +
      '<div class="card-produto__corpo">' +
        '<h3 class="card-produto__nome">' + esc(p.nome) + '</h3>' +
        '<p class="card-produto__nota">' + icone('estrela') + '<strong>' + Number(p.avaliacao || 0).toFixed(1) + '</strong>' +
          '<span>(' + formatarNumero(p.avaliacoes) + ' avaliações)</span></p>' +
        '<dl class="card-produto__meta">' +
          '<div><dt>Plataforma</dt><dd>' + esc(p.plataforma) + '</dd></div>' +
          '<div><dt>Entrega</dt><dd>' + esc(p.entrega) + '</dd></div>' +
        '</dl>' +
        '<div class="card-produto__rodape">' +
          '<p class="card-produto__preco">' + esc(faixaPreco(p)) + '<small>' + esc(legenda) + '</small></p>' +
          '<button class="card-produto__add" type="button" data-add-rapido="' + esc(p.id) + '" aria-label="Adicionar ' +
            esc(p.nome) + ' ao carrinho">' + icone('mais') + '</button>' +
        '</div>' +
      '</div>' +
      '<button class="card-produto__hit" type="button" data-produto-id="' + esc(p.id) + '" aria-label="Ver detalhes de ' +
        esc(p.nome) + '"></button>' +
    '</article>';
  }

  // Adiciona direto ao carrinho (botão "+" do card e fallback do clique).
  function adicionarRapido(id, gatilho) {
    var p = registro.get(id);
    if (!p) return;
    if (!window.Carrinho) {
      Api.toast('O carrinho não carregou. Recarregue a página.', 'error');
      return;
    }
    window.Carrinho.adicionar(p);
    window.Carrinho.abrir();
    Api.toast(p.nome + ' adicionado ao carrinho', 'success');
    var card = gatilho && gatilho.closest && gatilho.closest('.card-produto');
    if (card) {
      card.classList.add('is-adicionado');
      setTimeout(function () { card.classList.remove('is-adicionado'); }, 900);
    }
  }

  // Clique no card: abre o modal de detalhes. O botão "+" adiciona direto.
  document.addEventListener('click', function (evento) {
    var rapido = evento.target.closest && evento.target.closest('[data-add-rapido]');
    if (rapido) {
      evento.preventDefault();
      return adicionarRapido(rapido.getAttribute('data-add-rapido'), rapido);
    }

    var alvo = evento.target.closest && evento.target.closest('[data-produto-id]');
    if (!alvo) return;
    var p = registro.get(alvo.getAttribute('data-produto-id'));
    if (!p) return;

    // Sem o modal carregado, o clique continua adicionando (nunca fica sem ação).
    if (window.ProdutoModal) return window.ProdutoModal.abrir(p);
    adicionarRapido(p.id, alvo);
  });

  /* Cabeçalho ------------------------------------------------------------ */

  // Link ativo conforme <body data-pagina="...">
  var pagina = document.body.getAttribute('data-pagina');
  if (pagina) {
    document.querySelectorAll('[data-nav="' + pagina + '"]').forEach(function (link) {
      link.classList.add('is-active');
      link.setAttribute('aria-current', 'page');
    });
  }

  // Menu mobile
  var btnMenu = document.getElementById('btn-menu');
  var menu = document.getElementById('menu-mobile');
  if (btnMenu && menu) {
    var alternar = function (abrir) {
      menu.hidden = !abrir;
      btnMenu.setAttribute('aria-expanded', String(abrir));
      btnMenu.innerHTML = icone(abrir ? 'x' : 'menu');
    };
    btnMenu.addEventListener('click', function () { alternar(menu.hidden); });
    menu.addEventListener('click', function (evento) {
      if (evento.target.closest('a')) alternar(false);
    });
    document.addEventListener('keydown', function (evento) {
      if (evento.key === 'Escape' && !menu.hidden) alternar(false);
    });
  }

  // Usuário logado: troca "Entrar / Registrar" pelo avatar
  function htmlUsuario(usuario) {
    var nome = String(usuario.nome || '').trim();
    var partes = nome.split(/\s+/);
    var iniciais = ((partes[0] || '').charAt(0) + (partes.length > 1 ? partes[partes.length - 1].charAt(0) : '')).toUpperCase();
    return '<div class="usuario">' +
      // Admin entra no painel por um atalho no cabeçalho — sem digitar /admin.
      (Api.ehAdmin(usuario)
        ? '<a class="usuario__admin" href="/admin" title="Ir para o painel administrativo" aria-label="Painel administrativo">' +
            icone('escudo') + '<span class="usuario__admin-txt">Painel</span>' +
          '</a>'
        : '') +
      '<a class="usuario__conta" href="/conta" title="Minha conta" aria-label="Minha conta">' +
        '<span class="usuario__avatar" aria-hidden="true">' + esc(iniciais || '?') + '</span>' +
        '<span class="usuario__nome">' + esc(partes[0] || 'Cliente') + '</span>' +
      '</a>' +
      '<button class="usuario__sair" type="button" data-sair>Sair</button>' +
    '</div>';
  }

  // Estado do usuário logado — compartilhado com quem precisar (ex.: o modal
  // de produto), para não repetir a consulta a /api/auth/me em cada módulo.
  var estadoUsuario = { carregado: false, usuario: null };

  Api.me().then(function (usuario) {
    estadoUsuario.carregado = true;
    estadoUsuario.usuario = usuario || null;
    if (!usuario) return;
    document.querySelectorAll('[data-area-usuario]').forEach(function (area) {
      area.innerHTML = htmlUsuario(usuario);
    });
  });

  document.addEventListener('click', function (evento) {
    var sair = evento.target.closest && evento.target.closest('[data-sair]');
    if (!sair) return;
    sair.disabled = true;
    Api.logout();
  });

  window.UI = {
    icone: icone,
    capa: capa,
    cartao: cartao,
    faixaPreco: faixaPreco,
    usuario: function () { return estadoUsuario.usuario; },
    usuarioCarregado: function () { return estadoUsuario.carregado; }
  };
})();
