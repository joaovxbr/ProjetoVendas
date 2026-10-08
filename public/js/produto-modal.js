/*
 * produto-modal.js — modal de detalhes do produto.
 *
 *   ProdutoModal.abrir(produto)  -> abre o modal com o produto do card
 *   ProdutoModal.fechar()        -> fecha
 *
 * O modal abre IMEDIATAMENTE com os dados que o card já tem (nome, preço,
 * planos) e, em paralelo, busca GET /api/produtos/:id para completar com a
 * descrição completa, as avaliações recentes e o estado de favorito. Assim o
 * usuário nunca olha para uma tela vazia esperando rede.
 *
 * Depende de window.Api (api.js), window.UI (ui.js) e window.Carrinho (cart.js,
 * só no momento do clique em "adicionar").
 */
(function () {
  'use strict';

  var Api = window.Api;
  var UI = window.UI;
  var esc = Api.escapar;

  var el = {};
  var aberto = false;
  var focoAnterior = null;
  var produtoAtual = null;
  var planoAtual = null;
  var favoritado = false;
  var usuarioLogado = null;      // null enquanto não sabemos
  var usuarioResolvido = false;  // true depois da primeira consulta
  var token = 0;                 // descarta respostas de um produto que já saiu de cena

  /* Montagem --------------------------------------------------------------- */

  function montar() {
    var overlay = document.createElement('div');
    overlay.className = 'modal produto-modal';
    overlay.id = 'modal-produto';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'pm-titulo');
    overlay.hidden = true;

    overlay.innerHTML =
      '<div class="modal__caixa produto-modal__caixa">' +
        '<button class="icon-btn modal__fechar" type="button" data-pm-fechar aria-label="Fechar detalhes">' +
          UI.icone('x') +
        '</button>' +
        '<div class="produto-modal__corpo" data-pm-corpo></div>' +
      '</div>';

    document.body.appendChild(overlay);
    el.overlay = overlay;
    el.caixa = overlay.querySelector('.produto-modal__caixa');
    el.corpo = overlay.querySelector('[data-pm-corpo]');
    el.fechar = overlay.querySelector('[data-pm-fechar]');

    overlay.addEventListener('click', aoClicar);
    overlay.addEventListener('keydown', prenderFoco);
  }

  /* Conteúdo --------------------------------------------------------------- */

  function numero(n) {
    return Number(n || 0).toLocaleString('pt-BR');
  }

  function notaDe(p) {
    return Number(p.avaliacao || 0).toFixed(1);
  }

  function planosHtml(planos) {
    return planos.map(function (pl) {
      var selecionado = pl.id === planoAtual;
      return '<button class="pm-plano" type="button" data-pm-plano="' + esc(pl.id) + '" aria-pressed="' + selecionado + '">' +
        '<span class="pm-plano__nome">' + esc(pl.nome) + '</span>' +
        '<strong class="pm-plano__preco">' + esc(Api.formatarPreco(pl.preco)) + '</strong>' +
      '</button>';
    }).join('');
  }

  function recursosHtml(recursos) {
    if (!recursos || !recursos.length) return '';
    return '<section class="pm__bloco">' +
      '<h3 class="pm__sub">O que está incluído</h3>' +
      '<ul class="pm__recursos">' +
        recursos.map(function (item) {
          return '<li>' + UI.icone('check') + '<span>' + esc(item) + '</span></li>';
        }).join('') +
      '</ul>' +
    '</section>';
  }

  function avaliacoesHtml(lista) {
    if (!lista || !lista.length) return '';
    return '<section class="pm__bloco">' +
      '<h3 class="pm__sub">Avaliações recentes</h3>' +
      '<ul class="pm__avaliacoes">' +
        lista.map(function (a) {
          return '<li class="pm-avaliacao">' +
            '<div class="pm-avaliacao__topo">' +
              '<span class="pm-avaliacao__autor">' + esc(a.autor || 'Cliente') + '</span>' +
              '<span class="pm-avaliacao__nota">' + UI.icone('estrela') + Number(a.nota || 0).toFixed(1) + '</span>' +
            '</div>' +
            (a.comentario ? '<p class="pm-avaliacao__texto">' + esc(a.comentario) + '</p>' : '') +
          '</li>';
        }).join('') +
      '</ul>' +
    '</section>';
  }

  function conteudoHtml(p) {
    var planos = Array.isArray(p.planos) ? p.planos : [];
    var descricao = (p.descricaoLonga && String(p.descricaoLonga).trim()) || p.descricao || '';
    var kicker = [p.linha, p.nivel].filter(Boolean).join(' · ') || p.categoria || '';

    var compra = planos.length
      ? '<div class="pm__compra">' +
          '<div class="pm__planos" role="group" aria-label="Escolha o plano">' + planosHtml(planos) + '</div>' +
          '<div class="pm__acoes">' +
            '<button class="btn btn--primary btn--lg pm__add" type="button" data-pm-add>' +
              UI.icone('carrinho') + '<span>Adicionar ao carrinho</span>' +
            '</button>' +
            '<button class="pm__fav" type="button" data-pm-fav aria-pressed="' + favoritado + '" aria-label="Salvar nos favoritos">' +
              UI.icone('coracao') +
            '</button>' +
          '</div>' +
          '<p class="pm__selo">' + UI.icone('cadeado') + 'Pagamento seguro · Entrega automática</p>' +
        '</div>'
      : '<div class="pm__compra"><p class="pm__indisponivel">Este produto está indisponível no momento.</p></div>';

    return '<div class="pm">' +
      '<div class="pm__midia">' +
        '<div class="pm__capa">' + UI.capa(p) + '</div>' +
        (p.badge ? '<span class="pm__badge">' + esc(p.badge) + '</span>' : '') +
      '</div>' +
      '<div class="pm__info">' +
        (kicker ? '<p class="pm__kicker">' + esc(kicker) + '</p>' : '') +
        '<h2 class="pm__titulo" id="pm-titulo">' + esc(p.nome) + '</h2>' +
        '<p class="pm__nota">' + UI.icone('estrela') + '<strong>' + notaDe(p) + '</strong>' +
          '<span>(' + numero(p.avaliacoes) + ' avaliações)</span></p>' +
        '<dl class="pm__meta">' +
          '<div><dt>Plataforma</dt><dd>' + esc(p.plataforma || 'Windows') + '</dd></div>' +
          '<div><dt>Entrega</dt><dd>' + esc(p.entrega || 'Automática') + '</dd></div>' +
          '<div><dt>Categoria</dt><dd>' + esc(p.categoria || '—') + '</dd></div>' +
        '</dl>' +
        (descricao ? '<section class="pm__bloco"><h3 class="pm__sub">Sobre o produto</h3>' +
          '<p class="pm__descricao">' + esc(descricao) + '</p></section>' : '') +
        recursosHtml(p.recursos) +
        compra +
        avaliacoesHtml(p.avaliacoesRecentes) +
      '</div>' +
    '</div>';
  }

  function render(p) {
    el.corpo.innerHTML = conteudoHtml(p);
    if (aberto) el.fechar.focus();
  }

  /* Abrir / fechar --------------------------------------------------------- */

  function abrir(produto) {
    if (!produto || !produto.id) return;
    if (!el.overlay) montar();

    produtoAtual = produto;
    planoAtual = (produto.planos && produto.planos[0] && produto.planos[0].id) || null;
    favoritado = !!produto.favoritado;

    focoAnterior = document.activeElement;
    aberto = true;
    token += 1;
    var meuToken = token;

    el.overlay.hidden = false;
    document.documentElement.classList.add('no-scroll');
    render(produto);
    setTimeout(function () { if (aberto) el.fechar.focus(); }, 40);

    // Completa com os dados completos (descrição longa, avaliações, favorito).
    // O estado de login não é consultado aqui de propósito: o coração usa o
    // "favoritado" que já vem no detalhe. O Api.me() só roda se o usuário
    // clicar em favoritar, evitando um 401 extra ao abrir o modal.
    Api.get('/api/produtos/' + encodeURIComponent(produto.id)).then(function (resposta) {
      if (!aberto || meuToken !== token) return; // já fechou ou trocou de produto
      if (resposta.ok && resposta.data && resposta.data.id === produto.id) {
        produtoAtual = resposta.data;
        if (planoAtual === null && resposta.data.planos && resposta.data.planos[0]) {
          planoAtual = resposta.data.planos[0].id;
        }
        favoritado = !!resposta.data.favoritado;
        render(produtoAtual);
      }
    });
  }

  function fechar() {
    if (!aberto || !el.overlay) return;
    aberto = false;
    token += 1;
    el.overlay.hidden = true;
    document.documentElement.classList.remove('no-scroll');
    if (focoAnterior && document.contains(focoAnterior)) focoAnterior.focus({ preventScroll: true });
  }

  /* Ações ------------------------------------------------------------------ */

  // Reaproveita o usuário que o ui.js já buscou; só chama a API se preciso.
  function estaLogado() {
    if (usuarioResolvido) return Promise.resolve(!!usuarioLogado);

    if (window.UI && typeof UI.usuarioCarregado === 'function' && UI.usuarioCarregado()) {
      usuarioLogado = (typeof UI.usuario === 'function' ? UI.usuario() : null) || null;
      usuarioResolvido = true;
      return Promise.resolve(!!usuarioLogado);
    }

    return Api.me().then(function (usuario) {
      usuarioLogado = usuario || null;
      usuarioResolvido = true;
      return !!usuarioLogado;
    });
  }

  function adicionarAoCarrinho() {
    if (!produtoAtual) return;
    if (!window.Carrinho) {
      Api.toast('O carrinho não carregou. Recarregue a página.', 'error');
      return;
    }
    var ok = window.Carrinho.adicionar(produtoAtual, planoAtual);
    if (!ok) {
      Api.toast('Não foi possível adicionar este produto', 'error');
      return;
    }
    var nome = produtoAtual.nome;
    fechar();
    window.Carrinho.abrir();
    Api.toast(nome + ' adicionado ao carrinho', 'success');
  }

  async function alternarFavorito() {
    if (!produtoAtual) return;
    if (!(await estaLogado())) {
      Api.toast('Entre na sua conta para salvar nos favoritos');
      return;
    }

    var resposta = await Api.post('/api/favoritos/' + encodeURIComponent(produtoAtual.id) + '/alternar');
    if (!resposta.ok) {
      Api.toast((resposta.data && resposta.data.erro) || 'Não foi possível salvar', 'error');
      return;
    }

    favoritado = !!(resposta.data && resposta.data.favoritado);
    var botao = el.corpo.querySelector('[data-pm-fav]');
    if (botao) botao.setAttribute('aria-pressed', String(favoritado));
    Api.toast(favoritado ? 'Adicionado aos favoritos' : 'Removido dos favoritos', 'success');
  }

  function selecionarPlano(botao) {
    planoAtual = botao.getAttribute('data-pm-plano');
    el.corpo.querySelectorAll('[data-pm-plano]').forEach(function (b) {
      b.setAttribute('aria-pressed', String(b === botao));
    });
  }

  /* Eventos ---------------------------------------------------------------- */

  function aoClicar(evento) {
    if (evento.target === el.overlay) return fechar();

    var botao = evento.target.closest('button');
    if (!botao) return;

    if (botao.hasAttribute('data-pm-fechar')) return fechar();
    if (botao.hasAttribute('data-pm-add')) return adicionarAoCarrinho();
    if (botao.hasAttribute('data-pm-fav')) return alternarFavorito();
    if (botao.hasAttribute('data-pm-plano')) return selecionarPlano(botao);
  }

  function prenderFoco(evento) {
    if (evento.key === 'Escape') return fechar();
    if (evento.key !== 'Tab') return;

    var focaveis = Array.prototype.filter.call(
      el.caixa.querySelectorAll('button:not(:disabled), a[href]'),
      function (n) { return n.offsetParent !== null; }
    );
    if (!focaveis.length) return;

    var primeiro = focaveis[0];
    var ultimo = focaveis[focaveis.length - 1];
    if (evento.shiftKey && document.activeElement === primeiro) {
      evento.preventDefault();
      ultimo.focus();
    } else if (!evento.shiftKey && document.activeElement === ultimo) {
      evento.preventDefault();
      primeiro.focus();
    }
  }

  window.ProdutoModal = {
    abrir: abrir,
    fechar: fechar
  };
})();
