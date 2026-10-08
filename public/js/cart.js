/*
 * cart.js — carrinho lateral
 *   Carrinho.adicionar(produto, planoId?) / abrir() / fechar()
 *   Carrinho.itens() / total() / limpar()
 *
 * Cada item guarda o produto, o plano escolhido e a quantidade (1 a 10).
 * Salva no localStorage.
 *
 * O checkout (POST /api/vendas) agora leva três coisas alem dos itens:
 *   - a forma de pagamento escolhida (Pix, cartão ou boleto);
 *   - o cupom aplicado, se houver;
 *   - e, quando o pagamento NÃO é aprovado na hora (boleto), a tela de sucesso
 *     mostra as INSTRUÇÕES de pagamento em vez das chaves.
 *
 * A lista de formas de pagamento e os cupons públicos vêm do servidor
 * (/api/pagamentos/metodos e /api/cupons): a vitrine nunca "inventa" um meio
 * que nenhum gateway ativo aceita.
 *
 * Depende de window.Api (api.js) e window.UI (ui.js).
 */
(function () {
  'use strict';

  var Api = window.Api;
  var UI = window.UI;
  var CHAVE = 'loja:carrinho';
  var MAX_QTD = 10;
  var esc = Api.escapar;
  var icone = UI.icone;

  var itens = carregar();
  var aberto = false;
  var focoAnterior = null;
  var concluido = null; // pedido recém-finalizado (mostra as chaves ou o boleto)
  var el = {};

  // Estado do checkout
  var metodos = [];        // formas de pagamento oferecidas pelo servidor
  var metodo = null;       // id escolhido ('pix' | 'cartao' | 'boleto')
  var cuponsPublicos = []; // campanhas abertas, mostradas como sugestão
  var cupom = null;        // cupom validado { codigo, desconto, total, descricao }
  var cupomErro = '';
  var cupomCarregando = false;

  /* Estado ----------------------------------------------------------------- */

  // Guarda só o necessário do produto
  function resumo(p) {
    if (!p || typeof p.id !== 'string' || !Array.isArray(p.planos) || !p.planos.length) return null;
    return {
      id: p.id,
      nome: String(p.nome || 'Produto'),
      linha: p.linha || '',
      nivel: p.nivel || '',
      categoria: p.categoria || '',
      capa: p.capa || null,
      imagem: typeof p.imagem === 'string' && p.imagem.charAt(0) === '/' ? p.imagem : null,
      planos: p.planos.filter(function (pl) {
        return pl && typeof pl.id === 'string' && Number.isFinite(Number(pl.preco));
      }).map(function (pl) {
        return { id: pl.id, nome: String(pl.nome), preco: Number(pl.preco) };
      })
    };
  }

  function carregar() {
    try {
      var lista = JSON.parse(localStorage.getItem(CHAVE) || '[]');
      if (!Array.isArray(lista)) return [];
      return lista.map(function (item) {
        var produto = resumo(item && item.produto);
        if (!produto || !produto.planos.length) return null;
        var plano = produto.planos.some(function (pl) { return pl.id === item.planoId; }) ? item.planoId : produto.planos[0].id;
        var qtd = Math.min(Math.max(parseInt(item.quantidade, 10) || 1, 1), MAX_QTD);
        return { produto: produto, planoId: plano, quantidade: qtd };
      }).filter(Boolean);
    } catch (erro) {
      return [];
    }
  }

  function salvar() {
    try {
      localStorage.setItem(CHAVE, JSON.stringify(itens));
    } catch (erro) { /* sem armazenamento: segue só em memória */ }
  }

  function planoDe(item) {
    return item.produto.planos.find(function (pl) { return pl.id === item.planoId; }) || item.produto.planos[0];
  }

  function quantidadeTotal() {
    return itens.reduce(function (s, i) { return s + i.quantidade; }, 0);
  }

  function total() {
    return Math.round(itens.reduce(function (s, i) { return s + planoDe(i).preco * i.quantidade; }, 0) * 100) / 100;
  }

  /** Total com o desconto do cupom aplicado (ou o subtotal, sem cupom). */
  function totalComDesconto() {
    if (!cupom) return total();
    return Math.round(Math.max(cupom.total, 0) * 100) / 100;
  }

  function acharItem(id) {
    return itens.find(function (i) { return i.produto.id === id; }) || null;
  }

  /** Itens no formato que a API espera (só ids e quantidades). */
  function itensParaApi() {
    return itens.map(function (i) {
      return { produtoId: i.produto.id, planoId: i.planoId, quantidade: i.quantidade };
    });
  }

  function mudou() {
    salvar();
    // O cupom foi validado sobre um carrinho específico: se o carrinho muda,
    // o desconto pode ter deixado de valer. Revalida (ou descarta) sempre.
    if (cupom) revalidarCupom();
    render();
  }

  /* Servidor: métodos e cupons --------------------------------------------- */

  function carregarMetodos() {
    return Api.get('/api/pagamentos/metodos').then(function (r) {
      if (r.ok && r.data && Array.isArray(r.data.metodos)) {
        metodos = r.data.metodos;
        if (!metodo || !metodos.some(function (m) { return m.id === metodo; })) {
          metodo = r.data.padrao || (metodos[0] && metodos[0].id) || null;
        }
      } else {
        metodos = [];
        metodo = null;
      }
      render();
    });
  }

  function carregarCupons() {
    return Api.get('/api/cupons').then(function (r) {
      cuponsPublicos = (r.ok && Array.isArray(r.data)) ? r.data.slice(0, 4) : [];
      render();
    });
  }

  function revalidarCupom() {
    if (!cupom || !itens.length) { cupom = null; return; }
    Api.post('/api/cupons/validar', { codigo: cupom.codigo, itens: itensParaApi() }).then(function (r) {
      if (r.ok && r.data && r.data.valido) {
        cupom = { codigo: r.data.codigo, desconto: r.data.desconto, total: r.data.total, descricao: r.data.descricao };
        cupomErro = '';
      } else {
        cupom = null;
        cupomErro = (r.data && r.data.erro) || 'O cupom deixou de ser válido para este carrinho.';
      }
      render();
    });
  }

  function aplicarCupom(codigo) {
    var texto = String(codigo || '').trim().toUpperCase();
    if (!texto || !itens.length) return;

    cupomCarregando = true;
    cupomErro = '';
    render();

    Api.post('/api/cupons/validar', { codigo: texto, itens: itensParaApi() }).then(function (r) {
      cupomCarregando = false;
      if (r.ok && r.data && r.data.valido) {
        cupom = { codigo: r.data.codigo, desconto: r.data.desconto, total: r.data.total, descricao: r.data.descricao };
        cupomErro = '';
        Api.toast('Cupom aplicado: ' + r.data.codigo, 'success');
      } else {
        cupom = null;
        cupomErro = (r.data && r.data.erro) || 'Cupom inválido.';
      }
      render();
    });
  }

  function removerCupom() {
    cupom = null;
    cupomErro = '';
    render();
  }

  /* Ações ------------------------------------------------------------------ */

  function adicionar(produto, planoId) {
    var p = resumo(produto);
    if (!p || !p.planos.length) return false;
    concluido = null;

    var item = acharItem(p.id);
    if (item) {
      if (item.quantidade >= MAX_QTD) {
        Api.toast('Máximo de ' + MAX_QTD + ' unidades por produto');
        return false;
      }
      item.quantidade += 1;
      item.produto = p;
      if (planoId) item.planoId = planoId;
    } else {
      itens.push({ produto: p, planoId: planoId || p.planos[0].id, quantidade: 1 });
    }
    mudou();
    return true;
  }

  function limpar() {
    itens = [];
    cupom = null;
    mudou();
  }

  /* Marcação --------------------------------------------------------------- */

  function montar() {
    var overlay = document.createElement('div');
    overlay.className = 'carrinho-overlay';

    var gaveta = document.createElement('aside');
    gaveta.className = 'carrinho';
    gaveta.id = 'carrinho';
    gaveta.setAttribute('role', 'dialog');
    gaveta.setAttribute('aria-modal', 'true');
    gaveta.setAttribute('aria-labelledby', 'carrinho-titulo');
    gaveta.setAttribute('inert', '');
    gaveta.innerHTML =
      '<div class="carrinho__topo">' +
        '<h2 class="carrinho__titulo" id="carrinho-titulo">Carrinho <span class="carrinho__qtd" data-qtd></span></h2>' +
        '<button class="icon-btn" type="button" data-fechar aria-label="Fechar carrinho">' + icone('x') + '</button>' +
      '</div>' +
      '<div class="carrinho__corpo" data-corpo></div>' +
      '<div class="carrinho__rodape" data-rodape>' +
        '<div data-extras></div>' +
        '<div class="carrinho__resumo" data-resumo></div>' +
        '<div class="carrinho__total"><span>Total</span><strong data-total></strong></div>' +
        '<button class="btn btn--primary btn--lg btn--block" type="button" data-finalizar>' +
          '<span>Finalizar compra</span>' + icone('seta', 'btn__arrow') + '<span class="spinner" aria-hidden="true"></span>' +
        '</button>' +
        '<p class="carrinho__nota">' + icone('cadeado') + 'Pagamento seguro · Entrega automática</p>' +
      '</div>';

    document.body.appendChild(overlay);
    document.body.appendChild(gaveta);

    el.overlay = overlay;
    el.gaveta = gaveta;
    el.qtd = gaveta.querySelector('[data-qtd]');
    el.corpo = gaveta.querySelector('[data-corpo]');
    el.rodape = gaveta.querySelector('[data-rodape]');
    el.extras = gaveta.querySelector('[data-extras]');
    el.resumo = gaveta.querySelector('[data-resumo]');
    el.total = gaveta.querySelector('[data-total]');
    el.finalizar = gaveta.querySelector('[data-finalizar]');
    el.fechar = gaveta.querySelector('[data-fechar]');

    overlay.addEventListener('click', fechar);
    gaveta.addEventListener('click', aoClicar);
    gaveta.addEventListener('keydown', prenderFoco);
  }

  function htmlItem(item) {
    var p = item.produto;
    var plano = planoDe(item);
    var planos = p.planos.map(function (pl) {
      return '<button class="plano" type="button" data-plano="' + esc(pl.id) + '" aria-pressed="' + (pl.id === plano.id) + '">' +
        esc(pl.nome) + '</button>';
    }).join('');

    return '<li class="item-carrinho" data-id="' + esc(p.id) + '">' +
      '<div class="item-carrinho__thumb">' + UI.capa(p) + '</div>' +
      '<div>' +
        '<div class="item-carrinho__topo">' +
          '<p class="item-carrinho__nome">' + esc(p.nome) + '</p>' +
          '<span class="item-carrinho__preco">' + esc(Api.formatarPreco(plano.preco * item.quantidade)) + '</span>' +
        '</div>' +
        (p.planos.length > 1 ? '<div class="planos" role="group" aria-label="Plano de ' + esc(p.nome) + '">' + planos + '</div>'
          : '<p class="item-carrinho__plano">Plano: ' + esc(plano.nome) + '</p>') +
        '<div class="item-carrinho__acoes">' +
          '<div class="qtd">' +
            '<button type="button" data-acao="menos" aria-label="Diminuir quantidade"' + (item.quantidade <= 1 ? ' disabled' : '') + '>' + icone('menos') + '</button>' +
            '<span aria-live="polite">' + item.quantidade + '</span>' +
            '<button type="button" data-acao="mais" aria-label="Aumentar quantidade"' + (item.quantidade >= MAX_QTD ? ' disabled' : '') + '>' + icone('mais') + '</button>' +
          '</div>' +
          '<button class="remover" type="button" data-acao="remover">' + icone('lixeira') + 'Remover</button>' +
        '</div>' +
      '</div>' +
    '</li>';
  }

  /** Bloco de cupom + lista de cupons públicos (campanha aberta). */
  function htmlCupom() {
    var chips = cuponsPublicos.length
      ? '<div class="cupom__sugestoes">' +
          '<span class="cupom__sugestoes-rotulo">Cupons disponíveis:</span>' +
          cuponsPublicos.map(function (c) {
            return '<button class="cupom__chip" type="button" data-cupom="' + esc(c.codigo) + '">' +
              esc(c.codigo) + (c.descricao ? ' · ' + esc(c.descricao) : '') + '</button>';
          }).join('') +
        '</div>'
      : '';

    var aplicado = cupom
      ? '<div class="cupom__aplicado">' + icone('check') +
          '<span>Cupom <strong>' + esc(cupom.codigo) + '</strong> aplicado</span>' +
          '<button class="icon-btn" type="button" data-cupom-remover aria-label="Remover cupom">' + icone('x') + '</button>' +
        '</div>'
      : '<form class="cupom__form" data-cupom-form>' +
          '<input class="field__input" type="text" name="cupom" maxlength="24" placeholder="Código do cupom" ' +
            'autocomplete="off" aria-label="Código do cupom">' +
          '<button class="btn btn--soft btn--sm' + (cupomCarregando ? ' is-loading' : '') + '" type="submit">Aplicar</button>' +
        '</form>' +
        (cupomErro ? '<p class="cupom__erro">' + esc(cupomErro) + '</p>' : '');

    return '<div class="cupom">' + aplicado + chips + '</div>';
  }

  /** Seletor de forma de pagamento (vem do servidor). */
  function htmlPagamento() {
    if (!metodos.length) {
      return '<p class="carrinho__aviso">' + icone('aviso') +
        'Nenhuma forma de pagamento está disponível agora. Tente novamente em instantes.</p>';
    }

    return '<div class="pagamento">' +
      '<p class="pagamento__rotulo">Forma de pagamento</p>' +
      '<div class="pagamento__opcoes" role="radiogroup" aria-label="Forma de pagamento">' +
        metodos.map(function (m) {
          var ativo = m.id === metodo;
          return '<button class="pagamento__opcao' + (ativo ? ' is-active' : '') + '" type="button" role="radio" ' +
            'aria-checked="' + ativo + '" data-metodo="' + esc(m.id) + '">' +
            '<span class="pagamento__icone">' + icone(m.icone || 'cartao') + '</span>' +
            '<span class="pagamento__txt"><strong>' + esc(m.nome) + '</strong>' +
            '<small>' + esc(m.descricao || '') + '</small></span>' +
            (ativo ? '<span class="pagamento__check">' + icone('check') + '</span>' : '') +
          '</button>';
        }).join('') +
      '</div>' +
    '</div>';
  }

  function htmlResumo() {
    var subtotal = total();
    if (!cupom) {
      return '<div class="carrinho__linha"><span>Subtotal</span><span>' + esc(Api.formatarPreco(subtotal)) + '</span></div>';
    }
    return '<div class="carrinho__linha"><span>Subtotal</span><span>' + esc(Api.formatarPreco(subtotal)) + '</span></div>' +
      '<div class="carrinho__linha carrinho__linha--desconto"><span>Desconto (' + esc(cupom.codigo) + ')</span>' +
      '<span>- ' + esc(Api.formatarPreco(cupom.desconto)) + '</span></div>';
  }

  /** Tela de sucesso: chaves quando já pagou, instruções quando está pendente. */
  function htmlConcluido(pedido) {
    var numero = esc(pedido.numero || String(pedido.id).slice(0, 8).toUpperCase());
    var pago = pedido.status === 'pago';

    if (!pago && pedido.instrucoesPagamento) {
      var inst = pedido.instrucoesPagamento;
      var bloco = '';

      if (inst.copiaECola) {
        bloco = '<div class="chave"><p class="chave__produto">Pix copia e cola</p>' +
          '<div class="chave__linha"><code>' + esc(inst.copiaECola) + '</code>' +
          '<button class="icon-btn" type="button" data-copiar="' + esc(inst.copiaECola) + '" aria-label="Copiar código Pix">' +
          icone('copiar') + '</button></div></div>';
      } else if (inst.linhaDigitavel) {
        bloco = '<div class="chave"><p class="chave__produto">Boleto bancário' +
          (inst.vencimentoFormatado ? ' · vence em ' + esc(inst.vencimentoFormatado) : '') + '</p>' +
          '<div class="chave__linha"><code>' + esc(inst.linhaDigitavel) + '</code>' +
          '<button class="icon-btn" type="button" data-copiar="' + esc(inst.linhaDigitavel) + '" aria-label="Copiar linha digitável">' +
          icone('copiar') + '</button></div></div>';
      } else if (inst.linkPagamento) {
        bloco = '<a class="btn btn--primary btn--block" href="' + esc(inst.linkPagamento) + '" target="_blank" rel="noopener">' +
          'Abrir pagamento' + icone('seta', 'btn__arrow') + '</a>';
      }

      return '<div class="carrinho__estado">' +
        '<span class="carrinho__estado-icone carrinho__estado-icone--pendente">' + icone('relogio') + '</span>' +
        '<h3>Falta só o pagamento</h3>' +
        '<p>Pedido <strong>' + numero + '</strong> registrado · ' + esc(Api.formatarPreco(pedido.total)) + '. ' +
          esc(inst.aviso || 'Assim que o pagamento for confirmado, as chaves são liberadas na sua conta.') + '</p>' +
        bloco +
        '<a class="btn btn--soft btn--block" href="/conta#/pedidos">Acompanhar pedido</a>' +
        '<button class="btn btn--ghost btn--block" type="button" data-fechar>Continuar comprando</button>' +
      '</div>';
    }

    var chaves = (pedido.itens || []).map(function (item) {
      var linhas = (item.chaves || []).map(function (chave) {
        return '<div class="chave__linha"><code>' + esc(chave) + '</code>' +
          '<button class="icon-btn" type="button" data-copiar="' + esc(chave) + '" aria-label="Copiar chave">' + icone('copiar') + '</button></div>';
      }).join('');
      return '<div class="chave"><p class="chave__produto">' + esc(item.nome) + ' · ' + esc(item.plano) + '</p>' + linhas + '</div>';
    }).join('');

    return '<div class="carrinho__estado">' +
      '<span class="carrinho__estado-icone carrinho__estado-icone--ok">' + icone('check') + '</span>' +
      '<h3>Pedido confirmado!</h3>' +
      '<p>Pedido <strong>' + numero + '</strong> · ' + esc(Api.formatarPreco(pedido.total)) + '. Suas chaves já estão liberadas:</p>' +
      '<div class="chaves">' + chaves + '</div>' +
      '<button class="btn btn--soft btn--block" type="button" data-fechar>Continuar comprando</button>' +
    '</div>';
  }

  function render() {
    // Contadores do cabeçalho
    var qtd = quantidadeTotal();
    document.querySelectorAll('[data-carrinho-contador]').forEach(function (badge) {
      var anterior = Number(badge.textContent) || 0;
      badge.textContent = String(qtd);
      badge.classList.toggle('is-empty', qtd === 0);
      if (qtd > anterior) {
        badge.classList.remove('is-bump');
        void badge.offsetWidth;
        badge.classList.add('is-bump');
      }
    });

    if (!el.gaveta) return;
    el.qtd.textContent = qtd ? String(qtd) : '';
    el.qtd.hidden = !qtd;

    if (concluido) {
      el.corpo.innerHTML = htmlConcluido(concluido);
      el.rodape.hidden = true;
      return;
    }

    if (!itens.length) {
      el.corpo.innerHTML =
        '<div class="carrinho__estado">' +
          '<span class="carrinho__estado-icone">' + icone('carrinho') + '</span>' +
          '<h3>Seu carrinho está vazio</h3>' +
          '<p>Escolha um produto e ele aparece aqui na hora.</p>' +
          '<a class="btn btn--primary" href="/produtos">Ver produtos' + icone('seta', 'btn__arrow') + '</a>' +
        '</div>';
      el.rodape.hidden = true;
      return;
    }

    el.corpo.innerHTML = '<ul class="carrinho__lista">' + itens.map(htmlItem).join('') + '</ul>';
    el.extras.innerHTML = htmlCupom() + htmlPagamento();
    el.resumo.innerHTML = htmlResumo();
    el.total.textContent = Api.formatarPreco(totalComDesconto());
    el.rodape.hidden = false;

    // Sem forma de pagamento escolhida não dá para finalizar.
    el.finalizar.disabled = !metodo;
  }

  /* Eventos ---------------------------------------------------------------- */

  function aoClicar(evento) {
    // Cupons: formulário e chips
    var formCupom = evento.target.closest('[data-cupom-form]');
    if (formCupom) {
      evento.preventDefault();
      aplicarCupom(formCupom.querySelector('[name="cupom"]').value);
      return;
    }

    var botao = evento.target.closest('button');
    if (!botao) return;

    if (botao.hasAttribute('data-cupom')) return aplicarCupom(botao.getAttribute('data-cupom'));
    if (botao.hasAttribute('data-cupom-remover')) return removerCupom();
    if (botao.hasAttribute('data-metodo')) {
      metodo = botao.getAttribute('data-metodo');
      render();
      return;
    }

    if (botao.hasAttribute('data-fechar')) {
      if (concluido) {
        concluido = null;
        render();
      }
      return fechar();
    }
    if (botao.hasAttribute('data-finalizar')) return finalizar();
    if (botao.hasAttribute('data-copiar')) return copiar(botao.getAttribute('data-copiar'), botao);

    var li = botao.closest('[data-id]');
    var item = li && acharItem(li.getAttribute('data-id'));
    if (!item) return;

    if (botao.hasAttribute('data-plano')) {
      item.planoId = botao.getAttribute('data-plano');
    } else if (botao.getAttribute('data-acao') === 'mais') {
      item.quantidade = Math.min(item.quantidade + 1, MAX_QTD);
    } else if (botao.getAttribute('data-acao') === 'menos') {
      item.quantidade = Math.max(item.quantidade - 1, 1);
    } else if (botao.getAttribute('data-acao') === 'remover') {
      itens = itens.filter(function (i) { return i !== item; });
    } else {
      return;
    }
    mudou();
    if (aberto && !el.gaveta.contains(document.activeElement)) el.fechar.focus();
  }

  function copiar(texto, botao) {
    var ok = function () {
      botao.innerHTML = icone('check');
      Api.toast('Copiado', 'success');
      setTimeout(function () { botao.innerHTML = icone('copiar'); }, 1500);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(texto).then(ok, function () { Api.toast('Não foi possível copiar', 'error'); });
    } else {
      Api.toast('Selecione o texto e copie manualmente');
    }
  }

  async function finalizar() {
    if (!itens.length || el.finalizar.classList.contains('is-loading')) return;
    if (!metodo) { Api.toast('Escolha uma forma de pagamento', 'error'); return; }

    el.finalizar.classList.add('is-loading');

    var corpo = { itens: itensParaApi(), metodoPagamento: metodo };
    if (cupom) corpo.cupom = cupom.codigo;

    var resposta = await Api.post('/api/vendas', corpo);

    el.finalizar.classList.remove('is-loading');

    if (resposta.status === 401) {
      Api.toast('Entre na sua conta para finalizar');
      setTimeout(function () {
        window.location.href = '/login?next=' + encodeURIComponent(window.location.pathname);
      }, 800);
      return;
    }
    if (!resposta.ok) {
      Api.toast((resposta.data && resposta.data.erro) || 'Não foi possível finalizar', 'error');
      // Estoque esgotado no meio do caminho: recarrega os métodos/cupons.
      if (resposta.data && resposta.data.codigo === 'estoque_insuficiente') {
        carregarMetodos();
      }
      return;
    }

    itens = [];
    cupom = null;
    cupomErro = '';
    concluido = resposta.data;
    mudou();
  }

  /* Abrir / fechar ---------------------------------------------------------- */

  function abrir() {
    if (aberto || !el.gaveta) return;
    aberto = true;
    focoAnterior = document.activeElement;
    el.gaveta.removeAttribute('inert');
    el.overlay.classList.add('is-open');
    el.gaveta.classList.add('is-open');
    document.documentElement.classList.add('no-scroll');
    setTimeout(function () { if (aberto) el.fechar.focus(); }, 50);
  }

  function fechar() {
    if (!aberto) return;
    aberto = false;
    el.gaveta.setAttribute('inert', '');
    el.overlay.classList.remove('is-open');
    el.gaveta.classList.remove('is-open');
    document.documentElement.classList.remove('no-scroll');
    if (focoAnterior && document.contains(focoAnterior)) focoAnterior.focus({ preventScroll: true });
  }

  function prenderFoco(evento) {
    if (evento.key !== 'Tab') return;
    var focaveis = Array.prototype.filter.call(
      el.gaveta.querySelectorAll('button:not(:disabled), a[href], input:not(:disabled)'),
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

  document.addEventListener('keydown', function (evento) {
    if (evento.key === 'Escape' && aberto) fechar();
  });

  document.addEventListener('click', function (evento) {
    if (evento.target.closest && evento.target.closest('[data-abrir-carrinho]')) abrir();
  });

  // Mantém abas do navegador sincronizadas
  window.addEventListener('storage', function (evento) {
    if (evento.key !== CHAVE) return;
    itens = carregar();
    render();
  });

  montar();
  render();
  carregarMetodos();
  carregarCupons();

  window.Carrinho = {
    adicionar: adicionar,
    abrir: abrir,
    fechar: fechar,
    itens: function () { return itens.slice(); },
    total: total,
    limpar: limpar
  };
})();
