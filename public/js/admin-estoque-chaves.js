/*
 * public/js/admin-estoque-chaves.js
 * -----------------------------------------------------------------------------
 * Gaveta "Chaves do plano" do painel: lista as chaves de um plano com filtro por
 * situação, busca, seleção e as ações de remover (descartar) e excluir.
 *
 * A gaveta vive fora de #conteudo (num overlay no <body>), então os cliques da
 * delegação "data-acao" do admin.js não chegam aqui: os eventos são ligados na
 * própria gaveta. Carregado depois de admin-ui.js; expõe window.AdminChavesEstoque.
 */
(function () {
  'use strict';

  var UI = window.AdminUI;
  var esc = UI.esc;

  // Teto da API de listagem (paginacao limiteMax da rota /estoque/chaves).
  var LIMITE = 500;
  var DURACAO_DESTAQUE = 1600;
  var ATRASO_BUSCA = 200;

  var FILTROS = [
    { valor: 'todas', rotulo: 'Todas' },
    { valor: 'disponivel', rotulo: 'Disponíveis' },
    { valor: 'vendida', rotulo: 'Vendidas' },
    { valor: 'descartada', rotulo: 'Descartadas' },
    { valor: 'revogada', rotulo: 'Revogadas' }
  ];

  // Vendidas e revogadas pertencem a pedidos: ficam travadas no histórico.
  function podeExcluir(c) { return c.status === 'disponivel' || c.status === 'descartada'; }
  function podeRemover(c) { return c.status === 'disponivel'; }

  var ACOES = {
    remover: {
      rota: '/api/admin/estoque/chaves/descartar',
      titulo: 'Remover do estoque',
      confirmar: 'Remover',
      aceita: podeRemover,
      texto: function (n) {
        return n + ' chave(s) deixarão de ser vendidas e ficarão no histórico como descartadas. Você ainda pode excluí-las depois.';
      },
      sucesso: function (d) { return d.removidas + ' chave(s) removida(s) do estoque'; }
    },
    excluir: {
      rota: '/api/admin/estoque/chaves/excluir',
      titulo: 'Excluir definitivamente',
      confirmar: 'Excluir',
      aceita: podeExcluir,
      texto: function (n) {
        return n + ' chave(s) serão apagadas de vez. Essa ação não pode ser desfeita.';
      },
      sucesso: function (d) { return d.excluidas + ' chave(s) excluída(s) definitivamente'; }
    }
  };

  function erroDe(r) {
    return (r && r.data && r.data.erro) || 'Não foi possível concluir a operação.';
  }

  function mapaDeIds(ids) {
    return ids.reduce(function (mapa, id) {
      var novo = Object.assign({}, mapa);
      novo[id] = true;
      return novo;
    }, {});
  }

  /* ---------------------------------------------------------------------------
   * Estado derivado
   * ------------------------------------------------------------------------- */

  function contem(texto, termo) { return String(texto || '').toLowerCase().indexOf(termo) !== -1; }

  function visiveis(estado) {
    var termo = estado.busca.toLowerCase();
    return estado.chaves.filter(function (c) {
      if (estado.filtro !== 'todas' && c.status !== estado.filtro) return false;
      return !termo || contem(c.chave, termo) || contem(c.lote, termo) || contem(c.vendaNumero, termo);
    });
  }

  function selecionadas(estado) {
    return estado.chaves.filter(function (c) { return estado.selecionadas[c.id]; });
  }

  /** Seleção vale só para o que está na tela: evita apagar algo escondido pelo filtro. */
  function podar(estado) {
    var editaveis = visiveis(estado).filter(podeExcluir);
    var mantidas = editaveis.filter(function (c) { return estado.selecionadas[c.id]; });
    return Object.assign({}, estado, { selecionadas: mapaDeIds(mantidas.map(function (c) { return c.id; })) });
  }

  function contar(chaves) {
    return FILTROS.reduce(function (acc, f) {
      var total = f.valor === 'todas' ? chaves.length : chaves.filter(function (c) { return c.status === f.valor; }).length;
      var novo = Object.assign({}, acc);
      novo[f.valor] = total;
      return novo;
    }, {});
  }

  /* ---------------------------------------------------------------------------
   * HTML
   * ------------------------------------------------------------------------- */

  function htmlEstrutura() {
    return '<div class="adm-ck">' +
      '<div class="adm-ck__filtros" role="group" aria-label="Filtrar por situação" data-ck-filtros></div>' +
      '<span class="adm-barra__campo adm-ck__busca">' + UI.icone('busca') +
        '<input class="field__input" type="search" placeholder="Buscar chave, lote ou pedido…" aria-label="Buscar chave, lote ou pedido" data-ck-busca data-foco>' +
      '</span>' +
      '<p class="adm-ck__status" role="status" aria-live="polite" data-ck-status></p>' +
      '<div data-ck-lista>' + UI.esqueletoLinhas(6) + '</div>' +
      '<p class="adm-ck__legenda">' + UI.icone('info') +
        '<span><strong>Remover</strong> tira a chave da venda e a mantém no histórico como descartada. ' +
        '<strong>Excluir</strong> apaga de vez. Chaves vendidas e revogadas ficam travadas porque pertencem a pedidos.</span>' +
      '</p>' +
    '</div>';
  }

  function htmlFiltros(estado) {
    var contagem = contar(estado.chaves);
    return FILTROS.map(function (f) {
      var ativo = estado.filtro === f.valor;
      return '<button type="button" class="adm-ck__filtro' + (ativo ? ' is-active' : '') + '" data-ck-filtro="' + f.valor + '" aria-pressed="' + ativo + '">' +
        esc(f.rotulo) + '<b>' + UI.numero(contagem[f.valor]) + '</b></button>';
    }).join('');
  }

  function botaoLinha(acao, c, icone, rotulo, classe) {
    return '<button class="icon-btn' + (classe ? ' ' + classe : '') + '" type="button" data-ck-acao="' + acao + '" data-id="' + esc(c.id) + '"' +
      ' aria-label="' + esc(rotulo + ' ' + c.chave) + '" title="' + esc(rotulo) + '">' + UI.icone(icone) + '</button>';
  }

  function htmlMarca(c, marcada) {
    if (!podeExcluir(c)) {
      return '<span class="adm-ck__marca" title="Chave ligada a um pedido: não pode ser alterada">' +
        '<input type="checkbox" disabled aria-label="' + esc('Chave ' + c.chave + ' travada') + '"></span>';
    }
    return '<label class="adm-ck__marca">' +
      '<input type="checkbox" data-ck-marcar="' + esc(c.id) + '"' + (marcada ? ' checked' : '') +
      ' aria-label="' + esc('Selecionar ' + c.chave) + '"></label>';
  }

  function htmlLinha(c, estado) {
    var marcada = !!estado.selecionadas[c.id];
    var meta = 'Entrada ' + UI.dataCurta(c.criadaEm) +
      (c.lote ? ' · lote ' + c.lote : '') +
      (c.vendaNumero ? ' · pedido ' + c.vendaNumero : '');
    var classes = 'adm-ck__linha' + (marcada ? ' is-marcada' : '') +
      (estado.destaque[c.id] ? ' is-atualizada' : '') + (podeExcluir(c) ? '' : ' is-travada');

    return '<li class="' + classes + '" data-ck-id="' + esc(c.id) + '">' +
      htmlMarca(c, marcada) +
      '<div class="adm-ck__info">' +
        '<code>' + esc(c.chave) + '</code>' +
        '<span class="adm-ck__meta">' + UI.seloEstoqueChave(c.status) + '<span>' + esc(meta) + '</span></span>' +
      '</div>' +
      '<div class="adm-ck__botoes">' +
        botaoLinha('copiar', c, 'copiar', 'Copiar') +
        (podeRemover(c) ? botaoLinha('remover', c, 'menos', 'Remover do estoque', 'adm-ck__perigo') : '') +
        (podeExcluir(c) ? botaoLinha('excluir', c, 'lixeira', 'Excluir definitivamente', 'adm-ck__perigo') : '') +
      '</div>' +
    '</li>';
  }

  function htmlLista(estado) {
    if (!estado.chaves.length) {
      return UI.estado({ titulo: 'Nenhuma chave neste plano', texto: 'Use "Entrada" na tabela de estoque para adicionar chaves.', icone: 'chave' });
    }
    var lista = visiveis(estado);
    if (!lista.length) {
      return UI.estado({ titulo: 'Nenhuma chave encontrada', texto: 'Ajuste o filtro ou a busca.', icone: 'busca' });
    }
    var nota = estado.total > estado.chaves.length
      ? '<p class="adm-ck__nota">Mostrando as ' + UI.numero(estado.chaves.length) + ' chaves mais recentes de ' + UI.numero(estado.total) + '.</p>'
      : '';
    return '<ul class="adm-ck__lista">' + lista.map(function (c) { return htmlLinha(c, estado); }).join('') + '</ul>' + nota;
  }

  function htmlBarra(estado) {
    var editaveis = visiveis(estado).filter(podeExcluir);
    var marcadas = selecionadas(estado);
    var nRemover = marcadas.filter(podeRemover).length;
    var todas = editaveis.length > 0 && marcadas.length === editaveis.length;
    var rotulo = marcadas.length
      ? '<strong>' + UI.numero(marcadas.length) + '</strong> selecionada(s)'
      : 'Selecionar todas';

    return '<label class="adm-ck__todas">' +
        '<input type="checkbox" data-ck-todas' + (todas ? ' checked' : '') + (editaveis.length ? '' : ' disabled') +
        ' aria-label="Selecionar todas as chaves editáveis visíveis"><span>' + rotulo + '</span>' +
      '</label>' +
      '<button class="btn btn--soft btn--sm" type="button" data-ck-lote="remover"' + (nRemover ? '' : ' disabled') + '>' +
        UI.icone('menos') + '<span>Remover' + (nRemover ? ' (' + nRemover + ')' : '') + '</span></button>' +
      '<button class="btn btn--sm adm-ck__btn-perigo" type="button" data-ck-lote="excluir"' + (marcadas.length ? '' : ' disabled') + '>' +
        UI.icone('lixeira') + '<span>Excluir' + (marcadas.length ? ' (' + marcadas.length + ')' : '') + '</span></button>';
  }

  /* ---------------------------------------------------------------------------
   * Desenho e carga
   * ------------------------------------------------------------------------- */

  function parte(ctx, nome) { return ctx.caixa.querySelector('[data-ck-' + nome + ']'); }
  function aberta(ctx) { return !!ctx.caixa && document.body.contains(ctx.caixa); }

  function desenhar(ctx) {
    var estado = ctx.estado;
    parte(ctx, 'filtros').innerHTML = htmlFiltros(estado);
    parte(ctx, 'lista').innerHTML = htmlLista(estado);
    parte(ctx, 'barra').innerHTML = htmlBarra(estado);

    // "Selecionar todas" fica parcial quando só parte das visíveis está marcada.
    var todas = parte(ctx, 'todas');
    var marcadas = selecionadas(estado).length;
    if (todas) todas.indeterminate = marcadas > 0 && !todas.checked;
  }

  function avisar(ctx, texto) {
    if (aberta(ctx)) parte(ctx, 'status').textContent = texto;
  }

  function mostrarErro(ctx, r) {
    parte(ctx, 'lista').innerHTML = UI.estado({
      tipo: 'erro',
      titulo: 'Erro ao carregar as chaves',
      texto: erroDe(r),
      icone: 'aviso',
      acao: '<button class="btn btn--soft btn--sm" type="button" data-ck-tentar>' + UI.icone('atualizar') + 'Tentar de novo</button>'
    });
  }

  function carregar(ctx) {
    var url = '/api/admin/estoque/chaves?limite=' + LIMITE +
      '&produtoId=' + encodeURIComponent(ctx.alvo.produtoId) +
      '&planoId=' + encodeURIComponent(ctx.alvo.planoId);

    return Api.request('GET', url).then(function (r) {
      if (!aberta(ctx)) return;
      if (!r.ok) { mostrarErro(ctx, r); return; }
      ctx.estado = podar(Object.assign({}, ctx.estado, {
        chaves: r.data.chaves || [],
        total: r.data.total || 0
      }));
      desenhar(ctx);
    });
  }

  function atualizarEstado(ctx, mudancas) {
    ctx.estado = podar(Object.assign({}, ctx.estado, mudancas));
    desenhar(ctx);
  }

  /* ---------------------------------------------------------------------------
   * Operações
   * ------------------------------------------------------------------------- */

  function ocupar(ctx, ocupado, botao, ids) {
    ctx.estado = Object.assign({}, ctx.estado, { ocupado: ocupado });
    ctx.caixa.classList.toggle('is-ocupada', ocupado);
    if (botao) {
      botao.classList.toggle('is-carregando', ocupado);
      botao.disabled = ocupado;
    }
    ids.forEach(function (id) {
      var linha = ctx.caixa.querySelector('[data-ck-id="' + id + '"]');
      if (linha) linha.classList.toggle('is-processando', ocupado);
    });
  }

  function concluir(ctx, nome, ids, r) {
    var acao = ACOES[nome];
    if (!r.ok) {
      Api.toast(erroDe(r), 'error');
      avisar(ctx, erroDe(r));
      return;
    }
    var ignoradas = r.data.ignoradas || 0;
    var mensagem = acao.sucesso(r.data) + (ignoradas ? ' · ' + ignoradas + ' ignorada(s)' : '');
    Api.toast(mensagem, 'success');
    avisar(ctx, mensagem + '. Disponíveis agora: ' + UI.numero(r.data.disponivel) + '.');

    // Destaca as linhas que mudaram de situação (as excluídas somem da lista).
    ctx.estado = Object.assign({}, ctx.estado, {
      selecionadas: {},
      destaque: nome === 'remover' ? mapaDeIds(ids) : {}
    });
    setTimeout(function () { ctx.estado = Object.assign({}, ctx.estado, { destaque: {} }); }, DURACAO_DESTAQUE);

    if (aberta(ctx)) carregar(ctx);
    ctx.aoMudar();
  }

  function enviar(ctx, nome, ids, botao) {
    var corpo = { produtoId: ctx.alvo.produtoId, planoId: ctx.alvo.planoId, ids: ids };
    ocupar(ctx, true, botao, ids);
    avisar(ctx, 'Processando ' + ids.length + ' chave(s)…');
    Api.request('POST', ACOES[nome].rota, corpo).then(function (r) {
      if (aberta(ctx)) ocupar(ctx, false, botao, ids);
      concluir(ctx, nome, ids, r);
    });
  }

  function executar(ctx, nome, ids, botao) {
    var acao = ACOES[nome];
    if (ctx.estado.ocupado) return;
    var alvos = ctx.estado.chaves
      .filter(function (c) { return ids.indexOf(c.id) !== -1 && acao.aceita(c); })
      .map(function (c) { return c.id; });
    if (!alvos.length) return;

    UI.confirmar({ titulo: acao.titulo, texto: acao.texto(alvos.length), confirmar: acao.confirmar, perigo: true })
      .then(function (confirmado) {
        if (confirmado && aberta(ctx)) enviar(ctx, nome, alvos, botao);
      });
  }

  function copiar(botao, ctx) {
    var chave = ctx.estado.chaves.filter(function (c) { return c.id === botao.getAttribute('data-id'); })[0];
    if (!chave) return;
    UI.copiar(chave.chave);
    botao.innerHTML = UI.icone('check');
    setTimeout(function () { botao.innerHTML = UI.icone('copiar'); }, DURACAO_DESTAQUE);
  }

  /* ---------------------------------------------------------------------------
   * Eventos (ligados na própria gaveta)
   * ------------------------------------------------------------------------- */

  function aoClicar(ctx, evento) {
    var alvo = evento.target.closest('[data-ck-filtro], [data-ck-acao], [data-ck-lote], [data-ck-tentar]');
    if (!alvo) return;

    if (alvo.hasAttribute('data-ck-filtro')) {
      atualizarEstado(ctx, { filtro: alvo.getAttribute('data-ck-filtro') });
    } else if (alvo.hasAttribute('data-ck-tentar')) {
      parte(ctx, 'lista').innerHTML = UI.esqueletoLinhas(6);
      carregar(ctx);
    } else if (alvo.hasAttribute('data-ck-lote')) {
      var ids = selecionadas(ctx.estado).map(function (c) { return c.id; });
      executar(ctx, alvo.getAttribute('data-ck-lote'), ids, alvo);
    } else {
      var acao = alvo.getAttribute('data-ck-acao');
      if (acao === 'copiar') copiar(alvo, ctx);
      else executar(ctx, acao, [alvo.getAttribute('data-id')], alvo);
    }
  }

  function aoMarcar(ctx, evento) {
    var el = evento.target;
    if (el.hasAttribute('data-ck-todas')) {
      var ids = el.checked ? visiveis(ctx.estado).filter(podeExcluir).map(function (c) { return c.id; }) : [];
      atualizarEstado(ctx, { selecionadas: mapaDeIds(ids) });
      return;
    }
    var id = el.getAttribute('data-ck-marcar');
    if (!id) return;
    var novas = Object.assign({}, ctx.estado.selecionadas);
    if (el.checked) novas[id] = true;
    else delete novas[id];
    atualizarEstado(ctx, { selecionadas: novas });
  }

  function ligarEventos(ctx) {
    ctx.caixa.addEventListener('click', function (evento) { aoClicar(ctx, evento); });
    ctx.caixa.addEventListener('change', function (evento) { aoMarcar(ctx, evento); });
    var busca = UI.debounce(function (valor) { atualizarEstado(ctx, { busca: valor.trim() }); }, ATRASO_BUSCA);
    parte(ctx, 'busca').addEventListener('input', function (evento) { busca(evento.target.value); });
  }

  /**
   * Abre a gaveta de chaves de um plano.
   * @param {{produtoId:string, planoId:string, nome:string, aoMudar?:Function, aoFechar?:Function}} opcoes
   * @returns {{fechar:Function}} controle da camada (para o admin.js fechar)
   */
  function abrir(opcoes) {
    var ctx = {
      alvo: { produtoId: opcoes.produtoId, planoId: opcoes.planoId },
      estado: { chaves: [], total: 0, filtro: 'todas', busca: '', selecionadas: {}, destaque: {}, ocupado: false },
      aoMudar: typeof opcoes.aoMudar === 'function' ? opcoes.aoMudar : function () {},
      caixa: null
    };

    var controle = UI.gaveta({
      titulo: 'Chaves do plano',
      sub: opcoes.nome,
      corpo: htmlEstrutura(),
      pe: '<div class="adm-ck__barra" data-ck-barra></div>',
      aoFechar: opcoes.aoFechar,
      aoAbrir: function (caixa) {
        ctx.caixa = caixa;
        ligarEventos(ctx);
      }
    });

    carregar(ctx);
    return controle;
  }

  window.AdminChavesEstoque = { abrir: abrir };
})();
