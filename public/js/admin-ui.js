/*
 * admin-ui.js
 * -----------------------------------------------------------------------------
 * Peças reutilizáveis do painel administrativo. É um script comum (sem módulos)
 * carregado com "defer" depois de api.js, e expõe um único global: window.AdminUI.
 *
 *   AdminUI.icone(nome, classe?)      -> SVG em texto
 *   AdminUI.numero(n)                 -> "1.234"
 *   AdminUI.dinheiro(n)               -> "R$ 1.234,90"
 *   AdminUI.dataCurta(iso)            -> "30/09/2026"
 *   AdminUI.dataHora(iso)             -> "30/09/2026 21:08"
 *   AdminUI.relativo(iso)             -> "há 3 min"
 *   AdminUI.selo(tipo, texto)         -> selo colorido
 *   AdminUI.seloVenda(status)         -> selo do status do pedido
 *   AdminUI.seloLicenca(status)       -> selo do status da licença
 *   AdminUI.estrelas(nota)            -> linha de estrelas
 *   AdminUI.tabela({ colunas, corpo })-> tabela com estados
 *   AdminUI.estado({...})             -> bloco vazio/erro
 *   AdminUI.esqueletoLinhas(n)        -> linhas de carregamento
 *   AdminUI.paginacaoHtml({...})      -> controles de paginação
 *   AdminUI.grafico(dados)            -> SVG de barras (receita por dia)
 *   AdminUI.modal({...})              -> abre modal; devolve { fechar }
 *   AdminUI.gaveta({...})             -> abre gaveta lateral
 *   AdminUI.confirmar({...})          -> Promise<boolean>
 *   AdminUI.copiar(texto)             -> copia e avisa
 *   AdminUI.debounce(fn, ms)
 *   AdminUI.esc                       -> atalho para Api.escapar
 *
 * Princípios: nada aqui lança exceção para quem chama; e todo texto vindo de
 * dados (nome de cliente, chave, etc.) passa por AdminUI.esc antes de virar HTML.
 */
