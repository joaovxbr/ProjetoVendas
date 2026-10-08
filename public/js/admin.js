/*
 * admin.js
 * -----------------------------------------------------------------------------
 * Painel administrativo (SPA leve, sem framework). Roda depois de api.js e
 * admin-ui.js e expõe window.Admin (útil para depurar no console).
 *
 * Como funciona:
 *   - A URL usa hash: #/painel, #/pedidos, #/produtos... O roteador troca a view.
 *   - Cada view busca seus dados da API /api/admin/* e pinta em #conteudo.
 *   - Os cliques dentro do conteúdo são capturados por delegação e despachados
 *     para o mapa de ações registrado pela view atual (data-acao="...").
 *   - Um "token" de render evita que uma resposta atrasada pinte na view errada
 *     quando o admin troca de aba antes da requisição terminar.
 *
 * Segurança: a API já barra não-administradores (401/403). Esta página apenas
 * esconde a interface; nada aqui é a única barreira.
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

  // Token de render: só pinta se a resposta for da view que ainda está na tela.
  var tokenRender = 0;
  function novoToken() { return ++tokenRender; }
  function aindaValido(token) { return token === tokenRender; }

  function erroDe(resposta) {
    return (resposta && resposta.data && resposta.data.erro) || 'Não foi possível concluir a operação.';
  }

  function pedir(metodo, caminho, corpo) { return Api.request(metodo, caminho, corpo); }

  function moedaCompacta(valor) {
    var n = Number(valor) || 0;
    if (n >= 1000000) return 'R$ ' + (n / 1000000).toFixed(1).replace('.', ',') + 'M';
    if (n >= 1000) return 'R$ ' + Math.round(n / 1000) + 'k';
    return 'R$ ' + Math.round(n);
  }

  function jsonCurto(dados) {
    if (!dados || typeof dados !== 'object') return '—';
    var texto = JSON.stringify(dados);
    return texto.length > 70 ? texto.slice(0, 67) + '…' : texto;
  }

  var ROTULOS_ACAO = {
    'produto.criado': 'Produto criado',
    'produto.atualizado': 'Produto atualizado',
    'produto.ativado': 'Produto ativado',
    'produto.desativado': 'Produto desativado',
    'pedido.status_alterado': 'Status do pedido alterado',
    'cupom.criado': 'Cupom criado',
    'cupom.atualizado': 'Cupom atualizado',
    'cupom.removido': 'Cupom removido',
    'avaliacao.removida': 'Avaliação removida',
    'usuario.papel_alterado': 'Papel de usuário alterado',
    'usuario.ativado': 'Usuário ativado',
    'usuario.desativado': 'Usuário desativado',
    'configuracoes.atualizadas': 'Configurações atualizadas'
  };

  function rotuloAcao(acao) {
    if (ROTULOS_ACAO[acao]) return ROTULOS_ACAO[acao];
    return String(acao || '—').replace(/[._]/g, ' ');
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

  function barraBusca(placeholder, valor, acao) {
    return '<span class="adm-barra__campo">' + UI.icone('busca') +
      '<input class="field__input" type="search" placeholder="' + esc(placeholder) + '" value="' + esc(valor || '') + '"' +
      ' data-entrada="' + acao + '" aria-label="' + esc(placeholder) + '"></span>';
  }

  function opcoesSelect(itens, selecionado) {
    return itens.map(function (item) {
      var valor = typeof item === 'string' ? item : item.valor;
      var rotulo = typeof item === 'string' ? item : item.rotulo;
      return '<option value="' + esc(valor) + '"' + (String(valor) === String(selecionado) ? ' selected' : '') + '>' +
        esc(rotulo) + '</option>';
    }).join('');
  }

  function aviso(tipo, texto) {
    var ic = tipo === 'erro' ? 'aviso' : (tipo === 'info' ? 'info' : 'aviso');
    return '<div class="adm-aviso' + (tipo ? ' adm-aviso--' + tipo : '') + '">' + UI.icone(ic) + '<span>' + esc(texto) + '</span></div>';
  }

  function dataAttrData(iso) {
    return '<span title="' + esc(UI.dataHora(iso)) + '">' + esc(UI.relativo(iso)) + '</span>';
  }

  /* ---------------------------------------------------------------------------
   * Ações (delegação de eventos dentro de #conteudo)
   * ------------------------------------------------------------------------- */

  var acoes = {};
  function registrarAcoes(mapa) { acoes = mapa || {}; }

  function despachar(nome, alvo, evento) {
    var handler = acoes[nome];
    if (typeof handler !== 'function') return;
    evento.preventDefault();
    handler(alvo, evento);
  }

  /* ---------------------------------------------------------------------------
   * Roteador
   * ------------------------------------------------------------------------- */

  var VIEWS = {
    painel: { titulo: 'Painel', sub: 'Resumo da loja em tempo real', render: viewPainel },
    financeiro: { titulo: 'Financeiro', sub: 'O dinheiro da loja: recebido, a receber e devolvido', render: viewFinanceiro },
    relatorios: { titulo: 'Relatórios', sub: 'Desempenho da loja por período', render: viewRelatorios },
    indicadores: { titulo: 'Indicadores', sub: 'O que os clientes desejam e o que sai mais', render: viewIndicadores },
    pedidos: { titulo: 'Pedidos', sub: 'Acompanhe e gerencie as vendas', render: viewPedidos },
    gateways: { titulo: 'Gateways', sub: 'Provedores de pagamento, formas aceitas e notificações', render: viewGateways },
    estoque: { titulo: 'Estoque', sub: 'Chaves disponíveis, entradas, saídas e alertas', render: viewEstoque },
    licencas: { titulo: 'Licenças', sub: 'Chaves emitidas e revogações', render: viewLicencas },
    cupons: { titulo: 'Cupons', sub: 'Descontos ativos e histórico de uso', render: viewCupons },
    produtos: { titulo: 'Produtos', sub: 'Catálogo completo, inclusive inativos', render: viewProdutos },
    avaliacoes: { titulo: 'Avaliações', sub: 'Moderação dos comentários', render: viewAvaliacoes },
    usuarios: { titulo: 'Usuários', sub: 'Clientes e administradores', render: viewUsuarios },
    auditoria: { titulo: 'Auditoria', sub: 'Trilha de ações administrativas', render: viewAuditoria },
    configuracoes: { titulo: 'Configurações', sub: 'Ajustes da loja em tempo de execução', render: viewConfiguracoes },
    diagnostico: { titulo: 'Diagnóstico', sub: 'Estado técnico da aplicação', render: viewDiagnostico }
  };

  var estado = {
    usuario: null,
    view: 'painel',
    categorias: []
  };

  // A aba "Pagamentos" virou "Gateways": o endereço antigo continua valendo.
  var ALIASES = { pagamentos: 'gateways' };

  function viewDaUrl() {
    var bruto = String(window.location.hash || '').replace(/^#\/?/, '').split('?')[0];
    if (ALIASES[bruto]) bruto = ALIASES[bruto];
    return VIEWS[bruto] ? bruto : 'painel';
  }

  function rotear() {
    var bruto = String(window.location.hash || '').replace(/^#\/?/, '').split('?')[0];
    if (ALIASES[bruto]) {
      // Reescreve o endereço antigo; o hashchange chama rotear de novo.
      window.location.replace('#/' + ALIASES[bruto]);
      return;
    }

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

  /* ---------------------------------------------------------------------------
   * Casca (sidebar, topo, sessão)
   * ------------------------------------------------------------------------- */

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

  function preencherUsuario(usuario) {
    qs('#adm-avatar').textContent = UI.iniciais(usuario.nome);
    qs('#adm-nome').textContent = usuario.nome || '—';
    qs('#adm-email').textContent = usuario.email || '—';
  }

  function mostrarRestrito(usuario) {
    qs('#painel').hidden = true;
    var caixa = qs('#restrito');
    caixa.hidden = false;
    hidratarIcones(caixa);

    if (usuario) {
      qs('#restrito-titulo').textContent = 'Acesso restrito a administradores';
      qs('#restrito-texto').textContent = 'A conta ' + usuario.email +
        ' não tem permissão para acessar o painel. Entre com uma conta de administrador.';

      // Já logado como cliente: "Entrar como administrador" voltaria para cá,
      // porque o login reconhece a sessão aberta. Então encerramos a sessão e
      // mandamos para o login já apontando de volta ao painel.
      qs('#restrito-acoes').innerHTML =
        '<button class="btn btn--primary btn--block" type="button" id="restrito-trocar">' +
          'Sair e entrar com outra conta</button>' +
        '<a class="btn btn--soft btn--block" href="/">Voltar à loja</a>';
      qs('#restrito-trocar').addEventListener('click', function () {
        Api.logout('/login?next=/admin');
      });
    }
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

    qs('#adm-sair').addEventListener('click', function () { Api.logout(); });

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

    conteudo().addEventListener('submit', function (evento) {
      var form = evento.target.closest('form[data-form]');
      if (!form) return;
      evento.preventDefault();
      var handler = acoes[form.getAttribute('data-form')];
      if (typeof handler === 'function') handler(form, evento);
    });
  }

  /* ===========================================================================
   * VIEW: PAINEL
   * ========================================================================= */

  function viewPainel() {
    var token = novoToken();
    registrarAcoes({
      'recarregar': function () { viewPainel(); },
      'ver-pedidos': function () { window.location.hash = '#/pedidos'; },
      'ir-estoque': function () { window.location.hash = '#/estoque'; },
      'repor-do-painel': function (el) {
        abrirGerenciarEstoque(el.getAttribute('data-produto'), el.getAttribute('data-plano'), el.getAttribute('data-nome'));
      }
    });

    pintar(
      '<div class="adm-kpis" id="p-kpis">' +
        kpi('Receita', '…', '', 'dinheiro') +
        kpi('Pedidos pagos', '…', '', 'pacote') +
        kpi('Ticket médio', '…', '', 'cartao') +
        kpi('Clientes', '…', '', 'usuarios') +
        kpi('Produtos ativos', '…', '', 'camadas') +
        kpi('Licenças ativas', '…', '', 'cadeado') +
        kpi('Chaves em estoque', '…', '', 'caixa') +
        kpi('Alertas de estoque', '…', '', 'aviso') +
      '</div>' +
      '<div id="p-alertas"></div>' +
      '<div class="adm-grade adm-grade--2-1">' +
        cartao('Receita por dia', 'Últimos 30 dias', '<div id="p-grafico">' + UI.esqueletoLinhas(4) + '</div>') +
        cartao('Mais vendidos', 'Por unidades', '<div id="p-top">' + UI.esqueletoLinhas(5) + '</div>', { semPad: true }) +
      '</div>' +
      cartao('Últimas avaliações', 'O que os clientes estão dizendo', '<div id="p-avaliacoes">' + UI.esqueletoLinhas(3) + '</div>', { semPad: true })
    );

    pedir('GET', '/api/admin/painel?dias=30').then(function (r) {
      if (!aindaValido(token)) return;
      if (!r.ok) {
        pintar(UI.estado({ tipo: 'erro', titulo: 'Não foi possível carregar o painel', texto: erroDe(r), icone: 'aviso' }));
        return;
      }
      desenharPainel(r.data);
    });
  }

  function desenharPainel(d) {
    var fin = d.financeiro || {};
    var cat = d.catalogo || {};
    var cli = d.clientes || {};
    var lic = d.licencas || {};
    var ped = d.pedidos || {};
    var est = d.estoque || {};

    var alertas = Number(est.esgotados || 0) + Number(est.baixos || 0);

    qs('#p-kpis').innerHTML =
      kpi('Receita', UI.dinheiro(fin.receita || 0), 'em pedidos pagos', 'dinheiro') +
      kpi('Pedidos pagos', UI.numero(fin.pedidos || 0), (ped.pendentes ? '<strong>' + UI.numero(ped.pendentes) + '</strong> pendentes' : 'nenhum pendente'), 'pacote') +
      kpi('Ticket médio', UI.dinheiro(fin.ticketMedio || 0), 'por pedido', 'cartao') +
      kpi('Clientes', UI.numero(cli.total || 0), (cli.porPapel && cli.porPapel.admin ? UI.numero(cli.porPapel.admin) + ' admin(s)' : ''), 'usuarios') +
      kpi('Produtos ativos', UI.numero(cat.ativos || 0), UI.numero(cat.produtos || 0) + ' no total', 'camadas') +
      kpi('Licenças ativas', UI.numero(lic.ativa || 0), UI.numero(lic.resgatada || 0) + ' resgatadas', 'cadeado') +
      kpi('Chaves em estoque', UI.numero(est.disponivel || 0), UI.numero(est.vendida || 0) + ' vendidas', 'caixa') +
      kpi('Alertas de estoque', UI.numero(alertas), alertas ? 'reposição necessária' : 'tudo em ordem', 'aviso');

    // Faixa de alertas de estoque (só aparece quando há algo para repor).
    qs('#p-alertas').innerHTML = alertas
      ? '<div class="adm-alertas">' +
          '<div class="adm-alertas__cab">' +
            '<span class="adm-alertas__titulo">' + UI.icone('aviso') + 'Estoque pedindo atenção</span>' +
            '<button class="btn btn--soft btn--sm" type="button" data-acao="ir-estoque">Ver estoque' + UI.icone('seta') + '</button>' +
          '</div>' +
          '<div class="adm-alertas__lista">' + (est.alertas || []).map(function (item) {
            return '<div class="adm-alerta">' +
              '<span class="adm-alerta__txt">' +
                '<span class="adm-alerta__nome">' + esc(item.produto) + '</span>' +
                '<span class="adm-alerta__meta">' + esc(item.plano) + ' · ' + UI.numero(item.disponivel) + ' de ' + UI.numero(item.minimo) + '</span>' +
              '</span>' +
              (item.esgotado ? UI.selo('erro', 'Esgotado') : UI.selo('aviso', 'Baixo')) +
              '<button class="btn btn--primary btn--sm" type="button" data-acao="repor-do-painel" data-produto="' + esc(item.produtoId) + '" data-plano="' + esc(item.planoId) + '" data-nome="' + esc(item.produto + ' · ' + item.plano) + '">Repor</button>' +
            '</div>';
          }).join('') + '</div>' +
        '</div>'
      : '';

    // Gráfico (valores em reais para o eixo ficar legível).
    var serie = (d.receitaPorDia || []).map(function (item) {
      return { dia: item.dia, valor: (item.receitaCentavos || 0) / 100, pedidos: item.pedidos };
    });
    qs('#p-grafico').innerHTML = UI.grafico(serie, {
      formatarEixo: moedaCompacta,
      formatarValor: function (v) { return UI.dinheiro(v); }
    });

    // Top produtos.
    var top = d.topProdutos || [];
    qs('#p-top').innerHTML = top.length
      ? '<div class="adm-lista">' + top.map(function (item, indice) {
          return '<div class="adm-lista__item">' +
            '<span class="adm-rank">' + (indice + 1) + '</span>' +
            '<span class="adm-lista__txt">' +
              '<span class="adm-lista__nome">' + esc(item.nome) + '</span>' +
              '<span class="adm-lista__meta">' + UI.numero(item.unidades) + ' unidade(s)</span>' +
            '</span>' +
            '<span class="adm-lista__valor">' + UI.dinheiro(item.receita || 0) + '</span>' +
          '</div>';
        }).join('') + '</div>'
      : UI.estado({ titulo: 'Sem vendas ainda', texto: 'Os produtos mais vendidos aparecem aqui.', icone: 'trofeu' });

    // Últimas avaliações.
    var avaliacoes = d.ultimasAvaliacoes || [];
    qs('#p-avaliacoes').innerHTML = avaliacoes.length
      ? '<div class="adm-lista">' + avaliacoes.map(function (item) {
          return '<div class="adm-lista__item">' +
            '<span class="adm-quem__avatar">' + esc(UI.iniciais(item.autorNome)) + '</span>' +
            '<span class="adm-lista__txt">' +
              '<span class="adm-lista__nome">' + UI.estrelas(item.nota) + ' ' + esc(item.autorNome || 'Cliente') + '</span>' +
              '<span class="adm-lista__meta">' + esc(item.produtoNome || '') + ' · ' + esc(UI.relativo(item.criadoEm)) + '</span>' +
              (item.comentario ? '<span class="adm-lista__meta">“' + esc(item.comentario) + '”</span>' : '') +
            '</span>' +
          '</div>';
        }).join('') + '</div>'
      : UI.estado({ titulo: 'Nenhuma avaliação ainda', texto: 'As avaliações dos clientes aparecem aqui.', icone: 'estrela' });

    atualizarContadores(d);
  }

  function atualizarContadores(painel) {
    var pedidos = painel && painel.pedidos ? painel.pedidos.pendentes : 0;
    var avaliacoes = painel ? painel.avaliacoes : 0;
    // Esgotados + em nível baixo: é o número que o admin precisa ver de relance.
    var alertas = painel && painel.estoque
      ? Number(painel.estoque.esgotados || 0) + Number(painel.estoque.baixos || 0)
      : 0;

    var alvoPedidos = qs('[data-contador="pedidos-pendentes"]');
    if (alvoPedidos) {
      alvoPedidos.textContent = UI.numero(pedidos);
      alvoPedidos.hidden = !pedidos;
    }

    var alvoAvaliacoes = qs('[data-contador="avaliacoes"]');
    if (alvoAvaliacoes) {
      alvoAvaliacoes.textContent = UI.numero(avaliacoes);
      alvoAvaliacoes.hidden = !avaliacoes;
    }

    var alvoEstoque = qs('[data-contador="estoque-alertas"]');
    if (alvoEstoque) {
      alvoEstoque.textContent = UI.numero(alertas);
      alvoEstoque.hidden = !alertas;
      alvoEstoque.classList.toggle('is-perigo', alertas > 0);
    }
  }

  /* ===========================================================================
   * VIEW: PEDIDOS
   * ========================================================================= */

  var estadoPedidos = { status: '', pagina: 1, limite: 20, total: 0 };

  function viewPedidos() {
    var token = novoToken();
    registrarAcoes({
      'filtro-status': function (el) { estadoPedidos.status = el.value; estadoPedidos.pagina = 1; viewPedidos(); },
      'pagina': function (el) { estadoPedidos.pagina = Number(el.getAttribute('data-pagina')) || 1; viewPedidos(); },
      'abrir-pedido': function (el) { abrirPedido(el.getAttribute('data-id')); },
      'status-pedido': function (el) { mudarStatusPedido(el.getAttribute('data-id'), el.getAttribute('data-status')); }
    });

    pintar(
      cartao('Pedidos', 'Filtre por situação e abra um pedido para ver os detalhes', '<div id="t-pedidos">' + UI.esqueletoLinhas(7) + '</div>', {
        semPad: true,
        acoes: '<select class="adm-select" data-mudanca="filtro-status" aria-label="Filtrar por status">' +
          opcoesSelect([
            { valor: '', rotulo: 'Todos os status' },
            { valor: 'pendente', rotulo: 'Pendentes' },
            { valor: 'pago', rotulo: 'Pagos' },
            { valor: 'cancelado', rotulo: 'Cancelados' },
            { valor: 'reembolsado', rotulo: 'Reembolsados' }
          ], estadoPedidos.status) + '</select>'
      })
    );

    var deslocamento = (estadoPedidos.pagina - 1) * estadoPedidos.limite;
    var url = '/api/admin/pedidos?limite=' + estadoPedidos.limite + '&deslocamento=' + deslocamento +
      (estadoPedidos.status ? '&status=' + encodeURIComponent(estadoPedidos.status) : '');

    pedir('GET', url).then(function (r) {
      if (!aindaValido(token)) return;
      if (!r.ok) { qs('#t-pedidos').innerHTML = UI.estado({ tipo: 'erro', titulo: 'Erro ao carregar pedidos', texto: erroDe(r), icone: 'aviso' }); return; }

      var pedidos = r.data.pedidos || [];
      estadoPedidos.total = r.data.total || 0;
      var paginas = Math.max(Math.ceil(estadoPedidos.total / estadoPedidos.limite), 1);

      var corpo = pedidos.map(function (pedido) {
        return '<tr>' +
          '<td class="adm-mono">' + esc(pedido.numero) + '</td>' +
          '<td><span class="adm-tabela__principal">' + esc(pedido.cliente ? pedido.cliente.nome : '—') + '</span>' +
            '<span class="adm-tabela__sub">' + esc(pedido.cliente ? pedido.cliente.email : '') + '</span></td>' +
          '<td>' + UI.seloVenda(pedido.status) + '</td>' +
          '<td>' + esc(pedido.metodoPagamento || '—') + '</td>' +
          '<td class="adm-num">' + UI.dinheiro(pedido.total) + '</td>' +
          '<td>' + dataAttrData(pedido.criadoEm) + '</td>' +
          '<td class="adm-acoes"><button class="btn btn--soft btn--sm" type="button" data-acao="abrir-pedido" data-id="' + esc(pedido.id) + '">' +
            UI.icone('olho') + 'Detalhes</button></td>' +
        '</tr>';
      }).join('');

      qs('#t-pedidos').innerHTML =
        UI.tabela({
          colunas: [
            { rotulo: 'Número' }, { rotulo: 'Cliente' }, { rotulo: 'Status' },
            { rotulo: 'Pagamento' }, { rotulo: 'Total', classe: 'adm-num' }, { rotulo: 'Quando' }, { rotulo: '', classe: 'adm-acoes' }
          ],
          corpo: corpo,
          vazio: { titulo: 'Nenhum pedido encontrado', texto: 'Ajuste o filtro de status para ver outros pedidos.', icone: 'pacote' }
        }) +
        (pedidos.length ? UI.paginacaoHtml({ pagina: estadoPedidos.pagina, paginas: paginas, total: estadoPedidos.total }) : '');
    });
  }

  // Referência da gaveta de pedido aberta, para poder fechá-la de forma limpa.
  var camadaAtual = null;

  function abrirPedido(id) {
    camadaAtual = UI.gaveta({
      titulo: 'Pedido',
      sub: 'Carregando detalhes…',
      corpo: '<div class="adm-detalhe">' + UI.esqueletoLinhas(5) + '</div>',
      aoFechar: function () { camadaAtual = null; }
    });

    pedir('GET', '/api/admin/pedidos/' + encodeURIComponent(id)).then(function (r) {
      if (!avaliaGaveta()) return;
      var gaveta = qs('.adm-gaveta');
      if (!gaveta) return;
      if (!r.ok) {
        qs('.adm-gaveta__corpo').innerHTML = UI.estado({ tipo: 'erro', titulo: 'Erro ao abrir pedido', texto: erroDe(r), icone: 'aviso' });
        return;
      }
      var p = r.data;
      qs('.adm-modal__titulo', gaveta).textContent = 'Pedido ' + (p.numero || '');
      qs('.adm-modal__sub', gaveta).textContent = UI.dataHora(p.criadoEm) + ' · ' + (p.cliente ? p.cliente.email : '');

      var itens = (p.itens || []).map(function (item) {
        return '<div class="adm-detalhe__linha">' +
          '<span class="adm-detalhe__rotulo">' + esc(item.nome) + ' · ' + esc(item.plano) + ' ×' + item.quantidade + '</span>' +
          '<span class="adm-detalhe__valor">' + UI.dinheiro(item.subtotal) + '</span>' +
        '</div>';
      }).join('');

      var chaves = (p.licencas || []).length
        ? '<div class="adm-chaves">' + p.licencas.map(function (lic) {
            return '<div class="adm-chave">' + UI.seloLicenca(lic.status) +
              '<code>' + esc(lic.chave) + '</code>' +
              '<button class="icon-btn" type="button" data-acao="copiar-chave" data-chave="' + esc(lic.chave) + '" aria-label="Copiar chave" style="margin-left:auto;width:34px;height:34px">' + UI.icone('copiar') + '</button>' +
            '</div>';
          }).join('') + '</div>'
        : '<p style="font-size:13.5px;color:var(--text-3)">Nenhuma chave emitida (pedido não pago).</p>';

      var historico = (p.historico || []).length
        ? '<div class="adm-linha-tempo">' + p.historico.map(function (evento) {
            return '<div class="adm-linha-tempo__item">' +
              '<span class="adm-linha-tempo__ponto"></span>' +
              '<span>' +
                '<span class="adm-linha-tempo__txt">' + esc(rotuloAcao(evento.acao)) + '</span>' +
                '<span class="adm-linha-tempo__hora">' + esc(evento.atorNome || 'sistema') + ' · ' + esc(UI.dataHora(evento.criadoEm)) + '</span>' +
              '</span>' +
            '</div>';
          }).join('') + '</div>'
        : '<p style="font-size:13.5px;color:var(--text-3)">Sem eventos registrados.</p>';

      qs('.adm-gaveta__corpo').innerHTML =
        '<div class="adm-detalhe">' +
          '<div>' +
            '<div class="adm-detalhe__linha"><span class="adm-detalhe__rotulo">Status</span><span class="adm-detalhe__valor">' + UI.seloVenda(p.status) + '</span></div>' +
            '<div class="adm-detalhe__linha"><span class="adm-detalhe__rotulo">Cliente</span><span class="adm-detalhe__valor">' + esc(p.cliente ? p.cliente.nome : '—') + '</span></div>' +
            '<div class="adm-detalhe__linha"><span class="adm-detalhe__rotulo">Pagamento</span><span class="adm-detalhe__valor">' + esc(p.metodoPagamento || '—') + ' · ' + esc(p.pagamentoStatus || '—') + '</span></div>' +
            '<div class="adm-detalhe__linha"><span class="adm-detalhe__rotulo">Subtotal</span><span class="adm-detalhe__valor">' + UI.dinheiro(p.subtotal) + '</span></div>' +
            '<div class="adm-detalhe__linha"><span class="adm-detalhe__rotulo">Desconto' + (p.cupom ? ' (' + esc(p.cupom) + ')' : '') + '</span><span class="adm-detalhe__valor">− ' + UI.dinheiro(p.desconto) + '</span></div>' +
            '<div class="adm-detalhe__linha"><span class="adm-detalhe__rotulo">Total</span><span class="adm-detalhe__valor">' + UI.dinheiro(p.total) + '</span></div>' +
          '</div>' +
          '<div><p class="adm-cartao__titulo" style="margin-bottom:8px">Itens</p>' + (itens || '<p style="font-size:13.5px;color:var(--text-3)">Sem itens.</p>') + '</div>' +
          '<div><p class="adm-cartao__titulo" style="margin-bottom:8px">Licenças</p>' + chaves + '</div>' +
          '<div><p class="adm-cartao__titulo" style="margin-bottom:8px">Histórico</p>' + historico + '</div>' +
        '</div>';

      // Rodapé com as transições possíveis.
      var gavetaEl = qs('.adm-gaveta');
      var rodape = gavetaEl.querySelector('.adm-gaveta__pe');
      if (!rodape) {
        rodape = document.createElement('div');
        rodape.className = 'adm-gaveta__pe';
        gavetaEl.appendChild(rodape);
      }
      var botoes = [];
      if (p.status === 'pendente') botoes.push(botaoStatus(p.id, 'pago', 'Confirmar pagamento', 'btn--primary'));
      if (p.status !== 'cancelado') botoes.push(botaoStatus(p.id, 'cancelado', 'Cancelar pedido', 'btn--soft'));
      if (p.status === 'pago') botoes.push(botaoStatus(p.id, 'reembolsado', 'Reembolsar', 'btn--soft'));
      rodape.innerHTML = botoes.join('') || '<span style="font-size:13px;color:var(--text-3)">Nenhuma ação disponível.</span>';
    });
  }

  function avaliaGaveta() { return !!qs('.adm-gaveta'); }

  function botaoStatus(id, status, rotulo, classe) {
    return '<button class="btn ' + classe + '" type="button" data-acao="status-pedido" data-id="' + esc(id) + '" data-status="' + status + '">' +
      esc(rotulo) + '</button>';
  }

  function mudarStatusPedido(id, status) {
    var rotulos = { pago: 'confirmar o pagamento de', cancelado: 'cancelar', reembolsado: 'reembolsar' };
    var confirmado = status !== 'pago';

    var acao = function () {
      pedir('PATCH', '/api/admin/pedidos/' + encodeURIComponent(id) + '/status', { status: status }).then(function (r) {
        if (!r.ok) { Api.toast(erroDe(r), 'error'); return; }
        Api.toast('Pedido atualizado', 'success');
        fecharCamadas();
        viewPedidos();
        carregarContadores();
      });
    };

    if (!confirmado) { acao(); return; }

    UI.confirmar({
      titulo: 'Confirmar ação',
      texto: 'Deseja ' + (rotulos[status] || 'alterar') + ' o pedido? Esta ação fica registrada na auditoria.',
      confirmar: 'Sim, ' + (rotulos[status] || 'alterar'),
      perigo: status === 'cancelado' || status === 'reembolsado'
    }).then(function (sim) { if (sim) acao(); });
  }

  function fecharCamadas() {
    if (camadaAtual) {
      camadaAtual.fechar();
      camadaAtual = null;
    }
    qsa('.adm-overlay').forEach(function (el) { el.remove(); });
    document.documentElement.classList.remove('no-scroll');
  }

  /* ===========================================================================
   * VIEW: LICENÇAS
   * ========================================================================= */

  var estadoLicencas = { pagina: 1, limite: 25 };

  function viewLicencas() {
    var token = novoToken();
    registrarAcoes({
      'pagina': function (el) { estadoLicencas.pagina = Number(el.getAttribute('data-pagina')) || 1; viewLicencas(); },
      'revogar-licenca': function (el) { revogarLicenca(el.getAttribute('data-id'), el.getAttribute('data-chave')); },
      'copiar-chave': function (el) { UI.copiar(el.getAttribute('data-chave')); }
    });

    pintar(cartao('Licenças', 'Todas as chaves emitidas, com status e validade', '<div id="t-licencas">' + UI.esqueletoLinhas(7) + '</div>', { semPad: true }));

    var deslocamento = (estadoLicencas.pagina - 1) * estadoLicencas.limite;
    pedir('GET', '/api/admin/licencas?limite=' + estadoLicencas.limite + '&deslocamento=' + deslocamento).then(function (r) {
      if (!aindaValido(token)) return;
      if (!r.ok) { qs('#t-licencas').innerHTML = UI.estado({ tipo: 'erro', titulo: 'Erro ao carregar licenças', texto: erroDe(r), icone: 'aviso' }); return; }

      var licencas = r.data.licencas || [];
      var corpo = licencas.map(function (lic) {
        return '<tr>' +
          '<td><span class="adm-mono">' + esc(lic.chave) + '</span></td>' +
          '<td><span class="adm-tabela__principal">' + esc(lic.produtoNome || '—') + '</span><span class="adm-tabela__sub">' + esc(lic.planoId || '') + '</span></td>' +
          '<td>' + esc(lic.usuarioEmail || '—') + '</td>' +
          '<td>' + UI.seloLicenca(lic.status) + '</td>' +
          '<td>' + (lic.expiraEm ? esc(UI.dataCurta(lic.expiraEm)) : 'Vitalícia') + '</td>' +
          '<td>' + dataAttrData(lic.criadaEm) + '</td>' +
          '<td class="adm-acoes">' +
            '<button class="icon-btn" type="button" data-acao="copiar-chave" data-chave="' + esc(lic.chave) + '" aria-label="Copiar" title="Copiar" style="width:36px;height:36px">' + UI.icone('copiar') + '</button>' +
            (lic.status !== 'revogada'
              ? '<button class="icon-btn" type="button" data-acao="revogar-licenca" data-id="' + esc(lic.id) + '" data-chave="' + esc(lic.chave) + '" aria-label="Revogar" title="Revogar" style="width:36px;height:36px;margin-left:6px;color:var(--danger)">' + UI.icone('x') + '</button>'
              : '') +
          '</td>' +
        '</tr>';
      }).join('');

      qs('#t-licencas').innerHTML =
        UI.tabela({
          colunas: [
            { rotulo: 'Chave' }, { rotulo: 'Produto' }, { rotulo: 'Cliente' }, { rotulo: 'Status' },
            { rotulo: 'Validade' }, { rotulo: 'Emitida' }, { rotulo: '', classe: 'adm-acoes' }
          ],
          corpo: corpo,
          vazio: { titulo: 'Nenhuma licença emitida', texto: 'As chaves aparecem aqui após o primeiro pedido pago.', icone: 'cadeado' }
        }) +
        (licencas.length === estadoLicencas.limite
          ? UI.paginacaoHtml({ pagina: estadoLicencas.pagina, paginas: estadoLicencas.pagina + 1, total: (estadoLicencas.pagina) * estadoLicencas.limite })
          : '');
    });
  }

  function revogarLicenca(id, chave) {
    UI.confirmar({
      titulo: 'Revogar licença',
      texto: 'A chave ' + chave + ' deixará de funcionar imediatamente. Esta ação não pode ser desfeita.',
      confirmar: 'Revogar',
      perigo: true
    }).then(function (sim) {
      if (!sim) return;
      pedir('PATCH', '/api/admin/licencas/' + encodeURIComponent(id) + '/revogar', { motivo: 'revogada pelo painel' }).then(function (r) {
        if (!r.ok) { Api.toast(erroDe(r), 'error'); return; }
        Api.toast('Licença revogada', 'success');
        viewLicencas();
      });
    });
  }

  /* ===========================================================================
   * VIEW: CUPONS
   * ========================================================================= */

  function viewCupons() {
    var token = novoToken();
    registrarAcoes({
      'novo-cupom': function () { formCupom(null); },
      'editar-cupom': function (el) { formCupom(el.getAttribute('data-codigo')); },
      'excluir-cupom': function (el) { excluirCupom(el.getAttribute('data-codigo')); }
    });

    pintar(cartao('Cupons', 'Descontos aplicáveis no checkout', '<div id="t-cupons">' + UI.esqueletoLinhas(5) + '</div>', {
      semPad: true,
      acoes: '<button class="btn btn--primary btn--sm" type="button" data-acao="novo-cupom">' + UI.icone('mais') + 'Novo cupom</button>'
    }));

    pedir('GET', '/api/admin/cupons').then(function (r) {
      if (!aindaValido(token)) return;
      if (!r.ok) { qs('#t-cupons').innerHTML = UI.estado({ tipo: 'erro', titulo: 'Erro ao carregar cupons', texto: erroDe(r), icone: 'aviso' }); return; }

      var cupons = r.data.cupons || [];
      var corpo = cupons.map(function (cupom) {
        var valor = cupom.tipo === 'percentual'
          ? cupom.valor + '%'
          : UI.centavos(cupom.valor);
        var usos = UI.numero(cupom.usos) + (cupom.maxUsos ? ' / ' + UI.numero(cupom.maxUsos) : ' / ∞');
        var expira = cupom.expiraEm ? UI.dataCurta(cupom.expiraEm) : 'Sem prazo';

        return '<tr>' +
          '<td><span class="adm-mono">' + esc(cupom.codigo) + '</span>' +
            (cupom.descricao ? '<span class="adm-tabela__sub">' + esc(cupom.descricao) + '</span>' : '') + '</td>' +
          '<td>' + esc(valor) + ' <span class="adm-tabela__sub" style="display:inline">' + (cupom.tipo === 'percentual' ? 'percentual' : 'fixo') + '</span></td>' +
          '<td>' + (cupom.minimoCentavos ? UI.centavos(cupom.minimoCentavos) : '—') + '</td>' +
          '<td>' + esc(usos) + '</td>' +
          '<td>' + esc(expira) + '</td>' +
          '<td>' + UI.seloAtivo(cupom.ativo) + '</td>' +
          '<td class="adm-acoes">' +
            '<button class="icon-btn" type="button" data-acao="editar-cupom" data-codigo="' + esc(cupom.codigo) + '" aria-label="Editar" title="Editar" style="width:36px;height:36px">' + UI.icone('editar') + '</button>' +
            '<button class="icon-btn" type="button" data-acao="excluir-cupom" data-codigo="' + esc(cupom.codigo) + '" aria-label="Excluir" title="Excluir" style="width:36px;height:36px;margin-left:6px;color:var(--danger)">' + UI.icone('lixeira') + '</button>' +
          '</td>' +
        '</tr>';
      }).join('');

      qs('#t-cupons').innerHTML = UI.tabela({
        colunas: [
          { rotulo: 'Código' }, { rotulo: 'Desconto' }, { rotulo: 'Mínimo' },
          { rotulo: 'Usos' }, { rotulo: 'Validade' }, { rotulo: 'Status' }, { rotulo: '', classe: 'adm-acoes' }
        ],
        corpo: corpo,
        vazio: { titulo: 'Nenhum cupom cadastrado', texto: 'Crie um cupom para oferecer descontos no checkout.', icone: 'tag' }
      });
    });
  }

  function formCupom(codigo) {
    var edicao = !!codigo;
    var corpo = edicao
      ? '<form class="adm-form" data-form="salvar-cupom" data-codigo="' + esc(codigo) + '">' +
          '<div class="adm-form-grade">' +
            '<div class="field"><label class="field__label">Código</label><input class="field__input" value="' + esc(codigo) + '" disabled></div>' +
            '<div class="field"><label class="field__label">Máximo de usos</label><input class="field__input" name="maxUsos" type="number" min="1" placeholder="Sem limite"></div>' +
            '<div class="field"><label class="field__label">Expira em</label><input class="field__input" name="expiraEm" type="date"></div>' +
            '<div class="field"><label class="field__label">Descrição</label><input class="field__input" name="descricao" maxlength="120" placeholder="Opcional"></div>' +
          '</div>' +
          '<label class="adm-interruptor"><span class="adm-interruptor__txt"><span class="adm-interruptor__titulo">Cupom ativo</span><span class="adm-interruptor__dica">Desative para suspender o uso sem excluir</span></span><span class="adm-switch"><input type="checkbox" name="ativo" checked><span class="adm-switch__trilha"></span></span></label>' +
        '</form>'
      : '<form class="adm-form" data-form="salvar-cupom">' +
          '<div class="adm-form-grade">' +
            '<div class="field"><label class="field__label">Código</label><input class="field__input" name="codigo" data-foco required maxlength="24" placeholder="BEMVINDO10" style="text-transform:uppercase"></div>' +
            '<div class="field"><label class="field__label">Tipo</label><select class="field__input" name="tipo"><option value="percentual">Percentual (%)</option><option value="fixo">Valor fixo (R$)</option></select></div>' +
            '<div class="field"><label class="field__label">Valor do desconto</label><input class="field__input" name="valor" type="number" step="0.01" min="0" required placeholder="10"></div>' +
            '<div class="field"><label class="field__label">Pedido mínimo (R$)</label><input class="field__input" name="minimo" type="number" step="0.01" min="0" placeholder="0"></div>' +
            '<div class="field"><label class="field__label">Máximo de usos</label><input class="field__input" name="maxUsos" type="number" min="1" placeholder="Sem limite"></div>' +
            '<div class="field"><label class="field__label">Expira em</label><input class="field__input" name="expiraEm" type="date"></div>' +
            '<div class="field adm-campo-largo"><label class="field__label">Descrição</label><input class="field__input" name="descricao" maxlength="120" placeholder="Ex.: Boas-vindas para novos clientes"></div>' +
          '</div>' +
        '</form>';

    UI.modal({
      titulo: edicao ? 'Editar cupom' : 'Novo cupom',
      sub: edicao ? 'Atualize as regras do cupom ' + codigo : 'Defina o desconto e as condições de uso',
      corpo: corpo,
      pe: '<button class="btn btn--soft" type="button" data-fechar>Cancelar</button>' +
          '<button class="btn btn--primary" type="button" data-salvar-cupom>' + (edicao ? 'Salvar' : 'Criar cupom') + '</button>',
      aoAbrir: function (caixa, fechar) {
        var form = caixa.querySelector('form');
        caixa.querySelector('[data-salvar-cupom]').addEventListener('click', function () { salvarCupom(form, edicao, fechar); });
        if (edicao) {
          // Preenche com os dados atuais a partir da lista já carregada.
          pedir('GET', '/api/admin/cupons').then(function (r) {
            if (!r.ok) return;
            var cupom = (r.data.cupons || []).filter(function (c) { return c.codigo === codigo; })[0];
            if (!cupom) return;
            if (form.maxUsos) form.maxUsos.value = cupom.maxUsos || '';
            if (form.expiraEm) form.expiraEm.value = cupom.expiraEm ? String(cupom.expiraEm).slice(0, 10) : '';
            if (form.descricao) form.descricao.value = cupom.descricao || '';
            if (form.ativo) form.ativo.checked = !!cupom.ativo;
          });
        }
      }
    });
  }

  function salvarCupom(form, edicao, fechar) {
    var dados = {};
    function valor(nome) { return form.elements[nome] ? String(form.elements[nome].value || '').trim() : ''; }

    if (edicao) {
      dados.maxUsos = valor('maxUsos') === '' ? null : Number(valor('maxUsos'));
      dados.expiraEm = valor('expiraEm') || null;
      dados.descricao = valor('descricao');
      dados.ativo = form.elements.ativo ? form.elements.ativo.checked : true;
    } else {
      var codigo = valor('codigo').toUpperCase();
      if (!codigo) { Api.toast('Informe o código do cupom', 'error'); return; }
      dados.codigo = codigo;
      dados.tipo = valor('tipo');
      var valorNum = Number(valor('valor'));
      if (!Number.isFinite(valorNum) || valorNum <= 0) { Api.toast('Informe um valor de desconto válido', 'error'); return; }
      dados.valor = valorNum;
      dados.minimo = valor('minimo') === '' ? 0 : Number(valor('minimo'));
      dados.maxUsos = valor('maxUsos') === '' ? null : Number(valor('maxUsos'));
      dados.expiraEm = valor('expiraEm') || null;
      dados.descricao = valor('descricao');
    }

    var caminho = edicao ? '/api/admin/cupons/' + encodeURIComponent(form.getAttribute('data-codigo')) : '/api/admin/cupons';
    pedir(edicao ? 'PATCH' : 'POST', caminho, dados).then(function (r) {
      if (!r.ok) { Api.toast(erroDe(r), 'error'); return; }
      Api.toast(edicao ? 'Cupom atualizado' : 'Cupom criado', 'success');
      fechar();
      viewCupons();
    });
  }

  function excluirCupom(codigo) {
    UI.confirmar({
      titulo: 'Excluir cupom',
      texto: 'O cupom ' + codigo + ' será removido definitivamente.',
      confirmar: 'Excluir',
      perigo: true
    }).then(function (sim) {
      if (!sim) return;
      pedir('DELETE', '/api/admin/cupons/' + encodeURIComponent(codigo)).then(function (r) {
        if (!r.ok) { Api.toast(erroDe(r), 'error'); return; }
        Api.toast('Cupom removido', 'success');
        viewCupons();
      });
    });
  }

  /* ===========================================================================
   * VIEW: PRODUTOS
   * ========================================================================= */

  var ICONES_PRODUTO = ['raio', 'mira', 'teclado', 'camadas', 'vassoura', 'chip', 'sinal', 'escudo'];
  var estadoProdutos = { busca: '', categoria: '', itens: [], total: 0 };

  function viewProdutos() {
    var token = novoToken();
    registrarAcoes({
      'buscar-produtos': function (el) { estadoProdutos.busca = el.value.trim(); viewProdutos(); },
      'filtrar-categoria': function (el) { estadoProdutos.categoria = el.value; viewProdutos(); },
      'novo-produto': function () { formProduto(null); },
      'editar-produto': function (el) { formProduto(el.getAttribute('data-id')); },
      'alternar-produto': function (el) { alternarProduto(el.getAttribute('data-id'), el.getAttribute('data-ativo') === 'true'); },
      'alternar-destaque': function (el) { alternarDestaque(el.getAttribute('data-id'), el.getAttribute('data-destaque') === 'true'); },
      'repor-produto': function (el) {
        // Leva para o Estoque já filtrado pelo produto — lá estão as ações.
        estadoEstoque.busca = el.getAttribute('data-nome') || '';
        estadoEstoque.filtro = 'todos';
        window.location.hash = '#/estoque';
      }
    });

    pintar(cartao('Produtos', 'Inclui itens fora da vitrine', '<div id="t-produtos">' + UI.esqueletoLinhas(7) + '</div>', {
      semPad: true,
      acoes: '<button class="btn btn--primary btn--sm" type="button" data-acao="novo-produto">' + UI.icone('mais') + 'Novo produto</button>'
    }));

    // Barra de ferramentas acima do cartão.
    var filtros = '<div class="adm-barra">' +
      barraBusca('Buscar por nome, categoria…', estadoProdutos.busca, 'buscar-produtos') +
      '<select class="adm-select" data-mudanca="filtrar-categoria" aria-label="Filtrar por categoria">' +
        '<option value="">Todas as categorias</option>' +
        opcoesSelect(estado.categorias.map(function (c) { return { valor: c.nome, rotulo: c.nome + ' (' + c.total + ')' }; }), estadoProdutos.categoria) +
      '</select>' +
    '</div>';
    conteudo().insertAdjacentHTML('afterbegin', filtros);

    var url = '/api/admin/produtos?limite=100' +
      (estadoProdutos.busca ? '&busca=' + encodeURIComponent(estadoProdutos.busca) : '') +
      (estadoProdutos.categoria ? '&categoria=' + encodeURIComponent(estadoProdutos.categoria) : '');

    pedir('GET', url).then(function (r) {
      if (!aindaValido(token)) return;
      if (!r.ok) { qs('#t-produtos').innerHTML = UI.estado({ tipo: 'erro', titulo: 'Erro ao carregar produtos', texto: erroDe(r), icone: 'aviso' }); return; }

      var produtos = Array.isArray(r.data) ? r.data : [];
      var total = Number(r.headers && r.headers.get ? r.headers.get('X-Total-Count') : 0) || produtos.length;

      var corpo = produtos.map(function (p) {
        var planos = Array.isArray(p.planos) ? p.planos : [];
        var faixa = planos.length
          ? UI.dinheiro(p.precoMin) + (p.precoMax !== p.precoMin ? ' ~ ' + UI.dinheiro(p.precoMax) : '')
          : 'sem planos';

        var estoqueTotal = Number(p.estoqueTotal || 0);
        var planosVazios = planos.filter(function (pl) { return pl.esgotado; }).length;

        return '<tr>' +
          '<td><span class="adm-tabela__principal">' + esc(p.nome) + '</span><span class="adm-tabela__sub">/' + esc(p.slug || '') + '</span></td>' +
          '<td>' + esc(p.categoria || '—') + '</td>' +
          '<td>' + esc(faixa) + '<span class="adm-tabela__sub">' + planos.length + ' plano(s)</span></td>' +
          '<td><span class="adm-estoque-celula"><strong>' + UI.numero(estoqueTotal) + '</strong>' +
            (estoqueTotal === 0 ? UI.selo('erro', 'Esgotado') : UI.selo('ok', 'Disponível')) + '</span>' +
            (estoqueTotal > 0 && planosVazios ? '<span class="adm-tabela__sub">' + planosVazios + ' plano(s) sem chave</span>' : '') + '</td>' +
          '<td>' + (p.destaque ? UI.selo('aviso', 'Destaque') : '—') + '</td>' +
          '<td>' + UI.seloAtivo(p.ativo) + '</td>' +
          '<td class="adm-acoes">' +
            '<button class="btn btn--soft btn--sm" type="button" data-acao="repor-produto" data-id="' + esc(p.id) + '" data-nome="' + esc(p.nome) + '" title="Gerenciar estoque deste produto">' + UI.icone('caixa') + 'Estoque</button>' +
            '<button class="icon-btn" type="button" data-acao="editar-produto" data-id="' + esc(p.id) + '" aria-label="Editar" title="Editar" style="width:36px;height:36px;margin-left:6px">' + UI.icone('editar') + '</button>' +
            '<button class="icon-btn" type="button" data-acao="alternar-destaque" data-id="' + esc(p.id) + '" data-destaque="' + (!!p.destaque) + '" aria-label="Alternar destaque" title="Destaque" style="width:36px;height:36px;margin-left:6px;color:' + (p.destaque ? 'var(--star)' : 'var(--text-3)') + '">' + UI.icone('estrela') + '</button>' +
            '<button class="icon-btn" type="button" data-acao="alternar-produto" data-id="' + esc(p.id) + '" data-ativo="' + (!!p.ativo) + '" aria-label="Ativar/desativar" title="Ativar/desativar" style="width:36px;height:36px;margin-left:6px;color:' + (p.ativo ? 'var(--success)' : 'var(--text-3)') + '">' + UI.icone(p.ativo ? 'check' : 'x') + '</button>' +
          '</td>' +
        '</tr>';
      }).join('');

      qs('#t-produtos').innerHTML = UI.tabela({
        colunas: [
          { rotulo: 'Produto' }, { rotulo: 'Categoria' }, { rotulo: 'Preços' }, { rotulo: 'Estoque' },
          { rotulo: 'Destaque' }, { rotulo: 'Vitrine' }, { rotulo: '', classe: 'adm-acoes' }
        ],
        corpo: corpo,
        vazio: { titulo: 'Nenhum produto encontrado', texto: 'Ajuste a busca ou crie um novo produto.', icone: 'camadas' }
      }) + '<div class="adm-paginacao"><span class="adm-paginacao__info">' + UI.numero(total) + ' produto(s) no catálogo</span></div>';
    });
  }

  function formProduto(id) {
    var edicao = !!id;

    var abrir = function (p) {
      p = p || {};
      var planos = Array.isArray(p.planos) && p.planos.length ? p.planos : [{ nome: '', preco: '', dias: '' }];

      var corpo =
        '<form class="adm-form" data-form="salvar-produto" data-id="' + esc(id || '') + '">' +
          '<div class="adm-form-grade">' +
            '<div class="field"><label class="field__label">Nome</label><input class="field__input" name="nome" data-foco required maxlength="80" value="' + esc(p.nome || '') + '"></div>' +
            '<div class="field"><label class="field__label">Categoria</label><input class="field__input" name="categoria" required maxlength="40" list="lista-categorias" value="' + esc(p.categoria || '') + '"></div>' +
            '<div class="field"><label class="field__label">Slug (URL)</label><input class="field__input" name="slug" maxlength="60" placeholder="gerado do nome" value="' + esc(p.slug || '') + '"></div>' +
            '<div class="field"><label class="field__label">Selo / badge</label><input class="field__input" name="badge" maxlength="30" placeholder="Ex.: Mais vendido" value="' + esc(p.badge || '') + '"></div>' +
            '<div class="field"><label class="field__label">Linha</label><input class="field__input" name="linha" maxlength="40" value="' + esc(p.linha || '') + '"></div>' +
            '<div class="field"><label class="field__label">Nível</label><input class="field__input" name="nivel" maxlength="40" value="' + esc(p.nivel || '') + '"></div>' +
            '<div class="field"><label class="field__label">Plataforma</label><input class="field__input" name="plataforma" maxlength="40" value="' + esc(p.plataforma || 'Windows') + '"></div>' +
            '<div class="field"><label class="field__label">Entrega</label><input class="field__input" name="entrega" maxlength="40" value="' + esc(p.entrega || 'Automática') + '"></div>' +
            '<div class="field"><label class="field__label">Ícone da capa</label><select class="field__input" name="icone">' +
              opcoesSelect(ICONES_PRODUTO.map(function (i) { return { valor: i, rotulo: i.charAt(0).toUpperCase() + i.slice(1) }; }), (p.capa && p.capa.icone) || 'raio') +
            '</select></div>' +
            '<div class="field"><label class="field__label">Imagem (URL ou /caminho)</label><input class="field__input" name="imagem" maxlength="300" value="' + esc(p.imagem || '') + '"></div>' +
            '<div class="field"><label class="field__label">Ordem na vitrine</label><input class="field__input" name="ordem" type="number" min="0" title="Ordena o catálogo (/produtos). A home não usa este campo: ela mostra os destaques mais recentes." value="' + (p.ordem !== undefined && p.ordem !== null ? esc(p.ordem) : '') + '"></div>' +
            '<div class="field adm-campo-largo"><label class="field__label">Descrição</label><textarea class="field__input adm-textarea" name="descricao" maxlength="600">' + esc(p.descricao || '') + '</textarea></div>' +
            '<div class="field adm-campo-largo"><label class="field__label">Descrição completa (modal do produto)</label><textarea class="field__input adm-textarea" name="descricaoLonga" maxlength="4000" placeholder="Aparece no modal de detalhes da vitrine. Se ficar vazia, o modal mostra a descrição curta.">' + esc(p.descricaoLonga || '') + '</textarea></div>' +
            '<div class="field adm-campo-largo"><label class="field__label">Recursos (um por linha)</label><textarea class="field__input adm-textarea" name="recursos">' + esc((p.recursos || []).join('\n')) + '</textarea></div>' +
          '</div>' +

          '<div class="adm-form-grade">' +
            '<label class="adm-interruptor"><span class="adm-interruptor__txt"><span class="adm-interruptor__titulo">Visível na vitrine</span><span class="adm-interruptor__dica">Produtos sem plano ativo ficam ocultos de qualquer forma</span></span><span class="adm-switch"><input type="checkbox" name="ativo"' + (p.ativo === false ? '' : ' checked') + '><span class="adm-switch__trilha"></span></span></label>' +
            '<label class="adm-interruptor"><span class="adm-interruptor__txt"><span class="adm-interruptor__titulo">Destaque na home</span><span class="adm-interruptor__dica">A seção "Produtos em destaque" mostra todos os destaques, os mais recentes primeiro — marcar já faz aparecer</span></span><span class="adm-switch"><input type="checkbox" name="destaque"' + (p.destaque ? ' checked' : '') + '><span class="adm-switch__trilha"></span></span></label>' +
          '</div>' +

          '<div>' +
            '<p class="adm-cartao__titulo" style="margin-bottom:10px">Planos</p>' +
            '<div class="adm-planos" id="lista-planos">' + planos.map(linhaPlanoHtml).join('') + '</div>' +
            '<div class="adm-planos__rodape">' +
              '<button class="btn btn--soft btn--sm" type="button" data-acao="add-plano">' + UI.icone('mais') + 'Adicionar plano</button>' +
              '<span class="adm-cartao__dica">Preço em reais. Deixe os dias vazio para licença vitalícia.</span>' +
            '</div>' +
          '</div>' +
        '</form>';

      UI.modal({
        titulo: edicao ? 'Editar produto' : 'Novo produto',
        sub: edicao ? 'Atualize os dados e os planos do produto' : 'Cadastre um produto e ao menos um plano',
        largo: true,
        corpo: '<datalist id="lista-categorias">' + estado.categorias.map(function (c) { return '<option value="' + esc(c.nome) + '"></option>'; }).join('') + '</datalist>' + corpo,
        pe: '<button class="btn btn--soft" type="button" data-fechar>Cancelar</button>' +
            '<button class="btn btn--primary" type="button" data-salvar-produto>' + (edicao ? 'Salvar' : 'Criar produto') + '</button>',
        aoAbrir: function (caixa, fechar) {
          var form = caixa.querySelector('form');
          caixa.querySelector('[data-salvar-produto]').addEventListener('click', function () { salvarProduto(form, edicao, fechar); });
          caixa.addEventListener('click', function (evento) {
            var botao = evento.target.closest('[data-acao]');
            if (!botao) return;
            var nome = botao.getAttribute('data-acao');
            if (nome === 'add-plano') {
              caixa.querySelector('#lista-planos').insertAdjacentHTML('beforeend', linhaPlanoHtml({}));
            } else if (nome === 'remover-plano') {
              var linhas = caixa.querySelectorAll('[data-plano-linha]');
              if (linhas.length > 1) botao.closest('[data-plano-linha]').remove();
              else Api.toast('Mantenha ao menos um plano', 'error');
            }
          });
        }
      });
    };

    if (edicao) {
      pedir('GET', '/api/admin/produtos/' + encodeURIComponent(id)).then(function (r) {
        if (!r.ok) { Api.toast(erroDe(r), 'error'); return; }
        abrir(r.data);
      });
    } else {
      abrir({});
    }
  }

  /*
   * Uma linha do editor de planos.
   *
   * O campo "id" escondido é o que mantém o estoque intacto: o estoque de chaves
   * aponta para (produto, plano_id). Se o admin renomeasse um plano e o id fosse
   * regenerado a partir do nome, as chaves daquele plano ficariam órfãs. Enviando
   * o id original de volta, renomear é só uma troca de rótulo.
   */
  function linhaPlanoHtml(plano) {
    plano = plano || {};
    return '<div class="adm-plano-linha" data-plano-linha>' +
      '<input type="hidden" data-plano="id" value="' + esc(plano.id || '') + '">' +
      '<div class="field"><label class="field__label">Nome</label><input class="field__input" data-plano="nome" maxlength="40" placeholder="1 mês" value="' + esc(plano.nome || '') + '"></div>' +
      '<div class="field"><label class="field__label">Preço (R$)</label><input class="field__input" data-plano="preco" type="number" step="0.01" min="0" placeholder="9,99" value="' + (plano.preco !== undefined && plano.preco !== null ? esc(plano.preco) : '') + '"></div>' +
      '<div class="field"><label class="field__label">Dias</label><input class="field__input" data-plano="dias" type="number" min="1" placeholder="vitalício" value="' + (plano.dias !== undefined && plano.dias !== null ? esc(plano.dias) : '') + '"></div>' +
      '<button class="icon-btn adm-plano-linha__remover" type="button" data-acao="remover-plano" aria-label="Remover plano" title="Remover plano" style="width:44px;height:44px;color:var(--danger)">' + UI.icone('lixeira') + '</button>' +
    '</div>';
  }

  function salvarProduto(form, edicao, fechar) {
    function valor(nome) { return form.elements[nome] ? String(form.elements[nome].value || '').trim() : ''; }

    var nome = valor('nome');
    var categoria = valor('categoria');
    if (!nome || nome.length < 2) { Api.toast('Informe o nome do produto', 'error'); return; }
    if (!categoria) { Api.toast('Informe a categoria', 'error'); return; }

    var planos = qsa('[data-plano-linha]', form).map(function (linha) {
      return {
        id: String(linha.querySelector('[data-plano="id"]').value || '').trim(),
        nome: String(linha.querySelector('[data-plano="nome"]').value || '').trim(),
        preco: String(linha.querySelector('[data-plano="preco"]').value || '').trim(),
        dias: String(linha.querySelector('[data-plano="dias"]').value || '').trim()
      };
    }).filter(function (plano) { return plano.nome && plano.preco !== ''; });

    if (!planos.length) { Api.toast('Adicione ao menos um plano com nome e preço', 'error'); return; }

    var recursos = valor('recursos').split('\n').map(function (l) { return l.trim(); }).filter(Boolean);

    var dados = {
      nome: nome,
      categoria: categoria,
      linha: valor('linha'),
      nivel: valor('nivel'),
      plataforma: valor('plataforma'),
      entrega: valor('entrega'),
      badge: valor('badge'),
      descricao: valor('descricao'),
      descricaoLonga: valor('descricaoLonga'),
      imagem: valor('imagem'),
      capa: { icone: valor('icone') },
      recursos: recursos,
      ativo: form.elements.ativo ? form.elements.ativo.checked : true,
      destaque: form.elements.destaque ? form.elements.destaque.checked : false,
      planos: planos.map(function (plano) {
        var saida = { nome: plano.nome, preco: Number(plano.preco), dias: plano.dias === '' ? null : Number(plano.dias) };
        // Reenvia o id do plano existente para o estoque não perder o vínculo.
        if (plano.id) saida.id = plano.id;
        return saida;
      })
    };

    if (valor('slug')) dados.slug = valor('slug');
    if (valor('ordem') !== '') dados.ordem = Number(valor('ordem'));

    var caminho = edicao ? '/api/admin/produtos/' + encodeURIComponent(form.getAttribute('data-id')) : '/api/admin/produtos';
    pedir(edicao ? 'PATCH' : 'POST', caminho, dados).then(function (r) {
      if (!r.ok) { Api.toast(erroDe(r), 'error'); return; }
      Api.toast(edicao ? 'Produto atualizado' : 'Produto criado', 'success');
      fechar();
      carregarCategorias();
      viewProdutos();
    });
  }

  function alternarProduto(id, ativoAtual) {
    pedir('PATCH', '/api/admin/produtos/' + encodeURIComponent(id) + '/ativo', { ativo: !ativoAtual }).then(function (r) {
      if (!r.ok) { Api.toast(erroDe(r), 'error'); return; }
      Api.toast(!ativoAtual ? 'Produto ativado na vitrine' : 'Produto ocultado da vitrine', 'success');
      viewProdutos();
    });
  }

  function alternarDestaque(id, destaqueAtual) {
    pedir('PATCH', '/api/admin/produtos/' + encodeURIComponent(id), { destaque: !destaqueAtual }).then(function (r) {
      if (!r.ok) { Api.toast(erroDe(r), 'error'); return; }
      Api.toast(!destaqueAtual ? 'Produto em destaque' : 'Destaque removido', 'success');
      viewProdutos();
    });
  }

  function carregarCategorias() {
    return pedir('GET', '/api/produtos/categorias').then(function (r) {
      if (r.ok && Array.isArray(r.data)) estado.categorias = r.data;
    });
  }

  /* ===========================================================================
   * VIEW: AVALIAÇÕES
   * ========================================================================= */

  function viewAvaliacoes() {
    var token = novoToken();
    registrarAcoes({
      'remover-avaliacao': function (el) { removerAvaliacao(el.getAttribute('data-id')); }
    });

    pintar(cartao('Avaliações', 'Moderação dos comentários recentes', '<div id="t-avaliacoes">' + UI.esqueletoLinhas(6) + '</div>', { semPad: true }));

    pedir('GET', '/api/admin/avaliacoes?limite=100').then(function (r) {
      if (!aindaValido(token)) return;
      if (!r.ok) { qs('#t-avaliacoes').innerHTML = UI.estado({ tipo: 'erro', titulo: 'Erro ao carregar avaliações', texto: erroDe(r), icone: 'aviso' }); return; }

      var avaliacoes = r.data.avaliacoes || [];
      var corpo = avaliacoes.map(function (av) {
        return '<tr>' +
          '<td><span class="adm-tabela__principal">' + esc(av.produtoNome || '—') + '</span></td>' +
          '<td><span class="adm-tabela__principal">' + esc(av.autorNome || 'Cliente') + '</span><span class="adm-tabela__sub">' + esc(av.autorEmail || '') + '</span></td>' +
          '<td>' + UI.estrelas(av.nota) + '</td>' +
          '<td style="white-space:normal;max-width:380px">' + esc(av.comentario || '—') + '</td>' +
          '<td>' + dataAttrData(av.criadoEm) + '</td>' +
          '<td class="adm-acoes"><button class="icon-btn" type="button" data-acao="remover-avaliacao" data-id="' + esc(av.id) + '" aria-label="Remover" title="Remover" style="width:36px;height:36px;color:var(--danger)">' + UI.icone('lixeira') + '</button></td>' +
        '</tr>';
      }).join('');

      qs('#t-avaliacoes').innerHTML = UI.tabela({
        colunas: [
          { rotulo: 'Produto' }, { rotulo: 'Autor' }, { rotulo: 'Nota' },
          { rotulo: 'Comentário' }, { rotulo: 'Quando' }, { rotulo: '', classe: 'adm-acoes' }
        ],
        corpo: corpo,
        vazio: { titulo: 'Nenhuma avaliação', texto: 'As avaliações dos clientes aparecem aqui.', icone: 'estrela' }
      });
    });
  }

  function removerAvaliacao(id) {
    UI.confirmar({
      titulo: 'Remover avaliação',
      texto: 'A avaliação será apagada definitivamente e deixará de contar na nota do produto.',
      confirmar: 'Remover',
      perigo: true
    }).then(function (sim) {
      if (!sim) return;
      pedir('DELETE', '/api/admin/avaliacoes/' + encodeURIComponent(id)).then(function (r) {
        if (!r.ok) { Api.toast(erroDe(r), 'error'); return; }
        Api.toast('Avaliação removida', 'success');
        viewAvaliacoes();
      });
    });
  }

  /* ===========================================================================
   * VIEW: USUÁRIOS
   * ========================================================================= */

  var estadoUsuarios = { busca: '', pagina: 1, limite: 25, total: 0 };

  function viewUsuarios() {
    var token = novoToken();
    registrarAcoes({
      'buscar-usuarios': function (el) { estadoUsuarios.busca = el.value.trim(); estadoUsuarios.pagina = 1; viewUsuarios(); },
      'pagina': function (el) { estadoUsuarios.pagina = Number(el.getAttribute('data-pagina')) || 1; viewUsuarios(); },
      'abrir-cliente': function (el) { abrirCliente(el.getAttribute('data-id')); },
      'mudar-papel': function (el) { mudarPapel(el.getAttribute('data-id'), el.getAttribute('data-papel'), el.getAttribute('data-nome')); },
      'mudar-ativo': function (el) { mudarAtivo(el.getAttribute('data-id'), el.getAttribute('data-ativo') === 'true', el.getAttribute('data-nome')); }
    });

    pintar(cartao('Usuários', 'Clientes e administradores da loja', '<div id="t-usuarios">' + UI.esqueletoLinhas(7) + '</div>', { semPad: true }));
    conteudo().insertAdjacentHTML('afterbegin', '<div class="adm-barra">' + barraBusca('Buscar por nome ou e-mail…', estadoUsuarios.busca, 'buscar-usuarios') + '</div>');

    var deslocamento = (estadoUsuarios.pagina - 1) * estadoUsuarios.limite;
    var url = '/api/admin/usuarios?limite=' + estadoUsuarios.limite + '&deslocamento=' + deslocamento +
      (estadoUsuarios.busca ? '&busca=' + encodeURIComponent(estadoUsuarios.busca) : '');

    pedir('GET', url).then(function (r) {
      if (!aindaValido(token)) return;
      if (!r.ok) { qs('#t-usuarios').innerHTML = UI.estado({ tipo: 'erro', titulo: 'Erro ao carregar usuários', texto: erroDe(r), icone: 'aviso' }); return; }

      var usuarios = r.data.usuarios || [];
      estadoUsuarios.total = r.data.total || 0;
      var paginas = Math.max(Math.ceil(estadoUsuarios.total / estadoUsuarios.limite), 1);
      var euMesmo = estado.usuario ? estado.usuario.id : null;

      var corpo = usuarios.map(function (u) {
        var souEu = u.id === euMesmo;
        return '<tr>' +
          '<td><span class="adm-avatar-linha"><span class="adm-quem__avatar">' + esc(UI.iniciais(u.nome)) + '</span>' +
            '<span><span class="adm-tabela__principal">' + esc(u.nome) + (souEu ? ' <span class="adm-selo adm-selo--info adm-selo--sem-ponto">você</span>' : '') + '</span>' +
            '<span class="adm-tabela__sub">' + esc(u.email) + '</span></span></span></td>' +
          '<td>' + UI.seloPapel(u.papel) + '</td>' +
          '<td>' + UI.seloAtivo(u.ativo) + '</td>' +
          '<td class="adm-num">' + UI.numero(u.pedidos) + '</td>' +
          '<td class="adm-num">' + UI.dinheiro(u.gasto) + '</td>' +
          '<td class="adm-num">' + UI.numero(u.licencas) + '</td>' +
          '<td>' + (u.ultimoLoginEm ? dataAttrData(u.ultimoLoginEm) : 'nunca') + '</td>' +
          '<td class="adm-acoes">' +
            '<button class="btn btn--soft btn--sm" type="button" data-acao="abrir-cliente" data-id="' + esc(u.id) + '">' +
              UI.icone('olho') + 'Ficha</button>' +
            '<button class="btn btn--soft btn--sm" type="button" data-acao="mudar-papel" data-id="' + esc(u.id) + '" data-papel="' + (u.papel === 'admin' ? 'cliente' : 'admin') + '" data-nome="' + esc(u.nome) + '"' + (souEu ? ' disabled' : '') + ' style="margin-left:6px">' +
              (u.papel === 'admin' ? 'Tornar cliente' : 'Tornar admin') + '</button>' +
            '<button class="btn btn--soft btn--sm" type="button" data-acao="mudar-ativo" data-id="' + esc(u.id) + '" data-ativo="' + (!!u.ativo) + '" data-nome="' + esc(u.nome) + '"' + (souEu ? ' disabled' : '') + ' style="margin-left:6px;color:' + (u.ativo ? 'var(--danger)' : 'var(--success)') + '">' +
              (u.ativo ? 'Desativar' : 'Ativar') + '</button>' +
          '</td>' +
        '</tr>';
      }).join('');

      qs('#t-usuarios').innerHTML = UI.tabela({
        colunas: [
          { rotulo: 'Usuário' }, { rotulo: 'Papel' }, { rotulo: 'Status' }, { rotulo: 'Pedidos', classe: 'adm-num' },
          { rotulo: 'Gasto', classe: 'adm-num' }, { rotulo: 'Licenças', classe: 'adm-num' }, { rotulo: 'Último acesso' }, { rotulo: '', classe: 'adm-acoes' }
        ],
        corpo: corpo,
        vazio: { titulo: 'Nenhum usuário encontrado', texto: 'Ajuste a busca para encontrar alguém.', icone: 'usuarios' }
      }) + (usuarios.length ? UI.paginacaoHtml({ pagina: estadoUsuarios.pagina, paginas: paginas, total: estadoUsuarios.total }) : '');
    });
  }

  function mudarPapel(id, papel, nome) {
    UI.confirmar({
      titulo: papel === 'admin' ? 'Conceder acesso de administrador' : 'Remover acesso de administrador',
      texto: papel === 'admin'
        ? nome + ' passará a ter acesso total ao painel.'
        : nome + ' deixará de acessar o painel administrativo.',
      confirmar: 'Confirmar',
      perigo: papel !== 'admin'
    }).then(function (sim) {
      if (!sim) return;
      pedir('PATCH', '/api/admin/usuarios/' + encodeURIComponent(id) + '/papel', { papel: papel }).then(function (r) {
        if (!r.ok) { Api.toast(erroDe(r), 'error'); return; }
        Api.toast('Papel atualizado', 'success');
        viewUsuarios();
      });
    });
  }

  function mudarAtivo(id, ativoAtual, nome) {
    var ativar = !ativoAtual;
    UI.confirmar({
      titulo: ativar ? 'Ativar usuário' : 'Desativar usuário',
      texto: ativar
        ? nome + ' poderá voltar a entrar na loja.'
        : nome + ' não conseguirá entrar e as sessões abertas serão encerradas.',
      confirmar: ativar ? 'Ativar' : 'Desativar',
      perigo: !ativar
    }).then(function (sim) {
      if (!sim) return;
      pedir('PATCH', '/api/admin/usuarios/' + encodeURIComponent(id) + '/ativo', { ativo: ativar }).then(function (r) {
        if (!r.ok) { Api.toast(erroDe(r), 'error'); return; }
        Api.toast(ativar ? 'Usuário ativado' : 'Usuário desativado', 'success');
        viewUsuarios();
      });
    });
  }

  /**
   * Ficha do cliente: dados, resumo financeiro, pedidos e chaves. Abre numa
   * gaveta lateral para o admin conferir tudo sem sair da lista.
   */
  function abrirCliente(id) {
    camadaAtual = UI.gaveta({
      titulo: 'Ficha do cliente',
      sub: 'Carregando…',
      corpo: '<div class="adm-detalhe">' + UI.esqueletoLinhas(6) + '</div>',
      aoFechar: function () { camadaAtual = null; }
    });

    pedir('GET', '/api/admin/usuarios/' + encodeURIComponent(id)).then(function (r) {
      if (!avaliaGaveta()) return;
      var gaveta = qs('.adm-gaveta');
      if (!gaveta) return;

      if (!r.ok) {
        qs('.adm-gaveta__corpo').innerHTML = UI.estado({ tipo: 'erro', titulo: 'Erro ao abrir a ficha', texto: erroDe(r), icone: 'aviso' });
        return;
      }

      var u = r.data;
      var resumo = u.resumo || {};

      qs('.adm-modal__titulo', gaveta).textContent = u.nome || 'Cliente';
      qs('.adm-modal__sub', gaveta).textContent = u.email + ' · desde ' + UI.dataCurta(u.criadoEm);

      var estatisticas =
        '<div class="adm-mini-kpis">' +
          '<div class="adm-mini-kpi"><span class="adm-mini-kpi__rotulo">Pedidos</span><span class="adm-mini-kpi__valor">' + UI.numero(resumo.pedidos) + '</span></div>' +
          '<div class="adm-mini-kpi"><span class="adm-mini-kpi__rotulo">Total gasto</span><span class="adm-mini-kpi__valor">' + UI.dinheiro(resumo.gasto || 0) + '</span></div>' +
          '<div class="adm-mini-kpi"><span class="adm-mini-kpi__rotulo">Licenças</span><span class="adm-mini-kpi__valor">' + UI.numero(resumo.licencas) + '</span></div>' +
          '<div class="adm-mini-kpi"><span class="adm-mini-kpi__rotulo">Ativas</span><span class="adm-mini-kpi__valor">' + UI.numero(resumo.licencasAtivas) + '</span></div>' +
        '</div>';

      var dados =
        '<div class="adm-detalhe__linha"><span class="adm-detalhe__rotulo">Papel</span><span class="adm-detalhe__valor">' + UI.seloPapel(u.papel) + '</span></div>' +
        '<div class="adm-detalhe__linha"><span class="adm-detalhe__rotulo">Situação</span><span class="adm-detalhe__valor">' + UI.seloAtivo(u.ativo) + '</span></div>' +
        '<div class="adm-detalhe__linha"><span class="adm-detalhe__rotulo">Último acesso</span><span class="adm-detalhe__valor">' + (u.ultimoLoginEm ? esc(UI.dataHora(u.ultimoLoginEm)) : 'nunca entrou') + '</span></div>';

      var pedidos = (u.pedidos || []).length
        ? '<div class="adm-lista">' + u.pedidos.map(function (pedido) {
            var itens = (pedido.itens || []).map(function (item) {
              return esc(item.nome) + ' · ' + esc(item.plano) + ' ×' + item.quantidade;
            }).join('<br>');
            return '<div class="adm-lista__item">' +
              '<span class="adm-lista__txt">' +
                '<span class="adm-lista__nome">' + esc(pedido.numero) + ' ' + UI.seloVenda(pedido.status) + '</span>' +
                '<span class="adm-lista__meta">' + (itens || 'sem itens') + '</span>' +
                '<span class="adm-lista__meta">' + esc(UI.dataHora(pedido.criadoEm)) + '</span>' +
              '</span>' +
              '<span class="adm-lista__valor">' + UI.dinheiro(pedido.total) + '</span>' +
            '</div>';
          }).join('') + '</div>'
        : '<p style="font-size:13.5px;color:var(--text-3)">Nenhum pedido ainda.</p>';

      var chaves = (u.licencas || []).length
        ? '<div class="adm-chaves">' + u.licencas.slice(0, 30).map(function (lic) {
            return '<div class="adm-chave">' + UI.seloLicenca(lic.status) +
              '<code>' + esc(lic.chave) + '</code>' +
              '<button class="icon-btn" type="button" data-acao="copiar-chave" data-chave="' + esc(lic.chave) + '" aria-label="Copiar chave" style="margin-left:auto;width:34px;height:34px">' + UI.icone('copiar') + '</button>' +
            '</div>';
          }).join('') + '</div>'
        : '<p style="font-size:13.5px;color:var(--text-3)">Nenhuma chave emitida.</p>';

      qs('.adm-gaveta__corpo').innerHTML =
        '<div class="adm-detalhe">' +
          estatisticas +
          '<div>' + dados + '</div>' +
          '<div><p class="adm-cartao__titulo" style="margin-bottom:8px">Pedidos</p>' + pedidos + '</div>' +
          '<div><p class="adm-cartao__titulo" style="margin-bottom:8px">Chaves</p>' + chaves + '</div>' +
        '</div>';
    });
  }

  /* ===========================================================================
   * VIEW: AUDITORIA
   * ========================================================================= */

  var estadoAuditoria = { pagina: 1, limite: 50, entidade: '', acao: '', total: 0 };

  var ENTIDADES = ['', 'venda', 'usuario', 'produto', 'cupom', 'avaliacao', 'configuracao'];
  var ACOES = ['', 'produto.criado', 'produto.atualizado', 'produto.ativado', 'produto.desativado',
    'pedido.status_alterado', 'cupom.criado', 'cupom.atualizado', 'cupom.removido', 'avaliacao.removida',
    'usuario.papel_alterado', 'usuario.ativado', 'usuario.desativado', 'configuracoes.atualizadas'];

  function viewAuditoria() {
    var token = novoToken();
    registrarAcoes({
      'filtrar-entidade': function (el) { estadoAuditoria.entidade = el.value; estadoAuditoria.pagina = 1; viewAuditoria(); },
      'filtrar-acao': function (el) { estadoAuditoria.acao = el.value; estadoAuditoria.pagina = 1; viewAuditoria(); },
      'pagina': function (el) { estadoAuditoria.pagina = Number(el.getAttribute('data-pagina')) || 1; viewAuditoria(); }
    });

    pintar(cartao('Auditoria', 'Quem fez o quê, quando e de qual IP', '<div id="t-auditoria">' + UI.esqueletoLinhas(8) + '</div>', {
      semPad: true,
      acoes: '<select class="adm-select" data-mudanca="filtrar-entidade" aria-label="Filtrar por entidade">' +
          opcoesSelect(ENTIDADES.map(function (e) { return { valor: e, rotulo: e ? e.charAt(0).toUpperCase() + e.slice(1) : 'Todas as entidades' }; }), estadoAuditoria.entidade) +
        '</select>' +
        '<select class="adm-select" data-mudanca="filtrar-acao" aria-label="Filtrar por ação">' +
          opcoesSelect(ACOES.map(function (a) { return { valor: a, rotulo: a ? rotuloAcao(a) : 'Todas as ações' }; }), estadoAuditoria.acao) +
        '</select>'
    }));

    var deslocamento = (estadoAuditoria.pagina - 1) * estadoAuditoria.limite;
    var url = '/api/admin/auditoria?limite=' + estadoAuditoria.limite + '&deslocamento=' + deslocamento +
      (estadoAuditoria.entidade ? '&entidade=' + encodeURIComponent(estadoAuditoria.entidade) : '') +
      (estadoAuditoria.acao ? '&acao=' + encodeURIComponent(estadoAuditoria.acao) : '');

    pedir('GET', url).then(function (r) {
      if (!aindaValido(token)) return;
      if (!r.ok) { qs('#t-auditoria').innerHTML = UI.estado({ tipo: 'erro', titulo: 'Erro ao carregar auditoria', texto: erroDe(r), icone: 'aviso' }); return; }

      var eventos = r.data.eventos || [];
      estadoAuditoria.total = r.data.total || 0;
      var paginas = Math.max(Math.ceil(estadoAuditoria.total / estadoAuditoria.limite), 1);

      var corpo = eventos.map(function (ev) {
        return '<tr>' +
          '<td>' + dataAttrData(ev.criadoEm) + '<span class="adm-tabela__sub">' + esc(UI.dataHora(ev.criadoEm)) + '</span></td>' +
          '<td><span class="adm-tabela__principal">' + esc(ev.atorNome || 'sistema') + '</span>' +
            '<span class="adm-tabela__sub">' + esc(ev.atorEmail || (ev.atorId ? ev.atorId.slice(0, 8) : '—')) + '</span></td>' +
          '<td>' + esc(rotuloAcao(ev.acao)) + '</td>' +
          '<td>' + esc(ev.entidade || '—') + '</td>' +
          '<td><span class="adm-mono" title="' + esc(jsonCurto(ev.dados)) + '">' + esc(jsonCurto(ev.dados)) + '</span></td>' +
          '<td><span class="adm-mono">' + esc(ev.ip || '—') + '</span></td>' +
        '</tr>';
      }).join('');

      qs('#t-auditoria').innerHTML = UI.tabela({
        colunas: [
          { rotulo: 'Quando' }, { rotulo: 'Autor' }, { rotulo: 'Ação' },
          { rotulo: 'Entidade' }, { rotulo: 'Detalhes' }, { rotulo: 'IP' }
        ],
        corpo: corpo,
        vazio: { titulo: 'Nenhum evento registrado', texto: 'As ações administrativas aparecem aqui.', icone: 'lista' }
      }) + (eventos.length ? UI.paginacaoHtml({ pagina: estadoAuditoria.pagina, paginas: paginas, total: estadoAuditoria.total }) : '');
    });
  }

  /* ===========================================================================
   * VIEW: CONFIGURAÇÕES
   * ========================================================================= */

  function viewConfiguracoes() {
    var token = novoToken();
    registrarAcoes({
      'tentar-config': function () { viewConfiguracoes(); }
    });

    pintar('<div id="c-config">' + UI.esqueletoLinhas(6) + '</div>');

    pedir('GET', '/api/admin/configuracoes').then(function (r) {
      if (!aindaValido(token)) return;
      if (!r.ok) {
        qs('#c-config').innerHTML = UI.estado({
          tipo: 'erro', titulo: 'Erro ao carregar configurações', texto: erroDe(r), icone: 'aviso',
          acao: '<button class="btn btn--soft btn--sm" type="button" data-acao="tentar-config">' + UI.icone('atualizar') + 'Tentar de novo</button>'
        });
        return;
      }
      // Formulário, validação e salvamento ficam em admin-configuracoes.js.
      window.AdminConfiguracoes.render(qs('#c-config'), { configuracoes: r.data.configuracoes, pedir: pedir });
    });
  }

  /* ===========================================================================
   * VIEW: ESTOQUE
   * ========================================================================= */

  var estadoEstoque = { filtro: 'todos', busca: '', planos: [] };

  function seloEstoque(plano) {
    if (plano.esgotado) return UI.selo('erro', 'Esgotado');
    if (plano.baixo) return UI.selo('aviso', 'Estoque baixo');
    return UI.selo('ok', 'Disponível');
  }

  function dadosDoEl(el) {
    return {
      produtoId: el.getAttribute('data-produto'),
      planoId: el.getAttribute('data-plano'),
      nome: el.getAttribute('data-nome') || 'plano'
    };
  }

  function viewEstoque() {
    var token = novoToken();
    registrarAcoes({
      // Filtro e busca são aplicados no cliente: a lista já veio inteira, então
      // não há motivo para bater na API a cada tecla (e o input não perde foco).
      'filtrar-estoque': function (el) { estadoEstoque.filtro = el.value; desenharTabelaEstoque(estadoEstoque.planos); },
      'buscar-estoque': function (el) { estadoEstoque.busca = el.value.trim(); desenharTabelaEstoque(estadoEstoque.planos); },
      'entrada-estoque': function (el) { abrirEntradaEstoque(dadosDoEl(el)); },
      'gerenciar-estoque': function (el) {
        var alvo = dadosDoEl(el);
        abrirGerenciarEstoque(alvo.produtoId, alvo.planoId, alvo.nome);
      },
      'ver-chaves-plano': function (el) {
        var alvo = dadosDoEl(el);
        abrirChavesDoPlano(alvo.produtoId, alvo.planoId, alvo.nome);
      },
      'ver-movimentos': function () { abrirMovimentos(); },
      'copiar-chave': function (el) { UI.copiar(el.getAttribute('data-chave')); }
    });

    pintar(
      '<div class="adm-kpis" id="e-kpis">' +
        kpi('Disponíveis', '…', '', 'caixa') +
        kpi('Vendidas', '…', '', 'check') +
        kpi('Esgotados', '…', '', 'aviso') +
        kpi('Em nível baixo', '…', '', 'atividade') +
        kpi('Total de chaves', '…', '', 'camadas') +
      '</div>' +
      '<div id="e-alertas"></div>' +
      '<div class="adm-barra">' +
        barraBusca('Buscar por produto ou plano…', estadoEstoque.busca, 'buscar-estoque') +
        '<select class="adm-select" data-mudanca="filtrar-estoque" aria-label="Filtrar estoque">' +
          opcoesSelect([
            { valor: 'todos', rotulo: 'Todos os planos' },
            { valor: 'alerta', rotulo: 'Somente alertas' },
            { valor: 'esgotado', rotulo: 'Esgotados' },
            { valor: 'baixo', rotulo: 'Estoque baixo' },
            { valor: 'ok', rotulo: 'Saudáveis' }
          ], estadoEstoque.filtro) +
        '</select>' +
        '<button class="btn btn--soft btn--sm" type="button" data-acao="ver-movimentos">' + UI.icone('lista') + 'Movimentações</button>' +
      '</div>' +
      cartao('Estoque por plano', 'O estoque é controlado por plano: cada produto pode ter planos com saldos diferentes', '<div id="t-estoque">' + UI.esqueletoLinhas(8) + '</div>', { semPad: true })
    );

    pedir('GET', '/api/admin/estoque').then(function (r) {
      if (!aindaValido(token)) return;
      if (!r.ok) {
        qs('#t-estoque').innerHTML = UI.estado({ tipo: 'erro', titulo: 'Erro ao carregar o estoque', texto: erroDe(r), icone: 'aviso' });
        return;
      }
      desenharEstoque(r.data);
    });
  }

  function desenharEstoque(d) {
    var totais = d.totais || {};
    var resumoAlertas = d.resumoAlertas || {};

    estadoEstoque.planos = d.planos || [];

    qs('#e-kpis').innerHTML =
      kpi('Disponíveis', UI.numero(totais.disponivel || 0), 'prontas para venda', 'caixa') +
      kpi('Vendidas', UI.numero(totais.vendida || 0), 'já entregues', 'check') +
      kpi('Esgotados', UI.numero(resumoAlertas.esgotados || 0), 'planos sem chave', 'aviso') +
      kpi('Em nível baixo', UI.numero(resumoAlertas.baixos || 0), 'no ponto de reposição', 'atividade') +
      kpi('Total de chaves', UI.numero(totais.total || 0),
        UI.numero(totais.descartada || 0) + ' descartada(s) · ' + UI.numero(totais.revogada || 0) + ' revogada(s)', 'camadas');

    var alertas = d.alertas || [];
    qs('#e-alertas').innerHTML = alertas.length
      ? '<div class="adm-alertas">' +
          '<div class="adm-alertas__cab">' +
            '<span class="adm-alertas__titulo">' + UI.icone('aviso') + 'Reposição necessária (' + alertas.length + ')' + '</span>' +
          '</div>' +
          '<div class="adm-alertas__lista">' + alertas.map(function (item) {
            return '<div class="adm-alerta">' +
              '<span class="adm-alerta__txt">' +
                '<span class="adm-alerta__nome">' + esc(item.produtoNome) + '</span>' +
                '<span class="adm-alerta__meta">' + esc(item.planoNome) + ' · ' + UI.numero(item.disponivel) + ' de ' + UI.numero(item.estoqueMinimo) + '</span>' +
              '</span>' +
              (item.esgotado ? UI.selo('erro', 'Esgotado') : UI.selo('aviso', 'Baixo')) +
              '<button class="btn btn--primary btn--sm" type="button" data-acao="entrada-estoque" data-produto="' + esc(item.produtoId) + '" data-plano="' + esc(item.planoId) + '" data-nome="' + esc(item.produtoNome + ' · ' + item.planoNome) + '">Repor</button>' +
            '</div>';
          }).join('') + '</div>' +
        '</div>'
      : '<div class="adm-aviso adm-aviso--ok">' + UI.icone('escudo') + '<span>Nenhum plano em alerta — todo o catálogo tem chaves suficientes.</span></div>';

    desenharTabelaEstoque(estadoEstoque.planos);
  }

  function desenharTabelaEstoque(planos) {
    var busca = estadoEstoque.busca.toLowerCase();

    var filtrados = planos.filter(function (p) {
      if (estadoEstoque.filtro === 'alerta' && !p.alerta) return false;
      if (estadoEstoque.filtro === 'esgotado' && !p.esgotado) return false;
      if (estadoEstoque.filtro === 'baixo' && !p.baixo) return false;
      if (estadoEstoque.filtro === 'ok' && p.alerta) return false;
      if (busca) {
        var alvo = (String(p.produtoNome) + ' ' + String(p.planoNome) + ' ' + String(p.produtoCategoria || '')).toLowerCase();
        if (alvo.indexOf(busca) === -1) return false;
      }
      return true;
    });

    var corpo = filtrados.map(function (p) {
      var nome = p.produtoNome + ' · ' + p.planoNome;
      return '<tr' + (p.alerta ? ' class="adm-linha--alerta"' : '') + '>' +
        '<td><span class="adm-tabela__principal">' + esc(p.produtoNome) + '</span>' +
          '<span class="adm-tabela__sub">' + esc(p.produtoCategoria || '') + '</span></td>' +
        '<td><span class="adm-tabela__principal">' + esc(p.planoNome) + '</span>' +
          '<span class="adm-tabela__sub">' + UI.dinheiro(p.preco) + (p.planoAtivo ? '' : ' · fora da vitrine') + '</span></td>' +
        '<td class="adm-num"><strong>' + UI.numero(p.disponivel) + '</strong></td>' +
        '<td class="adm-num">' + UI.numero(p.vendida) + '</td>' +
        '<td class="adm-num">' + (p.estoqueMinimo ? UI.numero(p.estoqueMinimo) : '—') + '</td>' +
        '<td>' + seloEstoque(p) + '</td>' +
        '<td class="adm-acoes">' +
          '<button class="btn btn--soft btn--sm" type="button" data-acao="entrada-estoque" data-produto="' + esc(p.produtoId) + '" data-plano="' + esc(p.planoId) + '" data-nome="' + esc(nome) + '">' + UI.icone('mais') + 'Chaves</button>' +
          '<button class="btn btn--soft btn--sm" type="button" data-acao="gerenciar-estoque" data-produto="' + esc(p.produtoId) + '" data-plano="' + esc(p.planoId) + '" data-nome="' + esc(nome) + '" style="margin-left:6px">' + UI.icone('ajustes') + 'Gerenciar</button>' +
          '<button class="icon-btn" type="button" data-acao="ver-chaves-plano" data-produto="' + esc(p.produtoId) + '" data-plano="' + esc(p.planoId) + '" data-nome="' + esc(nome) + '" aria-label="Ver chaves" title="Ver chaves" style="width:36px;height:36px;margin-left:6px">' + UI.icone('chave') + '</button>' +
        '</td>' +
      '</tr>';
    }).join('');

    qs('#t-estoque').innerHTML = UI.tabela({
      colunas: [
        { rotulo: 'Produto' }, { rotulo: 'Plano' }, { rotulo: 'Disponível', classe: 'adm-num' },
        { rotulo: 'Vendidas', classe: 'adm-num' }, { rotulo: 'Mínimo', classe: 'adm-num' },
        { rotulo: 'Situação' }, { rotulo: '', classe: 'adm-acoes' }
      ],
      corpo: corpo,
      vazio: {
        titulo: 'Nenhum plano neste filtro',
        texto: 'Ajuste o filtro ou a busca para ver outros planos do catálogo.',
        icone: 'caixa'
      }
    }) + '<div class="adm-paginacao"><span class="adm-paginacao__info">' + UI.numero(filtrados.length) + ' de ' + UI.numero(planos.length) + ' plano(s)</span></div>';
  }

  /** Modal de entrada de chaves (gerar em lote ou colar uma lista). */
  function abrirEntradaEstoque(alvo) {
    var corpo =
      '<form class="adm-form" id="form-entrada-estoque">' +
        '<p class="adm-form__intro">Adicionando chaves a <strong>' + esc(alvo.nome) + '</strong>.</p>' +
        '<div class="adm-form-grade">' +
          '<div class="field"><label class="field__label">Quantidade a gerar</label>' +
            '<input class="field__input" name="quantidade" type="number" min="1" max="500" value="10" data-foco></div>' +
          '<div class="field"><label class="field__label">Lote (opcional)</label>' +
            '<input class="field__input" name="lote" maxlength="60" placeholder="Ex.: fornecedor-julho"></div>' +
          '<div class="field adm-campo-largo"><label class="field__label">Ou cole as chaves (uma por linha)</label>' +
            '<textarea class="field__input adm-textarea" name="chaves" placeholder="ABCD-1234-EF56-7890"></textarea>' +
            '<span class="adm-campo__dica">Se preencher este campo, a quantidade acima é ignorada. Formato aceito: ABCD-1234-EF56-7890.</span></div>' +
        '</div>' +
      '</form>';

    UI.modal({
      titulo: 'Adicionar chaves ao estoque',
      sub: 'Entrada de estoque',
      corpo: corpo,
      pe: '<button class="btn btn--soft" type="button" data-fechar>Cancelar</button>' +
          '<button class="btn btn--primary" type="button" data-confirmar-entrada>' + UI.icone('mais') + 'Adicionar</button>',
      aoAbrir: function (caixa, fechar) {
        caixa.querySelector('[data-confirmar-entrada]').addEventListener('click', function () {
          var form = caixa.querySelector('#form-entrada-estoque');
          var coladas = String(form.elements.chaves.value || '').trim();
          var dados = {
            produtoId: alvo.produtoId,
            planoId: alvo.planoId,
            lote: String(form.elements.lote.value || '').trim()
          };

          if (coladas) {
            dados.chaves = coladas;
          } else {
            var quantidade = Number(form.elements.quantidade.value);
            if (!Number.isInteger(quantidade) || quantidade < 1) {
              Api.toast('Informe uma quantidade válida (1 a 500)', 'error');
              return;
            }
            dados.quantidade = quantidade;
          }

          pedir('POST', '/api/admin/estoque/gerar', dados).then(function (r) {
            if (!r.ok) { Api.toast(erroDe(r), 'error'); return; }
            Api.toast(r.data.mensagem || 'Estoque atualizado', 'success');
            fechar();
            viewEstoque();
            carregarContadores();
          });
        });
      }
    });
  }

  /** Modal único com as três operações de quantidade de um plano. */
  function abrirGerenciarEstoque(produtoId, planoId, nome) {
    var corpo =
      '<div class="adm-gerenciar">' +
        '<p class="adm-form__intro">Ajustando <strong>' + esc(nome) + '</strong></p>' +

        '<div class="adm-bloco-acao">' +
          '<div class="adm-bloco-acao__txt">' +
            '<p class="adm-bloco-acao__titulo">Definir quantidade disponível</p>' +
            '<p class="adm-bloco-acao__dica">Gera ou descarta chaves até chegar no número desejado.</p>' +
          '</div>' +
          '<div class="adm-bloco-acao__form">' +
            '<input class="field__input" type="number" min="0" max="1000000" placeholder="Ex.: 50" data-alvo>' +
            '<button class="btn btn--primary btn--sm" type="button" data-definir>Definir</button>' +
          '</div>' +
        '</div>' +

        '<div class="adm-bloco-acao">' +
          '<div class="adm-bloco-acao__txt">' +
            '<p class="adm-bloco-acao__titulo">Remover chaves</p>' +
            '<p class="adm-bloco-acao__dica">Descarta as chaves disponíveis mais antigas (FIFO).</p>' +
          '</div>' +
          '<div class="adm-bloco-acao__form">' +
            '<input class="field__input" type="number" min="1" max="500" placeholder="Qtd." data-remover>' +
            '<button class="btn btn--soft btn--sm" type="button" data-remover-btn style="color:var(--danger)">Remover</button>' +
          '</div>' +
        '</div>' +

        '<div class="adm-bloco-acao">' +
          '<div class="adm-bloco-acao__txt">' +
            '<p class="adm-bloco-acao__titulo">Ponto de reposição</p>' +
            '<p class="adm-bloco-acao__dica">O painel avisa quando o disponível chegar neste número. Use 0 para desligar o alerta.</p>' +
          '</div>' +
          '<div class="adm-bloco-acao__form">' +
            '<input class="field__input" type="number" min="0" max="1000000" placeholder="Ex.: 5" data-minimo>' +
            '<button class="btn btn--soft btn--sm" type="button" data-minimo-btn>Salvar</button>' +
          '</div>' +
        '</div>' +
      '</div>';

    UI.modal({
      titulo: 'Gerenciar estoque',
      sub: 'Quantidade, remoção e ponto de reposição',
      corpo: corpo,
      pe: '<button class="btn btn--soft" type="button" data-fechar>Fechar</button>',
      aoAbrir: function (caixa, fechar) {
        function concluir(r, mensagem) {
          if (!r.ok) { Api.toast(erroDe(r), 'error'); return; }
          Api.toast(mensagem, 'success');
          fechar();
          viewEstoque();
          carregarContadores();
        }

        caixa.querySelector('[data-definir]').addEventListener('click', function () {
          var alvo = Number(caixa.querySelector('[data-alvo]').value);
          if (!Number.isInteger(alvo) || alvo < 0) { Api.toast('Informe uma quantidade válida', 'error'); return; }
          pedir('POST', '/api/admin/estoque/ajustar', { produtoId: produtoId, planoId: planoId, alvo: alvo })
            .then(function (r) { concluir(r, 'Quantidade ajustada para ' + alvo); });
        });

        caixa.querySelector('[data-remover-btn]').addEventListener('click', function () {
          var quantidade = Number(caixa.querySelector('[data-remover]').value);
          if (!Number.isInteger(quantidade) || quantidade < 1) { Api.toast('Informe quantas chaves remover', 'error'); return; }
          pedir('POST', '/api/admin/estoque/descartar', {
            produtoId: produtoId,
            planoId: planoId,
            quantidade: quantidade,
            motivo: 'Remoção manual pelo painel'
          }).then(function (r) { concluir(r, r.data && r.data.mensagem ? r.data.mensagem : 'Chaves removidas'); });
        });

        caixa.querySelector('[data-minimo-btn]').addEventListener('click', function () {
          var minimo = Number(caixa.querySelector('[data-minimo]').value);
          if (!Number.isInteger(minimo) || minimo < 0) { Api.toast('Informe um mínimo válido', 'error'); return; }
          pedir('PATCH', '/api/admin/estoque/minimo', { produtoId: produtoId, planoId: planoId, minimo: minimo })
            .then(function (r) { concluir(r, 'Ponto de reposição salvo'); });
        });
      }
    });
  }

  /**
   * Gaveta com as chaves de um plano: filtro por situação, busca, seleção e as
   * ações de remover/excluir (implementada em admin-estoque-chaves.js).
   */
  function abrirChavesDoPlano(produtoId, planoId, nome) {
    camadaAtual = window.AdminChavesEstoque.abrir({
      produtoId: produtoId,
      planoId: planoId,
      nome: nome,
      // Mantém a tabela de estoque e os contadores do menu em dia por trás da gaveta.
      aoMudar: function () { viewEstoque(); carregarContadores(); },
      aoFechar: function () { camadaAtual = null; }
    });
  }

  /** Gaveta com o livro-caixa do estoque (entradas, saídas, descartes...). */
  function abrirMovimentos() {
    camadaAtual = UI.gaveta({
      titulo: 'Movimentações de estoque',
      sub: 'Histórico de entradas, saídas, descartes e revogações',
      corpo: '<div class="adm-detalhe">' + UI.esqueletoLinhas(8) + '</div>',
      aoFechar: function () { camadaAtual = null; }
    });

    pedir('GET', '/api/admin/estoque/movimentos?limite=100').then(function (r) {
      if (!avaliaGaveta()) return;
      var gaveta = qs('.adm-gaveta');
      if (!gaveta) return;

      if (!r.ok) {
        qs('.adm-gaveta__corpo').innerHTML = UI.estado({ tipo: 'erro', titulo: 'Erro ao carregar movimentações', texto: erroDe(r), icone: 'aviso' });
        return;
      }

      var movimentos = r.data.movimentos || [];
      var corpo = movimentos.length
        ? '<div class="adm-linha-tempo">' + movimentos.map(function (m) {
            var sinal = (m.tipo === 'entrada') ? '+' : '−';
            return '<div class="adm-linha-tempo__item">' +
              '<span class="adm-linha-tempo__ponto" data-tipo="' + esc(m.tipo) + '"></span>' +
              '<span>' +
                '<span class="adm-linha-tempo__txt">' + UI.seloEstoqueTipo(m.tipo) + ' ' +
                  '<strong>' + sinal + UI.numero(m.quantidade) + '</strong> · ' + esc(m.produtoNome || '') + ' · ' + esc(m.planoNome || m.planoId) + '</span>' +
                '<span class="adm-linha-tempo__hora">' + esc(m.motivo || '') + ' · ' + esc(m.atorNome || 'sistema') + ' · ' + esc(UI.dataHora(m.criadoEm)) + '</span>' +
              '</span>' +
            '</div>';
          }).join('') + '</div>'
        : '<p style="font-size:13.5px;color:var(--text-3)">Nenhuma movimentação registrada ainda.</p>';

      qs('.adm-gaveta__corpo').innerHTML = '<div class="adm-detalhe"><div>' + corpo + '</div></div>';
    });
  }

  /* ===========================================================================
   * VIEW: RELATÓRIOS
   * ========================================================================= */

  var estadoRelatorios = { periodo: 30, desde: '', ate: '' };

  function variacaoHtml(percentual) {
    var p = Number(percentual) || 0;
    var classe = p > 0 ? 'adm-var--alta' : (p < 0 ? 'adm-var--baixa' : 'adm-var--neutro');
    var seta = p > 0 ? '↑' : (p < 0 ? '↓' : '•');
    return '<span class="adm-var ' + classe + '">' + seta + ' ' +
      (p > 0 ? '+' : '') + String(p.toFixed(1)).replace('.', ',') + '%</span>';
  }

  function barrasParticipacao(itens, opcoes) {
    opcoes = opcoes || {};
    if (!itens.length) {
      return UI.estado(opcoes.vazio || { titulo: 'Sem dados no período', texto: 'Não houve vendas suficientes para montar este ranking.', icone: 'grafico' });
    }

    var maximo = itens.reduce(function (maior, item) { return Math.max(maior, item.valor); }, 0) || 1;

    return '<div class="adm-barras">' + itens.map(function (item) {
      var largura = Math.max((item.valor / maximo) * 100, 3);
      return '<div class="adm-barra-item">' +
        '<div class="adm-barra-item__topo">' +
          '<span class="adm-barra-item__nome">' + esc(item.rotulo) + '</span>' +
          '<span class="adm-barra-item__valor">' + esc(item.valorTexto) + '</span>' +
        '</div>' +
        '<div class="adm-barra-item__trilha"><span class="adm-barra-item__fill"' + (opcoes.cor ? ' style="width:' + largura.toFixed(1) + '%;background:' + opcoes.cor + '"' : ' style="width:' + largura.toFixed(1) + '%"') + '></span></div>' +
        (item.meta ? '<span class="adm-barra-item__meta">' + esc(item.meta) + '</span>' : '') +
      '</div>';
    }).join('') + '</div>';
  }

  function viewRelatorios() {
    var token = novoToken();
    registrarAcoes({
      'periodo-relatorio': function (el) {
        estadoRelatorios.periodo = Number(el.value) || 30;
        estadoRelatorios.desde = '';
        estadoRelatorios.ate = '';
        viewRelatorios();
      },
      'aplicar-intervalo': function () {
        var de = qs('#rel-desde');
        var ate = qs('#rel-ate');
        estadoRelatorios.desde = de ? de.value : '';
        estadoRelatorios.ate = ate ? ate.value : '';
        if (!estadoRelatorios.desde || !estadoRelatorios.ate) {
          Api.toast('Informe a data inicial e a final', 'error');
          return;
        }
        viewRelatorios();
      },
      'limpar-intervalo': function () {
        estadoRelatorios.desde = '';
        estadoRelatorios.ate = '';
        viewRelatorios();
      },
      'ver-estoque-alerta': function () { window.location.hash = '#/estoque'; }
    });

    var usandoIntervalo = !!(estadoRelatorios.desde && estadoRelatorios.ate);

    pintar(
      '<div class="adm-barra">' +
        '<select class="adm-select" data-mudanca="periodo-relatorio" aria-label="Período do relatório"' + (usandoIntervalo ? ' disabled' : '') + '>' +
          opcoesSelect([
            { valor: '7', rotulo: 'Últimos 7 dias' },
            { valor: '30', rotulo: 'Últimos 30 dias' },
            { valor: '90', rotulo: 'Últimos 90 dias' },
            { valor: '365', rotulo: 'Últimos 12 meses' }
          ], String(estadoRelatorios.periodo)) +
        '</select>' +
        '<span class="adm-barra__sep">ou</span>' +
        '<input class="field__input adm-barra__data" type="date" id="rel-desde" value="' + esc(estadoRelatorios.desde) + '" aria-label="Data inicial">' +
        '<input class="field__input adm-barra__data" type="date" id="rel-ate" value="' + esc(estadoRelatorios.ate) + '" aria-label="Data final">' +
        '<button class="btn btn--soft btn--sm" type="button" data-acao="aplicar-intervalo">Aplicar</button>' +
        (usandoIntervalo ? '<button class="btn btn--ghost btn--sm" type="button" data-acao="limpar-intervalo">Limpar</button>' : '') +
      '</div>' +
      '<div class="adm-kpis" id="r-kpis">' +
        kpi('Receita', '…', '', 'dinheiro') +
        kpi('Pedidos pagos', '…', '', 'pacote') +
        kpi('Ticket médio', '…', '', 'cartao') +
        kpi('Unidades vendidas', '…', '', 'camadas') +
        kpi('Novos clientes', '…', '', 'usuarios') +
        kpi('Descontos', '…', '', 'tag') +
      '</div>' +
      cartao('Receita por dia', 'Evolução diária no período', '<div id="r-grafico">' + UI.esqueletoLinhas(4) + '</div>') +
      '<div class="adm-grade adm-grade--3">' +
        cartao('Produtos que mais faturaram', 'Top 10 por receita', '<div id="r-produtos">' + UI.esqueletoLinhas(5) + '</div>') +
        cartao('Vendas por categoria', 'Receita por categoria do catálogo', '<div id="r-categorias">' + UI.esqueletoLinhas(5) + '</div>') +
        cartao('Formas de pagamento', 'Receita por método', '<div id="r-metodos">' + UI.esqueletoLinhas(5) + '</div>') +
      '</div>' +
      '<div class="adm-grade adm-grade--2">' +
        cartao('Cupons no período', 'Descontos concedidos', '<div id="r-cupons">' + UI.esqueletoLinhas(4) + '</div>', { semPad: true }) +
        cartao('Situação dos pedidos', 'Todos os status criados no período', '<div id="r-status">' + UI.esqueletoLinhas(4) + '</div>') +
      '</div>' +
      cartao('Estoque em alerta', 'Planos que precisam de reposição agora', '<div id="r-estoque">' + UI.esqueletoLinhas(4) + '</div>', { semPad: true })
    );

    var query = usandoIntervalo
      ? '?desde=' + encodeURIComponent(estadoRelatorios.desde) + '&ate=' + encodeURIComponent(estadoRelatorios.ate)
      : '?periodo=' + estadoRelatorios.periodo;

    pedir('GET', '/api/admin/relatorios' + query).then(function (r) {
      if (!aindaValido(token)) return;
      if (!r.ok) {
        pintar(UI.estado({ tipo: 'erro', titulo: 'Não foi possível carregar o relatório', texto: erroDe(r), icone: 'aviso' }));
        return;
      }
      desenharRelatorio(r.data);
    });
  }

  function desenharRelatorio(d) {
    var fin = d.financeiro || {};
    var comp = d.comparativo || {};
    var cli = d.clientes || {};

    qs('#sub-view').textContent = d.janela && d.janela.rotulo ? d.janela.rotulo : 'Desempenho da loja por período';

    qs('#r-kpis').innerHTML =
      kpi('Receita', UI.dinheiro(fin.receita || 0), variacaoHtml(comp.variacaoReceita) + ' vs. período anterior', 'dinheiro') +
      kpi('Pedidos pagos', UI.numero(fin.pedidos || 0), variacaoHtml(comp.variacaoPedidos) + ' vs. ' + UI.numero(comp.pedidosAnterior || 0), 'pacote') +
      kpi('Ticket médio', UI.dinheiro(fin.ticketMedio || 0), variacaoHtml(comp.variacaoTicketMedio) + ' vs. anterior', 'cartao') +
      kpi('Unidades vendidas', UI.numero(fin.unidades || 0), 'chaves entregues no período', 'camadas') +
      kpi('Novos clientes', UI.numero(cli.novos || 0), UI.numero(cli.compradores || 0) + ' cliente(s) compraram', 'usuarios') +
      kpi('Descontos', UI.dinheiro(fin.descontos || 0), 'concedidos em cupons', 'tag');

    var serie = (d.receitaPorDia || []).map(function (item) {
      return { dia: item.dia, valor: (item.receitaCentavos || 0) / 100, pedidos: item.pedidos };
    });
    qs('#r-grafico').innerHTML = UI.grafico(serie, {
      formatarEixo: moedaCompacta,
      formatarValor: function (v) { return UI.dinheiro(v); }
    });

    qs('#r-produtos').innerHTML = barrasParticipacao((d.topProdutos || []).map(function (item) {
      return {
        rotulo: item.nome,
        valor: item.receitaCentavos || 0,
        valorTexto: UI.dinheiro(item.receita || 0),
        meta: UI.numero(item.unidades) + ' unidade(s) · ' + String(item.participacao).replace('.', ',') + '% da receita'
      };
    }));

    qs('#r-categorias').innerHTML = barrasParticipacao((d.porCategoria || []).map(function (item) {
      return {
        rotulo: item.categoria,
        valor: item.receitaCentavos || 0,
        valorTexto: UI.dinheiro(item.receita || 0),
        meta: UI.numero(item.unidades) + ' unidade(s) · ' + String(item.participacao).replace('.', ',') + '%'
      };
    }));

    var rotulosMetodo = { pix: 'PIX', cartao: 'Cartão', boleto: 'Boleto' };
    qs('#r-metodos').innerHTML = barrasParticipacao((d.porMetodo || []).map(function (item) {
      return {
        rotulo: rotulosMetodo[item.metodo] || item.metodo,
        valor: item.receitaCentavos || 0,
        valorTexto: UI.dinheiro(item.receita || 0),
        meta: UI.numero(item.pedidos) + ' pedido(s) · ' + String(item.participacao).replace('.', ',') + '%'
      };
    }));

    var cupons = d.cupons || [];
    qs('#r-cupons').innerHTML = UI.tabela({
      colunas: [{ rotulo: 'Cupom' }, { rotulo: 'Pedidos', classe: 'adm-num' }, { rotulo: 'Desconto', classe: 'adm-num' }],
      corpo: cupons.map(function (cupom) {
        return '<tr><td><span class="adm-mono">' + esc(cupom.codigo) + '</span></td>' +
          '<td class="adm-num">' + UI.numero(cupom.pedidos) + '</td>' +
          '<td class="adm-num">' + UI.dinheiro(cupom.desconto || 0) + '</td></tr>';
      }).join(''),
      vazio: { titulo: 'Nenhum cupom usado', texto: 'Nenhum pedido do período usou cupom de desconto.', icone: 'tag' }
    });

    var status = d.pedidosPorStatus || {};
    var mapaStatus = [
      ['pago', 'Pagos', 'ok'],
      ['pendente', 'Pendentes', 'aviso'],
      ['cancelado', 'Cancelados', 'neutro'],
      ['reembolsado', 'Reembolsados', 'erro']
    ];
    qs('#r-status').innerHTML = '<div class="adm-detalhe">' + mapaStatus.map(function (par) {
      return '<div class="adm-detalhe__linha"><span class="adm-detalhe__rotulo">' + UI.selo(par[2], par[1]) + '</span>' +
        '<span class="adm-detalhe__valor">' + UI.numero(status[par[0]] || 0) + '</span></div>';
    }).join('') + '</div>';

    var alertas = (d.estoque && d.estoque.alertas) || [];
    qs('#r-estoque').innerHTML = alertas.length
      ? UI.tabela({
          colunas: [{ rotulo: 'Produto' }, { rotulo: 'Plano' }, { rotulo: 'Disponível', classe: 'adm-num' }, { rotulo: 'Mínimo', classe: 'adm-num' }, { rotulo: 'Situação' }],
          corpo: alertas.map(function (item) {
            return '<tr><td>' + esc(item.produto) + '</td><td>' + esc(item.plano) + '</td>' +
              '<td class="adm-num">' + UI.numero(item.disponivel) + '</td>' +
              '<td class="adm-num">' + UI.numero(item.minimo) + '</td>' +
              '<td>' + (item.esgotado ? UI.selo('erro', 'Esgotado') : UI.selo('aviso', 'Baixo')) + '</td></tr>';
          }).join('')
        })
      : UI.estado({ titulo: 'Estoque saudável', texto: 'Nenhum plano precisa de reposição no momento.', icone: 'escudo' });
  }

  /* ===========================================================================
   * VIEW: FINANCEIRO
   *
   * O dinheiro da loja — não o desempenho dela (isso é Relatórios, que olha só
   * os pedidos pagos). Aqui a pergunta é "onde está o dinheiro":
   *
   *   RECEBIDO  = pedidos pagos no período;
   *   A RECEBER = pendentes (boleto que ainda não compensou);
   *   DEVOLVIDO = reembolsados;
   *   CANCELADO = nunca chegaram a virar dinheiro.
   * ========================================================================= */

  var estadoFinanceiro = { periodo: 30, desde: '', ate: '', status: '', pagina: 1, limite: 25, total: 0 };

  /** Query string do período atual — as duas chamadas do Financeiro usam a mesma. */
  function urlFinanceiro() {
    return (estadoFinanceiro.desde && estadoFinanceiro.ate)
      ? '?desde=' + encodeURIComponent(estadoFinanceiro.desde) + '&ate=' + encodeURIComponent(estadoFinanceiro.ate)
      : '?periodo=' + estadoFinanceiro.periodo;
  }

  function viewFinanceiro() {
    var token = novoToken();
    registrarAcoes({
      'periodo-financeiro': function (el) {
        estadoFinanceiro.periodo = Number(el.value) || 30;
        estadoFinanceiro.desde = '';
        estadoFinanceiro.ate = '';
        estadoFinanceiro.pagina = 1;
        viewFinanceiro();
      },
      'aplicar-intervalo-financeiro': function () {
        var de = qs('#fin-desde');
        var ate = qs('#fin-ate');
        estadoFinanceiro.desde = de ? de.value : '';
        estadoFinanceiro.ate = ate ? ate.value : '';
        if (!estadoFinanceiro.desde || !estadoFinanceiro.ate) {
          Api.toast('Informe a data inicial e a final', 'error');
          return;
        }
        estadoFinanceiro.pagina = 1;
        viewFinanceiro();
      },
      'limpar-intervalo-financeiro': function () {
        estadoFinanceiro.desde = '';
        estadoFinanceiro.ate = '';
        estadoFinanceiro.pagina = 1;
        viewFinanceiro();
      },
      'filtrar-status-financeiro': function (el) {
        estadoFinanceiro.status = el.value;
        estadoFinanceiro.pagina = 1;
        desenharExtratoFinanceiro();
      },
      // A paginação do UI.paginacaoHtml sempre dispara "pagina".
      'pagina': function (el) {
        estadoFinanceiro.pagina = Number(el.getAttribute('data-pagina')) || 1;
        desenharExtratoFinanceiro();
      },
      'abrir-pedido': function (el) { abrirPedido(el.getAttribute('data-id')); }
    });

    var usandoIntervalo = !!(estadoFinanceiro.desde && estadoFinanceiro.ate);

    pintar(
      '<div class="adm-barra">' +
        '<select class="adm-select" data-mudanca="periodo-financeiro" aria-label="Período do financeiro"' + (usandoIntervalo ? ' disabled' : '') + '>' +
          opcoesSelect([
            { valor: '7', rotulo: 'Últimos 7 dias' },
            { valor: '30', rotulo: 'Últimos 30 dias' },
            { valor: '90', rotulo: 'Últimos 90 dias' },
            { valor: '365', rotulo: 'Últimos 12 meses' }
          ], String(estadoFinanceiro.periodo)) +
        '</select>' +
        '<span class="adm-barra__sep">ou</span>' +
        '<input class="field__input adm-barra__data" type="date" id="fin-desde" value="' + esc(estadoFinanceiro.desde) + '" aria-label="Data inicial">' +
        '<input class="field__input adm-barra__data" type="date" id="fin-ate" value="' + esc(estadoFinanceiro.ate) + '" aria-label="Data final">' +
        '<button class="btn btn--soft btn--sm" type="button" data-acao="aplicar-intervalo-financeiro">Aplicar</button>' +
        (usandoIntervalo ? '<button class="btn btn--ghost btn--sm" type="button" data-acao="limpar-intervalo-financeiro">Limpar</button>' : '') +
      '</div>' +
      '<div class="adm-kpis" id="f-kpis">' +
        kpi('Recebido', '…', '', 'dinheiro') +
        kpi('A receber', '…', '', 'relogio') +
        kpi('Ticket médio', '…', '', 'cartao') +
        kpi('Devolvido', '…', '', 'atualizar') +
        kpi('Cancelado', '…', '', 'x') +
        kpi('Descontos', '…', '', 'tag') +
      '</div>' +
      '<div class="adm-grade adm-grade--2">' +
        cartao('Por forma de pagamento', 'Quanto entrou em Pix, cartão e boleto', '<div id="f-formas">' + UI.esqueletoLinhas(4) + '</div>') +
        cartao('Por provedor', 'Por qual gateway o dinheiro passou', '<div id="f-provedores">' + UI.esqueletoLinhas(4) + '</div>') +
      '</div>' +
      cartao('Pagamentos', 'O que entrou, o que está pendente e o que foi devolvido', '<div id="f-extrato">' + UI.esqueletoLinhas(6) + '</div>', {
        semPad: true,
        acoes: '<select class="adm-select" data-mudanca="filtrar-status-financeiro" aria-label="Filtrar por situação">' +
          opcoesSelect([
            { valor: '', rotulo: 'Todos os status' },
            { valor: 'pago', rotulo: 'Recebidos' },
            { valor: 'pendente', rotulo: 'A receber' },
            { valor: 'reembolsado', rotulo: 'Devolvidos' },
            { valor: 'cancelado', rotulo: 'Cancelados' }
          ], estadoFinanceiro.status) + '</select>'
      })
    );

    pedir('GET', '/api/admin/financeiro' + urlFinanceiro()).then(function (r) {
      if (!aindaValido(token)) return;
      if (!r.ok) {
        pintar(UI.estado({ tipo: 'erro', titulo: 'Não foi possível carregar o financeiro', texto: erroDe(r), icone: 'aviso' }));
        return;
      }

      desenharFinanceiro(r.data);
      desenharExtratoFinanceiro();
    });
  }

  function desenharFinanceiro(d) {
    var res = d.resumo || {};
    var comp = d.comparativo || {};

    if (d.janela && d.janela.rotulo) qs('#sub-view').textContent = d.janela.rotulo;

    var recebido = res.recebido || {};
    var aReceber = res.aReceber || {};
    var reembolsado = res.reembolsado || {};
    var cancelado = res.cancelado || {};

    qs('#f-kpis').innerHTML =
      kpi('Recebido', UI.dinheiro(recebido.valor || 0),
        variacaoHtml(comp.variacaoRecebido) + ' vs. anterior · ' + UI.numero(recebido.pedidos || 0) + ' pedido(s)', 'dinheiro') +
      kpi('A receber', UI.dinheiro(aReceber.valor || 0),
        (aReceber.pedidos || 0) ? UI.numero(aReceber.pedidos) + ' pedido(s) aguardando' : 'nada pendente', 'relogio') +
      kpi('Ticket médio', UI.dinheiro(res.ticketMedio || 0), 'por pedido recebido', 'cartao') +
      kpi('Devolvido', UI.dinheiro(reembolsado.valor || 0),
        (reembolsado.pedidos || 0) ? UI.numero(reembolsado.pedidos) + ' reembolso(s)' : 'nenhum reembolso', 'atualizar') +
      kpi('Cancelado', UI.dinheiro(cancelado.valor || 0),
        (cancelado.pedidos || 0) ? UI.numero(cancelado.pedidos) + ' pedido(s)' : 'nada cancelado', 'x') +
      kpi('Descontos', UI.dinheiro(res.descontos || 0), 'concedidos em cupons', 'tag');

    var vazioFormas = { titulo: 'Nada recebido no período', texto: 'Nenhum pagamento foi confirmado nesta janela de tempo.', icone: 'dinheiro' };

    qs('#f-formas').innerHTML = barrasParticipacao((d.porForma || []).map(function (item) {
      return {
        rotulo: item.nome,
        valor: item.valorCentavos || 0,
        valorTexto: UI.dinheiro(item.valor || 0),
        meta: UI.numero(item.pedidos) + ' pedido(s) · ' + String(item.participacao).replace('.', ',') + '% do recebido'
      };
    }), { vazio: vazioFormas });

    qs('#f-provedores').innerHTML = barrasParticipacao((d.porProvedor || []).map(function (item) {
      return {
        rotulo: item.nome,
        valor: item.valorCentavos || 0,
        valorTexto: UI.dinheiro(item.valor || 0),
        meta: UI.numero(item.pedidos) + ' pedido(s) · ' + String(item.participacao).replace('.', ',') + '% do recebido'
      };
    }), { vazio: vazioFormas });
  }

  /** Extrato de pagamentos — recarrega sozinho ao paginar ou trocar o filtro. */
  function desenharExtratoFinanceiro() {
    var alvo = qs('#f-extrato');
    if (!alvo) return;

    var token = novoToken();
    alvo.innerHTML = UI.esqueletoLinhas(6);

    var url = '/api/admin/financeiro/pagamentos' + urlFinanceiro() +
      '&limite=' + estadoFinanceiro.limite +
      '&pagina=' + estadoFinanceiro.pagina +
      (estadoFinanceiro.status ? '&status=' + encodeURIComponent(estadoFinanceiro.status) : '');

    pedir('GET', url).then(function (r) {
      if (!aindaValido(token) || !qs('#f-extrato')) return;

      if (!r.ok) {
        alvo.innerHTML = UI.estado({ tipo: 'erro', titulo: 'Erro ao carregar os pagamentos', texto: erroDe(r), icone: 'aviso' });
        return;
      }

      var lista = (r.data && r.data.pagamentos) || [];
      estadoFinanceiro.total = (r.data && r.data.total) || 0;
      var paginas = Math.max(Math.ceil(estadoFinanceiro.total / estadoFinanceiro.limite), 1);

      alvo.innerHTML = UI.tabela({
        colunas: [
          { rotulo: 'Pedido' }, { rotulo: 'Cliente' }, { rotulo: 'Situação' },
          { rotulo: 'Forma' }, { rotulo: 'Provedor' }, { rotulo: 'Valor', classe: 'adm-num' },
          { rotulo: 'Quando' }, { rotulo: '', classe: 'adm-acoes' }
        ],
        corpo: lista.map(function (item) {
          var cliente = item.cliente || {};
          return '<tr>' +
            '<td class="adm-mono">' + esc(item.numero) + '</td>' +
            '<td><span class="adm-tabela__principal">' + esc(cliente.nome || '—') + '</span>' +
              '<span class="adm-tabela__sub">' + esc(cliente.email || '') + '</span></td>' +
            '<td>' + UI.seloVenda(item.status) + '</td>' +
            '<td>' + esc(item.metodoNome || '—') + '</td>' +
            '<td>' + esc(item.provedorNome || '—') + '</td>' +
            '<td class="adm-num">' + UI.dinheiro(item.total || 0) +
              (item.desconto ? '<span class="adm-tabela__sub">-' + UI.dinheiro(item.desconto) + '</span>' : '') + '</td>' +
            '<td>' + dataAttrData(item.pagoEm || item.criadoEm) + '</td>' +
            '<td class="adm-acoes"><button class="btn btn--soft btn--sm" type="button" data-acao="abrir-pedido" data-id="' + esc(item.id) + '">' +
              UI.icone('olho') + 'Detalhes</button></td>' +
          '</tr>';
        }).join(''),
        vazio: {
          titulo: 'Nenhum pagamento no período',
          texto: 'Ajuste o período ou a situação para ver outros pagamentos.',
          icone: 'dinheiro'
        }
      }) + (lista.length ? UI.paginacaoHtml({ pagina: estadoFinanceiro.pagina, paginas: paginas, total: estadoFinanceiro.total }) : '');
    });
  }

  /* ===========================================================================
   * VIEW: DIAGNÓSTICO
   * ========================================================================= */

  function viewDiagnostico() {
    var token = novoToken();
    registrarAcoes({});

    pintar('<div id="c-diag">' + UI.esqueletoLinhas(8) + '</div>');

    pedir('GET', '/api/admin/diagnostico').then(function (r) {
      if (!aindaValido(token)) return;
      if (!r.ok) { qs('#c-diag').innerHTML = UI.estado({ tipo: 'erro', titulo: 'Erro ao carregar diagnóstico', texto: erroDe(r), icone: 'aviso' }); return; }

      var d = r.data;
      var app = d.aplicacao || {};
      var banco = d.banco || {};
      var cont = d.contadores || {};
      var cfg = d.configuracao || {};

      function linhas(pares) {
        return pares.map(function (par) {
          return '<div class="adm-detalhe__linha"><span class="adm-detalhe__rotulo">' + esc(par[0]) + '</span>' +
            '<span class="adm-detalhe__valor">' + par[1] + '</span></div>';
        }).join('');
      }

      var migracoes = Array.isArray(banco.migracoes)
        ? UI.numero(banco.migracoes.length) + ' aplicada(s)'
        : esc(String(banco.migracoes || '—'));

      var segundos = Number(app.uptimeSegundos) || 0;
      var uptime = Math.floor(segundos / 3600) + 'h ' + Math.floor((segundos % 3600) / 60) + 'min';

      qs('#c-diag').innerHTML =
        '<div class="adm-grade adm-grade--2">' +
          cartao('Aplicação', 'Processo em execução', linhas([
            ['Nome', esc(app.nome || '—')],
            ['Versão', esc(app.versao || '—')],
            ['Ambiente', esc(app.ambiente || '—')],
            ['Node', esc(app.node || '—')],
            ['Uptime', esc(uptime)],
            ['Memória (RSS)', UI.numero((app.memoriaMB && app.memoriaMB.rss) || 0) + ' MB'],
            ['Heap usada', UI.numero((app.memoriaMB && app.memoriaMB.heapUsada) || 0) + ' MB'],
            ['CPUs', UI.numero((app.sistema && app.sistema.cpus) || 0)]
          ])) +
          cartao('Banco de dados', 'SQLite', linhas([
            ['Arquivo', '<span class="adm-mono">' + esc(banco.arquivo || '—') + '</span>'],
            ['Migrações', migracoes],
            ['Integridade', banco.integridade === 'ok'
              ? UI.selo('ok', 'ok')
              : UI.selo('erro', String(banco.integridade || '—'))]
          ])) +
          cartao('Contadores', 'Registros atuais', linhas([
            ['Produtos', UI.numero(cont.produtos) + ' (' + UI.numero(cont.produtosAtivos) + ' ativos)'],
            ['Usuários', UI.numero(cont.usuarios)],
            ['Pedidos', UI.numero(cont.pedidos) + ' (' + UI.numero(cont.pedidosPendentes) + ' pendentes)'],
            ['Licenças', esc(JSON.stringify(cont.licencas || {}))]
          ])) +
          cartao('Pagamento e ambiente', 'Configuração atual', linhas([
            ['Provedor', esc(cfg.provedorPagamento || '—')],
            ['Forma padrão', esc(cfg.metodoPadrao || '—')],
            ['No checkout', esc(cfg.metodoNoCheckout || '—')],
            ['Formas na vitrine', (cfg.formasDisponiveis && cfg.formasDisponiveis.length) ? esc(cfg.formasDisponiveis.join(', ')) : 'nenhuma'],
            ['Nível de log', esc(cfg.nivelLog || '—')],
            ['Trust proxy', cfg.trustProxy === false || cfg.trustProxy == null ? 'não' : esc(String(cfg.trustProxy))],
            ['CORS extra', (cfg.origemExtraCors && cfg.origemExtraCors.length) ? esc(cfg.origemExtraCors.join(', ')) : 'nenhum']
          ])) +
        '</div>' +
        '<div class="adm-grade adm-grade--2">' +
          cartao('Receita', 'Somente pedidos pagos', linhas([
            ['Receita', UI.dinheiro((d.financeiro && d.financeiro.receita) || 0)],
            ['Ticket médio', UI.dinheiro((d.financeiro && d.financeiro.ticketMedio) || 0)]
          ])) +
          cartao('Licenças por status', 'Situação das chaves', linhas(
            Object.keys(cont.licencas || {}).length
              ? Object.keys(cont.licencas).map(function (k) { return [k, UI.numero(cont.licencas[k])]; })
              : [['Nenhuma licença', '—']]
          )) +
        '</div>';
    });
  }

  /* ===========================================================================
   * VIEW: INDICADORES
   * ========================================================================= */

  var ROTULO_STATUS_LICENCA = {
    ativa: 'Ativa',
    resgatada: 'Resgatada',
    revogada: 'Revogada',
    expirada: 'Expirada'
  };

  function somarMapa(mapa) {
    var total = 0;
    Object.keys(mapa || {}).forEach(function (chave) { total += Number(mapa[chave]) || 0; });
    return total;
  }

  function viewIndicadores() {
    var token = novoToken();
    registrarAcoes({
      'ir-produtos': function () { window.location.hash = '#/produtos'; },
      'ir-pedidos': function () { window.location.hash = '#/pedidos'; },
      'ir-licencas': function () { window.location.hash = '#/licencas'; }
    });

    pintar(
      '<div class="adm-kpis" id="i-kpis">' +
        kpi('Receita', '…', '', 'dinheiro') +
        kpi('Pedidos pagos', '…', '', 'pacote') +
        kpi('Ticket médio', '…', '', 'cartao') +
        kpi('Descontos', '…', '', 'cifrao') +
        kpi('Licenças emitidas', '…', '', 'chave') +
        kpi('Favoritos', '…', '', 'coracao') +
      '</div>' +
      '<div class="adm-grade adm-grade--2">' +
        cartao('Produtos mais desejados', 'Quantas vezes foram favoritados', '<div id="i-desejo">' + UI.esqueletoLinhas(5) + '</div>', { semPad: true }) +
        cartao('Produtos mais vendidos', 'Por unidades pagas', '<div id="i-top">' + UI.esqueletoLinhas(5) + '</div>', { semPad: true }) +
      '</div>' +
      '<div class="adm-grade adm-grade--2">' +
        cartao('Licenças por status', 'Situação das chaves emitidas', '<div id="i-licencas">' + UI.esqueletoLinhas(4) + '</div>') +
        cartao('Receita por dia', 'Últimos 30 dias', '<div id="i-grafico">' + UI.esqueletoLinhas(4) + '</div>') +
      '</div>'
    );

    // Duas fontes: /indicadores traz favoritos e licenças; /painel traz o
    // financeiro, os mais vendidos e a série de receita. Esperamos as duas.
    Promise.all([
      pedir('GET', '/api/admin/indicadores'),
      pedir('GET', '/api/admin/painel?dias=30')
    ]).then(function (respostas) {
      if (!aindaValido(token)) return;

      var indicadores = respostas[0];
      var painel = respostas[1];

      if (!indicadores.ok) {
        qs('#i-desejo').innerHTML = UI.estado({ tipo: 'erro', titulo: 'Erro ao carregar indicadores', texto: erroDe(indicadores), icone: 'aviso' });
        return;
      }

      if (painel.ok) {
        var d = painel.data || {};
        var fin = d.financeiro || {};
        estadoIndicadores.receita = fin.receita || 0;
        estadoIndicadores.pedidosPagos = fin.pedidos || 0;
        estadoIndicadores.ticketMedio = fin.ticketMedio || 0;
        estadoIndicadores.descontos = fin.descontos || 0;
        estadoIndicadores.topProdutos = d.topProdutos || [];
        estadoIndicadores.receitaPorDia = d.receitaPorDia || [];
      }

      desenharIndicadores(indicadores.data || {});
    });
  }

  function desenharIndicadores(d) {
    var licencas = d.licencas || {};
    var favoritos = d.favoritosPorProduto || [];

    qs('#i-kpis').innerHTML =
      kpi('Receita', UI.dinheiro(estadoIndicadores.receita), 'em pedidos pagos', 'dinheiro') +
      kpi('Pedidos pagos', UI.numero(estadoIndicadores.pedidosPagos), 'confirmados', 'pacote') +
      kpi('Ticket médio', UI.dinheiro(estadoIndicadores.ticketMedio), 'por pedido pago', 'cartao') +
      kpi('Descontos', UI.dinheiro(estadoIndicadores.descontos), 'concedidos por cupom', 'cifrao') +
      kpi('Licenças emitidas', UI.numero(somarMapa(licencas)), UI.numero(licencas.ativa || 0) + ' ainda ativa(s)', 'chave') +
      kpi('Favoritos', UI.numero(favoritos.reduce(function (soma, item) { return soma + (Number(item.favoritos) || 0); }, 0)),
        favoritos.length ? 'em ' + UI.numero(favoritos.length) + ' produto(s)' : 'nenhum ainda', 'coracao');

    /* Produtos mais desejados ---------------------------------------------- */
    qs('#i-desejo').innerHTML = favoritos.length
      ? '<div class="adm-lista">' + favoritos.map(function (item, indice) {
          return '<div class="adm-lista__item">' +
            '<span class="adm-rank">' + (indice + 1) + '</span>' +
            '<span class="adm-lista__txt">' +
              '<span class="adm-lista__nome">' + esc(item.nome) + '</span>' +
              '<span class="adm-lista__meta">' + UI.numero(item.favoritos) + ' favorito(s)</span>' +
            '</span>' +
            UI.icone('coracao', 'adm-lista__icone') +
          '</div>';
        }).join('') + '</div>'
      : UI.estado({ titulo: 'Nenhum favorito ainda', texto: 'Quando os clientes favoritarem produtos, o ranking aparece aqui.', icone: 'coracao' });

    /* Produtos mais vendidos ------------------------------------------------ */
    var top = estadoIndicadores.topProdutos || [];
    qs('#i-top').innerHTML = top.length
      ? '<div class="adm-lista">' + top.map(function (item, indice) {
          return '<div class="adm-lista__item">' +
            '<span class="adm-rank">' + (indice + 1) + '</span>' +
            '<span class="adm-lista__txt">' +
              '<span class="adm-lista__nome">' + esc(item.nome) + '</span>' +
              '<span class="adm-lista__meta">' + UI.numero(item.unidades) + ' unidade(s)</span>' +
            '</span>' +
            '<span class="adm-lista__valor">' + UI.dinheiro(item.receita || 0) + '</span>' +
          '</div>';
        }).join('') + '</div>'
      : UI.estado({ titulo: 'Sem vendas ainda', texto: 'Os produtos mais vendidos aparecem aqui.', icone: 'trofeu' });

    /* Licenças por status --------------------------------------------------- */
    var chavesLicenca = Object.keys(licencas);
    var totalLicencas = somarMapa(licencas);
    qs('#i-licencas').innerHTML = (chavesLicenca.length && totalLicencas)
      ? chavesLicenca.map(function (chave) {
          var valor = Number(licencas[chave]) || 0;
          var pct = totalLicencas ? Math.round((valor / totalLicencas) * 100) : 0;
          return '<div class="adm-barra-status">' +
            '<div class="adm-barra-status__topo">' +
              '<span>' + esc(ROTULO_STATUS_LICENCA[chave] || chave) + '</span>' +
              '<span class="adm-barra-status__valor">' + UI.numero(valor) +
                ' <span class="adm-barra-status__pct">' + pct + '%</span></span>' +
            '</div>' +
            '<div class="adm-barra-status__trilha">' +
              '<div class="adm-barra-status__preenche" style="width:' + pct + '%"></div>' +
            '</div>' +
          '</div>';
        }).join('')
      : UI.estado({ titulo: 'Nenhuma licença emitida', texto: 'As chaves aparecem aqui assim que houver vendas pagas.', icone: 'cadeado' });

    /* Receita por dia -------------------------------------------------------- */
    var serie = (estadoIndicadores.receitaPorDia || []).map(function (item) {
      return { dia: item.dia, valor: (item.receitaCentavos || 0) / 100 };
    });
    qs('#i-grafico').innerHTML = UI.grafico(serie, {
      formatarEixo: moedaCompacta,
      formatarValor: function (v) { return UI.dinheiro(v); }
    });
  }

  /* ===========================================================================
   * VIEW: GATEWAYS
   *
   * Nomenclatura desta aba (para não confundir os três conceitos):
   *   - GATEWAY            = o provedor que cobra (Mercado Pago, simulador…);
   *   - FORMA DE PAGAMENTO = Pix, cartão ou boleto (o que o cliente escolhe);
   *   - NOTIFICAÇÃO        = o webhook que o provedor envia (pagamento recebido).
   * Os PAGAMENTOS em si (pedidos e o que foi recebido) ficam em Pedidos.
   * ========================================================================= */

  var estadoGateways = {
    formas: {},
    // id do provedor -> nome, para a tabela de notificações não mostrar o slug.
    nomes: {},
    // Forma escolhida pelo admin como padrão do checkout (pode estar indisponível).
    padrao: '',
    // Forma que o checkout realmente usará: a padrão se estiver disponível,
    // senão a primeira que algum provedor ligado aceita (cai do servidor).
    padraoEfetivo: '',
    eventos: { pagina: 1, limite: 25, total: 0, gateway: '' }
  };

  // Guarda o que veio do /painel para as KPIs da aba Indicadores.
  var estadoIndicadores = {
    receita: 0, pedidosPagos: 0, ticketMedio: 0, descontos: 0,
    topProdutos: [], receitaPorDia: []
  };

  function urlWebhook(id) {
    return window.location.origin + '/api/pagamentos/webhook/' + id;
  }

  function seloModo(modo) {
    return String(modo) === 'producao' ? UI.selo('ok', 'Produção') : UI.selo('info', 'Sandbox');
  }

  // Distingue "vai cobrar de verdade" de "vai simular".
  function seloOperacao(g) {
    if (g.somenteSimulacao) return UI.selo('info', 'Simulador');
    return g.credenciaisCompletas ? UI.selo('ok', 'Operação real') : UI.selo('aviso', 'Em demonstração');
  }

  function metaForma(id) {
    return estadoGateways.formas[id] || { id: id, nome: id, descricao: '', icone: 'cifrao', imediato: false };
  }

  function linhaForma(id, marcada) {
    var meta = metaForma(id);
    return '<label class="adm-metodo' + (marcada ? ' is-ativo' : '') + '">' +
      '<input type="checkbox" name="metodos" value="' + esc(id) + '"' + (marcada ? ' checked' : '') + '>' +
      '<span class="adm-metodo__marca">' + UI.icone('check') + '</span>' +
      '<span class="adm-metodo__icone">' + UI.icone(meta.icone) + '</span>' +
      '<span class="adm-metodo__txt">' +
        '<span class="adm-metodo__nome">' + esc(meta.nome) + '</span>' +
        '<span class="adm-metodo__desc">' + esc(meta.descricao || '') + '</span>' +
      '</span>' +
    '</label>';
  }

  function campoCredencial(g, campo) {
    var info = (g.credenciais && g.credenciais[campo.chave]) || { preenchido: false, valor: '' };
    var segredo = !!campo.segredo;

    // Segredo ja salvo: o campo fica vazio com a mascara no placeholder. Deixar
    // em branco MANTEM o valor atual (o servidor so troca o que vier preenchido).
    var valor = segredo ? '' : (info.valor || '');
    var dica = info.preenchido ? info.valor : (campo.exemplo || 'Não configurado');

    return '<div class="field" data-campo="' + esc(campo.chave) + '">' +
      '<label class="field__label">' + esc(campo.rotulo) +
        (campo.obrigatorio ? '' : '<span class="adm-campo__opcional">opcional</span>') +
      '</label>' +
      '<div class="adm-credencial">' +
        '<input class="field__input" type="' + (segredo ? 'password' : 'text') + '"' +
          ' name="cred:' + esc(campo.chave) + '" value="' + esc(valor) + '"' +
          ' placeholder="' + esc(dica) + '" data-mascara="' + esc(dica) + '"' +
          ' autocomplete="off" spellcheck="false">' +
        (info.preenchido
          ? '<button class="icon-btn adm-credencial__limpar" type="button" data-acao="gw-limpar-campo"' +
            ' title="Remover esta credencial" aria-label="Remover ' + esc(campo.rotulo) + '">' + UI.icone('lixeira') + '</button>'
          : '') +
      '</div>' +
      (campo.dica ? '<span class="adm-campo__dica">' + esc(campo.dica) + '</span>' : '') +
    '</div>';
  }

  function cartaoGateway(g) {
    var corpo = '';

    if (g.somenteSimulacao) {
      corpo += aviso('info', 'O simulador interno aprova Pix e cartão na hora e deixa o boleto pendente. Não faz chamada externa e nunca sai do modo demonstração — é ele que mantém a loja vendendo antes de você configurar um provedor real.');
    } else if (!g.credenciaisCompletas) {
      corpo += aviso('aviso', 'Faltam credenciais obrigatórias: ' + g.faltando.join(', ') + '. Enquanto isso, este provedor opera em demonstração — nenhuma cobrança real é feita.');
    } else {
      corpo += aviso('ok', 'Credenciais completas. Este provedor está pronto para cobrar de verdade.');
    }

    /* Ligar / desligar ------------------------------------------------------ */
    corpo += '<label class="adm-interruptor">' +
      '<span class="adm-interruptor__txt">' +
        '<span class="adm-interruptor__titulo">Usar este provedor</span>' +
        '<span class="adm-interruptor__dica">Quando ligado, ele disputa as formas de pagamento marcadas abaixo conforme a prioridade.</span>' +
      '</span>' +
      '<span class="adm-switch">' +
        '<input type="checkbox" name="ativo"' + (g.ativo ? ' checked' : '') + '>' +
        '<span class="adm-switch__trilha"></span>' +
      '</span>' +
    '</label>';

    /* Ambiente e prioridade ------------------------------------------------ */
    corpo += '<div class="adm-form-grade">' +
      '<div class="field"><label class="field__label">Ambiente</label>' +
        '<select class="adm-select" name="modo">' + opcoesSelect([
          { valor: 'sandbox', rotulo: 'Sandbox (testes)' },
          { valor: 'producao', rotulo: 'Produção (cobrança real)' }
        ], g.modo) + '</select>' +
        '<span class="adm-campo__dica">Trocar para produção exige todas as credenciais obrigatórias.</span></div>' +
      '<div class="field"><label class="field__label">Prioridade</label>' +
        '<input class="field__input" name="prioridade" type="number" min="0" max="999" value="' +
          esc(String(g.prioridade === undefined || g.prioridade === null ? 0 : g.prioridade)) + '">' +
        '<span class="adm-campo__dica">Maior prioridade cobra primeiro quando dois provedores aceitam a mesma forma.</span></div>' +
    '</div>';

    /* Formas aceitas -------------------------------------------------------- */
    corpo += '<p class="adm-form__rotulo">Formas de pagamento aceitas</p>' +
      '<div class="adm-metodos">' + (g.metodosSuportados || []).map(function (id) {
        return linhaForma(id, (g.metodos || []).indexOf(id) !== -1);
      }).join('') + '</div>';

    /* Credenciais e webhook ------------------------------------------------ */
    if (!g.somenteSimulacao) {
      var url = urlWebhook(g.id);

      corpo += '<p class="adm-form__rotulo">Credenciais</p>' +
        '<div class="adm-form-grade">' + (g.campos || []).map(function (c) {
          return campoCredencial(g, c);
        }).join('') + '</div>' +
        '<div class="adm-webhook">' +
          '<div class="adm-webhook__cab">' +
            '<span class="adm-webhook__rotulo">' + UI.icone('plugue') + 'URL de webhook</span>' +
            '<span class="adm-webhook__dica">Cole esta URL no painel do provedor para receber a confirmação dos pagamentos.</span>' +
          '</div>' +
          '<div class="adm-webhook__linha">' +
            '<code class="adm-webhook__url">' + esc(url) + '</code>' +
            '<button class="btn btn--soft btn--sm" type="button" data-acao="gw-copiar" data-copiar="' + esc(url) + '">' +
              UI.icone('copiar') + 'Copiar</button>' +
          '</div>' +
        '</div>';
    }

    /* Resultado do último teste -------------------------------------------- */
    corpo += '<div id="gw-resultado-' + esc(g.id) + '"></div>';

    var acoes =
      '<button class="btn btn--soft btn--sm" type="button" data-acao="gw-testar" data-gateway="' + esc(g.id) + '">' +
        UI.icone('atividade') + 'Testar</button>' +
      '<button class="btn btn--primary btn--sm" type="button" data-acao="gw-salvar" data-gateway="' + esc(g.id) + '">' +
        UI.icone('check') + 'Salvar</button>';

    var titulo = g.nome + (g.ativo ? '' : ' (desligado)');

    return '<section class="adm-cartao adm-gateway' + (g.ativo ? '' : ' is-desligado') + '"' +
        ' data-gateway-card="' + esc(g.id) + '" style="--gw-cor:' + esc(g.cor || '#5B7CFA') + '">' +
      '<div class="adm-cartao__cab">' +
        '<div>' +
          '<p class="adm-cartao__titulo">' +
            '<span class="adm-gateway__ponto"></span>' + esc(titulo) + '</p>' +
          '<p class="adm-cartao__dica">' + esc(g.descricao || '') + '</p>' +
        '</div>' +
        '<div class="adm-cartao__acoes">' + acoes + '</div>' +
      '</div>' +
      '<div class="adm-gateway__selos">' +
        (g.ativo ? UI.selo('ok', 'Ativo') : UI.selo('neutro', 'Desligado')) +
        seloModo(g.modo) +
        seloOperacao(g) +
        UI.selo('neutro', 'Prioridade ' + UI.numero(g.prioridade || 0)) +
        (g.site ? '<a class="adm-gateway__link" href="' + esc(g.site) + '" target="_blank" rel="noopener noreferrer">Site' + UI.icone('seta') + '</a>' : '') +
        (g.docs ? '<a class="adm-gateway__link" href="' + esc(g.docs) + '" target="_blank" rel="noopener noreferrer">Documentação' + UI.icone('seta') + '</a>' : '') +
      '</div>' +
      '<div class="adm-cartao__corpo">' + corpo + '</div>' +
    '</section>';
  }

  function viewGateways() {
    var token = novoToken();
    registrarAcoes({
      'gw-salvar': function (el) { salvarGateway(el.getAttribute('data-gateway')); },
      'gw-testar': function (el) { testarGateway(el.getAttribute('data-gateway')); },
      'gw-limpar-campo': function (el) { alternarLimpezaCampo(el); },
      'gw-copiar': function (el) { UI.copiar(el.getAttribute('data-copiar')); },
      'gw-definir-padrao': function (el) { definirMetodoPadrao(el.value); },
      'gw-filtrar-eventos': function (el) {
        estadoGateways.eventos.gateway = el.value;
        estadoGateways.eventos.pagina = 1;
        desenharEventos();
      },
      'pagina': function (el) {
        estadoGateways.eventos.pagina = Number(el.getAttribute('data-pagina')) || 1;
        desenharEventos();
      }
    });

    pintar(
      '<div id="gw-topo">' + UI.esqueletoLinhas(3) + '</div>' +
      cartao('Formas de pagamento', 'Qual aparece no checkout e qual provedor atende cada uma',
        '<div id="gw-padrao">' + UI.esqueletoLinhas(1) + '</div>' +
        '<div id="gw-disponiveis">' + UI.esqueletoLinhas(3) + '</div>') +
      '<div id="gw-gateways">' + UI.esqueletoLinhas(6) + '</div>' +
      cartao('Notificações recebidas', 'Todo webhook que chegou, válido ou não', '<div id="gw-eventos">' + UI.esqueletoLinhas(5) + '</div>', {
        semPad: true,
        acoes: '<select class="adm-select" data-mudanca="gw-filtrar-eventos" aria-label="Filtrar por provedor"><option value="">Todos os provedores</option></select>'
      })
    );

    pedir('GET', '/api/admin/gateways').then(function (r) {
      if (!aindaValido(token)) return;
      if (!r.ok) {
        pintar(UI.estado({ tipo: 'erro', titulo: 'Não foi possível carregar os gateways', texto: erroDe(r), icone: 'aviso' }));
        return;
      }

      var d = r.data || {};
      var gateways = d.gateways || [];

      // Índice das formas (pix/cartão/boleto) para os seletores das fichas.
      estadoGateways.formas = {};
      (d.formas || []).forEach(function (forma) { estadoGateways.formas[forma.id] = forma; });

      // A escolha do admin (preferência) e a que o checkout usará de fato.
      estadoGateways.padrao = d.metodoPadrao || '';
      estadoGateways.padraoEfetivo = (d.disponiveis && d.disponiveis.padrao) || '';

      // Nome legível de cada provedor (a tabela de eventos só recebe o id).
      estadoGateways.nomes = {};
      gateways.forEach(function (g) { estadoGateways.nomes[g.id] = g.nome; });

      desenharTopoGateways(gateways, d.disponiveis || {});
      desenharPadrao(d);
      desenharDisponiveis(d.disponiveis || {});

      qs('#gw-gateways').innerHTML = '<div class="adm-grade adm-grade--2">' +
        gateways.map(cartaoGateway).join('') + '</div>';

      var seletor = qs('[data-mudanca="gw-filtrar-eventos"]');
      if (seletor) {
        seletor.innerHTML = '<option value="">Todos os provedores</option>' + gateways.map(function (g) {
          return '<option value="' + esc(g.id) + '"' + (estadoGateways.eventos.gateway === g.id ? ' selected' : '') + '>' +
            esc(g.nome) + '</option>';
        }).join('');
      }

      desenharEventos();
    });
  }

  function desenharTopoGateways(gateways, disponiveis) {
    var ligados = gateways.filter(function (g) { return g.ativo; });
    var reais = gateways.filter(function (g) { return g.ativo && !g.somenteSimulacao && g.credenciaisCompletas; });
    var emProducao = reais.filter(function (g) { return g.modo === 'producao'; });
    var metodos = (disponiveis && disponiveis.metodos) || [];

    var faixa;

    if (!metodos.length) {
      faixa = '<div class="adm-aviso adm-aviso--erro">' + UI.icone('aviso') +
        '<span>Nenhuma forma de pagamento está disponível: o checkout está bloqueado. Ligue o simulador interno ou configure um provedor.</span></div>';
    } else if (!reais.length) {
      faixa = '<div class="adm-aviso adm-aviso--aviso">' + UI.icone('info') +
        '<span>A loja está vendendo em <strong>modo demonstração</strong>: as compras são aprovadas sem cobrança real. Configure um provedor e mude para produção quando quiser cobrar de verdade.</span></div>';
    } else if (emProducao.length) {
      faixa = '<div class="adm-aviso adm-aviso--ok">' + UI.icone('escudo') +
        '<span>Cobrança real ativa em <strong>' + esc(emProducao.map(function (g) { return g.nome; }).join(', ')) + '</strong>. ' +
        (metodos.length ? 'Formas na vitrine: ' + esc(metodos.map(function (m) { return m.nome; }).join(', ')) + '.' : '') + '</span></div>';
    } else {
      faixa = '<div class="adm-aviso adm-aviso--info">' + UI.icone('info') +
        '<span>Há provedores com credenciais completas, mas todos operando em <strong>sandbox</strong>. Mude o ambiente para produção quando estiver pronto para cobrar.</span></div>';
    }

    qs('#gw-topo').innerHTML =
      '<div class="adm-kpis">' +
        kpi('Provedores ligados', UI.numero(ligados.length), 'de ' + UI.numero(gateways.length) + ' disponíveis', 'plugue') +
        kpi('Prontos para cobrar', UI.numero(reais.length), reais.length ? 'credenciais completas' : 'nenhum configurado', 'escudo') +
        kpi('Em produção', UI.numero(emProducao.length), emProducao.length ? 'cobrança real' : 'somente sandbox', 'raio') +
        kpi('Formas na vitrine', UI.numero(metodos.length), metodos.length ? esc(metodos.map(function (m) { return m.nome; }).join(' · ')) : 'checkout bloqueado', 'cartao') +
      '</div>' +
      faixa;
  }

  /**
   * Seletor da forma de pagamento padrão (a que vem pré-selecionada no
   * checkout). É só uma preferência do admin: se a forma escolhida não tiver
   * provedor ligado, o checkout cai para outra sozinho — o servidor resolve em
   * `escolherMetodo`. Por isso o rodapé avisa quando a escolha e o efetivo
   * divergem, em vez de fingir que a escolha foi aplicada.
   */
  function desenharPadrao(d) {
    var alvo = qs('#gw-padrao');
    if (!alvo) return;

    var formas = d.formas || [];
    if (!formas.length) { alvo.innerHTML = ''; return; }

    var nomes = {};
    formas.forEach(function (f) { nomes[f.id] = f.nome; });

    var comProvedor = {};
    ((d.disponiveis && d.disponiveis.metodos) || []).forEach(function (m) { comProvedor[m.id] = true; });

    var escolhido = estadoGateways.padrao;
    var efetivo = estadoGateways.padraoEfetivo;
    var semProvedor = !!escolhido && !comProvedor[escolhido];

    var opcoes = formas.map(function (f) {
      return '<option value="' + esc(f.id) + '"' + (f.id === escolhido ? ' selected' : '') + '>' +
        esc(f.nome + (comProvedor[f.id] ? '' : ' (sem provedor)')) + '</option>';
    }).join('');

    var nota;
    if (!escolhido) {
      nota = 'Nenhuma forma escolhida: o checkout usa ' + esc(nomes[efetivo] || '—') + '.';
    } else if (semProvedor) {
      nota = esc(nomes[escolhido]) + ' não tem provedor ligado — o checkout vai usar ' +
        esc(nomes[efetivo] || '—') + '. Ligue um provedor que aceite ' + esc(nomes[escolhido]) + '.';
    } else {
      nota = 'No checkout, ' + esc(nomes[escolhido]) + ' já vem selecionado.';
    }

    alvo.innerHTML =
      '<div class="adm-padrao' + (semProvedor ? ' is-alerta' : '') + '">' +
        '<label class="adm-padrao__rotulo" for="gw-metodo-padrao">Forma de pagamento padrão</label>' +
        '<select id="gw-metodo-padrao" class="adm-select" data-mudanca="gw-definir-padrao" aria-label="Forma de pagamento padrão">' +
          opcoes +
        '</select>' +
        '<p class="adm-padrao__nota">' + UI.icone(semProvedor ? 'aviso' : 'info') + '<span>' + nota + '</span></p>' +
      '</div>';
  }

  /** Salva a forma de pagamento padrão escolhida no seletor. */
  function definirMetodoPadrao(metodo) {
    var seletor = qs('#gw-metodo-padrao');
    if (seletor) seletor.disabled = true;

    pedir('PATCH', '/api/admin/gateways/metodo-padrao', { metodo: metodo }).then(function (r) {
      if (seletor) seletor.disabled = false;

      if (!r.ok) {
        Api.toast(erroDe(r), 'error');
        // Desfaz a seleção visual para não mentir sobre o que ficou salvo.
        if (seletor) seletor.value = estadoGateways.padrao;
        return;
      }

      Api.toast(r.data.mensagem || 'Forma de pagamento padrão atualizada', 'success');
      viewGateways();
      carregarSeloGateways();
    });
  }

  function desenharDisponiveis(disponiveis) {
    var alvo = qs('#gw-disponiveis');
    if (!alvo) return;

    var metodos = (disponiveis && disponiveis.metodos) || [];

    if (!metodos.length) {
      alvo.innerHTML = UI.estado({
        tipo: 'erro',
        titulo: 'Nenhuma forma de pagamento ativa',
        texto: 'Marque ao menos uma forma de pagamento em um provedor ligado — ou ligue o simulador interno.',
        icone: 'aviso'
      });
      return;
    }

    var padrao = estadoGateways.padraoEfetivo;

    alvo.innerHTML = '<div class="adm-vitrine">' + metodos.map(function (m) {
      var gw = m.gateway || {};
      var ePadrao = m.id === padrao;
      return '<div class="adm-vitrine__item' + (ePadrao ? ' is-padrao' : '') + '">' +
        '<span class="adm-vitrine__icone">' + UI.icone(m.icone || 'cifrao') + '</span>' +
        '<span class="adm-vitrine__txt">' +
          '<span class="adm-vitrine__nome">' + esc(m.nome) + '</span>' +
          '<span class="adm-vitrine__desc">' + esc(m.descricao || '') + '</span>' +
        '</span>' +
        '<span class="adm-vitrine__meta">' +
          (ePadrao ? UI.selo('ok', 'Padrão no checkout') : '') +
          '<span class="adm-vitrine__gateway">' + esc(gw.nome || '—') +
            (gw.demonstracao ? UI.selo('aviso', 'demo') : UI.selo('ok', gw.modo === 'producao' ? 'produção' : 'sandbox')) +
          '</span>' +
          (m.imediato ? UI.selo('info', 'Imediato') : UI.selo('neutro', 'Compensa em dias úteis')) +
        '</span>' +
      '</div>';
    }).join('') + '</div>';
  }

  /** Liga/desliga a remoção de uma credencial já salva. */
  function alternarLimpezaCampo(botao) {
    var bloco = botao.parentNode ? botao.parentNode.parentNode : null;
    while (bloco && !bloco.getAttribute('data-campo')) bloco = bloco.parentNode;
    if (!bloco) return;

    var input = qs('input', bloco);
    if (!input) return;

    var marcado = input.getAttribute('data-limpar') !== '1';
    input.setAttribute('data-limpar', marcado ? '1' : '0');
    bloco.classList.toggle('is-limpar', marcado);
    botao.classList.toggle('is-ativo', marcado);
    botao.setAttribute('title', marcado ? 'Manter a credencial atual' : 'Remover esta credencial');
    input.placeholder = marcado ? 'Será removida ao salvar' : (input.getAttribute('data-mascara') || '');
    if (!marcado) input.value = '';
  }

  function salvarGateway(id) {
    var card = qs('[data-gateway-card="' + id + '"]');
    if (!card) return;

    // Só envia o que o admin mexeu: campo vazio = mantém o que já está salvo.
    var credenciais = {};
    qsa('[data-campo]', card).forEach(function (bloco) {
      var chave = bloco.getAttribute('data-campo');
      var input = qs('input', bloco);
      if (!chave || !input) return;
      if (input.getAttribute('data-limpar') === '1') { credenciais[chave] = null; return; }
      var valor = String(input.value || '').trim();
      if (valor) credenciais[chave] = valor;
    });

    var caixaAtivo = qs('input[name="ativo"]', card);
    var caixaModo = qs('select[name="modo"]', card);
    var caixaPrioridade = qs('input[name="prioridade"]', card);

    var dados = {
      ativo: !!(caixaAtivo && caixaAtivo.checked),
      modo: (caixaModo && caixaModo.value) || 'sandbox',
      metodos: qsa('input[name="metodos"]:checked', card).map(function (item) { return item.value; }),
      prioridade: Number((caixaPrioridade && caixaPrioridade.value) || 0)
    };

    if (Object.keys(credenciais).length) dados.credenciais = credenciais;

    var botao = qs('[data-acao="gw-salvar"]', card);
    if (botao) { botao.disabled = true; botao.classList.add('is-carregando'); }

    pedir('PATCH', '/api/admin/gateways/' + encodeURIComponent(id), dados).then(function (r) {
      if (botao) { botao.disabled = false; botao.classList.remove('is-carregando'); }
      if (!r.ok) { Api.toast(erroDe(r), 'error'); return; }

      Api.toast(r.data.mensagem || 'Provedor atualizado', 'success');
      viewGateways();
      carregarSeloGateways();
    });
  }

  function testarGateway(id) {
    var botao = qs('[data-gateway-card="' + id + '"] [data-acao="gw-testar"]');
    if (botao) botao.disabled = true;

    var alvo = qs('#gw-resultado-' + id);
    if (alvo) alvo.innerHTML = '<div class="adm-aviso adm-aviso--info">' + UI.icone('relogio') + '<span>Testando…</span></div>';

    pedir('POST', '/api/admin/gateways/' + encodeURIComponent(id) + '/testar').then(function (r) {
      if (botao) botao.disabled = false;
      if (!r.ok) {
        if (alvo) alvo.innerHTML = aviso('erro', erroDe(r));
        return;
      }

      var d = r.data || {};
      var tipo = d.ok === false ? 'erro' : (d.modoEfetivo === 'real' ? 'ok' : 'info');
      if (alvo) alvo.innerHTML = aviso(tipo, d.mensagem || 'Teste concluído.');
      Api.toast(d.ok === false ? 'O teste apontou um problema' : 'Teste concluído', d.ok === false ? 'error' : 'success');
    });
  }

  function desenharEventos() {
    var alvo = qs('#gw-eventos');
    if (!alvo) return;

    var e = estadoGateways.eventos;
    var token = novoToken();

    alvo.innerHTML = UI.esqueletoLinhas(5);

    var url = '/api/admin/gateways/eventos?limite=' + e.limite +
      '&deslocamento=' + ((e.pagina - 1) * e.limite) +
      (e.gateway ? '&gateway=' + encodeURIComponent(e.gateway) : '');

    pedir('GET', url).then(function (r) {
      if (!aindaValido(token) || !qs('#gw-eventos')) return;

      if (!r.ok) {
        alvo.innerHTML = UI.estado({ tipo: 'erro', titulo: 'Erro ao carregar notificações', texto: erroDe(r), icone: 'aviso' });
        return;
      }

      var eventos = (r.data && r.data.eventos) || [];
      e.total = (r.data && r.data.total) || 0;
      var paginas = Math.max(Math.ceil(e.total / e.limite), 1);

      var corpo = eventos.map(function (ev) {
        var nomeGateway = estadoGateways.nomes[ev.gatewayId] || ev.gatewayId;
        return '<tr>' +
          '<td>' + dataAttrData(ev.criadoEm) + '<span class="adm-tabela__sub">' + esc(UI.dataHora(ev.criadoEm)) + '</span></td>' +
          '<td><span class="adm-tabela__principal">' + esc(nomeGateway) + '</span>' +
            '<span class="adm-tabela__sub adm-mono">' + esc(ev.ip || '—') + '</span></td>' +
          '<td>' + (ev.valido ? UI.selo('ok', 'Assinatura válida') : UI.selo('erro', 'Recusada')) +
            (ev.motivo ? '<span class="adm-tabela__sub">' + esc(ev.motivo) + '</span>' : '') + '</td>' +
          '<td><span class="adm-mono">' + esc(ev.referencia || '—') + '</span></td>' +
          '<td>' + esc(ev.status || '—') + '</td>' +
          '<td><span class="adm-mono" title="' + esc(jsonCurto(ev.payload)) + '">' + esc(jsonCurto(ev.payload)) + '</span></td>' +
        '</tr>';
      }).join('');

      alvo.innerHTML = UI.tabela({
        colunas: [
          { rotulo: 'Quando' }, { rotulo: 'Provedor' }, { rotulo: 'Assinatura' },
          { rotulo: 'Pedido' }, { rotulo: 'Status' }, { rotulo: 'Corpo' }
        ],
        corpo: corpo,
        vazio: {
          titulo: 'Nenhuma notificação recebida',
          texto: 'Os webhooks aparecem aqui — inclusive os recusados, que ficam registrados para auditoria.',
          icone: 'plugue'
        }
      }) + (eventos.length ? UI.paginacaoHtml({ pagina: e.pagina, paginas: paginas, total: e.total }) : '');
    });
  }

  /* ===========================================================================
   * Boot
   * ========================================================================= */

  function carregarContadores() {
    pedir('GET', '/api/admin/painel?dias=1').then(function (r) {
      if (r.ok) atualizarContadores(r.data);
    });
    carregarSeloGateways();
  }

  /*
   * Selo do menu Gateways: avisa de relance que a loja está vendendo em modo
   * demonstração. Usa a rota pública porque é exatamente o que o cliente vê.
   */
  function carregarSeloGateways() {
    var alvo = qs('[data-contador="gateways-demo"]');
    if (!alvo) return;

    pedir('GET', '/api/pagamentos/metodos').then(function (r) {
      if (!r.ok || !r.data) return;

      var metodos = r.data.metodos || [];

      if (!metodos.length) {
        alvo.textContent = 'sem meio';
        alvo.hidden = false;
        alvo.classList.add('is-perigo');
        return;
      }

      var demonstracao = metodos.filter(function (m) {
        return m.gateway && m.gateway.demonstracao;
      }).length;

      alvo.classList.remove('is-perigo');
      if (!demonstracao) { alvo.hidden = true; return; }
      alvo.textContent = 'demo';
      alvo.hidden = false;
    });
  }

  /* ---------------------------------------------------------------------------
   * Tempo real (SSE)
   * ---------------------------------------------------------------------------
   * O servidor publica cada mudança no barramento de eventos e expõe em
   * /api/admin/eventos. Aqui abrimos um EventSource: a cada evento atualizamos
   * os contadores do menu e, se a view na tela for afetada, recarregamos só ela.
   * Sem polling — o painel fica "vivo" sem gastar rede à toa.
   * ------------------------------------------------------------------------- */

  var fonte = null;

  // Quais views devem recarregar quando cada tipo de evento chega.
  // "gateways" fica de fora de propósito: a tela tem formulários de credencial e
  // repintá-la por baixo apagaria o que o admin está digitando.
  var VIEWS_POR_EVENTO = {
    'estoque.atualizado': ['estoque', 'painel', 'produtos'],
    'catalogo.atualizado': ['produtos', 'painel', 'estoque'],
    'produto.atualizado': ['produtos', 'painel'],
    'venda.atualizada': ['pedidos', 'painel', 'licencas', 'estoque', 'financeiro']
  };

  function estadoVivo(nome, texto) {
    var el = qs('#adm-vivo');
    if (!el) return;
    el.setAttribute('data-estado', nome);
    var txt = qs('.adm-vivo__txt', el);
    if (txt && texto) txt.textContent = texto;
  }

  function pulsarVivo() {
    var el = qs('#adm-vivo');
    if (!el) return;
    el.classList.remove('is-pulso');
    void el.offsetWidth; // reinicia a animação
    el.classList.add('is-pulso');
  }

  // Rajadas de eventos (um checkout publica vários) viram um único render.
  var contadoresEmBreve = UI.debounce(carregarContadores, 500);

  var recarregarEmBreve = UI.debounce(function () {
    if (camadaAtual) return; // não repinta por baixo de uma gaveta aberta
    atualizar();
  }, 450);

  function tratarEvento(payload) {
    pulsarVivo();
    contadoresEmBreve();

    var tipo = payload && payload.tipo;
    var afetadas = VIEWS_POR_EVENTO[tipo];
    if (afetadas && afetadas.indexOf(estado.view) !== -1) recarregarEmBreve();
  }

  function ligarTempoReal() {
    if (!window.EventSource) {
      estadoVivo('offline', 'Tempo real indisponível');
      return;
    }

    try {
      fonte = new EventSource('/api/admin/eventos');
    } catch (erro) {
      estadoVivo('offline', 'Tempo real offline');
      return;
    }

    fonte.onopen = function () { estadoVivo('vivo', 'Ao vivo'); };

    // O EventSource se reconecta sozinho (retry: 3000 do servidor); só sinaliza.
    fonte.onerror = function () { estadoVivo('offline', 'Reconectando…'); };

    fonte.addEventListener('pronto', function () { estadoVivo('vivo', 'Ao vivo'); });

    fonte.onmessage = function (evento) {
      var payload = null;
      try { payload = JSON.parse(evento.data); } catch (erro) { return; }
      tratarEvento(payload);
    };
  }

  function iniciar() {
    ligarCasca();

    Api.me().then(function (usuario) {
      if (!Api.ehAdmin(usuario)) {
        mostrarRestrito(usuario);
        return;
      }
      estado.usuario = usuario;
      preencherUsuario(usuario);
      mostrarPainel();

      carregarCategorias();
      carregarSeloGateways();
      window.addEventListener('hashchange', rotear);
      rotear();
      ligarTempoReal();
    });
  }

  window.Admin = {
    iniciar: iniciar,
    rotear: rotear,
    estado: estado,
    view: function () { return estado.view; }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', iniciar);
  } else {
    iniciar();
  }
})();
