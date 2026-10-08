/*
 * home.js — página inicial: recursos, produtos em destaque e vídeo de demonstração.
 * Depende de Api (api.js) e UI (ui.js).
 */
(function () {
  'use strict';

  var Api = window.Api;
  var UI = window.UI;

  /* Recursos --------------------------------------------------------------- */

  var RECURSOS = [
    ['pacote', 'Entrega automática', 'Sua chave aparece na tela segundos depois da confirmação do pagamento.'],
    ['suporte', 'Suporte 24/7', 'Time de verdade respondendo a qualquer hora, inclusive fins de semana.'],
    ['cadeado', 'Pagamento seguro', 'Transações criptografadas. Não guardamos os dados do seu cartão.'],
    ['atualizar', 'Sempre atualizado', 'Atualizações frequentes e gratuitas durante todo o período do plano.'],
    ['chat', 'Comunidade ativa', 'Milhares de jogadores trocando configurações, dicas e perfis prontos.'],
    ['cartao', 'Pix, cartão ou boleto', 'Escolha como pagar. O Pix é confirmado praticamente na hora.']
  ];

  var listaRecursos = document.getElementById('lista-recursos');
  if (listaRecursos) {
    listaRecursos.innerHTML = RECURSOS.map(function (r, i) {
      return '<article class="recurso reveal" data-delay="' + (i % 3) + '">' +
        '<span class="recurso__icone">' + UI.icone(r[0]) + '</span>' +
        '<h3>' + r[1] + '</h3>' +
        '<p>' + r[2] + '</p>' +
      '</article>';
    }).join('');
  }

  /* Destaques -------------------------------------------------------------- */

  var grade = document.getElementById('grade-destaques');
  var ultimosDestaques = null; // HTML da última pintura, para não repintar igual

  async function carregarDestaques() {
    if (!grade) return;
    /*
     * Usa o atalho dedicado /api/produtos/destaques em vez de pedir o catalogo
     * inteiro e filtrar no navegador.
     *
     * Sem ?limite: a home mostra TODOS os destaques cadastrados. Antes ela pedia
     * limite=3 e ainda cortava com slice(0, 3), entao o 4o destaque em diante
     * sumia, como se o painel so permitisse tres.
     *
     * O servidor devolve os destaques MAIS RECENTES primeiro, entao um produto
     * recem-marcado como destaque entra na frente — e a revalidacao abaixo faz
     * ele aparecer sem precisar recarregar a pagina.
     */
    var r = await Api.get('/api/produtos/destaques');
    grade.setAttribute('aria-busy', 'false');

    if (!r.ok || !Array.isArray(r.data)) {
      // Numa revalidacao que falhou, mantem o que ja esta na tela: uma
      // oscilacao de rede nao pode esvaziar a vitrine de quem ja estava lendo.
      if (ultimosDestaques === null) {
        grade.innerHTML = '<p class="sub-secao">Não foi possível carregar os produtos agora.</p>';
      }
      return;
    }

    // atraso ciclico (0..2) como no catalogo: so existem data-delay ate 4.
    var html = r.data.map(function (p, i) {
      return UI.cartao(p, { atraso: i % 3 });
    }).join('');

    // Sem mudanca real, nao mexe no DOM: evita piscar e reiniciar as animacoes
    // de entrada a cada checagem periodica.
    if (html === ultimosDestaques) return;

    ultimosDestaques = html;
    grade.innerHTML = html;
    Api.observarReveal(grade);
  }

  /* Vídeo de demonstração ------------------------------------------------- */

  var modal = document.getElementById('modal-demo');
  var video = document.getElementById('video-demo');
  var aviso = document.getElementById('aviso-demo');
  var focoAnterior = null;

  function abrirDemo() {
    if (!modal) return;
    focoAnterior = document.activeElement;
    modal.hidden = false;
    document.documentElement.classList.add('no-scroll');
    var fechar = modal.querySelector('[data-fechar-demo]');
    if (fechar) fechar.focus();
    if (video && !video.hidden) {
      var tocar = video.play();
      if (tocar && tocar.catch) tocar.catch(function () { /* autoplay bloqueado: usuário clica no play */ });
    }
  }

  function fecharDemo() {
    if (!modal || modal.hidden) return;
    modal.hidden = true;
    document.documentElement.classList.remove('no-scroll');
    if (video) video.pause();
    if (focoAnterior) focoAnterior.focus({ preventScroll: true });
  }

  // Sem arquivo em /video/demo.mp4: mostra um aviso no lugar do player
  if (video && aviso) {
    video.addEventListener('error', function () {
      video.hidden = true;
      aviso.hidden = false;
    });
  }

  document.addEventListener('click', function (evento) {
    if (evento.target.closest('[data-abrir-demo]')) return abrirDemo();
    if (evento.target.closest('[data-fechar-demo]') || evento.target === modal) fecharDemo();
  });

  document.addEventListener('keydown', function (evento) {
    if (evento.key === 'Escape') fecharDemo();
  });

  Api.observarReveal();

  /*
   * Revalida os destaques ao voltar para a aba — o caso comum e o admin
   * cadastrar o produto em outra aba e voltar para a home — e de minuto em
   * minuto enquanto a aba estiver visivel. A primeira carga sai por aqui.
   */
  Api.aoRevalidar(carregarDestaques, { intervaloMs: 60000 });
})();
