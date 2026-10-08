# MEMORY.md — Projeto Vendas (NEXUS.GG)

Regras curtas e armadilhas. A descrição completa do sistema está no `README.md`.

## O que é

Loja de licenças digitais para gamers (tema escuro + azul), entrega automática: comprou →
chave na tela. Front em HTML/CSS/JS puro (`public/`), backend Express + SQLite.

## Convenções (não quebrar)

- **Tudo em português** (código, comentários, erros, docs), inclusive nomes de variáveis,
  funções e tabelas (`usuarios`, `vendas`, `criarSessao`).
- **3 camadas, sem exceção:** `repositories/` (só banco) → `services/` (regra, nunca vê
  `req`/`res`) → `routes/` (só traduz HTTP). `app.js` separado de `server.js` para os testes
  subirem o app sem porta.
- **Envelope de erro único:** `{ erro, codigo, detalhes? }` (`detalhes` = `{campo: msg}`).
- **Dinheiro em centavos** (inteiro) no banco; reais só na borda (`utils/dinheiro.js`).
  Desconto percentual arredonda **para baixo**.
- **Migrações imutáveis** — só acrescentar em `db/migracoes.js` (hoje **7**).
  **`.workbuddy-ai/` não é cache** — não apagar.
- **Cache (`app.js`) — uma regra só, em qualquer ambiente:** `/api/*` sai com
  **`Cache-Control: no-store`** (resposta de API nunca é cacheada — sem isso o browser podia
  servir um `/api/produtos/destaques` velho por *heuristic caching*); os **estáticos**
  (`.js`/`.css`/`.html`) saem com **`no-cache`** (= **revalide sempre**: o browser guarda e
  pergunta via ETag/`Last-Modified`, custo de um `304`). **Não voltar** o `max-age` longo em
  produção: sem build/*hash* no nome, `max-age=86400` é uma promessa incumprível e produz o
  pior caso — **HTML novo + JS antigo**, com a correção presa até 24 h. Sintoma de cache velho:
  se o front "não mudar", suspeitar de cache **antes** da lógica.

## Ambiente

- Stack: Node 18+ · Express 4 · better-sqlite3 (síncrono) · sessões em banco · scrypt ·
  Helmet/CSP (`scriptSrc: 'self'`, **sem script inline**) · rate limit em 3 baldes ·
  `node:test` · **SSE** (EventEmitter em processo → `/api/admin/eventos`).
- Comandos: `npm start` · `npm run dev` · `npm test` (**126** testes, SQLite em memória) ·
  `npm run rebuild` (ABI) · `db:migrate` / `db:seed` / `db:reset`.
- **Rodar os testes:** `"/c/Program Files/nodejs/node.exe" --test "testes/*.test.js"` —
  `node --test testes/` **não funciona** (o glob precisa das aspas).
- **Módulo nativo (ABI):** `better-sqlite3` depende do ABI do Node (22 = 127, 24 = 137);
  instalar num Node e rodar noutro = `ERR_DLOPEN_FAILED`. **Mesma versão para instalar e
  rodar.** O usuário roda **Node 24**; o `node` do shell do agente é **Node 22** — invoque o
  Node 24 explicitamente. `require('better-sqlite3')` **não** carrega o `.node` — só o
  primeiro `new Database()`. `src/db/conexao.js` traduz o erro de ABI.
- Contas demo: cliente `demo@loja.com`/`demo123` · admin `admin@loja.com`/`admin123`.

## Regras de negócio que não podem regredir

1. Preço é **sempre** recalculado no servidor; o cliente manda só ids e quantidades.
2. Pedido nasce `pendente`, é cobrado, e só então vira `pago` com licenças emitidas.
3. Boleto não entrega chave antes da confirmação (instruções em
   `vendas.instrucoes_pagamento`; confirma pelo webhook, ou pelo admin no simulador).
4. Validade da licença conta a partir do **resgate**, não da compra.
5. Só quem comprou avalia (compra verificada); uma avaliação por cliente/produto.
6. Cupom só é consumido quando o pagamento confirma (`UPDATE ... WHERE usos < max_usos`).
7. Produto sem plano ativo sai da vitrine, mas continua visível para o admin.
8. Ids de produto derivam do slug (`idEstavel`) — não trocar, quebra carrinhos salvos.
9. **O estoque é a fonte da verdade.** A chave existe no pool **antes** da venda; sem chave
   suficiente a venda é **bloqueada** (`409 estoque_insuficiente`). Consumo **FIFO**, na
   **mesma transação** que emite a licença (se faltar no meio, tudo volta atrás).
10. `estoque_chaves` = o que existe para vender; `licencas` = o que já foi vendido.
    Cancelar/reembolsar devolve as chaves como **`revogada`** (nunca `disponivel`).
11. **Toda** mudança de estoque grava linha em `estoque_movimentos` (com autor).
12. **Editar produto usa UPSERT de planos** (`substituirPlanos`). Nunca DELETE+INSERT:
    apagaria os planos e orfanaria as chaves. O form manda o `id` do plano de volta.
13. **Pagamentos:** gateways em `src/gateways/` (simulador + Mercado Pago, InfinityPay,
    Pagar.me, Asaas, Stripe) atrás do mesmo contrato (`base.js`); provedores reais têm
    prioridade acima do simulador. Credenciais cifradas em AES-256-GCM (chave derivada do
    `SEGREDO_APP`) — a API devolve só a **máscara**; campo vazio preserva, `null` limpa;
    gateway real em produção sem credenciais completas = `422`. O webhook
    (`POST /api/pagamentos/webhook/:gateway`) valida assinatura (inválida → `400`), é
    **idempotente** e registra todo evento em `pagamentos_eventos`.
14. **Nomenclatura (não misturar):** **GATEWAY** = provedor que cobra → é o **módulo**
    (aba e rotas `/api/admin/gateways`) e fica no grupo **Sistema** da sidebar (é
    infraestrutura, não operação); **FORMA DE PAGAMENTO** = pix/cartão/boleto;
    **PAGAMENTO** = o recebido → o **extrato** fica em **Financeiro** e o **detalhe/status**
    em **Pedidos**. O painel tem alias: `#/pagamentos` redireciona para `#/gateways`
    (`ALIASES` em `admin.js`). As rotas **públicas**
    seguem `/api/pagamentos/*` de propósito (contrato do carrinho + URL de webhook já
    cadastrada nos provedores) — **não** renomear. Os arquivos `pagamento.service.js`,
    `pagamentos.repo.js` e `pagamentos.routes.js` também ficam: tratam do pagamento em si.
15. **Forma de pagamento padrão é preferência, não garantia.** O admin escolhe no seletor
    da aba Gateways (`PATCH /api/admin/gateways/metodo-padrao` → `configuracoes`, chave
    `metodo_pagamento_padrao`); ela vem pré-selecionada no checkout. Se nenhum gateway
    ligado aceitar a forma escolhida, `escolherMetodo()` **cai para a primeira disponível**
    em vez de bloquear a venda — o painel avisa e marca a opção "(sem provedor)". O
    `PAGAMENTO_METODO_PADRAO` do `.env` é só fallback.
16. **Backfill do estoque (não remover):** o seed só roda quando `bancoVazio()`. Num banco
    já existente, a migração do estoque cria tabelas vazias e a loja fica "esgotada" →
    para de vender. Por isso o `server.js` chama `garantirEstoqueInicial()` quando
    `estoqueNuncaInicializado()` (não há chave **E** não há movimento) — o critério "sem
    movimentos" respeita o admin: se ele descartou tudo de propósito, nada é reposto.
17. **Relatórios × Financeiro (não é duplicação, é foco):** `relatorios` = **desempenho**
    ("estou vendendo bem?") e olha **só pedidos pagos** (tendência, série diária, top
    produtos, categorias, cupons). `financeiro` = **caixa** ("quanto entrou e quanto falta
    entrar?") e olha **todos os status** (recebido, a receber, devolvido, cancelado,
    descontos, extrato). O boleto pendente **não** aparece em Relatórios e **precisa**
    aparecer em Financeiro. Serviço em `financeiro.service.js`; consultas em
    `vendas.repo.js`; reusa `montarJanela()` do `relatorio.service` (mesmo formato de
    janela). Ticket médio do Financeiro é **derivado** do recebido — nunca um número solto.
    O extrato (`/admin/financeiro/pagamentos`) é o **único** lugar do painel que mostra
    pago, pendente e reembolsado **juntos**.
18. **A home mostra os 3 destaques MAIS RECENTES — não os de menor `ordem`.** `destaques()`
    (`catalogo.service.js`) usa `ordem: 'recentes'` (`criado_em DESC, ordem DESC, nome ASC`;
    o `ordem DESC` desempata `criado_em` igual no mesmo ms). **Não voltar para `relevancia`:**
    `proximaOrdem()` põe todo produto novo **no fim** (`MAX(ordem)+1`), então com `ordem ASC`
    um destaque recém-criado **nunca** entra no top 3 (era o bug do "produto novo não aparece
    na home"). A "Ordem na vitrine" manda só no **catálogo** (`/api/produtos`); a **home
    ignora** esse campo — marcar como destaque **basta**.

## Status HTTP (conferir em `src/utils/erros.js` antes de afirmar)

`ErroValidacao` = **400 `dados_invalidos`** · `RegraNegocio` = **422 `regra_de_negocio`**
(é o caso do gateway real em produção sem credenciais) · `Conflito`/`EstoqueInsuficiente`
= **409** · `SemPermissao` = **403**. Já errei isso uma vez escrevendo 422 para validação.

## Segurança

- `dynamoveto` era **malware**, foi removido. O `Projeto Vendas.zip` da raiz é o pacote
  antigo contaminado — não instalar a partir dele.
- Login não revela se o e-mail existe (mensagem e custo de CPU idênticos). Trocar/redefinir
  senha derruba as outras sessões. Tokens de recuperação: só o SHA-256 vai ao banco, uso
  único. Fora de produção a recuperação devolve o token na resposta (testável) — em
  produção, ligar e-mail e remover o campo.

## Armadilhas de front / painel (as que já custaram tempo)

- **Sem script inline** (CSP): delegação por
  `data-acao`/`data-mudanca`/`data-entrada`/`data-form` — nunca `onclick`.
- **Predicado único `Api.ehAdmin(usuario)`** (em `api.js`; aceita `admin` e o legado
  `administrador`). Não reintroduzir `papel === 'admin'` solto.
- **A sessão reconhece o lado administrativo** — não se digita `/admin`. Admin vai direto a
  `/admin` (`login.js#destinoPara`); `?next=` explícito vence. Logado, o cabeçalho mostra
  "Painel" e o `/conta` mostra "Painel administrativo" na **barra superior**
  (`#conta-admin-topo` — a lateral vira gaveta em telas estreitas). Cliente logado abrindo
  `/admin` vê "Sair e entrar com outra conta" para não cair em loop.
- **SSE:** o cliente faz **debounce** e **não repinta com gaveta/modal aberto** (só os
  contadores). **Estoque no painel:** filtro/busca **no cliente**; `data-entrada`
  guarda/restaura o foco (a view repinta e recria o elemento).
- **Vitrine se revalida ao voltar para a aba (`Api.aoRevalidar`, `api.js`):** home e vitrine
  buscavam os dados **1× no `load`** — um produto criado no painel (outra aba) só aparecia
  com **F5**. `aoRevalidar(cb, {intervaloMs, debounceMs, imediato})` dispara em
  `visibilitychange`/`focus`, com **debounce 200 ms**, **máx. 1×/min** e **janela de carga
  500 ms** (engole eventos logo após o `load`, senão busca 2×). Home e vitrine **só repintam
  se o HTML mudou** (na vitrine preserva os filtros; na home evita "piscar"). A home **não
  apaga** a lista visível se a revalidação falhar. O `/admin` **não** usa isso — lá é SSE.
- **`atividades` ≠ `auditoria`:** `auditoria` é a trilha do **admin**; `atividades` é o que o
  **cliente** fez, exibido a ele. Nunca misturar. Catálogos (tipos de atividade, opções de
  preferência) ficam **no servidor** — o front monta os controles a partir dos dados.
  Preferências são **4 colunas em `usuarios`** (1:1, sem JOIN). `atividade.service.registrar()`
  é **try/catch** (histórico nunca derruba a operação). "Salvar sem mudar nada" não registra.
- **Carrinho (`public/js/cart.js`):** forma de pagamento (de `/api/pagamentos/metodos`),
  cupom (campo + chips de `/api/cupons`, prévia por `/api/cupons/validar`, revalidado a cada
  mudança do carrinho), `numero` do pedido e, em boleto, as instruções.
- **Modal do produto:** clicar no card **abre o modal** (não adiciona); o `+` do card
  (`data-add-rapido`, `z-index: 6`) é adição rápida. O modal **não** consulta
  `/api/auth/me` ao abrir. `descricao` (curta) e `descricaoLonga` (modal, até 4000 chars,
  **sem quebra de linha**).
- **Relatórios:** janela `[desde, ate)` ISO/UTC, comparada ao período anterior de mesmo
  tamanho. Só leitura, sem exportação (decisão do usuário).
- **Onde se configura o gateway:** sidebar → grupo **Sistema** → **Gateways** (selo `demo`
  enquanto só o simulador estiver ligado). É lá que se liga/desliga provedor, define
  ambiente/prioridade/formas, credenciais, a **forma de pagamento padrão** e a URL de
  webhook — **não** em Configurações. Foi movido de **Vendas** para **Sistema** porque é
  configuração de infraestrutura, não operação do dia a dia.
- **O dinheiro fica em `#/financeiro`** (grupo **Visão geral**, ao lado de Painel e
  Relatórios): 6 KPIs, quebras por forma/provedor e o extrato. `gateways` **não** entra em
  `VIEWS_POR_EVENTO` de propósito (a tela tem formulários de credencial — repintar apagaria
  o que está sendo digitado); `financeiro` entra em `venda.atualizada`.
- **CSS — badges em linha flex:** selo/badge dentro de um `display:flex` precisa de
  `flex: none` (senão encolhe) e o container de `flex-wrap: wrap`; texto com `flex: 1`
  sem `min-width: 0`/`overflow-wrap` esmaga e **sobrepõe** os vizinhos. Foi o bug da
  faixa "Formas de pagamento" (`.adm-vitrine`).
- **CSS — `flex: none` num bloco de selos também estoura:** com `flex: none` a largura
  fica no `max-content`, então se o bloco não couber nem sozinho numa linha ele **vaza
  para fora da borda do cartão**. `.adm-vitrine__meta` precisa de **`max-width: 100%`**
  (assim os selos quebram entre si). Bug real, pego só medindo em várias larguras.
- **Medir overflow:** `document.scrollWidth` **não** denuncia overflow *dentro* de uma
  caixa com `overflow: visible`. Compare `scrollWidth` com `clientWidth` **de cada item**
  e repita em várias larguras (760→1600px).
- **Ao medir overflow, excluir estes — os três acusam "estouro" por design:**
  - **`.adm-kpi`** — o `::after` é um brilho decorativo em `top:-40px; right:-40px;
    width:120px`, recortado pelo `overflow: hidden` do cartão. `scrollWidth` acusa
    **+40px** em toda KPI (Relatórios mostra os mesmos 40px). Meça os filhos
    (`__rotulo`/`__valor`/`__nota`) ou pule o cartão.
  - **`.adm-tabela`** — rola na horizontal de propósito (`white-space: nowrap` dentro de
    `.adm-tabela-wrap { overflow-x: auto }`). O que importa é a **página** não rolar.
  - **`.adm-paginacao`** — só aparece quando há ≥1 linha.
- **`dataAttrData()` mostra tempo RELATIVO** ("agora há pouco") e guarda a data absoluta no
  `title` (`01/10/2026 às 00:14`). Procurar `dd/mm/aaaa` no `innerText` **falha** — olhe o
  `title`. (Convenção de Pedidos/Usuários/Auditoria/Financeiro.)
- **A paginação do painel aparece com ≥1 linha, mesmo em 1 página** — `lista.length ?
  paginacaoHtml(...) : ''` em Pedidos, Usuários, Auditoria, Relatórios e Financeiro. Com 1
  resultado fica "1 registro(s) · página 1 de 1" e os **dois botões `disabled`**. Não é bug,
  e mudar só uma view criaria inconsistência.
- **Ao cortar `innerText` num assert, cuidado com `.slice(n)`** — corta no meio da última
  célula e faz parecer que valor/data não existem. Já me enganou no extrato do Financeiro.

## Pendências / próximos passos

- Escolhidos pelo usuário e **não implementados**: programa de indicação, busca/filtros
  avançados na vitrine. (Recuperação por e-mail real e webhook já existem — falta só ligar o
  envio de e-mail em produção.) Pagamento real exige credenciais no painel.
- `src/middlewares/manutencao.js` lê o modo manutenção do banco com cache de 10s.
- O barramento de eventos é **por instância** — com várias instâncias, trocar o
  `EventEmitter` por Redis pub/sub (a rota SSE não muda).

## Verificar no navegador (sem baixar browser, sem deixar processo solto)

- `playwright-core` e `jsdom` estão em `~/.workbuddy-ai/binaries/node/workspace` (**não** no
  `node_modules` do projeto); `playwright-core` só é importável por **caminho absoluto**.
  Edge do sistema: `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`.
- **Melhor padrão: subir o app em processo.** `BANCO_ARQUIVO=':memory:'` → `conectar()` →
  `semear({ silencioso: true })` (**não esquecer o `semear`**, senão o login dá 500) →
  `criarApp().listen(0)` → dirigir o navegador → `servidor.close()` + `fechar()`.
- Login: `POST /api/auth/login` (montado em `/api/auth`). `waitUntil: 'domcontentloaded'` —
  **`networkidle` nunca dispara** onde há SSE (`/admin`). Único `401` esperado é
  `/api/auth/me` anônimo.
- **Armadilha:** `waitForSelector('#x[hidden]')` **nunca** resolve — `waitForSelector` espera
  **visível** por padrão. Para "ficou escondido", use `locator('#x[hidden]').count() === 1`.
- **Armadilha (headless):** `page.bringToFront()` **não** dispara `visibilitychange` — o Edge
  headless mantém toda aba `visible`. Para testar revalidação na volta à aba, dispare à mão:
  `document.dispatchEvent(new Event('visibilitychange'))` + `window.dispatchEvent(new Event('focus'))`.
- **Armadilha (timing):** revalidação disparada **logo após o `load`** é (corretamente)
  engolida pela janela de carga (500 ms). Espere ~700 ms antes de simular a volta à aba.
- Em telas com **estado vazio e preenchido**, testar só o vazio esconde quase todos os bugs
  de layout. Semear dados pela API antes de olhar.
- Views do `/admin` são SPA por hash: mude `window.location.hash` e chame
  `window.Admin.rotear()`. A aba de provedores é **`#/gateways`** (`#/pagamentos` redireciona).
- A skill do projeto `.workbuddy-ai/skills/verificar-no-navegador/` tem o passo a passo.
