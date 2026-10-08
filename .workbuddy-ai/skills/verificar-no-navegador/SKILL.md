---
name: verificar-no-navegador
description: Verifica telas e fluxos do NEXUS.GG num navegador real (Edge via playwright-core) sem baixar browser e sem deixar processo rodando. Use ao mudar o front (`public/`) ou o painel (`/admin`, `/conta`) e precisar provar que as telas renderizam sem erro de JavaScript — ou ao validar um fluxo de ponta a ponta (carrinho, checkout, login, conta, admin). Sobe o app em processo com banco em memória, dirige o navegador e fecha tudo no fim.
agent_created: true
---

# Verificar o front do NEXUS.GG num navegador real

Objetivo: provar que uma tela ou fluxo funciona **de verdade** (não só "o teste passa"),
sem baixar browser e sem deixar servidor de fundo. O usuário já reclamou de processo
`node server.js` esquecido — por isso a regra é **subir o app em processo**.

## Pré-requisitos (já instalados, fora do projeto)

- `playwright-core` e `jsdom` ficam em `C:\Users\joaovx\.workbuddy-ai\binaries\node\workspace\node_modules`.
  **Não** estão no `node_modules` do projeto — `playwright-core` só é importável por
  **caminho absoluto**.
- Edge do sistema: `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`
  (nunca baixar Chromium).
- Rodar com **Node 24** (`"/c/Program Files/nodejs/node.exe"`), o mesmo que o usuário usa.

## Passo a passo

1. Escreva um script **temporário** na raiz do projeto (`tmp-verificar-*.js`) com
   `'use strict'` e, no topo:
   `process.env.NODE_ENV='test'`, `BANCO_ARQUIVO=':memory:'`, `SEGREDO_APP='segredo-de-teste'`,
   `LOG_NIVEL='silent'`.
2. Suba o app **em processo** (a parte que mais dá errado se esquecer):
   ```js
   const { criarApp } = require('./src/app');
   const { conectar, fechar } = require('./src/db/conexao');
   const { semear } = require('./src/db/semear');
   conectar();
   semear({ silencioso: true });          // NÃO ESQUECER: sem isto o login dá 500
   const servidor = criarApp().listen(0); // porta efêmera
   await new Promise(r => servidor.once('listening', r));
   const base = 'http://127.0.0.1:' + servidor.address().port;
   ```
3. Abra o Edge e dirija o navegador:
   ```js
   const { chromium } = require('C:/Users/joaovx/.workbuddy-ai/binaries/node/workspace/node_modules/playwright-core');
   const navegador = await chromium.launch({ executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true });
   ```
4. Sessão: `await contexto.request.post(base + '/api/auth/login', { data: { email, senha } })`
   — o cookie fica no contexto e vale para as páginas abertas nele.
   Contas demo: `admin@loja.com`/`admin123` · `demo@loja.com`/`demo123`.
5. Navegue com `waitUntil: 'domcontentloaded'` e colete
   `pageerror` + `console` nível `error`.
6. No fim: `await navegador.close(); servidor.close(); fechar();` e **apague o `tmp-*`**.

## Armadilhas que já custaram tempo

- **`networkidle` nunca dispara** onde há SSE (`/admin`): use `domcontentloaded`.
- **`waitForSelector('#x[hidden]')` nunca resolve** — `waitForSelector` espera **visível**
  por padrão, e um elemento `[hidden]` não é visível. Para "ficou escondido", use
  `locator('#x[hidden]').count() === 1`.
- **Esquecer `semear()`** → login responde **500** (não 401) porque o admin não existe.
- O **carrinho abre sozinho** ao adicionar item (`data-add-rapido`): não clique de novo em
  `[data-abrir-carrinho]` — espere `#carrinho.is-open`.
- O único `401` esperado no console é o `/api/auth/me` **anônimo** (uma vez por carga da
  tela de login). Qualquer outro erro de JS é regressão.
- **Estado vazio esconde bugs de layout.** Semeie dados pela API antes de olhar: compre
  (com `metodoPagamento: 'boleto'` para gerar um pedido **pendente**), favorite, avalie.
- Views do `/admin` são SPA por hash: `window.location.hash = '#/gateways'` +
  `window.Admin.rotear()` e espere `#conteudo` ter conteúdo.
  (O endereço antigo `#/pagamentos` continua valendo: o roteador redireciona para
  `#/gateways`. A aba se chama **Gateways** e mora no grupo **Sistema**; o **extrato** dos
  pagamentos recebidos está em **Financeiro**, no grupo **Visão geral**.)
- **Clicar num item do menu é mais fiel que trocar o hash:** se o teste é sobre *onde* o
  item está, use `locator('#nav [data-view="gateways"]').click()` e leia `#titulo-view`.
  Para mapear os grupos, percorra `#nav.children` guardando o último `.adm-nav__grupo`.
- Ao mexer no front e "a tela não mudar": suspeite de **cache** antes da lógica. Hoje a regra
  é única em qualquer ambiente: `/api/*` manda **`no-store`** e os estáticos mandam
  **`no-cache`** (= revalide sempre). Se a tela ainda parecer velha, confira os cabeçalhos com
  `curl -I` antes de acusar o código.
