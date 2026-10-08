/*
 * conta.js
 * -----------------------------------------------------------------------------
 * Painel do CLIENTE (SPA leve, sem framework). Roda depois de api.js e
 * admin-ui.js e expõe window.Conta (útil para depurar no console).
 *
 * Como funciona:
 *   - A URL usa hash: #/painel, #/pedidos, #/licencas... O roteador troca a view.
 *   - Cada view busca seus dados da API /api/conta/* (e das rotas do cliente) e
 *     pinta em #conteudo.
 *   - Os cliques dentro do conteúdo são capturados por delegação e despachados
 *     para o mapa de ações da view atual (data-acao="...").
 *   - Um "token" de render evita que uma resposta atrasada pinte na view errada
 *     quando a pessoa troca de aba antes da requisição terminar.
 *
 * Segurança: a API exige sessão em todas as rotas do cliente (401 sem login).
 * Esta página apenas esconde a interface; nada aqui é a única barreira.
 */
(function () {
  'use strict';

  var Api = window.Api;
  var UI = window.AdminUI;
  var esc = Api.escapar;

  /* ---------------------------------------------------------------------------
   * Helpers básicos
   * ------------------------------------------------------------------------- */

  function qs(seletor, raiz) { return (raiz || document).querySelector(seletor); }
  function qsa(seletor, raiz) { return Array.prototype.slice.call((raiz || document).querySelectorAll(seletor)); }
  function conteudo() { return qs('#conteudo'); }

  function pintar(html) { conteudo().innerHTML = html; }

  var tokenRender = 0;
  function novoToken() { return ++tokenRender; }
  function aindaValido(token) { return token === tokenRender; }

  function erroDe(resposta) {
    return (resposta && resposta.data && resposta.data.erro) || 'Não foi possível concluir a operação.';
  }

  function pedir(metodo, caminho, corpo) { return Api.request(metodo, caminho, corpo); }

  function primeiroNome(nome) {
    var partes = String(nome || '').trim().split(/\s+/);
    return partes[0] || 'jogador';
  }

  /* ---------------------------------------------------------------------------
   * Peças de layout reutilizadas pelas views
   * ------------------------------------------------------------------------- */

  function cartao(titulo, dica, corpoHtml, opcoes) {
    opcoes = opcoes || {};
    return '<section class="adm-cartao">' +
      '<div class="adm-cartao__cab">' +
        '<div>' +
          '<p class="adm-cartao__titulo">' + esc(titulo) + '</p>' +
          (dica ? '<p class="adm-cartao__dica">' + esc(dica) + '</p>' : '') +
        '</div>' +
        (opcoes.acoes ? '<div class="adm-cartao__acoes">' + opcoes.acoes + '</div>' : '') +
      '</div>' +
      '<div class="adm-cartao__corpo' + (opcoes.semPad ? ' adm-cartao__corpo--sem-pad' : '') + '">' + corpoHtml + '</div>' +
    '</section>';
  }

  function kpi(rotulo, valor, nota, icone) {
    return '<article class="adm-kpi">' +
      '<div class="adm-kpi__topo">' +
        '<span class="adm-kpi__rotulo">' + esc(rotulo) + '</span>' +
        '<span class="adm-kpi__icone">' + UI.icone(icone) + '</span>' +
      '</div>' +
      '<p class="adm-kpi__valor">' + esc(valor) + '</p>' +
      (nota ? '<p class="adm-kpi__nota">' + nota + '</p>' : '') +
    '</article>';
  }

  function aviso(tipo, texto) {
    var ic = tipo === 'erro' ? 'aviso' : (tipo === 'info' ? 'info' : 'aviso');
    return '<div class="adm-aviso' + (tipo ? ' adm-aviso--' + tipo : '') + '">' +
      UI.icone(ic) + '<span>' + esc(texto) + '</span></div>';
  }

  function opcoesSelect(itens, selecionado) {
    return itens.map(function (item) {
      var valor = typeof item === 'string' ? item : item.valor;
      var rotulo = typeof item === 'string' ? item : item.rotulo;
      return '<option value="' + esc(valor) + '"' + (String(valor) === String(selecionado) ? ' selected' : '') + '>' +
        esc(rotulo) + '</option>';
    }).join('');
  }

  function barraBusca(placeholder, valor, acao) {
    return '<span class="adm-barra__campo">' + UI.icone('busca') +
      '<input class="field__input" type="search" placeholder="' + esc(placeholder) + '" value="' + esc(valor || '') + '"' +
      ' data-entrada="' + acao + '" aria-label="' + esc(placeholder) + '"></span>';
  }

  function botaoAcao(rotulo, acao, icone, atributos) {
    return '<button class="btn btn--soft btn--sm" type="button" data-acao="' + esc(acao) + '"' +
      (atributos || '') + '>' + (icone ? UI.icone(icone) : '') + esc(rotulo) + '</button>';
  }

  function esqueleto(blocos) {
    var html = '<div class="adm-kpis">';
    for (var i = 0; i < 4; i++) html += '<div class="skeleton" style="height:112px;border-radius:var(--radius-lg)"></div>';
    html += '</div>';
    for (var j = 0; j < (blocos || 2); j++) {
      html += '<div class="adm-cartao"><div class="adm-cartao__corpo">' + UI.esqueletoLinhas(4) + '</div></div>';
    }
    return html;
  }

  /* ---------------------------------------------------------------------------
   * Estado
   * ------------------------------------------------------------------------- */

  var estado = {
    usuario: null,
    view: 'painel',
    pedidos: { status: '', pagina: 1 },
    licencas: { status: '' },
    atividades: { tipo: '', busca: '', pagina: 1 }
  };

  /* ---------------------------------------------------------------------------
   * Ações (delegação de eventos dentro de #conteudo)
   * ------------------------------------------------------------------------- */

  var acoes = {};

  // Ações presentes em todas as views.
  var ACOES_COMUNS = {
    copiar: function (el) { UI.copiar(el.getAttribute('data-valor')); },
    ir: function (el) { window.location.hash = '#/' + el.getAttribute('data-view'); },
    recarregar: function () { atualizar(); }
  };

  function registrarAcoes(mapa) {
    acoes = {};
    Object.keys(ACOES_COMUNS).forEach(function (chave) { acoes[chave] = ACOES_COMUNS[chave]; });
    Object.keys(mapa || {}).forEach(function (chave) { acoes[chave] = mapa[chave]; });
  }

  function despachar(nome, el, evento) {
    var handler = acoes[nome];
    if (typeof handler === 'function') handler(el, evento);
  }

  /* ===========================================================================
   * VIEW: VISÃO GERAL
   * ========================================================================= */

  function heroPerfil(usuario) {
    var selos = '';
    if (usuario.criadoEm) selos += UI.selo('neutro', 'Cliente desde ' + UI.dataCurta(usuario.criadoEm));
    if (usuario.ultimoLoginEm) selos += UI.selo('info', 'Último acesso ' + UI.relativo(usuario.ultimoLoginEm));

    return '<section class="adm-cartao">' +
      '<div class="conta-hero">' +
        '<span class="conta-hero__avatar" aria-hidden="true">' + esc(UI.iniciais(usuario.nome)) + '</span>' +
        '<div class="conta-hero__txt">' +
          '<h2 class="conta-hero__nome">Olá, ' + esc(primeiroNome(usuario.nome)) + '</h2>' +
          '<p class="conta-hero__email">' + esc(usuario.email) + '</p>' +
          (selos ? '<div class="conta-hero__meta">' + selos + '</div>' : '') +
        '</div>' +
        '<div class="conta-hero__acoes">' +
          '<a class="btn btn--soft btn--sm" href="/produtos">' + UI.icone('camadas') + 'Explorar produtos</a>' +
        '</div>' +
      '</div>' +
    '</section>';
  }

  function listaPedidos(pedidos, compacto) {
    if (!pedidos.length) {
      return UI.estado({
        titulo: 'Nenhuma compra ainda',
        texto: 'Quando você comprar, seus pedidos aparecem aqui.',
        icone: 'pacote',
        acao: '<a class="btn btn--primary btn--sm" href="/produtos">Explorar produtos</a>'
      });
    }

    return '<div class="adm-lista">' + pedidos.map(function (pedido) {
      return '<div class="adm-lista__item">' +
        '<span class="adm-rank">' + UI.icone('pacote') + '</span>' +
        '<div class="adm-lista__txt">' +
          '<p class="adm-lista__nome">' + esc(pedido.numero) + '</p>' +
          '<p class="adm-lista__meta">' + UI.numero(pedido.itens) + ' item(ns) · ' +
            esc(compacto ? pedido.quando : UI.dataHora(pedido.criadoEm)) + '</p>' +
        '</div>' +
        '<span class="adm-lista__valor">' + esc(pedido.total) + '</span>' +
        UI.seloVenda(pedido.status) +
      '</div>';
    }).join('') + '</div>';
  }

  // Texto de validade da licença, considerando resgate/vitaliciedade/expiração.
  function validadeTexto(licenca) {
    if (licenca.status === 'revogada') return 'Revogada — fale com o suporte';
    if (licenca.status === 'ativa') return 'Aguardando ativação';
    if (licenca.vitalicia) return 'Licença vitalícia';
    if (licenca.expirada) return 'Expirou em ' + (licenca.expiraEmFormatado || '—');
    if (licenca.expiraEmFormatado) return 'Válida até ' + licenca.expiraEmFormatado;
    return 'Ativa';
  }

  /*
   * Selo próprio do cliente: para o admin, "ativa" significa "emitida e válida",
   * mas para quem comprou a chave isso se lê como "já usei". Aqui "ativa" vira
   * "Aguardando ativação", para bater com o texto de validade ao lado.
   */
  var MAPA_LICENCA_CLIENTE = {
    ativa: ['aviso', 'Aguardando ativação'],
    resgatada: ['ok', 'Ativada'],
    revogada: ['erro', 'Revogada'],
    expirada: ['neutro', 'Expirada']
  };

  function seloLicencaCliente(status) {
    var info = MAPA_LICENCA_CLIENTE[status] || ['neutro', status || '—'];
    return UI.selo(info[0], info[1]);
  }

  function listaChaves(chaves) {
    if (!chaves.length) {
      return UI.estado({
        titulo: 'Nenhuma chave ainda',
        texto: 'Suas chaves de licença aparecem aqui depois da primeira compra.',
        icone: 'cadeado'
      });
    }

    return '<div class="conta-chaves">' + chaves.map(function (licenca) {
      return '<div class="conta-chave">' +
        '<div class="conta-chave__topo">' +
          '<div class="conta-chave__txt">' +
            '<p class="conta-chave__nome">' + esc(licenca.produto || 'Licença') + '</p>' +
            '<p class="conta-chave__plano">' + esc(validadeTexto(licenca)) + '</p>' +
          '</div>' +
          seloLicencaCliente(licenca.status) +
        '</div>' +
        '<div class="conta-chave__codigo">' +
          '<code>' + esc(licenca.chave) + '</code>' +
          '<button class="icon-btn" type="button" data-acao="copiar" data-valor="' + esc(licenca.chave) +
            '" aria-label="Copiar chave" title="Copiar chave">' + UI.icone('copiar') + '</button>' +
        '</div>' +
      '</div>';
    }).join('') + '</div>';
  }

  function listaAtividades(atividades, compacto) {
    if (!atividades.length) {
      return UI.estado({
        titulo: 'Sem atividades ainda',
        texto: 'O que você fizer na loja (compras, resgates, avaliações) aparece aqui.',
        icone: 'atividade'
      });
    }

    return '<div class="conta-tempo">' + atividades.map(function (item) {
      return '<div class="conta-tempo__item">' +
        '<span class="conta-tempo__marca" data-tom="' + esc(item.tom || 'neutro') + '">' + UI.icone(item.icone || 'relogio') + '</span>' +
        '<div class="conta-tempo__corpo">' +
          '<div class="conta-tempo__topo">' +
            '<span class="conta-tempo__titulo">' + esc(item.titulo) + '</span>' +
            '<span class="conta-tempo__quando" title="' + esc(UI.dataHora(item.criadoEm)) + '">' +
              esc(compacto ? UI.relativo(item.criadoEm) : UI.dataHora(item.criadoEm)) + '</span>' +
          '</div>' +
          (item.descricao ? '<p class="conta-tempo__desc">' + esc(item.descricao) + '</p>' : '') +
          '<p class="conta-tempo__meta">' + esc(item.tipoRotulo || item.tipo) + '</p>' +
        '</div>' +
      '</div>';
    }).join('') + '</div>';
  }

  function atalho(titulo, dica, icone, view) {
    return '<a class="conta-atalho" href="#/' + esc(view) + '">' +
      '<span class="conta-atalho__icone">' + UI.icone(icone) + '</span>' +
      '<span class="conta-atalho__txt">' +
        '<span class="conta-atalho__titulo">' + esc(titulo) + '</span>' +
        '<span class="conta-atalho__dica">' + esc(dica) + '</span>' +
      '</span>' +
    '</a>';
  }

  function viewPainel() {
    var token = novoToken();
    registrarAcoes({});
    pintar(esqueleto(2));

    // O resumo traz os totais; a lista de atividades vem de uma segunda chamada
    // (o resumo só carrega a última) — assim a visão geral fica realmente útil.
    Promise.all([
      pedir('GET', '/api/conta'),
      pedir('GET', '/api/conta/atividades?limite=5')
    ]).then(function (resultados) {
      var resposta = resultados[0];
      var respostaAtividades = resultados[1];

      if (!aindaValido(token)) return;
      if (!resposta.ok) {
        return pintar(UI.estado({
          tipo: 'erro',
          titulo: 'Não foi possível carregar sua conta',
          texto: erroDe(resposta),
          icone: 'aviso',
          acao: '<button class="btn btn--primary btn--sm" type="button" data-acao="recarregar">Tentar de novo</button>'
        }));
      }

      var dados = resposta.data;
      atualizarCasca(dados.usuario, dados.estatisticas);
      var e = dados.estatisticas;
      var atividades = (respostaAtividades.ok && respostaAtividades.data.atividades) || [];

      var html =
        heroPerfil(dados.usuario) +
        '<div class="adm-kpis">' +
          kpi('Pedidos', UI.numero(e.pedidos), '', 'pacote') +
          kpi('Total gasto', UI.dinheiro(e.gasto), '', 'dinheiro') +
          kpi('Licenças ativas', UI.numero(e.licencasAtivas), UI.numero(e.licencas) + ' no total', 'cadeado') +
          kpi('Avaliações', UI.numero(e.avaliacoes), UI.numero(e.favoritos) + ' favorito(s)', 'estrela') +
        '</div>' +
        '<div class="adm-grade adm-grade--2-1">' +
          cartao('Pedidos recentes', 'Suas últimas compras', listaPedidos(dados.pedidosRecentes, true),
            { semPad: true, acoes: botaoAcao('Ver todos', 'ir', 'seta', ' data-view="pedidos"') }) +
          cartao('Atalhos', 'Vá direto ao que você precisa',
            '<div class="conta-atalhos">' +
              atalho('Minhas licenças', 'Copie e ative suas chaves', 'cadeado', 'licencas') +
              atalho('Favoritos', 'Sua lista de desejos', 'coracao', 'favoritos') +
              atalho('Preferências', 'Avisos e aparência', 'ajustes', 'preferencias') +
              atalho('Segurança', 'Senha e dispositivos', 'escudo', 'seguranca') +
            '</div>') +
        '</div>' +
        '<div class="adm-grade adm-grade--2">' +
          cartao('Chaves recentes', 'Suas últimas licenças', listaChaves(dados.licencasRecentes)) +
          cartao('Atividades recentes', 'O que aconteceu de novo na sua conta',
            listaAtividades(atividades, true),
            { acoes: botaoAcao('Ver histórico', 'ir', 'seta', ' data-view="atividades"') }) +
        '</div>';

      pintar(html);
    });
  }

  /* ===========================================================================
   * VIEW: MEUS PEDIDOS
   * ========================================================================= */

  function pedidoCard(pedido) {
    var itens = (pedido.itens || []).map(function (item) {
      return '<div class="conta-pedido__item">' +
        '<div class="conta-pedido__item-txt">' +
          '<p class="conta-pedido__item-nome">' + esc(item.nome) + '</p>' +
          '<p class="conta-pedido__item-meta">' + esc(item.plano) + ' · ' + UI.numero(item.quantidade) + 'x · ' +
            UI.dinheiro(item.preco) + '</p>' +
        '</div>' +
        '<span class="conta-pedido__valor">' + esc(item.subtotal) + '</span>' +
      '</div>';
    }).join('');

    var chaves = (pedido.chaves && pedido.chaves.length)
      ? '<div class="conta-pedido__chaves">' + pedido.chaves.map(function (chave) {
          return '<span class="conta-pedido__chave"><code>' + esc(chave) + '</code>' +
            '<button class="icon-btn" type="button" style="width:28px;height:28px" data-acao="copiar" data-valor="' +
              esc(chave) + '" aria-label="Copiar chave">' + UI.icone('copiar') + '</button></span>';
        }).join('') + '</div>'
      : '';

    var rodape = (pedido.desconto && pedido.desconto !== 'R$ 0,00')
      ? '<div class="conta-pedido__item"><div class="conta-pedido__item-txt"><p class="conta-pedido__item-nome">Desconto' +
        (pedido.cupom ? ' (' + esc(pedido.cupom) + ')' : '') + '</p></div>' +
        '<span class="conta-pedido__valor">- ' + esc(pedido.desconto) + '</span></div>'
      : '';

    /*
     * Pedido pendente: o cliente precisa conseguir PAGAR. Mostramos de novo as
     * instruções (Pix copia-e-cola / linha digitável), que agora ficam
     * guardadas no pedido, e damos a opção de desistir.
     */
    var pendente = pedido.status === 'pendente';
    var inst = pedido.instrucoesPagamento;

    var pagamentoPendente = '';
    if (pendente && inst) {
      var codigo = inst.copiaECola || inst.linhaDigitavel || '';
      var rotulo = inst.copiaECola ? 'Pix copia e cola' : 'Linha digitável do boleto';

      pagamentoPendente =
        '<div class="conta-pedido__pagamento">' +
          UI.icone('relogio') +
          '<div class="conta-pedido__pagamento-txt">' +
            '<p class="conta-pedido__pagamento-titulo">Aguardando pagamento · ' + esc(rotulo) + '</p>' +
            (codigo
              ? '<span class="conta-pedido__codigo"><code>' + esc(codigo) + '</code>' +
                '<button class="icon-btn" type="button" style="width:28px;height:28px" data-acao="copiar" data-valor="' +
                esc(codigo) + '" aria-label="Copiar código de pagamento">' + UI.icone('copiar') + '</button></span>'
              : '') +
            (inst.linkPagamento
              ? '<a class="btn btn--soft btn--sm" href="' + esc(inst.linkPagamento) + '" target="_blank" rel="noopener">Abrir pagamento</a>'
              : '') +
            (inst.vencimentoFormatado ? '<p class="conta-pedido__pagamento-nota">Vence em ' + esc(inst.vencimentoFormatado) + '</p>' : '') +
          '</div>' +
        '</div>';
    }

    var acoes = pendente
      ? '<div class="conta-pedido__acoes">' +
          '<button class="btn btn--ghost btn--sm" type="button" data-acao="cancelar-pedido" ' +
            'data-id="' + esc(pedido.id) + '" data-numero="' + esc(pedido.numero) + '">' +
            UI.icone('x') + 'Cancelar pedido</button>' +
        '</div>'
      : '';

    return '<article class="conta-pedido">' +
      '<div class="conta-pedido__cab">' +
        '<span class="conta-pedido__num">' + esc(pedido.numero) + '</span>' +
        '<span class="conta-pedido__data">' + esc(UI.dataHora(pedido.criadoEm)) + '</span>' +
        UI.seloVenda(pedido.status) +
        '<span class="conta-pedido__total">' + esc(pedido.total) + '</span>' +
      '</div>' +
      '<div class="conta-pedido__itens">' + itens + rodape + '</div>' +
      pagamentoPendente +
      chaves +
      acoes +
    '</article>';
  }

  /** Cancela um pedido ainda não pago (o cliente desiste antes de pagar). */
  function cancelarPedido(el) {
    var id = el.getAttribute('data-id');
    var numero = el.getAttribute('data-numero') || 'este pedido';
    if (!id) return;

    UI.confirmar({
      titulo: 'Cancelar pedido',
      texto: 'O pedido ' + numero + ' será cancelado e não poderá mais ser pago. Esta ação não pode ser desfeita.',
      confirmar: 'Cancelar pedido'
    }).then(function (confirmado) {
      if (!confirmado) return;

      el.classList.add('is-loading');
      pedir('POST', '/api/vendas/' + encodeURIComponent(id) + '/cancelar', {}).then(function (resposta) {
        if (!resposta.ok) {
          Api.toast(erroDe(resposta), 'error');
          el.classList.remove('is-loading');
          return;
        }
        Api.toast('Pedido cancelado', 'success');
        viewPedidos();
      });
    });
  }

  function viewPedidos() {
    var token = novoToken();
    var filtro = estado.pedidos;

    registrarAcoes({
      'filtrar-pedidos': function (el) {
        estado.pedidos.status = el.value;
        estado.pedidos.pagina = 1;
        viewPedidos();
      },
      'cancelar-pedido': function (el) { cancelarPedido(el); }
    });

    pintar(esqueleto(3));

    var caminho = '/api/conta/pedidos?limite=20&deslocamento=' + ((filtro.pagina - 1) * 20) +
      (filtro.status ? '&status=' + encodeURIComponent(filtro.status) : '');

    pedir('GET', caminho).then(function (resposta) {
      if (!aindaValido(token)) return;
      if (!resposta.ok) return pintar(UI.estado({ tipo: 'erro', titulo: 'Erro ao carregar pedidos', texto: erroDe(resposta), icone: 'aviso' }));

      var pedidos = resposta.data.pedidos || [];
      var corpo = pedidos.length
        ? pedidos.map(pedidoCard).join('')
        : UI.estado({
            titulo: filtro.status ? 'Nenhum pedido com esse status' : 'Você ainda não comprou',
            texto: filtro.status ? 'Tente outro filtro.' : 'Quando você comprar, os pedidos aparecem aqui.',
            icone: 'pacote',
            acao: '<a class="btn btn--primary btn--sm" href="/produtos">Explorar produtos</a>'
          });

      var barra =
        '<div class="adm-barra">' +
          '<select class="adm-select" data-mudanca="filtrar-pedidos" aria-label="Filtrar por status">' +
            opcoesSelect([
              { valor: '', rotulo: 'Todos os status' },
              { valor: 'pendente', rotulo: 'Pendente' },
              { valor: 'pago', rotulo: 'Pago' },
              { valor: 'cancelado', rotulo: 'Cancelado' },
              { valor: 'reembolsado', rotulo: 'Reembolsado' }
            ], filtro.status) +
          '</select>' +
          '<span class="adm-barra__sep">' + UI.numero(pedidos.length) + ' pedido(s) nesta página</span>' +
          '<span style="margin-left:auto">' + botaoAcao('Atualizar', 'recarregar', 'atualizar') + '</span>' +
        '</div>';

      pintar(cartao('Histórico de compras', 'Todos os seus pedidos, do mais recente ao mais antigo', barra + corpo));
    });
  }

  /* ===========================================================================
   * VIEW: MINHAS LICENÇAS
   * ========================================================================= */

  function viewLicencas() {
    var token = novoToken();
    var filtro = estado.licencas;

    registrarAcoes({
      'filtrar-licencas': function (el) { estado.licencas.status = el.value; viewLicencas(); },
      'resgatar': function (el, evento) {
        var form = el.closest('form');
        var campo = form.querySelector('[name="chave"]');
        var chave = String(campo.value || '').trim();
        if (!chave) return Api.toast('Informe a chave que você quer ativar', 'error');

        var botao = form.querySelector('[data-acao="resgatar"]');
        botao.classList.add('is-loading');
        pedir('POST', '/api/licencas/resgatar', { chave: chave }).then(function (resposta) {
          botao.classList.remove('is-loading');
          if (!resposta.ok) return Api.toast(erroDe(resposta), 'error');
          Api.toast(resposta.data.mensagem || 'Chave ativada', 'success');
          campo.value = '';
          estado.licencas.status = '';
          viewLicencas();
        });
      }
    });

    pintar(esqueleto(2));

    var caminho = '/api/licencas' + (filtro.status ? '?status=' + encodeURIComponent(filtro.status) : '');

    pedir('GET', caminho).then(function (resposta) {
      if (!aindaValido(token)) return;
      if (!resposta.ok) return pintar(UI.estado({ tipo: 'erro', titulo: 'Erro ao carregar licenças', texto: erroDe(resposta), icone: 'aviso' }));

      var chaves = resposta.data.chaves || [];

      var formulario = cartao('Ativar uma chave', 'Cole a chave no formato XXXX-1234-EF56-7890 para começar a contar o prazo',
        '<form class="adm-form" data-form="resgatar" novalidate>' +
          '<div class="adm-form-grade">' +
            '<div class="field adm-campo-largo">' +
              '<label class="field__label" for="chave-resgate">Chave de licença</label>' +
              '<div class="field__control">' +
                '<input class="field__input" id="chave-resgate" name="chave" type="text" autocomplete="off"' +
                  ' spellcheck="false" placeholder="ABCD-1234-EF56-7890" style="text-transform:uppercase">' +
              '</div>' +
              '<span class="adm-campo__dica">A validade começa a contar no momento da ativação, não da compra.</span>' +
            '</div>' +
          '</div>' +
          '<div class="conta-rodape">' +
            '<button class="btn btn--primary" type="button" data-acao="resgatar">' + UI.icone('cadeado') +
              'Ativar chave<span class="spinner" aria-hidden="true"></span></button>' +
          '</div>' +
        '</form>');

      var barra =
        '<div class="adm-barra">' +
          '<select class="adm-select" data-mudanca="filtrar-licencas" aria-label="Filtrar por status">' +
            opcoesSelect([
              { valor: '', rotulo: 'Todas as chaves' },
              { valor: 'ativa', rotulo: 'Aguardando ativação' },
              { valor: 'resgatada', rotulo: 'Ativadas' },
              { valor: 'revogada', rotulo: 'Revogadas' }
            ], filtro.status) +
          '</select>' +
          '<span class="adm-barra__sep">' + UI.numero(chaves.length) + ' chave(s)</span>' +
          '<span style="margin-left:auto">' + botaoAcao('Atualizar', 'recarregar', 'atualizar') + '</span>' +
        '</div>';

      pintar(
        '<div class="adm-grade adm-grade--2-1">' +
          cartao('Minhas chaves', 'Suas licenças e o estado de cada uma', barra + listaChaves(chaves)) +
          formulario +
        '</div>'
      );
    });
  }

  /* ===========================================================================
   * VIEW: FAVORITOS
   * ========================================================================= */

  function cardFavorito(produto) {
    var icone = (produto.capa && produto.capa.icone) || 'raio';
    var preco = produto.precoMin === produto.precoMax
      ? Api.formatarPreco(produto.precoMin)
      : Api.formatarPreco(produto.precoMin) + ' ~ ' + Api.formatarPreco(produto.precoMax);

    return '<article class="conta-fav">' +
      '<div class="conta-fav__topo">' +
        '<span class="conta-fav__icone">' + UI.icone(icone) + '</span>' +
        '<div>' +
          '<p class="conta-fav__nome">' + esc(produto.nome) + '</p>' +
          '<p class="conta-fav__cat">' + esc(produto.categoria || produto.plataforma || '') + '</p>' +
        '</div>' +
      '</div>' +
      '<div class="conta-fav__rodape">' +
        '<span class="conta-fav__preco">' + esc(preco) + '</span>' +
        '<button class="icon-btn" type="button" data-acao="remover-favorito" data-produto="' + esc(produto.id) +
          '" aria-label="Remover dos favoritos" title="Remover dos favoritos">' + UI.icone('lixeira') + '</button>' +
      '</div>' +
    '</article>';
  }

  function viewFavoritos() {
    var token = novoToken();

    registrarAcoes({
      'remover-favorito': function (el) {
        var id = el.getAttribute('data-produto');
        el.disabled = true;
        pedir('DELETE', '/api/favoritos/' + encodeURIComponent(id)).then(function (resposta) {
          el.disabled = false;
          if (!resposta.ok) return Api.toast(erroDe(resposta), 'error');
          Api.toast('Removido dos favoritos', 'success');
          viewFavoritos();
        });
      }
    });

    pintar(esqueleto(2));

    pedir('GET', '/api/favoritos').then(function (resposta) {
      if (!aindaValido(token)) return;
      if (!resposta.ok) return pintar(UI.estado({ tipo: 'erro', titulo: 'Erro ao carregar favoritos', texto: erroDe(resposta), icone: 'aviso' }));

      var produtos = resposta.data.produtos || [];
      var corpo = produtos.length
        ? '<div class="conta-favs">' + produtos.map(cardFavorito).join('') + '</div>'
        : UI.estado({
            titulo: 'Sua lista está vazia',
            texto: 'Toque no coração de um produto para salvá-lo aqui.',
            icone: 'coracao',
            acao: '<a class="btn btn--primary btn--sm" href="/produtos">Explorar produtos</a>'
          });

      pintar(cartao('Favoritos', UI.numero(produtos.length) + ' produto(s) salvos', corpo));
    });
  }

  /* ===========================================================================
   * VIEW: MINHAS AVALIAÇÕES
   * ========================================================================= */

  function estrelasInput(valor) {
    var v = Number(valor) || 0;
    var html = '';
    for (var i = 1; i <= 5; i++) {
      html += '<button class="conta-nota__btn' + (i <= v ? ' is-on' : '') + '" type="button" data-estrela="' + i +
        '" aria-label="' + i + ' de 5">' + UI.icone('estrela') + '</button>';
    }
    return html;
  }

  function abrirFormAvaliacao(item) {
    var notaAtual = item.avaliacao ? item.avaliacao.nota : 5;
    var comentarioAtual = item.avaliacao ? (item.avaliacao.comentario || '') : '';

    var corpo =
      '<div class="adm-form">' +
        '<input type="hidden" name="nota" value="' + Number(notaAtual) + '">' +
        '<div class="field">' +
          '<span class="field__label">Sua nota</span>' +
          '<div class="conta-nota" data-nota>' + estrelasInput(notaAtual) + '</div>' +
        '</div>' +
        '<div class="field">' +
          '<label class="field__label" for="avaliacao-comentario">Comentário (opcional)</label>' +
          '<textarea class="field__input adm-textarea" id="avaliacao-comentario" name="comentario" maxlength="600"' +
            ' placeholder="O que você achou do produto?">' + esc(comentarioAtual) + '</textarea>' +
        '</div>' +
      '</div>';

    UI.modal({
      titulo: item.avaliacao ? 'Editar avaliação' : 'Avaliar produto',
      sub: item.produto || '',
      corpo: corpo,
      pe: '<button class="btn btn--soft" type="button" data-fechar>Cancelar</button>' +
          '<button class="btn btn--primary" type="button" data-salvar-avaliacao>' + UI.icone('check') +
          'Salvar<span class="spinner" aria-hidden="true"></span></button>',
      aoAbrir: function (caixa, fechar) {
        var campoNota = caixa.querySelector('[name="nota"]');
        var blocoNota = caixa.querySelector('[data-nota]');

        blocoNota.addEventListener('click', function (evento) {
          var botao = evento.target.closest('[data-estrela]');
          if (!botao) return;
          campoNota.value = botao.getAttribute('data-estrela');
          blocoNota.innerHTML = estrelasInput(campoNota.value);
        });

        caixa.querySelector('[data-salvar-avaliacao]').addEventListener('click', function () {
          var botao = this;
          botao.classList.add('is-loading');
          pedir('POST', '/api/avaliacoes', {
            produtoId: item.produtoId,
            nota: Number(campoNota.value),
            comentario: caixa.querySelector('[name="comentario"]').value
          }).then(function (resposta) {
            botao.classList.remove('is-loading');
            if (!resposta.ok) return Api.toast(erroDe(resposta), 'error');
            Api.toast('Avaliação salva', 'success');
            fechar();
            viewAvaliacoes();
          });
        });
      }
    });
  }

  function itemAvaliacao(item) {
    var avaliacao = item.avaliacao;

    var corpo = avaliacao
      ? '<div class="conta-avaliacao">' +
          '<div>' + UI.estrelas(avaliacao.nota) + '</div>' +
          (avaliacao.comentario
            ? '<p class="conta-avaliacao__texto">' + esc(avaliacao.comentario) + '</p>'
            : '<p class="conta-avaliacao__texto" style="color:var(--text-3)">Sem comentário.</p>') +
          '<div class="conta-avaliacao__rodape">' +
            '<span class="adm-selo adm-selo--neutro adm-selo--sem-ponto">' +
              esc(avaliacao.atualizadoEm ? 'Editada ' + UI.relativo(avaliacao.atualizadoEm) : 'Publicada ' + UI.relativo(avaliacao.criadoEm)) +
            '</span>' +
            '<span style="margin-left:auto"></span>' +
            botaoAcao('Editar', 'avaliar', 'editar', ' data-produto="' + esc(item.produtoId) + '"') +
            botaoAcao('Remover', 'remover-avaliacao', 'lixeira', ' data-avaliacao="' + esc(avaliacao.id) + '"') +
          '</div>' +
        '</div>'
      : '<div class="conta-avaliacao">' +
          '<p class="conta-avaliacao__texto" style="color:var(--text-3)">' +
            'Você ainda não avaliou este produto. Sua opinião ajuda outros jogadores.' +
          '</p>' +
          '<div class="conta-avaliacao__rodape">' +
            botaoAcao('Avaliar', 'avaliar', 'estrela', ' data-produto="' + esc(item.produtoId) + '"') +
          '</div>' +
        '</div>';

    return cartao(item.produto || 'Produto', 'Compra verificada', corpo);
  }

  var cacheAvaliacoes = [];

  function viewAvaliacoes() {
    var token = novoToken();

    registrarAcoes({
      'avaliar': function (el) {
        var produtoId = el.getAttribute('data-produto');
        var item = cacheAvaliacoes.filter(function (i) { return i.produtoId === produtoId; })[0];
        if (item) abrirFormAvaliacao(item);
      },
      'remover-avaliacao': function (el) {
        var id = el.getAttribute('data-avaliacao');
        UI.confirmar({
          titulo: 'Remover avaliação',
          texto: 'Sua avaliação será apagada e não poderá ser recuperada. Deseja continuar?',
          confirmar: 'Remover'
        }).then(function (confirmado) {
          if (!confirmado) return;
          pedir('DELETE', '/api/avaliacoes/' + encodeURIComponent(id)).then(function (resposta) {
            if (!resposta.ok) return Api.toast(erroDe(resposta), 'error');
            Api.toast('Avaliação removida', 'success');
            viewAvaliacoes();
          });
        });
      }
    });

    pintar(esqueleto(2));

    pedir('GET', '/api/avaliacoes/minhas').then(function (resposta) {
      if (!aindaValido(token)) return;
      if (!resposta.ok) return pintar(UI.estado({ tipo: 'erro', titulo: 'Erro ao carregar avaliações', texto: erroDe(resposta), icone: 'aviso' }));

      cacheAvaliacoes = resposta.data.itens || [];

      if (!cacheAvaliacoes.length) {
        return pintar(cartao('Minhas avaliações', 'Só quem comprou pode avaliar',
          UI.estado({
            titulo: 'Nada para avaliar ainda',
            texto: 'Depois de comprar um produto, você poderá avaliá-lo aqui.',
            icone: 'estrela',
            acao: '<a class="btn btn--primary btn--sm" href="/produtos">Explorar produtos</a>'
          })));
      }

      pintar(
        '<div class="adm-aviso adm-aviso--info">' + UI.icone('info') +
          '<span>Avaliações são de <strong>compra verificada</strong>: aparecem aqui os produtos que você já adquiriu.</span>' +
        '</div>' +
        '<div class="adm-grade adm-grade--2">' + cacheAvaliacoes.map(itemAvaliacao).join('') + '</div>'
      );
    });
  }

  /* ===========================================================================
   * VIEW: PERFIL
   * ========================================================================= */

  function viewPerfil() {
    var token = novoToken();

    registrarAcoes({
      'salvar-perfil': function (el) {
        var form = el.closest('form');
        var botao = form.querySelector('[data-acao="salvar-perfil"]');
        botao.classList.add('is-loading');

        pedir('PATCH', '/api/conta', {
          nome: form.querySelector('[name="nome"]').value,
          email: form.querySelector('[name="email"]').value
        }).then(function (resposta) {
          botao.classList.remove('is-loading');
          if (!resposta.ok) {
            var detalhes = resposta.data && resposta.data.detalhes;
            if (detalhes) {
              var primeiro = Object.keys(detalhes)[0];
              return Api.toast(detalhes[primeiro], 'error');
            }
            return Api.toast(erroDe(resposta), 'error');
          }
          Api.toast(resposta.data.mensagem || 'Perfil atualizado', 'success');
          atualizarCasca(resposta.data.usuario, null);
          viewPerfil();
        });
      }
    });

    pintar(esqueleto(2));

    pedir('GET', '/api/conta').then(function (resposta) {
      if (!aindaValido(token)) return;
      if (!resposta.ok) return pintar(UI.estado({ tipo: 'erro', titulo: 'Erro ao carregar perfil', texto: erroDe(resposta), icone: 'aviso' }));

      var usuario = resposta.data.usuario;
      atualizarCasca(usuario, null);

      var formulario = cartao('Dados do perfil', 'Como você aparece na loja',
        '<form class="adm-form" data-form="perfil" novalidate>' +
          '<div class="adm-form-grade">' +
            '<div class="field">' +
              '<label class="field__label" for="perfil-nome">Nome</label>' +
              '<div class="field__control">' +
                '<input class="field__input" id="perfil-nome" name="nome" type="text" autocomplete="name"' +
                  ' maxlength="60" value="' + esc(usuario.nome) + '" required>' +
              '</div>' +
            '</div>' +
            '<div class="field">' +
              '<label class="field__label" for="perfil-email">E-mail</label>' +
              '<div class="field__control">' +
                '<input class="field__input" id="perfil-email" name="email" type="email" autocomplete="email"' +
                  ' spellcheck="false" maxlength="254" value="' + esc(usuario.email) + '" required>' +
              '</div>' +
              '<span class="adm-campo__dica">É por aqui que você entra na conta e recebe os avisos.</span>' +
            '</div>' +
          '</div>' +
          '<div class="conta-rodape">' +
            '<button class="btn btn--primary" type="button" data-acao="salvar-perfil">' + UI.icone('check') +
              'Salvar alterações<span class="spinner" aria-hidden="true"></span></button>' +
            '<span class="conta-rodape__dica">Alterações ficam registradas no seu histórico de atividades.</span>' +
          '</div>' +
        '</form>');

      var ficha = cartao('Sua conta', 'Informações de cadastro',
        '<div class="adm-detalhe">' +
          '<div class="adm-detalhe__linha"><span class="adm-detalhe__rotulo">Nome</span>' +
            '<span class="adm-detalhe__valor">' + esc(usuario.nome) + '</span></div>' +
          '<div class="adm-detalhe__linha"><span class="adm-detalhe__rotulo">E-mail</span>' +
            '<span class="adm-detalhe__valor">' + esc(usuario.email) + '</span></div>' +
          '<div class="adm-detalhe__linha"><span class="adm-detalhe__rotulo">Perfil</span>' +
            '<span class="adm-detalhe__valor">' + (Api.ehAdmin(usuario) ? 'Administrador' : 'Cliente') + '</span></div>' +
          '<div class="adm-detalhe__linha"><span class="adm-detalhe__rotulo">Cliente desde</span>' +
            '<span class="adm-detalhe__valor">' + esc(UI.dataCurta(usuario.criadoEm)) + '</span></div>' +
          '<div class="adm-detalhe__linha"><span class="adm-detalhe__rotulo">Último acesso</span>' +
            '<span class="adm-detalhe__valor">' + esc(UI.dataHora(usuario.ultimoLoginEm)) + '</span></div>' +
        '</div>' +
        '<div class="conta-rodape">' +
          '<a class="btn btn--soft btn--sm" href="#/seguranca">' + UI.icone('escudo') + 'Ir para segurança</a>' +
        '</div>');

      pintar(
        '<div class="adm-grade adm-grade--2-1">' + formulario + ficha + '</div>'
      );
    });
  }

  /* ===========================================================================
   * VIEW: SEGURANÇA
   * ========================================================================= */

  function viewSeguranca() {
    var token = novoToken();

    registrarAcoes({
      'salvar-senha': function (el) {
        var form = el.closest('form');
        var senhaAtual = form.querySelector('[name="senhaAtual"]').value;
        var novaSenha = form.querySelector('[name="novaSenha"]').value;
        var confirmar = form.querySelector('[name="confirmar"]').value;
        var erro = form.querySelector('[data-erro-senha]');

        erro.textContent = '';
        if (novaSenha !== confirmar) {
          erro.textContent = 'A confirmação não confere com a nova senha.';
          return;
        }

        var botao = form.querySelector('[data-acao="salvar-senha"]');
        botao.classList.add('is-loading');

        pedir('PATCH', '/api/auth/senha', { senhaAtual: senhaAtual, novaSenha: novaSenha }).then(function (resposta) {
          botao.classList.remove('is-loading');
          if (!resposta.ok) {
            var detalhes = resposta.data && resposta.data.detalhes;
            var msg = detalhes ? (detalhes.senhaAtual || detalhes.novaSenha || detalhes.senha) : null;
            erro.textContent = msg || erroDe(resposta);
            return;
          }
          Api.toast('Senha alterada com sucesso', 'success');
          form.reset();
          viewSeguranca();
        });
      },
      'encerrar-outras': function () {
        UI.confirmar({
          titulo: 'Encerrar outras sessões',
          texto: 'Você continuará conectado neste aparelho, mas sairá de todos os outros.',
          confirmar: 'Encerrar outras'
        }).then(function (confirmado) {
          if (!confirmado) return;
          pedir('POST', '/api/auth/sessoes/encerrar-outras').then(function (resposta) {
            if (!resposta.ok) return Api.toast(erroDe(resposta), 'error');
            Api.toast(resposta.data.encerradas
              ? resposta.data.encerradas + ' sessão(ões) encerrada(s)'
              : 'Nenhuma outra sessão estava aberta', 'success');
            viewSeguranca();
          });
        });
      }
    });

    pintar(esqueleto(2));

    pedir('GET', '/api/conta/dispositivos').then(function (resposta) {
      if (!aindaValido(token)) return;
      if (!resposta.ok) return pintar(UI.estado({ tipo: 'erro', titulo: 'Erro ao carregar dispositivos', texto: erroDe(resposta), icone: 'aviso' }));

      var dispositivos = resposta.data.dispositivos || [];

      var senhaForm = cartao('Alterar senha', 'Trocar a senha encerra as sessões dos outros aparelhos',
        '<form class="adm-form" data-form="senha" novalidate>' +
          '<div class="adm-form-grade">' +
            '<div class="field adm-campo-largo">' +
              '<label class="field__label" for="senha-atual">Senha atual</label>' +
              '<div class="field__control">' +
                '<input class="field__input" id="senha-atual" name="senhaAtual" type="password"' +
                  ' autocomplete="current-password" required>' +
              '</div>' +
            '</div>' +
            '<div class="field">' +
              '<label class="field__label" for="senha-nova">Nova senha</label>' +
              '<div class="field__control">' +
                '<input class="field__input" id="senha-nova" name="novaSenha" type="password"' +
                  ' autocomplete="new-password" required>' +
              '</div>' +
            '</div>' +
            '<div class="field">' +
              '<label class="field__label" for="senha-confirmar">Confirmar nova senha</label>' +
              '<div class="field__control">' +
                '<input class="field__input" id="senha-confirmar" name="confirmar" type="password"' +
                  ' autocomplete="new-password" required>' +
              '</div>' +
            '</div>' +
          '</div>' +
          '<p class="field__error" data-erro-senha></p>' +
          '<div class="conta-rodape">' +
            '<button class="btn btn--primary" type="button" data-acao="salvar-senha">' + UI.icone('escudo') +
              'Alterar senha<span class="spinner" aria-hidden="true"></span></button>' +
            '<a class="btn btn--ghost btn--sm" href="/login?recuperar=1">Esqueci minha senha</a>' +
          '</div>' +
        '</form>');

      var lista = dispositivos.length
        ? dispositivos.map(function (dispositivo) {
            return '<div class="conta-dispositivo">' +
              '<span class="conta-dispositivo__icone">' + UI.icone(dispositivo.atual ? 'escudo' : 'chip') + '</span>' +
              '<div class="conta-dispositivo__txt">' +
                '<p class="conta-dispositivo__nome">' +
                  (dispositivo.atual ? 'Este aparelho' : 'Outro aparelho') + '</p>' +
                '<p class="conta-dispositivo__meta">' + esc(dispositivo.dispositivo || 'Desconhecido') +
                  (dispositivo.ip ? ' · ' + esc(dispositivo.ip) : '') + '</p>' +
                '<p class="conta-dispositivo__meta">Iniciada ' + esc(UI.dataHora(dispositivo.criadaEm)) +
                  (dispositivo.expiraEm ? ' · expira em ' + esc(UI.dataCurta(dispositivo.expiraEm)) : '') + '</p>' +
              '</div>' +
              (dispositivo.atual ? UI.selo('ok', 'Atual') : '') +
            '</div>';
          }).join('')
        : UI.estado({ titulo: 'Nenhuma sessão', texto: 'Não encontramos sessões ativas.', icone: 'escudo' });

      var dispositivosCard = cartao('Dispositivos conectados',
        UI.numero(dispositivos.length) + ' sessão(ões) ativa(s)',
        lista +
        '<div class="conta-rodape">' +
          botaoAcao('Encerrar outras sessões', 'encerrar-outras', 'sair') +
        '</div>');

      pintar('<div class="adm-grade adm-grade--2-1">' + senhaForm + dispositivosCard + '</div>');
    });
  }

  /* ===========================================================================
   * VIEW: PREFERÊNCIAS
   * ========================================================================= */

  function controlePreferencia(opcao, valor) {
    var controle;

    if (opcao.tipo === 'booleano') {
      controle = '<span class="adm-switch">' +
        '<input type="checkbox" name="' + esc(opcao.chave) + '"' + (valor ? ' checked' : '') +
          ' aria-label="' + esc(opcao.titulo) + '">' +
        '<span class="adm-switch__trilha" aria-hidden="true"></span>' +
      '</span>';
    } else {
      controle = '<select class="adm-select" name="' + esc(opcao.chave) + '" aria-label="' + esc(opcao.titulo) + '">' +
        opcoesSelect(opcao.opcoes || [], valor) + '</select>';
    }

    return '<div class="conta-pref-linha">' +
      '<div class="conta-pref-linha__txt">' +
        '<p class="conta-pref-linha__titulo">' + esc(opcao.titulo) + '</p>' +
        '<p class="conta-pref-linha__dica">' + esc(opcao.descricao || '') + '</p>' +
      '</div>' +
      controle +
    '</div>';
  }

  function viewPreferencias() {
    var token = novoToken();

    registrarAcoes({
      'salvar-preferencias': function (el) {
        var form = el.closest('form');
        var dados = {};

        qsa('[name]', form).forEach(function (campo) {
          dados[campo.name] = campo.type === 'checkbox' ? campo.checked : campo.value;
        });

        var botao = form.querySelector('[data-acao="salvar-preferencias"]');
        botao.classList.add('is-loading');

        pedir('PATCH', '/api/conta/preferencias', dados).then(function (resposta) {
          botao.classList.remove('is-loading');
          if (!resposta.ok) return Api.toast(erroDe(resposta), 'error');
          Api.toast(resposta.data.mensagem || 'Preferências salvas', 'success');
          viewPreferencias();
        });
      }
    });

    pintar(esqueleto(2));

    pedir('GET', '/api/conta/preferencias').then(function (resposta) {
      if (!aindaValido(token)) return;
      if (!resposta.ok) return pintar(UI.estado({ tipo: 'erro', titulo: 'Erro ao carregar preferências', texto: erroDe(resposta), icone: 'aviso' }));

      var preferencias = resposta.data.preferencias || {};
      var opcoes = resposta.data.opcoes || [];

      var corpo = '<form class="adm-form" data-form="preferencias" novalidate>' +
        '<div class="conta-prefs">' +
          opcoes.map(function (opcao) { return controlePreferencia(opcao, preferencias[opcao.chave]); }).join('') +
        '</div>' +
        '<div class="conta-rodape">' +
          '<button class="btn btn--primary" type="button" data-acao="salvar-preferencias">' + UI.icone('check') +
            'Salvar preferências<span class="spinner" aria-hidden="true"></span></button>' +
          '<span class="conta-rodape__dica">Você pode mudar isso quando quiser.</span>' +
        '</div>' +
      '</form>';

      pintar(cartao('Preferências', 'Como você quer ser avisado e qual aparência prefere', corpo));
    });
  }

  /* ===========================================================================
   * VIEW: ATIVIDADES
   * ========================================================================= */

  function chipsTipos(tipos, ativo) {
    var html = '<button class="conta-chip' + (!ativo ? ' is-active' : '') + '" type="button"' +
      ' data-acao="filtrar-tipo" data-tipo="">' + UI.icone('lista') + 'Todos</button>';

    tipos.forEach(function (tipo) {
      html += '<button class="conta-chip' + (ativo === tipo.tipo ? ' is-active' : '') + '" type="button"' +
        ' data-acao="filtrar-tipo" data-tipo="' + esc(tipo.tipo) + '">' +
        UI.icone(tipo.icone) + esc(tipo.rotulo) + '<b>' + UI.numero(tipo.total) + '</b></button>';
    });

    return '<div class="conta-chips">' + html + '</div>';
  }

  function viewAtividades() {
    var token = novoToken();
    var filtro = estado.atividades;
    var POR_PAGINA = 30;

    registrarAcoes({
      'filtrar-tipo': function (el) {
        estado.atividades.tipo = el.getAttribute('data-tipo');
        estado.atividades.pagina = 1;
        viewAtividades();
      },
      'pagina': function (el) {
        estado.atividades.pagina = Number(el.getAttribute('data-pagina')) || 1;
        viewAtividades();
      },
      'limpar-atividades': function () {
        UI.confirmar({
          titulo: 'Limpar histórico',
          texto: 'Todo o seu histórico de atividades será apagado. Esta ação não pode ser desfeita.',
          confirmar: 'Limpar tudo'
        }).then(function (confirmado) {
          if (!confirmado) return;
          pedir('DELETE', '/api/conta/atividades').then(function (resposta) {
            if (!resposta.ok) return Api.toast(erroDe(resposta), 'error');
            Api.toast(resposta.data.mensagem || 'Histórico limpo', 'success');
            estado.atividades.pagina = 1;
            estado.atividades.tipo = '';
            viewAtividades();
          });
        });
      },
      'buscar-atividades': function (el) {
        estado.atividades.busca = el.value;
        estado.atividades.pagina = 1;
        viewAtividades();
      }
    });

    pintar(esqueleto(2));

    var caminho = '/api/conta/atividades?limite=' + POR_PAGINA +
      '&deslocamento=' + ((filtro.pagina - 1) * POR_PAGINA) +
      (filtro.tipo ? '&tipo=' + encodeURIComponent(filtro.tipo) : '') +
      (filtro.busca ? '&busca=' + encodeURIComponent(filtro.busca) : '');

    pedir('GET', caminho).then(function (resposta) {
      if (!aindaValido(token)) return;
      if (!resposta.ok) return pintar(UI.estado({ tipo: 'erro', titulo: 'Erro ao carregar atividades', texto: erroDe(resposta), icone: 'aviso' }));

      var dados = resposta.data;
      var atividades = dados.atividades || [];
      var total = dados.total || 0;

      atualizarContador('atividades', total);

      var filtros = '<div class="adm-barra" style="flex-direction:column;align-items:stretch;gap:12px">' +
        '<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">' +
          barraBusca('Buscar no histórico...', filtro.busca, 'buscar-atividades') +
          '<span style="margin-left:auto">' +
            botaoAcao('Limpar histórico', 'limpar-atividades', 'lixeira') +
            botaoAcao('Atualizar', 'recarregar', 'atualizar') +
          '</span>' +
        '</div>' +
        chipsTipos(dados.tipos || [], filtro.tipo) +
      '</div>';

      var paginas = Math.max(Math.ceil(total / POR_PAGINA), 1);
      var paginacao = total > POR_PAGINA
        ? UI.paginacaoHtml({ pagina: filtro.pagina, paginas: paginas, total: total })
        : '';

      pintar(cartao('Histórico de atividades', UI.numero(total) + ' registro(s) na sua linha do tempo',
        filtros + listaAtividades(atividades, false) + paginacao));
    });
  }

  /* ===========================================================================
   * Roteador
   * ========================================================================= */

  var VIEWS = {
    painel: { titulo: 'Visão geral', sub: 'Seu resumo na NEXUS.GG', render: viewPainel },
    pedidos: { titulo: 'Meus pedidos', sub: 'Histórico completo de compras', render: viewPedidos },
    licencas: { titulo: 'Minhas licenças', sub: 'Suas chaves e a ativação', render: viewLicencas },
    favoritos: { titulo: 'Favoritos', sub: 'Produtos que você salvou', render: viewFavoritos },
    avaliacoes: { titulo: 'Minhas avaliações', sub: 'Sua opinião sobre o que você comprou', render: viewAvaliacoes },
    perfil: { titulo: 'Perfil', sub: 'Seus dados de cadastro', render: viewPerfil },
    seguranca: { titulo: 'Segurança', sub: 'Senha e dispositivos conectados', render: viewSeguranca },
    preferencias: { titulo: 'Preferências', sub: 'Avisos e aparência', render: viewPreferencias },
    atividades: { titulo: 'Atividades', sub: 'Tudo o que aconteceu na sua conta', render: viewAtividades }
  };

  function viewDaUrl() {
    var bruto = String(window.location.hash || '').replace(/^#\/?/, '').split('?')[0];
    return VIEWS[bruto] ? bruto : 'painel';
  }

  function rotear() {
    var nome = viewDaUrl();
    estado.view = nome;

    qs('#titulo-view').textContent = VIEWS[nome].titulo;
    qs('#sub-view').textContent = VIEWS[nome].sub;

    qsa('#nav [data-view]').forEach(function (link) {
      var ativo = link.getAttribute('data-view') === nome;
      link.classList.toggle('is-active', ativo);
      if (ativo) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });

    fecharSidebar();
    VIEWS[nome].render();
  }

  function atualizar() {
    VIEWS[estado.view].render();
  }

  /* ===========================================================================
   * Casca (sidebar, topo, sessão)
   * ========================================================================= */

  function hidratarIcones(raiz) {
    qsa('[data-icone]', raiz).forEach(function (el) {
      var nome = el.getAttribute('data-icone');
      el.removeAttribute('data-icone');
      el.innerHTML = UI.icone(nome);
    });
  }

  function abrirSidebar() {
    qs('#sidebar').classList.add('is-aberta');
    qs('#sidebar-fundo').hidden = false;
    qs('#btn-sidebar').setAttribute('aria-expanded', 'true');
  }

  function fecharSidebar() {
    qs('#sidebar').classList.remove('is-aberta');
    qs('#sidebar-fundo').hidden = true;
    qs('#btn-sidebar').setAttribute('aria-expanded', 'false');
  }

  function atualizarContador(nome, valor) {
    var el = qs('[data-contador="' + nome + '"]');
    if (!el) return;
    if (valor === null || valor === undefined || valor === 0) {
      el.hidden = true;
      el.textContent = '';
      return;
    }
    el.hidden = false;
    el.textContent = UI.numero(valor);
  }

  // Atualiza a ficha lateral e, quando informadas, as estatísticas dos contadores.
  function atualizarCasca(usuario, estatisticas) {
    if (usuario) {
      estado.usuario = usuario;
      qs('#conta-avatar').textContent = UI.iniciais(usuario.nome);
      qs('#conta-nome').textContent = usuario.nome || '—';
      qs('#conta-email').textContent = usuario.email || '—';
    }

    if (estatisticas) {
      atualizarContador('pedidos', estatisticas.pedidos);
      atualizarContador('licencas', estatisticas.licencas);
      atualizarContador('favoritos', estatisticas.favoritos);
      atualizarContador('sessoes', estatisticas.sessoesAtivas);
    }
  }

  function mostrarRestrito() {
    qs('#painel').hidden = true;
    var caixa = qs('#restrito');
    caixa.hidden = false;
    hidratarIcones(caixa);
  }

  function mostrarPainel() {
    qs('#restrito').hidden = true;
    var painel = qs('#painel');
    painel.hidden = false;
    hidratarIcones(painel);
  }

  function ligarCasca() {
    qs('#btn-atualizar').addEventListener('click', function () {
      var botao = qs('#btn-atualizar');
      botao.classList.add('is-loading');
      atualizar();
      setTimeout(function () { botao.classList.remove('is-loading'); }, 600);
    });

    qs('#conta-sair').addEventListener('click', function () { Api.logout(); });

    qs('#btn-sidebar').addEventListener('click', abrirSidebar);
    qs('#sidebar-fundo').addEventListener('click', fecharSidebar);

    qs('#nav').addEventListener('click', function (evento) {
      if (evento.target.closest('a')) fecharSidebar();
    });

    document.addEventListener('keydown', function (evento) {
      if (evento.key === 'Escape') fecharSidebar();
    });

    // Delegação dentro do conteúdo.
    conteudo().addEventListener('click', function (evento) {
      var alvo = evento.target.closest('[data-acao]');
      if (alvo) despachar(alvo.getAttribute('data-acao'), alvo, evento);
    });

    conteudo().addEventListener('change', function (evento) {
      var alvo = evento.target.closest('[data-mudanca]');
      if (alvo) despachar(alvo.getAttribute('data-mudanca'), alvo, evento);
    });

    var aoDigitar = UI.debounce(function (alvo) {
      var acao = alvo.getAttribute('data-entrada');
      var handler = acoes[acao];
      if (typeof handler !== 'function') return;

      // A view repinta e recria o input; guardamos foco e seleção para restaurar
      // logo depois — sem isso, digitar na busca perderia o cursor a cada tecla.
      var inicio = null;
      var fim = null;
      try { inicio = alvo.selectionStart; fim = alvo.selectionEnd; } catch (erro) { /* inputs sem seleção */ }

      handler(alvo);

      var novo = qs('[data-entrada="' + acao + '"]');
      if (novo && novo !== alvo) {
        novo.focus();
        if (inicio !== null) {
          try { novo.setSelectionRange(inicio, fim); } catch (erro) { /* ignora */ }
        }
      }
    }, 380);

    conteudo().addEventListener('input', function (evento) {
      var alvo = evento.target.closest('[data-entrada]');
      if (alvo) aoDigitar(alvo);
    });

    // Enter dentro dos formulários da área do cliente dispara o botão principal.
    conteudo().addEventListener('submit', function (evento) {
      var form = evento.target.closest('form[data-form]');
      if (!form) return;
      evento.preventDefault();
      var principal = form.querySelector('[data-acao]');
      if (principal) despachar(principal.getAttribute('data-acao'), principal, evento);
    });

    window.addEventListener('hashchange', rotear);
  }

  /* ===========================================================================
   * Início
   * ========================================================================= */

  function iniciar() {
    ligarCasca();

    Api.me().then(function (usuario) {
      if (!usuario) return mostrarRestrito();

      // Administrador ganha um atalho direto para o painel na barra superior —
      // lugar sempre visível, mesmo com a gaveta lateral fechada em telas
      // estreitas.
      var atalho = qs('#conta-admin-topo');
      if (atalho) atalho.hidden = !Api.ehAdmin(usuario);

      atualizarCasca(usuario, null);
      mostrarPainel();
      rotear();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', iniciar);
  } else {
    iniciar();
  }

  window.Conta = {
    ir: function (view) { window.location.hash = '#/' + view; },
    atualizar: atualizar,
    estado: estado
  };
})();
