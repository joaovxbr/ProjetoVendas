/*
 * produtos.js — catálogo: categorias com contagem, busca, ordenação e grade.
 * Filtra no navegador (a lista é pequena). Aceita ?categoria=Nome na URL.
 * Depende de Api (api.js) e UI (ui.js).
 */
(function () {
  'use strict';

  var Api = window.Api;
  var UI = window.UI;
  var esc = Api.escapar;

  var grade = document.getElementById('grade-produtos');
  var listaCategorias = document.getElementById('categorias');
  var busca = document.getElementById('busca');
  var ordem = document.getElementById('ordem');
  var contagem = document.getElementById('contagem');
  var estado = document.getElementById('estado');

  var produtos = [];
  var filtro = { categoria: '', termo: '', ordem: 'relevancia' };

  try {
    filtro.categoria = new URLSearchParams(location.search).get('categoria') || '';
  } catch (erro) { /* navegador antigo */ }

  function normalizar(texto) {
    return String(texto || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
  }

  var ORDENS = {
    'menor-preco': function (a, b) { return a.precoMin - b.precoMin; },
    'maior-preco': function (a, b) { return b.precoMin - a.precoMin; },
    avaliacao: function (a, b) { return b.avaliacao - a.avaliacao || b.avaliacoes - a.avaliacoes; }
  };

  /* Renderização ----------------------------------------------------------- */

  function renderCategorias(categorias) {
    var total = categorias.reduce(function (s, c) { return s + c.total; }, 0);
    var html = '<button class="categoria" type="button" data-categoria="" aria-pressed="' + !filtro.categoria + '">' +
      '<span>Todas as categorias</span><b>' + total + '</b></button>';
    categorias.forEach(function (c) {
      html += '<button class="categoria" type="button" data-categoria="' + esc(c.nome) + '" aria-pressed="' +
        (normalizar(c.nome) === normalizar(filtro.categoria)) + '"><span>' + esc(c.nome) + '</span><b>' + c.total + '</b></button>';
    });
    listaCategorias.innerHTML = html;
  }

  function mostrarEstado(tipo) {
    if (!tipo) {
      estado.hidden = true;
      return;
    }
    estado.innerHTML = tipo === 'vazio'
      ? '<h3>Nenhum produto encontrado</h3><p>Tente outro termo de busca ou veja todas as categorias.</p>' +
        '<button class="btn btn--soft" type="button" data-limpar>Limpar filtros</button>'
      : '<h3>Não foi possível carregar</h3><p>Verifique sua conexão e tente novamente.</p>' +
        '<button class="btn btn--primary" type="button" data-recarregar>Tentar novamente</button>';
    estado.hidden = false;
  }

  var ultimaGrade = null;

  function render() {
    var termo = normalizar(filtro.termo);
    var lista = produtos.filter(function (p) {
      if (filtro.categoria && normalizar(p.categoria) !== normalizar(filtro.categoria)) return false;
      if (termo && normalizar(p.nome + ' ' + p.categoria).indexOf(termo) === -1) return false;
      return true;
    });
    if (ORDENS[filtro.ordem]) lista = lista.slice().sort(ORDENS[filtro.ordem]);

    grade.setAttribute('aria-busy', 'false');

    var html = lista.map(function (p, i) { return UI.cartao(p, { atraso: i % 3 }); }).join('');
    // Só mexe no DOM quando a lista mudou de verdade: a revalidação periódica
    // não pode reiniciar as animações de entrada nem piscar a grade.
    if (html !== ultimaGrade) {
      ultimaGrade = html;
      grade.innerHTML = html;
      Api.observarReveal(grade);
    }

    contagem.innerHTML = '<strong>' + lista.length + '</strong> ' + (lista.length === 1 ? 'produto encontrado' : 'produtos encontrados');
    mostrarEstado(lista.length ? null : 'vazio');
  }

  /* Eventos ---------------------------------------------------------------- */

  listaCategorias.addEventListener('click', function (evento) {
    var botao = evento.target.closest('[data-categoria]');
    if (!botao) return;
    filtro.categoria = botao.getAttribute('data-categoria');
    listaCategorias.querySelectorAll('[data-categoria]').forEach(function (b) {
      b.setAttribute('aria-pressed', String(b === botao));
    });
    // Guarda a categoria na URL (dá para compartilhar o link)
    try {
      var url = new URL(location.href);
      if (filtro.categoria) url.searchParams.set('categoria', filtro.categoria);
      else url.searchParams.delete('categoria');
      history.replaceState(null, '', url);
    } catch (erro) { /* sem suporte: ignora */ }
    render();
  });

  var espera = null;
  busca.addEventListener('input', function () {
    clearTimeout(espera);
    espera = setTimeout(function () {
      filtro.termo = busca.value;
      render();
    }, 120);
  });

  ordem.addEventListener('change', function () {
    filtro.ordem = ordem.value;
    render();
  });

  estado.addEventListener('click', function (evento) {
    if (evento.target.closest('[data-limpar]')) {
      filtro.termo = '';
      filtro.categoria = '';
      busca.value = '';
      listaCategorias.querySelectorAll('[data-categoria]').forEach(function (b) {
        b.setAttribute('aria-pressed', String(!b.getAttribute('data-categoria')));
      });
      render();
    } else if (evento.target.closest('[data-recarregar]')) {
      carregar();
    }
  });

  /* Carregamento ----------------------------------------------------------- */

  async function carregar() {
    mostrarEstado(null);
    var respostas = await Promise.all([Api.get('/api/produtos'), Api.get('/api/produtos/categorias')]);
    var rProdutos = respostas[0];
    var rCategorias = respostas[1];

    if (!rProdutos.ok || !Array.isArray(rProdutos.data)) {
      grade.innerHTML = '';
      contagem.textContent = '';
      mostrarEstado('erro');
      return;
    }

    produtos = rProdutos.data;
    renderCategorias(rCategorias.ok && Array.isArray(rCategorias.data) ? rCategorias.data : []);
    render();
  }

  /**
   * Revalida o catálogo sem passar pelo estado de "carregando": a lista que já
   * está na tela fica lá até a resposta chegar, e uma oscilação de rede não
   * apaga o que o usuário estava lendo. Os filtros escolhidos continuam valendo,
   * porque `render()` lê o mesmo `filtro`.
   */
  async function revalidar() {
    var respostas = await Promise.all([Api.get('/api/produtos'), Api.get('/api/produtos/categorias')]);
    var rProdutos = respostas[0];
    var rCategorias = respostas[1];

    if (!rProdutos.ok || !Array.isArray(rProdutos.data)) {
      // Nunca chegou a carregar: aí sim vale mostrar o erro com "Tentar novamente".
      if (!produtos.length) {
        grade.innerHTML = '';
        contagem.textContent = '';
        mostrarEstado('erro');
      }
      return;
    }

    produtos = rProdutos.data;
    renderCategorias(rCategorias.ok && Array.isArray(rCategorias.data) ? rCategorias.data : []);
    render();
  }

  Api.observarReveal();
  carregar();

  /*
   * Um produto recém-cadastrado aparece na vitrine sem precisar de F5: ao voltar
   * para a aba (o caso comum é cadastrar no painel em outra aba) e de minuto em
   * minuto enquanto a aba estiver visível. `imediato: false` porque a primeira
   * carga é a de cima, que mostra o estado de "carregando".
   */
  Api.aoRevalidar(revalidar, { intervaloMs: 60000, imediato: false });
})();