(function () {
  'use strict';

  var Api = window.Api;
  var esc = Api.escapar;

  /* ---------------------------------------------------------------------------
   * Ícones
   * ------------------------------------------------------------------------- */

  var PATHS = {
    painel: '<rect x="3" y="3" width="7.5" height="7.5" rx="1.6"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.6"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="1.6"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.6"/>',
    pacote: '<path d="m3 7.5 9-4.5 9 4.5v9L12 21l-9-4.5Z"/><path d="m3 7.5 9 4.5 9-4.5M12 12v9"/>',
    camadas: '<path d="m12 3 9.5 5-9.5 5-9.5-5Z"/><path d="m2.5 13 9.5 5 9.5-5"/>',
    tag: '<path d="M3 12.5V4h8.5L21 13.5 13.5 21Z"/><circle cx="7.5" cy="8" r="1.3"/>',
    usuario: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4-6 8-6s7 2 8 6"/>',
    usuarios: '<circle cx="9" cy="8" r="3.4"/><path d="M2.5 20c.8-3.4 3.4-5.2 6.5-5.2S14.7 16.6 15.5 20"/><path d="M16 5.2a3.4 3.4 0 0 1 0 6.6M17.5 14.9c2.3.5 3.8 2.2 4.3 5.1"/>',
    cadeado: '<rect x="5" y="11" width="14" height="10" rx="2.5"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
    estrela: '<path fill="currentColor" stroke="none" d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9Z"/>',
    lista: '<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="4" cy="6" r="1.1" fill="currentColor" stroke="none"/><circle cx="4" cy="12" r="1.1" fill="currentColor" stroke="none"/><circle cx="4" cy="18" r="1.1" fill="currentColor" stroke="none"/>',
    ajustes: '<path d="M4 8h10M18 8h2M4 16h4M12 16h8"/><circle cx="16" cy="8" r="2.4"/><circle cx="10" cy="16" r="2.4"/>',
    atividade: '<path d="M3 12h4l2.5-6 4 12L16 12h5"/>',
    dinheiro: '<rect x="2.5" y="6" width="19" height="12" rx="2.5"/><circle cx="12" cy="12" r="2.6"/><path d="M6 10v4M18 10v4"/>',
    carrinho: '<path d="M3 4h2l2.4 11h10.9l2-8H6.2"/><circle cx="9.5" cy="19.5" r="1.3"/><circle cx="17.5" cy="19.5" r="1.3"/>',
    grafico: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
    relogio: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
    atualizar: '<path d="M20 11a8 8 0 0 0-14.3-4.9L4 8"/><path d="M4 3.5V8h4.5"/><path d="M4 13a8 8 0 0 0 14.3 4.9L20 16"/><path d="M20 20.5V16h-4.5"/>',
    mais: '<path d="M12 5v14M5 12h14"/>',
    menos: '<path d="M5 12h14"/>',
    x: '<path d="M6 6l12 12M18 6 6 18"/>',
    check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
    lixeira: '<path d="M4 7h16M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13"/>',
    editar: '<path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17Z"/><path d="m14.5 6.5 3 3"/>',
    olho: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="3"/>',
    busca: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>',
    seta: '<path d="M5 12h14"/><path d="m13 6 6 6-6 6"/>',
    setaEsq: '<path d="M19 12H5"/><path d="m11 6-6 6 6 6"/>',
    setaBaixo: '<path d="m6 9 6 6 6-6"/>',
    sair: '<path d="M15 4h3.5A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5H15"/><path d="M10 12h9"/><path d="m13.5 8.5 3.5 3.5-3.5 3.5"/><path d="M4 4v16"/>',
    copiar: '<rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3"/>',
    chave: '<circle cx="8" cy="14" r="4"/><path d="m11 11 9-9M17 3l3 3M15 5l2.5 2.5"/>',
    aviso: '<path d="M12 3.5 21 19H3Z"/><path d="M12 10v4M12 17h.01"/>',
    info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8h.01"/>',
    escudo: '<path d="M12 3 20 6v6c0 4.8-3.4 8-8 9-4.6-1-8-4.2-8-9V6Z"/><path d="m9 12 2 2 4-4"/>',
    filtro: '<path d="M3 5h18l-7 8v5l-4 2v-7Z"/>',
    trofeu: '<path d="M8 4h8v5a4 4 0 0 1-8 0Z"/><path d="M8 5.5H5.5A2.5 2.5 0 0 0 8 10M16 5.5h2.5A2.5 2.5 0 0 1 16 10"/><path d="M12 13v4M9 20h6M10 20l.5-3h3l.5 3"/>',
    calendario: '<rect x="3.5" y="5" width="17" height="16" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
    chat: '<path d="M4 5h16v11H9.5L5 20v-4H4Z"/><path d="M8.5 10.5h.01M12 10.5h.01M15.5 10.5h.01"/>',
    cartao: '<rect x="2.5" y="5" width="19" height="14" rx="2.5"/><path d="M2.5 10h19M6.5 15h4"/>',
    boleto: '<path d="M4 6v12M7 6v12M10 6v12M13 6v12M16 6v12M20 6v12"/>',
    cifrao: '<path d="M12 3v18"/><path d="M16.5 7.5A3.5 3.5 0 0 0 13 5h-1.5a3 3 0 0 0 0 6h2a3 3 0 0 1 0 6H12a3.5 3.5 0 0 1-3.5-2.5"/>',
    plugue: '<path d="M9 3v6M15 3v6"/><path d="M6 9h12v3a6 6 0 0 1-12 0Z"/><path d="M12 18v3"/>',
    raio: '<path d="M13 2 4.5 13.5H11L10 22l8.5-11.5H12Z"/>',
    menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
    caixa: '<path d="M4 7.5 12 3l8 4.5v9L12 21l-8-4.5Z"/><path d="M4 7.5 12 12l8-4.5M12 12v9"/>',
    coracao: '<path d="M12 20.3 4.6 13a4.7 4.7 0 0 1 7.4-5.8 4.7 4.7 0 0 1 7.4 5.8Z"/>'
  };

  function icone(nome, classe) {
    var traco = PATHS[nome] || PATHS.raio;
    return '<svg' + (classe ? ' class="' + classe + '"' : '') +
      ' viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"' +
      ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
      traco + '</svg>';
  }

  /* ---------------------------------------------------------------------------
   * Formatação
   * ------------------------------------------------------------------------- */

  function numero(valor) {
    var n = Number(valor);
    if (!Number.isFinite(n)) n = 0;
    return n.toLocaleString('pt-BR');
  }

  function dinheiro(valor) {
    return Api.formatarPreco(valor);
  }

  function centavos(valor) {
    var n = Number(valor);
    if (!Number.isFinite(n)) n = 0;
    return Api.formatarPreco(n / 100);
  }

  function dataValida(iso) {
    if (!iso) return null;
    var d = new Date(iso);
    return isNaN(d.getTime()) ? null : d;
  }

  function dataCurta(iso) {
    var d = dataValida(iso);
    if (!d) return '—';
    return d.toLocaleDateString('pt-BR');
  }

  function dataHora(iso) {
    var d = dataValida(iso);
    if (!d) return '—';
    return d.toLocaleDateString('pt-BR') + ' às ' +
      d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }

  function relativo(iso) {
    var d = dataValida(iso);
    if (!d) return '—';

    var segundos = Math.round((Date.now() - d.getTime()) / 1000);
    if (segundos < 0) segundos = 0;
    if (segundos < 60) return 'agora há pouco';

    var minutos = Math.floor(segundos / 60);
    if (minutos < 60) return 'há ' + minutos + ' min';

    var horas = Math.floor(minutos / 60);
    if (horas < 24) return 'há ' + horas + ' h';

    var dias = Math.floor(horas / 24);
    if (dias < 30) return 'há ' + dias + (dias === 1 ? ' dia' : ' dias');

    var meses = Math.floor(dias / 30);
    if (meses < 12) return 'há ' + meses + (meses === 1 ? ' mês' : ' meses');

    return 'há ' + Math.floor(meses / 12) + ' ano(s)';
  }

  /* ---------------------------------------------------------------------------
   * Selos
   * ------------------------------------------------------------------------- */

  function selo(tipo, texto, semPonto) {
    var classe = 'adm-selo' + (tipo ? ' adm-selo--' + tipo : '') + (semPonto ? ' adm-selo--sem-ponto' : '');
    return '<span class="' + classe + '">' + esc(texto) + '</span>';
  }

  var MAPA_VENDA = {
    pendente: ['aviso', 'Pendente'],
    pago: ['ok', 'Pago'],
    cancelado: ['neutro', 'Cancelado'],
    reembolsado: ['erro', 'Reembolsado']
  };

  function seloVenda(status) {
    var info = MAPA_VENDA[status] || ['neutro', status || '—'];
    return selo(info[0], info[1]);
  }

  var MAPA_LICENCA = {
    ativa: ['info', 'Ativa'],
    resgatada: ['ok', 'Resgatada'],
    revogada: ['erro', 'Revogada'],
    expirada: ['neutro', 'Expirada']
  };

  function seloLicenca(status) {
    var info = MAPA_LICENCA[status] || ['neutro', status || '—'];
    return selo(info[0], info[1]);
  }

  function seloPapel(papel) {
    return papel === 'admin' ? selo('info', 'Administrador') : selo('neutro', 'Cliente');
  }

  function seloAtivo(ativo) {
    return ativo ? selo('ok', 'Ativo') : selo('neutro', 'Inativo');
  }

  // Situação de uma chave dentro do estoque (pool de licenças).
  var MAPA_ESTOQUE_CHAVE = {
    disponivel: ['info', 'Disponível'],
    vendida: ['ok', 'Vendida'],
    descartada: ['neutro', 'Descartada'],
    revogada: ['erro', 'Revogada']
  };

  function seloEstoqueChave(status) {
    var info = MAPA_ESTOQUE_CHAVE[status] || ['neutro', status || '—'];
    return selo(info[0], info[1]);
  }

  // Tipo de movimento no livro-razão do estoque.
  var MAPA_ESTOQUE_TIPO = {
    entrada: ['ok', 'Entrada'],
    saida: ['info', 'Saída'],
    descarte: ['neutro', 'Descarte'],
    revogacao: ['erro', 'Revogação']
  };

  function seloEstoqueTipo(tipo) {
    var info = MAPA_ESTOQUE_TIPO[tipo] || ['neutro', tipo || '—'];
    return selo(info[0], info[1]);
  }

  function estrelas(nota) {
    var valor = Math.round(Number(nota) || 0);
    var saida = '<span class="adm-estrelas" aria-label="' + valor + ' de 5">';
    for (var i = 1; i <= 5; i++) {
      saida += '<span style="opacity:' + (i <= valor ? '1' : '.28') + '">' + icone('estrela') + '</span>';
    }
    return saida + '</span>';
  }

  /* ---------------------------------------------------------------------------
   * Blocos de estado
   * ------------------------------------------------------------------------- */

  function estado(opcoes) {
    opcoes = opcoes || {};
    var tipo = opcoes.tipo === 'erro' ? ' adm-estado--erro' : '';
    return '<div class="adm-estado' + tipo + '">' +
      '<span class="adm-estado__icone">' + icone(opcoes.icone || 'info') + '</span>' +
      '<p class="adm-estado__titulo">' + esc(opcoes.titulo || 'Nada por aqui') + '</p>' +
      (opcoes.texto ? '<p class="adm-estado__txt">' + esc(opcoes.texto) + '</p>' : '') +
      (opcoes.acao || '') +
    '</div>';
  }

  function esqueletoLinhas(quantidade) {
    var total = quantidade || 6;
    var saida = '';
    for (var i = 0; i < total; i++) {
      saida += '<div class="skeleton adm-esqueleto-linha"></div>';
    }
    return saida;
  }

  /* ---------------------------------------------------------------------------
   * Tabela
   * ------------------------------------------------------------------------- */

  /**
   * Monta o HTML de uma tabela dentro de um cartão.
   * @param {object} opcoes
   * @param {Array<{rotulo:string, classe?:string}>} opcoes.colunas
   * @param {string} [opcoes.corpo] linhas <tr> já montadas
   * @param {boolean} [opcoes.carregando]
   * @param {object} [opcoes.vazio] { titulo, texto, icone }
   */
  function tabela(opcoes) {
    opcoes = opcoes || {};
    var colunas = opcoes.colunas || [];

    if (opcoes.carregando) {
      return '<div class="adm-cartao__corpo--sem-pad">' + esqueletoLinhas(7) + '</div>';
    }

    var corpo = opcoes.corpo;
    if (!corpo) {
      return estado(opcoes.vazio || { titulo: 'Nada por aqui', texto: 'Nenhum registro encontrado.', icone: 'caixa' });
    }

    var cabecalho = colunas.map(function (coluna) {
      return '<th' + (coluna.classe ? ' class="' + coluna.classe + '"' : '') + '>' + esc(coluna.rotulo) + '</th>';
    }).join('');

    return '<div class="adm-tabela-wrap"><table class="adm-tabela">' +
      '<thead><tr>' + cabecalho + '</tr></thead>' +
      '<tbody>' + corpo + '</tbody>' +
    '</table></div>';
  }

  /* ---------------------------------------------------------------------------
   * Paginação
   * ------------------------------------------------------------------------- */

  function paginacaoHtml(opcoes) {
    opcoes = opcoes || {};
    var pagina = opcoes.pagina || 1;
    var paginas = Math.max(opcoes.paginas || 1, 1);
    var total = opcoes.total || 0;

    return '<div class="adm-paginacao" data-paginacao>' +
      '<span class="adm-paginacao__info">' + numero(total) + ' registro(s) · página ' + pagina + ' de ' + paginas + '</span>' +
      '<span class="adm-paginacao__acoes">' +
        '<button class="btn btn--soft btn--sm" type="button" data-acao="pagina" data-pagina="' + (pagina - 1) + '"' + (pagina <= 1 ? ' disabled' : '') + '>' +
          icone('setaEsq') + 'Anterior</button>' +
        '<button class="btn btn--soft btn--sm" type="button" data-acao="pagina" data-pagina="' + (pagina + 1) + '"' + (pagina >= paginas ? ' disabled' : '') + '>' +
          'Próxima' + icone('seta') + '</button>' +
      '</span>' +
    '</div>';
  }

  /* ---------------------------------------------------------------------------
   * Gráfico de barras (receita por dia) — SVG puro, sem dependências
   * ------------------------------------------------------------------------- */

  // Escolhe um passo "redondo" (1, 2, 5, 10 × potência de 10) para o eixo Y,
  // para os rótulos saírem em números limpos (0 / 10 / 20 / 30...).
  function passoBonitoDoEixo(maximo) {
    var bruto = (Number(maximo) || 1) / 4;
    var magnitude = Math.pow(10, Math.floor(Math.log(bruto) / Math.LN10));
    if (!Number.isFinite(magnitude) || magnitude < 1) magnitude = 1;

    var normalizado = bruto / magnitude;
    var passo = normalizado <= 1 ? 1 : normalizado <= 2 ? 2 : normalizado <= 5 ? 5 : 10;
    return passo * magnitude;
  }

  function grafico(dados, opcoes) {
    opcoes = opcoes || {};
    var serie = (dados || []).filter(function (item) { return item && item.valor !== undefined; });

    if (!serie.length) {
      return estado({ titulo: 'Sem dados no período', texto: 'Assim que houver pedidos pagos, o gráfico aparece aqui.', icone: 'grafico' });
    }

    var largura = 640;
    var altura = 240;
    var margem = { topo: 14, direita: 10, baixo: 30, esquerda: 52 };
    var areaL = largura - margem.esquerda - margem.direita;
    var areaA = altura - margem.topo - margem.baixo;

    var maximo = 1;
    serie.forEach(function (item) { if (item.valor > maximo) maximo = item.valor; });

    var topo = passoBonitoDoEixo(maximo) * 4;

    var n = serie.length;
    var passoX = areaL / n;
    // A barra ocupa boa parte da faixa, mas não fica gigante quando há poucos dias.
    var larguraBarra = Math.min(Math.max(passoX - Math.min(passoX * 0.35, 10), 3), 56);

    function x(i) { return margem.esquerda + i * passoX + (passoX - larguraBarra) / 2; }
    function y(valor) { return margem.topo + areaA - (valor / topo) * areaA; }

    // Linhas de grade + rótulos do eixo Y (4 faixas).
    var grade = '';
    for (var g = 0; g <= 4; g++) {
      var valorLinha = (topo / 4) * g;
      var yy = y(valorLinha);
      grade += '<line x1="' + margem.esquerda + '" y1="' + yy.toFixed(1) + '" x2="' + (largura - margem.direita) + '" y2="' + yy.toFixed(1) + '" stroke="rgba(148,163,184,.14)" stroke-width="1"/>' +
        '<text class="adm-grafico__eixo" x="' + (margem.esquerda - 8) + '" y="' + (yy + 3).toFixed(1) + '" text-anchor="end">' +
          esc(opcoes.formatarEixo ? opcoes.formatarEixo(valorLinha) : numero(Math.round(valorLinha))) +
        '</text>';
    }

    // Barras.
    var barras = '';
    var intervaloRotulo = n > 14 ? Math.ceil(n / 7) : (n > 7 ? 2 : 1);
    for (var i = 0; i < n; i++) {
      var item = serie[i];
      var alturaBarra = Math.max(areaA - (y(item.valor) - margem.topo), item.valor > 0 ? 3 : 0);
      var titulo = (item.rotulo || item.dia || '') + ': ' + (opcoes.formatarValor ? opcoes.formatarValor(item.valor) : numero(item.valor));

      barras += '<rect class="adm-grafico__barra" x="' + x(i).toFixed(1) + '" y="' + y(item.valor).toFixed(1) + '"' +
        ' width="' + larguraBarra.toFixed(1) + '" height="' + alturaBarra.toFixed(1) + '" rx="3"' +
        ' fill="url(#gradBarra)"><title>' + esc(titulo) + '</title></rect>';

      if (i % intervaloRotulo === 0) {
        var rotulo = item.rotulo || (item.dia ? item.dia.slice(8, 10) + '/' + item.dia.slice(5, 7) : '');
        barras += '<text class="adm-grafico__eixo" x="' + (x(i) + larguraBarra / 2).toFixed(1) + '" y="' + (altura - 10) + '" text-anchor="middle">' +
          esc(rotulo) + '</text>';
      }
    }

    return '<div class="adm-grafico"><svg viewBox="0 0 ' + largura + ' ' + altura + '" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Receita por dia">' +
      '<defs><linearGradient id="gradBarra" x1="0" y1="0" x2="0" y2="1">' +
        '<stop offset="0%" stop-color="#60A5FA"/><stop offset="100%" stop-color="#2F7BFF"/>' +
      '</linearGradient></defs>' +
      grade + barras +
    '</svg></div>';
  }

  /* ---------------------------------------------------------------------------
   * Modal / gaveta / confirmação
   * ------------------------------------------------------------------------- */

  var abertos = [];

  function travarScroll(travar) {
    if (travar) document.documentElement.classList.add('no-scroll');
    else document.documentElement.classList.remove('no-scroll');
  }

  function fecharTopo() {
    var ultimo = abertos.pop();
    if (ultimo) ultimo.fechar(true);
    travarScroll(abertos.length > 0);
  }

  document.addEventListener('keydown', function (evento) {
    if (evento.key === 'Escape' && abertos.length) fecharTopo();
  });

  function montarCamada(html, opcoes) {
    opcoes = opcoes || {};
    var overlay = document.createElement('div');
    overlay.className = 'adm-overlay';
    overlay.innerHTML = html;
    document.body.appendChild(overlay);

    var caixa = overlay.querySelector(opcoes.seletor || '.adm-modal');
    var focoAnterior = document.activeElement;
    var fechado = false;

    function fechar(imediato) {
      if (fechado) return;
      fechado = true;
      var indice = abertos.indexOf(controle);
      if (indice !== -1) abertos.splice(indice, 1);
      if (imediato) {
        overlay.remove();
      } else {
        overlay.style.opacity = '0';
        setTimeout(function () { overlay.remove(); }, 160);
      }
      travarScroll(abertos.length > 0);
      if (focoAnterior && typeof focoAnterior.focus === 'function') focoAnterior.focus();
      if (typeof opcoes.aoFechar === 'function') opcoes.aoFechar();
    }

    // Fecha ao clicar no fundo (fora da caixa).
    overlay.addEventListener('mousedown', function (evento) {
      if (evento.target === overlay && opcoes.fecharNoFundo !== false) fechar();
    });

    overlay.querySelectorAll('[data-fechar]').forEach(function (botao) {
      botao.addEventListener('click', function () { fechar(); });
    });

    var controle = { overlay: overlay, caixa: caixa, fechar: fechar };
    abertos.push(controle);
    travarScroll(true);

    // Foco no primeiro campo/botão útil.
    var alvo = overlay.querySelector('[data-foco]') ||
      overlay.querySelector('input, select, textarea, button:not([data-fechar])');
    if (alvo && typeof alvo.focus === 'function') setTimeout(function () { alvo.focus(); }, 30);

    return controle;
  }

  function modal(opcoes) {
    opcoes = opcoes || {};
    var html = '<div class="adm-modal' + (opcoes.largo ? ' adm-modal--largo' : '') + '" role="dialog" aria-modal="true">' +
      '<div class="adm-modal__cab">' +
        '<div>' +
          '<h2 class="adm-modal__titulo">' + esc(opcoes.titulo || '') + '</h2>' +
          (opcoes.sub ? '<p class="adm-modal__sub">' + esc(opcoes.sub) + '</p>' : '') +
        '</div>' +
        '<button class="icon-btn adm-modal__fechar" type="button" data-fechar aria-label="Fechar">' + icone('x') + '</button>' +
      '</div>' +
      '<div class="adm-modal__corpo">' + (opcoes.corpo || '') + '</div>' +
      (opcoes.pe ? '<div class="adm-modal__pe">' + opcoes.pe + '</div>' : '') +
    '</div>';

    var controle = montarCamada(html, opcoes);
    if (typeof opcoes.aoAbrir === 'function') opcoes.aoAbrir(controle.caixa, controle.fechar);
    return controle;
  }

  function gaveta(opcoes) {
    opcoes = opcoes || {};
    var html = '<aside class="adm-gaveta" role="dialog" aria-modal="true">' +
      '<div class="adm-gaveta__cab">' +
        '<div>' +
          '<h2 class="adm-modal__titulo">' + esc(opcoes.titulo || '') + '</h2>' +
          (opcoes.sub ? '<p class="adm-modal__sub">' + esc(opcoes.sub) + '</p>' : '') +
        '</div>' +
        '<button class="icon-btn adm-modal__fechar" type="button" data-fechar aria-label="Fechar">' + icone('x') + '</button>' +
      '</div>' +
      '<div class="adm-gaveta__corpo">' + (opcoes.corpo || '') + '</div>' +
      (opcoes.pe ? '<div class="adm-gaveta__pe">' + opcoes.pe + '</div>' : '') +
    '</aside>';

    var controle = montarCamada(html, {
      seletor: '.adm-gaveta',
      fecharNoFundo: opcoes.fecharNoFundo,
      aoFechar: opcoes.aoFechar
    });
    if (typeof opcoes.aoAbrir === 'function') opcoes.aoAbrir(controle.caixa, controle.fechar);
    return controle;
  }

  /**
   * Confirmação. Devolve uma Promise<boolean> resolvida com a escolha.
   * @param {{titulo?:string, texto?:string, confirmar?:string, perigo?:boolean}} opcoes
   */
  function confirmar(opcoes) {
    opcoes = opcoes || {};
    return new Promise(function (resolver) {
      var escolha = false;

      modal({
        titulo: opcoes.titulo || 'Confirmar ação',
        sub: opcoes.sub,
        corpo: '<p style="font-size:14px;color:var(--text-2);line-height:1.6">' + esc(opcoes.texto || 'Tem certeza?') + '</p>',
        pe: '<button class="btn btn--soft" type="button" data-fechar>Cancelar</button>' +
            '<button class="btn btn--primary" type="button" data-confirmar' +
            (opcoes.perigo === false ? '' : ' style="background:var(--danger);box-shadow:none"') + '>' +
            esc(opcoes.confirmar || 'Confirmar') + '</button>',
        aoAbrir: function (caixa, fechar) {
          caixa.querySelector('[data-confirmar]').addEventListener('click', function () {
            escolha = true;
            fechar();
          });
        },
        aoFechar: function () { resolver(escolha); }
      });
    });
  }

  /* ---------------------------------------------------------------------------
   * Utilidades
   * ------------------------------------------------------------------------- */

  function copiar(texto) {
    var valor = String(texto === null || texto === undefined ? '' : texto);
    if (!valor) return;

    function avisar() { Api.toast('Copiado para a área de transferência', 'success'); }

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(valor).then(avisar).catch(function () { avisar(); });
      return;
    }

    var area = document.createElement('textarea');
    area.value = valor;
    area.setAttribute('readonly', 'readonly');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    try { document.execCommand('copy'); avisar(); } catch (erro) { /* silencioso */ }
    document.body.removeChild(area);
  }

  function debounce(fn, ms) {
    var id = null;
    return function () {
      var args = arguments;
      var contexto = this;
      clearTimeout(id);
      id = setTimeout(function () { fn.apply(contexto, args); }, ms || 300);
    };
  }

  function iniciais(nome) {
    var partes = String(nome || '').trim().split(/\s+/);
    return ((partes[0] || '').charAt(0) + (partes.length > 1 ? partes[partes.length - 1].charAt(0) : '')).toUpperCase() || '?';
  }

  window.AdminUI = {
    esc: esc,
    icone: icone,
    numero: numero,
    dinheiro: dinheiro,
    centavos: centavos,
    dataCurta: dataCurta,
    dataHora: dataHora,
    relativo: relativo,
    selo: selo,
    seloVenda: seloVenda,
    seloLicenca: seloLicenca,
    seloPapel: seloPapel,
    seloAtivo: seloAtivo,
    seloEstoqueChave: seloEstoqueChave,
    seloEstoqueTipo: seloEstoqueTipo,
    estrelas: estrelas,
    estado: estado,
    esqueletoLinhas: esqueletoLinhas,
    tabela: tabela,
    paginacaoHtml: paginacaoHtml,
    grafico: grafico,
    modal: modal,
    gaveta: gaveta,
    confirmar: confirmar,
    copiar: copiar,
    debounce: debounce,
    iniciais: iniciais
  };
})();