- **`page.bringToFront()` NÃO dispara `visibilitychange` em headless.** O Edge headless mantém
  toda aba `visible`, então a revalidação "na volta à aba" (`Api.aoRevalidar`) nunca dispara
  sozinha. Dispare os eventos à mão:
  ```js
  await page.evaluate(() => {
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('focus'));
  });
  ```
- **Revalidação logo após o `load` é engolida pela janela de carga** (500 ms) — é o
  comportamento **correto** (senão a página buscaria os dados 2×). Se o teste dispara o evento
  cedo demais, ele "não faz nada" e parece bug. Espere ~700 ms (`await page.waitForTimeout(700)`)
  antes de simular a volta à aba.
- **Overflow dentro do cartão não aparece em `document.scrollWidth`.** Uma caixa com
  `overflow: visible` pode ter `scrollWidth > clientWidth` sem gerar rolagem na página.
  Para pegar isso, compare `scrollWidth` com `clientWidth` **de cada item** — foi assim
  que apareceu o bug do bloco de selos da vitrine (`flex: none` + `max-width: 100%`).
  Vale rodar a verificação em **várias larguras** (760 → 1600px), não só na padrão.
- **Três elementos acusam "estouro" por design — exclua-os do medidor**, senão você
  persegue um bug que não existe:
  - **`.adm-kpi`** — o `::after` é um **brilho decorativo** em `top:-40px; right:-40px;
    width:120px`, recortado de propósito pelo `overflow: hidden` do cartão. Toda KPI acusa
    **+40px** de `scrollWidth` (Relatórios idem). Meça os filhos
    (`__rotulo`/`__valor`/`__nota`) ou pule o cartão. Para "o KPI recorta o conteúdo",
    compare `scrollHeight` com `clientHeight` no cartão — isso sim é válido.
  - **`.adm-tabela`** — rola na horizontal **de propósito** (`white-space: nowrap` dentro de
    `.adm-tabela-wrap { overflow-x: auto }`). O que importa é a **página** não rolar.
  - **`.adm-paginacao`** — só existe quando há ≥1 linha (ver abaixo).
- **A paginação do painel aparece com ≥1 linha, mesmo em 1 página.** O padrão é
  `lista.length ? UI.paginacaoHtml(...) : ''` (Pedidos, Usuários, Auditoria, Relatórios,
  Financeiro). Com 1 resultado ela fica "1 registro(s) · página 1 de 1" e os **dois botões
  `disabled`**. **Não** escreva assert esperando que ela suma — e não "conserte" só uma
  view, que fica inconsistente com o resto.
- **`dataAttrData()` mostra tempo RELATIVO**, não data absoluta: renderiza "agora há pouco"
  e guarda a data real no `title` (`01/10/2026 às 00:14`). Procurar `dd/mm/aaaa` no
  `innerText` **falha**. Asserte sobre o `title` da célula.
- **Cuidado ao cortar `innerText` num assert (`.slice(70)`).** O corte cai no meio da última
  célula e faz parecer que valor e data **não existem** — foi exatamente o que me enganou no
  extrato do Financeiro. Corte pelo fim ou leia a célula com `.locator('td').nth(i)`.
- **Para forçar 2 páginas sem depender do seed**, reponha o estoque antes
  (`POST /api/admin/estoque/gerar` com `{ produtoId, planoId, quantidade }`, autenticado como
  admin) e crie os pedidos pela API — o pool do seed acaba e a venda passa a responder 400
  (`estoque_insuficiente`), o que faz o script "criar menos pedidos" silenciosamente.

## Cobertura mínima recomendada

- `/admin`: todas as **15 views** renderizam e as telas novas (Gateways, Indicadores,
  Financeiro) trazem dados reais.
- **Gateways:** o seletor de forma padrão salva e reflete no checkout público
  (`/api/pagamentos/metodos`), e o caso "forma escolhida sem provedor ligado" mostra o
  alerta e cai para outra forma. Para montar esse cenário: desligue o `simulado` e ligue
  só a `stripe` (que aceita apenas `cartao`), então escolha `boleto` como padrão.
- **Financeiro:** o menu (Gateways em **Sistema**, não em Vendas; Financeiro em **Visão
  geral**), os 6 KPIs batendo com `GET /api/admin/financeiro`, as quebras por forma/provedor
  com nome **legível**, e o extrato com paginação + filtro por situação. Semear
  **pago + pendente + reembolsado** antes (o extrato é o único lugar que mostra os três
  juntos) e conferir que o filtro "Devolvidos" deixa 1 linha com selo Reembolsado.
- Vitrine: home (destaques), carrinho com **formas de pagamento** e **cupom**
  (`BEMVINDO10` aplica e aparece a linha de desconto), finalizar.
- **Home em tempo real:** crie um produto novo com `destaque: true` pela API do admin, volte
  para a aba (dispare `visibilitychange`/`focus` à mão — ver armadilha acima), e confira que o
  produto **aparece sem F5** e **entra na frente** (a home mostra os **3 destaques mais
  recentes**). Confirme também que a página **não recarregou** (plante uma marca em
  `window`) e que os destaques foram pedidos **1× só** no load (conte as requisições a
  `/api/produtos/destaques`).
- `/login`: recuperação de senha (2 passos; redefinir retorna 200).
- `/conta`: cancelar pedido pendente (botão + `[data-confirmar]`).
