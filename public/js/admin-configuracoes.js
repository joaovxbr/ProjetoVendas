/*
 * public/js/admin-configuracoes.js
 * -----------------------------------------------------------------------------
 * Tela "Configurações" do painel: ajustes da loja agrupados por assunto
 * (vitrine, suporte, manutenção), com contador de caracteres, validação no
 * próprio campo e uma barra fixa que mostra o que ainda não foi salvo.
 *
 * Só os campos alterados vão no PATCH, assim a auditoria registra exatamente o
 * que mudou. Os eventos são ligados no próprio formulário (que não usa a
 * delegação "data-form" do admin.js). Expõe window.AdminConfiguracoes.
 */
(function () {
  'use strict';

  var UI = window.AdminUI;
  var esc = UI.esc;

  var DURACAO_DESTAQUE = 1400;
  var LIMIAR_CONTADOR = 0.9;
  var EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  var URL_REGEX = /^https?:\/\/[^\s/$.?#][^\s]*$/i;
  var CHAVE_MANUTENCAO = 'modo_manutencao';

  function validarEmail(v) {
    return !v || EMAIL_REGEX.test(v) ? '' : 'Informe um e-mail válido, como suporte@sualoja.com';
  }

  function validarUrl(v) {
    return !v || URL_REGEX.test(v) ? '' : 'Use o link completo, começando com https://';
  }

  var SECOES = [
    {
      id: 'vitrine', titulo: 'Vitrine', icone: 'tag',
      dica: 'Textos de destaque exibidos para os clientes',
      campos: [
        { nome: 'aviso_topo', rotulo: 'Aviso no topo da loja', max: 200,
          placeholder: 'Ex.: Frete grátis em pedidos acima de R$ 300',
          dica: 'Faixa curta acima do cabeçalho. Deixe vazio para não exibir.' },
        { nome: 'destaque_home', rotulo: 'Destaque da home', max: 200,
          placeholder: 'Ex.: Novos planos com 20% de desconto',
          dica: 'Frase do banner principal da página inicial.' }
      ]
    },
    {
      id: 'suporte', titulo: 'Suporte', icone: 'chat', grade: true,
      dica: 'Canais para o cliente pedir ajuda',
      campos: [
        { nome: 'suporte_email', rotulo: 'E-mail de suporte', max: 120, tipo: 'email',
          placeholder: 'suporte@sualoja.com', dica: 'Contato para dúvidas e reembolsos.', validar: validarEmail },
        { nome: 'suporte_discord', rotulo: 'Convite do Discord', max: 200, tipo: 'url',
          placeholder: 'https://discord.gg/...', dica: 'Link de convite completo.', validar: validarUrl }
      ]
    }
  ];

  var SECAO_MANUTENCAO = {
    id: 'manutencao', titulo: 'Modo manutenção', icone: 'aviso',
    dica: 'Tira a loja do ar para os clientes. Admins e webhooks de pagamento continuam funcionando.'
  };

  var CAMPO_MENSAGEM = {
    nome: 'texto_manutencao', rotulo: 'Mensagem para os clientes', max: 300, multilinha: true,
    placeholder: 'Ex.: Estamos em manutenção. Voltamos em instantes.',
    dica: 'Aparece para quem tentar usar a loja enquanto o modo estiver ligado.'
  };

  var CAMPOS = SECOES.reduce(function (todos, s) { return todos.concat(s.campos); }, []).concat([CAMPO_MENSAGEM]);
  var NOMES = CAMPOS.map(function (c) { return c.nome; }).concat([CHAVE_MANUTENCAO]);
  var POR_NOME = CAMPOS.reduce(function (mapa, c) { mapa[c.nome] = c; return mapa; }, {});

  function erroDe(r) {
    return (r && r.data && r.data.erro) || 'Não foi possível salvar as configurações.';
  }

  /* ---------------------------------------------------------------------------
   * Valores
   * ------------------------------------------------------------------------- */

  function normalizar(config) {
    var valores = {};
    CAMPOS.forEach(function (c) {
      var bruto = config[c.nome];
      valores[c.nome] = String(bruto === null || bruto === undefined ? '' : bruto).trim();
    });
    valores[CHAVE_MANUTENCAO] = String(config[CHAVE_MANUTENCAO]) === 'true' ? 'true' : 'false';
    return valores;
  }

  function lerFormulario(form) {
    var valores = {};
    CAMPOS.forEach(function (c) { valores[c.nome] = String(form.elements[c.nome].value || '').trim(); });
    valores[CHAVE_MANUTENCAO] = form.elements[CHAVE_MANUTENCAO].checked ? 'true' : 'false';
    return valores;
  }

  function alterados(atual, salvo) {
    return NOMES.filter(function (nome) { return atual[nome] !== salvo[nome]; });
  }

  /* ---------------------------------------------------------------------------
   * HTML
   * ------------------------------------------------------------------------- */

  function campoHtml(c, valor) {
    var id = 'cfg-' + c.nome;
    var comuns = ' class="field__input' + (c.multilinha ? ' adm-textarea' : '') + '" id="' + id + '"' +
      ' name="' + c.nome + '" maxlength="' + c.max + '" placeholder="' + esc(c.placeholder) + '"' +
      ' aria-describedby="' + id + '-dica ' + id + '-erro"';
    var controle = c.multilinha
      ? '<textarea' + comuns + '>' + esc(valor) + '</textarea>'
      : '<input' + comuns + ' type="' + (c.tipo || 'text') + '" value="' + esc(valor) + '" autocomplete="off"' +
        (c.tipo ? ' spellcheck="false"' : '') + '>';

    return '<div class="field adm-cfg__campo" data-cfg-campo="' + c.nome + '">' +
      '<div class="adm-cfg__rotulo">' +
        '<label class="field__label" for="' + id + '">' + esc(c.rotulo) + '</label>' +
        '<span class="adm-cfg__contador" data-cfg-contador aria-hidden="true"></span>' +
      '</div>' +
      controle +
      '<p class="field__hint" id="' + id + '-dica">' + esc(c.dica) + '</p>' +
      '<p class="field__error" id="' + id + '-erro" data-cfg-erro></p>' +
    '</div>';
  }

  function cabecalhoHtml(s, extra) {
    return '<header class="adm-cfg__cab">' +
      '<span class="adm-cfg__icone">' + UI.icone(s.icone) + '</span>' +
      '<div class="adm-cfg__txt">' +
        '<h2 class="adm-cfg__titulo" id="cfg-sec-' + s.id + '">' + esc(s.titulo) + '</h2>' +
        '<p class="adm-cfg__dica">' + esc(s.dica) + '</p>' +
      '</div>' +
      (extra || '') +
    '</header>';
  }

  function secaoHtml(s, valores) {
    return '<section class="adm-cfg__secao" aria-labelledby="cfg-sec-' + s.id + '">' +
      cabecalhoHtml(s) +
      '<div class="adm-cfg__corpo' + (s.grade ? ' adm-cfg__corpo--grade' : '') + '">' +
        s.campos.map(function (c) { return campoHtml(c, valores[c.nome]); }).join('') +
      '</div>' +
    '</section>';
  }

  function estadoManutencaoHtml(agora, salvo) {
    if (agora !== salvo) {
      return UI.icone('relogio') + '<span>' + (agora
        ? 'Será <strong>ligado</strong> quando você salvar: a loja sai do ar na hora.'
        : 'Será <strong>desligado</strong> quando você salvar: a loja volta ao ar na hora.') + '</span>';
    }
    return agora
      ? UI.icone('aviso') + '<span><strong>Loja fora do ar.</strong> Os clientes veem a mensagem abaixo.</span>'
      : UI.icone('check') + '<span><strong>Loja no ar.</strong> Ligue só durante manutenções programadas.</span>';
  }

  function manutencaoHtml(valores) {
    var ligado = valores[CHAVE_MANUTENCAO] === 'true';
    var chave = '<label class="adm-switch adm-cfg__chave">' +
      '<input type="checkbox" role="switch" name="' + CHAVE_MANUTENCAO + '" aria-labelledby="cfg-sec-manutencao"' +
        (ligado ? ' checked' : '') + '>' +
      '<span class="adm-switch__trilha"></span>' +
    '</label>';

    return '<section class="adm-cfg__secao adm-cfg__secao--manutencao" data-cfg-manutencao aria-labelledby="cfg-sec-manutencao">' +
      cabecalhoHtml(SECAO_MANUTENCAO, chave) +
      '<div class="adm-cfg__corpo">' +
        '<p class="adm-cfg__estado" data-cfg-estado></p>' +
        campoHtml(CAMPO_MENSAGEM, valores[CAMPO_MENSAGEM.nome]) +
      '</div>' +
    '</section>';
  }

  function barraHtml() {
    return '<div class="adm-cfg__barra" data-cfg-barra>' +
      '<p class="adm-cfg__status" data-cfg-status role="status" aria-live="polite"></p>' +
      '<button class="btn btn--soft btn--sm" type="button" data-cfg-descartar disabled>Descartar</button>' +
      '<button class="btn btn--primary btn--sm" type="submit" data-cfg-salvar disabled>' +
        UI.icone('check') + 'Salvar alterações</button>' +
    '</div>';
  }

  /* ---------------------------------------------------------------------------
   * Pintura do estado
   * ------------------------------------------------------------------------- */

  function campoEl(form, nome) { return form.querySelector('[data-cfg-campo="' + nome + '"]'); }

  function pintarCampo(form, c, alterado) {
    var el = campoEl(form, c.nome);
    var tamanho = form.elements[c.nome].value.length;
    var contador = el.querySelector('[data-cfg-contador]');
    contador.textContent = tamanho + '/' + c.max;
    contador.classList.toggle('is-limite', tamanho >= c.max * LIMIAR_CONTADOR);
    el.classList.toggle('is-alterado', alterado);
  }

  function pintarManutencao(ctx, ligado) {
    var secao = ctx.form.querySelector('[data-cfg-manutencao]');
    secao.classList.toggle('is-ativa', ligado);
    secao.querySelector('[data-cfg-estado]').innerHTML =
      estadoManutencaoHtml(ligado, ctx.salvo[CHAVE_MANUTENCAO] === 'true');
  }

  function textoStatus(ctx, pendentes) {
    if (ctx.erro) return ctx.erro;
    if (pendentes) return pendentes === 1 ? '1 alteração não salva' : pendentes + ' alterações não salvas';
    return ctx.salvoEm ? 'Alterações salvas' : 'Tudo salvo';
  }

  function definirStatus(ctx, texto) {
    var el = ctx.form.querySelector('[data-cfg-status]');
    // Só troca quando muda: evita o leitor de tela repetir a cada tecla.
    if (el.textContent !== texto) el.textContent = texto;
  }

  function pintarBarra(ctx, pendentes) {
    var barra = ctx.form.querySelector('[data-cfg-barra]');
    barra.classList.toggle('is-pendente', pendentes > 0);
    barra.classList.toggle('is-erro', Boolean(ctx.erro));
    barra.querySelector('[data-cfg-salvar]').disabled = ctx.ocupado || !pendentes;
    barra.querySelector('[data-cfg-descartar]').disabled = ctx.ocupado || !pendentes;
    definirStatus(ctx, ctx.ocupado ? 'Salvando…' : textoStatus(ctx, pendentes));
  }

  function atualizar(ctx) {
    var atual = lerFormulario(ctx.form);
    var mudou = alterados(atual, ctx.salvo);
    CAMPOS.forEach(function (c) { pintarCampo(ctx.form, c, mudou.indexOf(c.nome) !== -1); });
    pintarManutencao(ctx, atual[CHAVE_MANUTENCAO] === 'true');
    pintarBarra(ctx, mudou.length);
  }

  /* ---------------------------------------------------------------------------
   * Validação
   * ------------------------------------------------------------------------- */

  function mostrarErro(form, nome, mensagem) {
    var entrada = form.elements[nome];
    campoEl(form, nome).querySelector('[data-cfg-erro]').textContent = mensagem;
    if (mensagem) entrada.setAttribute('aria-invalid', 'true');
    else entrada.removeAttribute('aria-invalid');
  }

  function validarCampo(form, c, valor) {
    var mensagem = c.validar ? c.validar(valor) : '';
    mostrarErro(form, c.nome, mensagem);
    return !mensagem;
  }

  // O servidor valida de novo; o que ele recusar aparece no campo certo.
  function marcarErrosDoServidor(form, r) {
    var detalhes = r && r.data && r.data.detalhes;
    if (!detalhes || typeof detalhes !== 'object') return;
    var marcados = CAMPOS.filter(function (c) {
      var mensagem = detalhes[c.nome];
      if (typeof mensagem !== 'string' || !mensagem) return false;
      mostrarErro(form, c.nome, mensagem);
      return true;
    });
    if (marcados.length) form.elements[marcados[0].nome].focus();
  }

  function validarTudo(ctx, atual) {
    var invalidos = CAMPOS.filter(function (c) { return !validarCampo(ctx.form, c, atual[c.nome]); });
    if (invalidos.length) ctx.form.elements[invalidos[0].nome].focus();
    return !invalidos.length;
  }

  /* ---------------------------------------------------------------------------
   * Ações
   * ------------------------------------------------------------------------- */

  function ocupar(ctx, sim) {
    ctx.ocupado = sim;
    ctx.form.classList.toggle('is-ocupada', sim);
    var botao = ctx.form.querySelector('[data-cfg-salvar]');
    botao.classList.toggle('is-carregando', sim);
    botao.setAttribute('aria-busy', String(sim));
    atualizar(ctx);
  }

  function destacar(ctx, nomes) {
    var marcados = nomes
      .map(function (nome) { return campoEl(ctx.form, nome); })
      .filter(Boolean);
    marcados.forEach(function (el) { el.classList.add('is-salvo'); });
    setTimeout(function () {
      marcados.forEach(function (el) { el.classList.remove('is-salvo'); });
    }, DURACAO_DESTAQUE);
  }

  function enviar(ctx, atual, mudou) {
    var dados = {};
    mudou.forEach(function (nome) { dados[nome] = atual[nome]; });

    ocupar(ctx, true);
    ctx.pedir('PATCH', '/api/admin/configuracoes', dados).then(function (r) {
      if (!r.ok) {
        ctx.erro = 'Não foi possível salvar. Tente de novo.';
        ocupar(ctx, false);
        marcarErrosDoServidor(ctx.form, r);
        Api.toast(erroDe(r), 'error');
        return;
      }
      ctx.salvo = normalizar(r.data.configuracoes || atual);
      ctx.salvoEm = Date.now();
      ocupar(ctx, false);
      destacar(ctx, mudou);
      Api.toast(mudou.length === 1 ? 'Ajuste salvo' : mudou.length + ' ajustes salvos', 'success');
    });
  }

  function confirmarSeLigando(atual, mudou) {
    var ligando = mudou.indexOf(CHAVE_MANUTENCAO) !== -1 && atual[CHAVE_MANUTENCAO] === 'true';
    if (!ligando) return Promise.resolve(true);
    return UI.confirmar({
      titulo: 'Ligar o modo manutenção?',
      texto: 'A loja e a API saem do ar para os clientes assim que você salvar. Pagamentos já feitos continuam sendo confirmados.',
      confirmar: 'Ligar e salvar',
      perigo: true
    });
  }

  function salvar(ctx) {
    if (ctx.ocupado) return;
    var atual = lerFormulario(ctx.form);
    var mudou = alterados(atual, ctx.salvo);
    if (!mudou.length) return;
    if (!validarTudo(ctx, atual)) { Api.toast('Revise os campos destacados', 'error'); return; }

    confirmarSeLigando(atual, mudou).then(function (ok) {
      if (ok) enviar(ctx, atual, mudou);
    });
  }

  function descartar(ctx) {
    CAMPOS.forEach(function (c) {
      ctx.form.elements[c.nome].value = ctx.salvo[c.nome];
      mostrarErro(ctx.form, c.nome, '');
    });
    ctx.form.elements[CHAVE_MANUTENCAO].checked = ctx.salvo[CHAVE_MANUTENCAO] === 'true';
    ctx.erro = null;
    atualizar(ctx);
    Api.toast('Alterações descartadas', 'info');
  }

  function ligar(ctx) {
    var form = ctx.form;
    form.addEventListener('input', function (evento) {
      var alvo = evento.target;
      if (alvo.hasAttribute('aria-invalid')) mostrarErro(form, alvo.name, '');
      ctx.erro = null;
      atualizar(ctx);
    });
    form.addEventListener('change', function () { atualizar(ctx); });
    form.addEventListener('focusout', function (evento) {
      var c = POR_NOME[evento.target.name];
      if (c && c.validar) validarCampo(form, c, String(evento.target.value || '').trim());
    });
    form.addEventListener('submit', function (evento) {
      evento.preventDefault();
      salvar(ctx);
    });
    form.querySelector('[data-cfg-descartar]').addEventListener('click', function () { descartar(ctx); });
  }

  /**
   * Pinta a tela dentro de `container`.
   * @param {HTMLElement} container
   * @param {{configuracoes: object, pedir: function}} opcoes
   */
  function render(container, opcoes) {
    var valores = normalizar(opcoes.configuracoes || {});
    container.innerHTML =
      '<form class="adm-cfg" id="form-config" novalidate>' +
        SECOES.map(function (s) { return secaoHtml(s, valores); }).join('') +
        manutencaoHtml(valores) +
        barraHtml() +
      '</form>';

    var ctx = {
      form: container.querySelector('#form-config'),
      salvo: valores,
      pedir: opcoes.pedir,
      ocupado: false,
      salvoEm: null,
      erro: null
    };
    ligar(ctx);
    atualizar(ctx);
  }

  window.AdminConfiguracoes = { render: render };
})();
