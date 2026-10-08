'use strict';

process.env.NODE_ENV = 'test';
process.env.BANCO_ARQUIVO = ':memory:';
process.env.SEGREDO_APP = 'segredo-de-teste';
process.env.LOG_NIVEL = 'silent';

const path = require('path');
const PW = 'C:/Users/joaovx/.workbuddy-ai/binaries/node/workspace/node_modules/playwright-core';
const { chromium } = require(PW);
const { criarApp } = require('./src/app');
const { conectar, fechar } = require('./src/db/conexao');
const { semear } = require('./src/db/semear');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const falhas = [];
const ok = (c, m) => { console.log((c ? '  OK  ' : ' FALHA') + ' · ' + m); if (!c) falhas.push(m); };

/** Mesmo formato que a tela usa (R$ 1.460,23). */
const brl = (v) => new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v);

(async () => {
  conectar();
  semear({ silencioso: true });
  const servidor = criarApp().listen(0);
  await new Promise((r) => servidor.once('listening', r));
  const base = 'http://127.0.0.1:' + servidor.address().port;

  // ---------------------------------------------------------------- semear via API
  let cookie = '';
  let cookieAdmin = '';
  async function req(metodo, caminho, corpo) {
    const r = await fetch(base + caminho, {
      method: metodo,
      headers: { 'content-type': 'application/json', cookie },
      body: corpo ? JSON.stringify(corpo) : undefined
    });
    const set = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
    if (set.length) cookie = set.map(c => c.split(';')[0]).join('; ');
    const texto = await r.text();
    let json = null;
    try { json = JSON.parse(texto); } catch { /* ignore */ }
    return { status: r.status, corpo: json };
  }
  async function login(email, senha) { cookie = ''; return req('POST', '/api/auth/login', { email, senha }); }

  await login('admin@loja.com', 'admin123');
  cookieAdmin = cookie;

  const produtos = (await req('GET', '/api/produtos')).corpo || [];
  const produto = produtos.find(p => (p.planos || []).length) || produtos[0];
  const plano = produto.planos[0];

  // Repoe estoque para poder gerar mais pedidos do que o seed permite.
  const reposicao = await req('POST', '/api/admin/estoque/gerar', {
    produtoId: produto.id, planoId: plano.id, quantidade: 60, lote: 'verificacao-financeiro'
  });
  ok(reposicao.status === 201, 'estoque reposto pelo admin (' + reposicao.corpo.inseridas + ' chaves)');

  await login('demo@loja.com', 'demo123');

  const PAGOS = 28;
  const pedidos = [];
  for (let i = 0; i < PAGOS; i += 1) {
    const r = await req('POST', '/api/vendas', {
      itens: [{ produtoId: produto.id, planoId: plano.id, quantidade: 1 }],
      metodoPagamento: 'pix'
    });
    if (r.status === 201) pedidos.push(r.corpo);
  }
  ok(pedidos.length === PAGOS, 'criados ' + pedidos.length + ' pedidos pagos no pix');

  const boleto = await req('POST', '/api/vendas', {
    itens: [{ produtoId: produto.id, planoId: plano.id, quantidade: 1 }],
    metodoPagamento: 'boleto'
  });
  ok(boleto.status === 201, 'boleto criado (pendente, dinheiro a receber)');

  cookie = cookieAdmin;
  const estorno = await req('PATCH', '/api/admin/pedidos/' + pedidos[0].id + '/status', { status: 'reembolsado' });
  ok(estorno.status === 200, 'pedido estornado pelo admin (status=' + estorno.status + ')');

  const TOTAL_ESPERADO = PAGOS + 1;

  // Fonte da verdade: a propria API.
  const api = (await req('GET', '/api/admin/financeiro?periodo=30')).corpo;
  ok(api.resumo.recebido.pedidos === PAGOS - 1, 'API: recebidos = ' + (PAGOS - 1) + ' (veio ' + api.resumo.recebido.pedidos + ')');
  ok(api.resumo.aReceber.pedidos === 1, 'API: a receber = 1 (veio ' + api.resumo.aReceber.pedidos + ')');
  ok(api.resumo.reembolsado.pedidos === 1, 'API: devolvidos = 1 (veio ' + api.resumo.reembolsado.pedidos + ')');
  ok(api.resumo.cancelado.pedidos === 0, 'API: cancelados = 0 (veio ' + api.resumo.cancelado.pedidos + ')');

  // ------------------------------------------------------------------- navegador
  const navegador = await chromium.launch({ executablePath: EDGE, headless: true });
  const contexto = await navegador.newContext({ viewport: { width: 1440, height: 980 } });
  await contexto.request.post(base + '/api/auth/login', { data: { email: 'admin@loja.com', senha: 'admin123' } });

  const pagina = await contexto.newPage();
  const erros = [];
  pagina.on('pageerror', (e) => erros.push('pageerror: ' + e.message));
  pagina.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (t.includes('/api/auth/me') && t.includes('401')) return;
    erros.push('console: ' + t);
  });

  await pagina.goto(base + '/admin', { waitUntil: 'domcontentloaded' });
  await pagina.waitForSelector('#nav [data-view="painel"]', { timeout: 15000 });

  /* ---------------------------------------------- 1. Onde cada item do menu está */
  const grupos = await pagina.evaluate(() => {
    const nav = document.querySelector('#nav');
    const saida = {};
    let grupo = null;
    Array.from(nav.children).forEach((el) => {
      if (el.classList.contains('adm-nav__grupo')) { grupo = el.textContent.trim(); saida[grupo] = []; return; }
      const view = el.getAttribute('data-view');
      if (view && grupo) saida[grupo].push(view);
    });
    return saida;
  });

  ok((grupos['Sistema'] || []).includes('gateways'),
    'Gateways está no grupo Sistema (' + JSON.stringify(grupos['Sistema']) + ')');
  ok(!(grupos['Vendas'] || []).includes('gateways'),
    'Gateways saiu do grupo Vendas (' + JSON.stringify(grupos['Vendas']) + ')');
  ok((grupos['Visão geral'] || []).includes('financeiro'),
    'Financeiro está no grupo Visão geral (' + JSON.stringify(grupos['Visão geral']) + ')');

  /* -------------------------------------------------------- 2. A tela carrega */
  await pagina.evaluate(() => { window.location.hash = '#/financeiro'; window.Admin.rotear(); });
  await pagina.waitForSelector('#f-kpis .adm-kpi', { timeout: 15000 });
  await pagina.waitForTimeout(900);

  const titulo = (await pagina.locator('#titulo-view').textContent()).trim();
  ok(titulo === 'Financeiro', 'o título da view é "Financeiro" (veio "' + titulo + '")');

  const kpis = (await pagina.locator('#f-kpis').innerText()).replace(/\s+/g, ' ');
  ['Recebido', 'A receber', 'Ticket médio', 'Devolvido', 'Cancelado', 'Descontos']
    .forEach((rotulo) => ok(kpis.includes(rotulo), 'KPI "' + rotulo + '" presente'));
  ok(kpis.includes(brl(api.resumo.recebido.valor)),
    'a tela mostra o Recebido igual à API (' + brl(api.resumo.recebido.valor) + ')');
  ok(kpis.includes(brl(api.resumo.aReceber.valor)),
    'a tela mostra o A receber igual à API (' + brl(api.resumo.aReceber.valor) + ')');
  ok(kpis.includes(brl(api.resumo.reembolsado.valor)),
    'a tela mostra o Devolvido igual à API (' + brl(api.resumo.reembolsado.valor) + ')');

  /* ------------------------------------------------- 3. Quebras por forma/provedor */
  const formas = (await pagina.locator('#f-formas').innerText()).replace(/\s+/g, ' ');
  ok(formas.includes('Pix'), 'a quebra por forma mostra Pix ("' + formas.slice(0, 80) + '")');

  const provedores = (await pagina.locator('#f-provedores').innerText()).replace(/\s+/g, ' ');
  ok(provedores.includes('Simulador interno'), 'a quebra por provedor mostra o Simulador interno');

  /* --------------------------------------------------- 4. Extrato e paginacao */
  const linhasPag1 = await pagina.locator('#f-extrato tbody tr').count();
  ok(linhasPag1 === 25, 'a 1ª página do extrato traz 25 linhas (veio ' + linhasPag1 + ')');

  const paginacao = (await pagina.locator('#f-extrato .adm-paginacao').innerText()).replace(/\s+/g, ' ');
  ok(paginacao.includes(TOTAL_ESPERADO + ' registro(s)'),
    'a paginação diz ' + TOTAL_ESPERADO + ' registros ("' + paginacao + '")');
  ok(paginacao.includes('página 1 de 2'), 'a paginação diz página 1 de 2');

  // A coluna "Quando" mostra tempo relativo ("agora há pouco") e guarda a data
  // absoluta no title — mesma convenção de Pedidos/Usuários/Auditoria.
  const quando = await pagina.locator('#f-extrato tbody tr').first().locator('td').nth(6).evaluate((td) => ({
    texto: td.innerText.trim(),
    titulo: (td.querySelector('[title]') || {}).title || ''
  }));
  ok(quando.texto.length > 0, 'a 1ª linha traz um "Quando" legível ("' + quando.texto + '")');
  ok(/\d{2}\/\d{2}\/\d{4}/.test(quando.titulo),
    'o "Quando" guarda a data absoluta (dd/mm/aaaa) no title ("' + quando.titulo + '")');

  // A coluna Valor precisa trazer dinheiro formatado.
  const valorCelula = await pagina.locator('#f-extrato tbody tr').first().locator('td').nth(5).innerText();
  ok(/R\$\s?\d/.test(valorCelula.replace(/\u00a0/g, ' ')), 'a 1ª linha traz o valor em reais ("' + valorCelula.trim() + '")');

  await pagina.locator('#f-extrato [data-acao="pagina"][data-pagina="2"]').click();
  await pagina.waitForTimeout(1000);
  const linhasPag2 = await pagina.locator('#f-extrato tbody tr').count();
  ok(linhasPag2 === TOTAL_ESPERADO - 25, 'a 2ª página traz ' + (TOTAL_ESPERADO - 25) + ' linhas (veio ' + linhasPag2 + ')');
  const paginacao2 = (await pagina.locator('#f-extrato .adm-paginacao').innerText()).replace(/\s+/g, ' ');
  ok(paginacao2.includes('página 2 de 2'), 'a paginação avançou para a página 2');

  /* ---------------------------------------------------- 5. Filtro de situacao */
  await pagina.locator('[data-mudanca="filtrar-status-financeiro"]').selectOption('reembolsado');
  await pagina.waitForTimeout(1000);
  ok(await pagina.locator('#f-extrato tbody tr').count() === 1, 'o filtro "Devolvidos" deixa 1 linha');
  const textoFiltro = (await pagina.locator('#f-extrato').innerText()).replace(/\s+/g, ' ');
  ok(textoFiltro.includes('Reembolsado'), 'a linha filtrada está marcada como Reembolsado');
  // Com 1 resultado a paginação continua na tela (convenção do painel inteiro:
  // Pedidos, Usuários, Auditoria e Relatórios fazem igual), mas fica em 1 de 1
  // e com os dois botões desabilitados — não há para onde navegar.
  const pagFiltro = (await pagina.locator('#f-extrato .adm-paginacao').innerText()).replace(/\s+/g, ' ');
  ok(pagFiltro.includes('1 registro(s)'), 'com 1 resultado a paginação diz 1 registro ("' + pagFiltro + '")');
  ok(pagFiltro.includes('página 1 de 1'), 'com 1 resultado a paginação diz página 1 de 1');
  ok(await pagina.locator('#f-extrato [data-acao="pagina"][data-pagina="2"]').isDisabled(),
    'com 1 resultado o botão "Próxima" fica desabilitado');
  ok(await pagina.locator('#f-extrato [data-acao="pagina"][data-pagina="0"]').isDisabled(),
    'com 1 resultado o botão "Anterior" fica desabilitado');

  await pagina.locator('[data-mudanca="filtrar-status-financeiro"]').selectOption('pendente');
  await pagina.waitForTimeout(1000);
  ok(await pagina.locator('#f-extrato tbody tr').count() === 1, 'o filtro "A receber" deixa 1 linha');

  await pagina.locator('[data-mudanca="filtrar-status-financeiro"]').selectOption('');
  await pagina.waitForTimeout(1000);

  /* ------------------------------------------------------------- 6. Período */
  await pagina.locator('[data-mudanca="periodo-financeiro"]').selectOption('7');
  await pagina.waitForTimeout(1000);
  const kpis7 = (await pagina.locator('#f-kpis').innerText()).replace(/\s+/g, ' ');
  ok(kpis7.includes(brl(api.resumo.recebido.valor)), 'trocar para 7 dias mantém o mesmo Recebido (tudo é de hoje)');

  const subtitulo = (await pagina.locator('#sub-view').textContent()).trim();
  ok(subtitulo === 'Últimos 7 dias', 'o subtítulo reflete o período, com acento ("' + subtitulo + '")');

  /* ------------------------------------------------------- 7. Sem erro de JS */
  ok(erros.length === 0, 'nenhum erro de JavaScript na tela' + (erros.length ? ' -> ' + erros.join(' ; ') : ''));

  await pagina.evaluate(() => { window.location.hash = '#/financeiro'; window.Admin.rotear(); });
  await pagina.waitForSelector('#f-kpis .adm-kpi');
  await pagina.waitForTimeout(1000);
  await pagina.evaluate(() => window.scrollTo(0, 0));
  await pagina.waitForTimeout(300);
  await pagina.screenshot({ path: path.join(__dirname, 'tmp-prints/financeiro.png') });
  await pagina.screenshot({ path: path.join(__dirname, 'tmp-prints/financeiro-completo.png'), fullPage: true });

  /* --------------------------------------------------- 8. Layout em várias larguras */
  // Ficam de fora, de propósito:
  //   .adm-kpi      -> tem um brilho decorativo (::after em right:-40px) recortado
  //                    pelo overflow:hidden do próprio cartão; scrollWidth acusa
  //                    +40px por design (Relatórios mostra exatamente o mesmo).
  //   .adm-tabela   -> rola na horizontal dentro de .adm-tabela-wrap (white-space:
  //                    nowrap); isso é o comportamento desejado, não um vazamento.
  for (const largura of [1600, 1366, 1180, 1024, 900, 760]) {
    await pagina.setViewportSize({ width: largura, height: 980 });
    await pagina.waitForTimeout(400);
    const m = await pagina.evaluate(() => {
      const raiz = document.documentElement;
      const blocos = Array.from(document.querySelectorAll(
        '#conteudo .adm-cartao, #conteudo .adm-barra, #f-extrato .adm-paginacao, ' +
        '#f-kpis .adm-kpi__rotulo, #f-kpis .adm-kpi__valor, #f-kpis .adm-kpi__nota'
      ));
      const estourados = blocos
        .filter(el => el.scrollWidth > el.clientWidth + 1)
        .map(el => el.className + ' (' + (el.scrollWidth - el.clientWidth) + 'px)');
      return {
        scrollH: raiz.scrollWidth > raiz.clientWidth + 1,
        estourados,
        // O conteúdo do KPI não pode ser recortado pelo overflow:hidden do cartão.
        kpiRecortado: Array.from(document.querySelectorAll('#f-kpis .adm-kpi'))
          .some(k => k.scrollHeight > k.clientHeight + 1)
      };
    });
    ok(!m.scrollH, largura + 'px: sem rolagem horizontal na página');
    ok(m.estourados.length === 0,
      largura + 'px: nenhum bloco estoura' + (m.estourados.length ? ' -> ' + m.estourados.join(', ') : ''));
    ok(!m.kpiRecortado, largura + 'px: nenhum KPI recorta o próprio conteúdo');
  }

  /* ------------------------------------------- 9. Gateways abre da nova posição */
  await pagina.setViewportSize({ width: 1440, height: 980 });
  await pagina.locator('#nav [data-view="gateways"]').click();
  await pagina.waitForTimeout(1200);
  const tituloGw = (await pagina.locator('#titulo-view').textContent()).trim();
  ok(tituloGw === 'Gateways', 'o item Gateways, agora em Sistema, abre a view ("' + tituloGw + '")');
  ok(await pagina.locator('#conteudo .adm-cartao').count() > 0, 'a view de Gateways renderiza os cartões');
  await pagina.screenshot({ path: path.join(__dirname, 'tmp-prints/gateways-em-sistema.png') });

  await navegador.close();
  servidor.close();
  fechar();

  console.log('\n' + (falhas.length ? 'FALHAS: ' + falhas.length : 'Tudo certo: 0 falhas'));
  process.exit(falhas.length ? 1 : 0);
})().catch((e) => { console.error('ERRO FATAL:', e); try { fechar(); } catch { /* ignore */ } process.exit(2); });
