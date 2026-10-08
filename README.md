# NEXUS.GG — loja de licenças digitais

Loja de produtos digitais para gamers com **entrega automática**: o cliente compra, o
pagamento é aprovado e a chave de licença aparece na tela na hora. Tema escuro com
destaque azul.

Este repositório contém o **front-end** (páginas e assets em `public/`) e o
**back-end completo** que o alimenta: API REST, persistência em SQLite, autenticação
por sessão, checkout com **escolha de forma de pagamento** (Pix, cartão, boleto) e
cupons, **gateways de pagamento plugáveis** (simulador + provedores reais),
**estoque de chaves por plano**, emissão e resgate de licenças, avaliações, lista de
desejos, painel administrativo **sincronizado em tempo real** e trilha de auditoria.

---

## Stack

| Camada       | Tecnologia                                                    |
| ------------ | ------------------------------------------------------------- |
| Runtime      | Node.js 20+ (testado no 22 e no 24)                           |
| Servidor     | Express 4                                                     |
| Banco        | SQLite via `better-sqlite3` (síncrono, sem servidor externo)   |
| Sessão       | Cookie `httpOnly` + sessões no banco                          |
| Senhas       | `scrypt` com salt por usuário                                 |
| Segurança    | Helmet (CSP), CORS restrito, rate limit em 3 baldes            |
| Testes       | `node:test` (126 testes de integração)                        |

Zero serviços externos obrigatórios: `npm install && npm start` já sobe a loja
funcionando, com catálogo e contas de demonstração.

---

## Rodar

```bash
npm install
cp .env.example .env     # opcional: os padrões já funcionam
npm start
```

Abra <http://localhost:3000>.

Na primeira execução o banco é criado, o schema é migrado e o catálogo inicial é
semeado automaticamente — não existe passo manual de setup. O seed também gera as
**chaves de estoque** de cada plano (40 por plano, com dois planos deixados de propósito
no limite para o painel já nascer mostrando os alertas de reposição).

> **Módulo nativo e versão do Node.** O `better-sqlite3` é um módulo **nativo**:
> o binário compilado depende da versão exata do Node (ABI). Use **a mesma versão
> do Node** para instalar e para rodar — instalar no Node 22 e rodar no Node 24
> causa o erro `NODE_MODULE_VERSION ... was compiled against a different Node.js
> version`. Se isso acontecer, rode `npm run rebuild` (ou apague `node_modules` e
> rode `npm install` de novo) **com a versão do Node que você vai usar**.
> O projeto já traz o campo `allowScripts` no `package.json`, necessário para o
> npm (11.19+) permitir a compilação do módulo nativo durante o `npm install`.

### Contas de demonstração

| Perfil        | E-mail           | Senha      |
| ------------- | ---------------- | ---------- |
| Cliente       | `demo@loja.com`  | `demo123`  |
| Administrador | `admin@loja.com` | `admin123` |

O botão **"Entrar com a conta demo"** na tela de login já preenche a conta de cliente.

### Scripts

| Comando               | O que faz                                                      |
| --------------------- | -------------------------------------------------------------- |
| `npm start`           | Sobe o servidor                                                |
| `npm run dev`         | Sobe com reinício automático (nodemon)                          |
| `npm run rebuild`     | Recompila o `better-sqlite3` para a versão atual do Node        |
| `npm run build`       | Minifica e versiona o front em `dist/public/` (para publicar)   |
| `npm run pack`        | Build + pacote de deploy pronto em `dist/`                      |
| `npm test`            | Roda a suíte de testes (banco em memória, não toca nos dados)    |
| `npm run db:migrate`  | Aplica só as migrações pendentes                                |
| `npm run db:seed`     | Popula catálogo, cupons e contas demo (idempotente)             |
| `npm run db:reset`    | Apaga o banco e recria do zero (pede confirmação)               |

---

## Build e produção

O front roda **sem build** — em desenvolvimento o servidor serve `public/` direto, então
editar um `.js` e recarregar já mostra a mudança. Para **publicar**, existe um build que
minifica e põe *hash* de conteúdo no nome dos arquivos.

```bash
npm run build     # gera dist/public/
npm run pack      # build + dist/deploy/ + dist/nexus-gg-deploy.zip
```

### O que o build faz

1. **Lê as listas de arquivos do próprio HTML.** Não há lista hardcoded no build: incluir um
   script novo numa página é só acrescentar a tag no HTML. (Um recurso externo — a fonte do
   Google — é ignorado; um recurso local que não exista faz o build **falhar**.)
2. **Minifica e concatena** com [esbuild](https://esbuild.github.io/). Cada arquivo é
   minificado *isoladamente*, como script, e os resultados são concatenados na ordem em que
   o HTML já carregava — não é empacotamento de módulos. O motivo: os 13 arquivos de
   `public/js` são IIFE que só conversam por `window.*` (`Api`, `UI`, `Carrinho`,
   `AdminUI`…). Não há um único `import`/`export` no projeto, então não existe grafo de
   módulos — empacotar só arriscaria renomear os globais e quebrar a loja. A ordem de
   execução fica idêntica à de antes.
3. **Separa o que é comum do que é exclusivo.** As 6 páginas começam pelos mesmos
   `base.css`, `app.css` e `api.js`; isso sai uma vez para o site inteiro, e o resto vai por
   página. Resultado: **2 arquivos de JS e 2 de CSS por página**, em vez de 4 a 8.
4. **Põe *hash* de conteúdo no nome:** `comum.9f3a2b1c.js`. É o que permite
   `Cache-Control: immutable` de um ano sem risco de servir JavaScript velho (ver
   [Cache](#cache-nada-de-resposta-presa-no-navegador)).
5. **Reescreve o HTML** para apontar aos nomes novos e **remove as tags repetidas** (seis
   tags virando o mesmo bundle deixariam seis linhas mortas). O HTML **não** é minificado:
   os comentários dele são documentação, e a diferença depois de gzip é irrelevante.
6. Grava `dist/manifest.json` com o mapa `arquivo original → arquivo gerado`.

### Ganho medido

| | antes | depois |
| --- | --- | --- |
| Painel admin (1ª visita) | 8 requisições, 77,1 KB gzip | 4 requisições, 52,1 KB gzip (**−32 %**) |
| Painel admin (2ª visita) | 77,1 KB | **0 bytes** (o navegador reusa o `immutable`) |
| Site inteiro (js+css) | 21 arquivos, 514,2 KB | 14 arquivos, 448,1 KB (**−12,8 %**) |

### O que o servidor faz em cada ambiente

| Ambiente | Serve | Efeito |
| --- | --- | --- |
| Desenvolvimento | `public/` direto | editar e recarregar, sem build |
| Produção, com `dist/` | `dist/public/` | minificado + `immutable` de 1 ano |
| Produção, **sem** `dist/` | `public/` + **aviso no boot** | funciona igual, só que sem os ganhos |

O terceiro caso é proposital: **produção sem build não quebra o servidor.** Ele sobe, avisa
no log e serve do jeito antigo. Um deploy esquecido aparece como aviso, não como página
quebrada.

### Publicando

```bash
npm run build
npm run pack
```

O `pack` monta `dist/deploy/` (lista branca: `server.js`, `src/`, `scripts/` do banco,
`dist/public/`, `package.json`, `package-lock.json`, `.env.example` e um `INSTRUCOES.txt`)
e fecha em `dist/nexus-gg-deploy.zip` no Windows. **Nunca** entram `.env`, `dados/`,
`node_modules/` — a montagem é por lista branca, e há uma conferência que falha o empacotar
se algum deles aparecer.

No servidor:

```bash
npm ci --omit=dev     # esbuild é devDependency: em produção não é instalado
npm start
```

Confira o boot. Deve aparecer:

```
Front servido do build (dist/public): minificado e com cache longo
```

---

## Estrutura

```
server.js                    boot: migra, semeia, sobe o HTTP, encerra com graça
src/
  config/index.js            lê e valida o .env uma única vez
  app.js                     monta o Express (testável sem abrir porta)
  db/
    conexao.js               conexão SQLite única + helper de transação
    migracoes.js             schema versionado
    catalogo.js              catálogo inicial (fonte de verdade do seed)
    semear.js                semeadura idempotente + dados de amostra
  repositories/              acesso a dados (SQL preparado, mapeamento p/ camelCase)
    usuarios · sessoes · tokens · produtos · vendas · licencas
    cupons · avaliacoes · favoritos · auditoria · configuracoes · estoque · atividades
  services/                  regras de negócio
    auth · catalogo · checkout · cupom · licenca · pagamento · gateway
    avaliacao · favorito · conta · admin · metricas · estoque · relatorio · atividade
  gateways/                  provedores de pagamento plugáveis
    index · catalogo · base (contrato comum)
    simulado · mercadopago · pagarme · stripe · asaas · infinitypay
  routes/                    camada HTTP
    index · auth · produtos · vendas · licencas · cupons · pagamentos
    avaliacoes · favoritos · conta · admin
  middlewares/               contexto · sessao · limites · validar · manutencao · erros
  utils/                     erros · seguranca · cripto · validacao · dinheiro · datas · logger · eventos
                             cache (política de Cache-Control por nome de arquivo)
scripts/
  build.js                   build do front: minifica, versiona e reescreve o HTML
  pacotar.js                 monta o pacote de deploy em dist/
  migrar.js · semear.js · reiniciar.js    CLIs de banco
testes/
  api.test.js                testes de integração (API, regras e HTTP)
  build.test.js              build do front e política de cache
  proxy.test.js              TRUST_PROXY e identificação do IP
public/                      front-end (HTML, CSS, JS)
  index.html · produtos.html · login.html · termos.html · admin.html · conta.html
  css/                       base, app (vitrine) e um arquivo por página
  js/
    api.js                   cliente HTTP + utilidades (window.Api)
    ui.js                    cards, ícones, cabeçalho (window.UI)
    produto-modal.js         modal de detalhes do produto (window.ProdutoModal)
    cart.js                  carrinho lateral (window.Carrinho)
    home.js · produtos.js · login.js
    loja-ajustes.js          aplica os ajustes do painel na loja (aviso, destaque, suporte,
                             tela de manutenção) via GET /api/loja/ajustes
  css/loja-ajustes.css       estilos do aviso no topo, destaque, links de suporte e manutenção
  css/admin.css              estilos do painel (reaproveitados pela conta)
  js/admin-ui.js             componentes reutilizáveis (AdminUI) — usados pelo admin E pela conta
  js/admin-estoque-chaves.js gaveta "Chaves do plano" (filtro, seleção, remover/excluir)
  js/admin-configuracoes.js  tela "Configurações" (seções, validação, alterações pendentes)
  js/admin.js                views, roteador e regras do painel admin (Admin)
  css/conta.css              estilos exclusivos do painel do cliente
  js/conta.js                views, roteador e regras do painel do cliente (Conta)
dados/nexus.db               banco (criado no primeiro boot, fora do git)
dist/                        saída do build (gerado, fora do git)
```

A separação é rígida e vale a pena respeitar: **repositório** só fala com o banco,
**serviço** só fala com repositório e nunca vê `req`/`res`, **rota** só traduz HTTP
para chamadas de serviço. É o que permite testar o checkout inteiro sem subir HTTP.

> **Código antigo:** a versão anterior (banco em memória, com tudo em `src/data/db.js`)
> foi substituída por esta arquitetura. Os arquivos originais foram preservados em
> `.workbuddy-ai/backup-codigo-antigo/` — não são carregados por nada, servem só de
> referência histórica. Não edite o catálogo por lá: a fonte de verdade agora é
> `src/db/catalogo.js` (para o seed) e o banco (em runtime).

---

## Variáveis de ambiente

Todas têm padrão sensato; o arquivo `.env` é opcional em desenvolvimento.
A referência completa comentada está em `.env.example`.

| Variável                    | Padrão              | Para que serve                                     |
| --------------------------- | ------------------- | -------------------------------------------------- |
| `PORT`                      | `3000`              | Porta HTTP                                          |
| `NODE_ENV`                  | `development`       | `production` endurece cookies e o log               |
| `LOJA_NOME`                 | `NEXUS.GG`          | Nome exibido e usado nas respostas                  |
| `LOJA_URL`                  | `http://localhost:3000` | Base dos links em e-mails de recuperação       |
| `BANCO_ARQUIVO`             | `./dados/nexus.db`  | Caminho do SQLite                                   |
| `SESSAO_DIAS`               | `7`                 | Validade do "lembrar-me"                            |
| `SEGREDO_APP`               | aleatório           | **Defina em produção** — também deriva a chave que cifra as credenciais dos gateways |
| `CORS_ORIGIN`               | vazio (desligado)   | Origens extras liberadas                            |
| `ADMIN_EMAILS`              | vazio               | E-mails promovidos a admin automaticamente          |
| `PAGAMENTO_PROVEDOR`        | `simulado`          | Rótulo do provedor exibido no diagnóstico           |
| `PAGAMENTO_METODO_PADRAO`   | `pix`               | Método quando o cliente não informa                 |
| `LOG_NIVEL`                 | `info`              | `debug` · `info` · `warn` · `error` · `silent`      |
| `TRUST_PROXY`               | `loopback`          | `false` sem proxy · `1`/`2`… nº de proxies · lista de IPs/CIDRs (`true` = `1`) |
| `RATE_LIMIT_GERAL`          | `300`               | Requisições por minuto por IP                       |
| `RATE_LIMIT_AUTH`           | `10`                | Tentativas de login por 15 min                      |

---

## API

Base: `/api`. Erros seguem sempre o mesmo envelope:

```json
{ "erro": "mensagem amigável", "codigo": "identificador", "detalhes": { "campo": "..." } }
```

`detalhes` só aparece em erros de formulário. **(login)** = exige cookie de sessão.
**(admin)** = exige papel `admin`.

### Diagnóstico

| Método | Rota            | Descrição                                                      |
| ------ | --------------- | -------------------------------------------------------------- |
| GET    | `/status`       | Nome da loja, versão, ambiente e hora                           |
| GET    | `/saude`        | Health check: processo **e** banco (503 se o banco cair)         |

### Autenticação

| Método | Rota                        | Descrição                                                        |
| ------ | --------------------------- | ---------------------------------------------------------------- |
| POST   | `/auth/login`               | `{ email, senha, lembrar? }` → `{ usuario }`                      |
| POST   | `/auth/registrar`           | `{ nome, email, senha }` → `201 { usuario }`                      |
| POST   | `/auth/logout`              | Encerra a sessão → `204`                                          |
| GET    | `/auth/me`                  | Usuário logado ou `401`                                           |
| PATCH  | `/auth/senha` **(login)**   | `{ senhaAtual, novaSenha }` — derruba as outras sessões           |
| POST   | `/auth/recuperar-senha`     | `{ email }` — resposta idêntica exista ou não a conta             |
| POST   | `/auth/redefinir-senha`     | `{ token, senha }` — token de uso único                           |
| GET    | `/auth/sessoes` **(login)** | Dispositivos com sessão aberta                                    |
| POST   | `/auth/sessoes/encerrar-outras` **(login)** | "Sair dos outros aparelhos"                       |

> **Recuperação de senha sem servidor de e-mail:** fora de produção, a resposta inclui
> `token` e `link` para o fluxo ser testável. Em produção, ligue o envio por e-mail em
> `auth.service.js` e remova esses campos.

### Catálogo

| Método | Rota                  | Descrição                                                            |
| ------ | --------------------- | -------------------------------------------------------------------- |
| GET    | `/produtos`           | Lista. Filtros: `?categoria=` `?destaque=true` `?busca=` `?ordem=`     |
| GET    | `/produtos/categorias`| `[{ nome, total }]`                                                  |
| GET    | `/produtos/destaques` | Atalho para a home: **todos** os destaques, mais recentes primeiro (`?limite=` opcional, máx. 100) |
| GET    | `/produtos/:id`       | Um produto — aceita o **id (UUID)** ou o **slug**                     |

`ordem` aceita: `relevancia` (padrão) · `menor-preco` · `maior-preco` · `avaliacao` · `recentes`.

**A home não usa `relevancia`.** `/produtos/destaques` lista **todos** os destaques, os
**mais recentes** primeiro (`ordem: 'recentes'` → `criado_em DESC, ordem DESC, nome ASC`).
Não há limite de 3: cada produto marcado como destaque no painel aparece na home. A ordem por
recência é de propósito: todo produto novo entra no catálogo com a **maior** `ordem`
(`proximaOrdem()` = `MAX(ordem)+1`), ou seja, **no fim** da vitrine — se a home ordenasse
por `relevancia` (`ordem ASC`), um destaque recém-criado iria para o fim da seção. O campo "Ordem na vitrine"
continua mandando no catálogo (`/api/produtos`); a home ignora esse campo.

Filtro por categoria ignora acentos e maiúsculas: `?categoria=otimizacao` encontra
`Otimização`.

**Descrição do produto:** cada produto tem duas — `descricao` (curta, vai no card e
entra na busca) e `descricaoLonga` (texto completo, exibido no modal de detalhes). Se a
longa estiver vazia, o front cai na curta.

**Paginação:** sem `?limite`/`?pagina` a rota devolve um **array** (é o que a vitrine
consome). Com esses parâmetros, continua devolvendo array, mas com os totais nos
cabeçalhos `X-Total-Count`, `X-Page`, `X-Per-Page` e `X-Total-Pages`.

### Checkout e pedidos

| Método | Rota                                  | Descrição                                                |
| ------ | ------------------------------------- | -------------------------------------------------------- |
| POST   | `/vendas` **(login)**                 | Cria o pedido e devolve as chaves                        |
| GET    | `/vendas` **(login)**                 | `{ quantidade, total, vendas }`                          |
| GET    | `/vendas/:id` **(login)**             | Detalhe (só o dono ou admin)                             |
| POST   | `/vendas/:id/cancelar` **(login)**    | Cancela pedido ainda não pago                            |
| POST   | `/vendas/:id/confirmar-pagamento` **(admin)** | Simula o webhook do provedor e libera as chaves  |

Corpo do checkout:

```json
{
  "itens": [{ "produtoId": "uuid", "planoId": "7d", "quantidade": 2 }],
  "cupom": "BEMVINDO10",
  "metodoPagamento": "pix"
}
```

Resposta (`201`):

```json
{
  "id": "uuid",
  "numero": "NX-E9683F",
  "status": "pago",
  "total": 59.98,
  "desconto": 0,
  "itens": [
    { "nome": "FPS Booster - Basic", "plano": "7 dias", "quantidade": 2,
      "chaves": ["2F37-5054-092C-58E4", "792B-4DDB-44F6-5595"] }
  ],
  "chaves": ["2F37-5054-092C-58E4", "792B-4DDB-44F6-5595"]
}
```

### Licenças

| Método | Rota                 | Descrição                                                     |
| ------ | -------------------- | ------------------------------------------------------------- |
| GET    | `/licencas` **(login)**       | Minhas chaves (`?produtoId=` `?status=`)             |
| GET    | `/licencas/resumo` **(login)**| Contagem por situação                                |
| POST   | `/licencas/resgatar` **(login)** | `{ chave }` — ativa a chave e começa a contar o prazo |

### Cupons

| Método | Rota               | Descrição                                                          |
| ------ | ------------------ | ------------------------------------------------------------------ |
| GET    | `/cupons`          | Cupons ativos (campanha pública)                                    |
| POST   | `/cupons/validar`  | `{ codigo, itens }` → desconto calculado sem criar pedido           |

### Pagamentos

Estas rotas são **públicas** e mantêm o nome `pagamentos` de propósito: são o contrato do
**checkout** com o navegador e com os provedores, não o módulo administrativo (esse é
**Gateways**, em `/admin/gateways`). Renomeá-las quebraria o carrinho e as URLs de webhook
já cadastradas nos painéis dos provedores.

| Método | Rota                          | Descrição                                                     |
| ------ | ----------------------------- | ------------------------------------------------------------- |
| GET    | `/pagamentos/metodos`         | Formas de pagamento que a vitrine pode oferecer **agora** (`{ metodos, padrao }`) |
| POST   | `/pagamentos/webhook/:gateway`| Notificação do gateway — valida a assinatura e confirma/cancela o pedido |

`GET /pagamentos/metodos` é o que o carrinho consome para montar o seletor: a vitrine
nunca "inventa" um meio de pagamento que nenhum gateway ativo aceita. O campo `padrao` é a
**forma padrão** escolhida no painel, já resolvida para uma forma disponível. O **webhook**
é a única porta pela qual um pedido pendente vira pago sem um admin clicar: ele valida a
assinatura, registra **todo** evento recebido (válido ou não, para auditoria) e é
**idempotente** — confirmar duas vezes o mesmo pedido não faz efeito duplo.

### Avaliações

| Método | Rota                            | Descrição                                       |
| ------ | ------------------------------- | ----------------------------------------------- |
| GET    | `/avaliacoes/produto/:produtoId`| Avaliações públicas + média                     |
| GET    | `/avaliacoes/minhas` **(login)**| O que eu já avaliei                             |
| POST   | `/avaliacoes` **(login)**       | `{ produtoId, nota, comentario }` — exige compra |
| DELETE | `/avaliacoes/:id` **(login)**   | Remove a minha (ou admin)                       |

### Favoritos **(login)**

| Método | Rota                              | Descrição                        |
| ------ | --------------------------------- | -------------------------------- |
| GET    | `/favoritos`                      | Produtos favoritados             |
| POST   | `/favoritos/:produtoId`           | Adiciona                         |
| DELETE | `/favoritos/:produtoId`           | Remove                           |
| POST   | `/favoritos/:produtoId/alternar`  | Alterna (para o botão de coração)|

### Conta **(login)**

| Método | Rota                  | Descrição                                              |
| ------ | --------------------- | ------------------------------------------------------ |
| GET    | `/conta`              | Painel: pedidos, chaves, gasto, favoritos, atividades e preferências |
| GET    | `/conta/pedidos`      | Histórico (`?status=`)                                 |
| GET    | `/conta/dispositivos` | Sessões abertas                                        |
| GET    | `/conta/atividades`   | Linha do tempo do cliente (`?tipo=` `?busca=` `?limite=` `?deslocamento=`) |
| DELETE | `/conta/atividades`   | Apaga o próprio histórico                              |
| GET    | `/conta/preferencias` | `{ preferencias, opcoes }` — as opções vêm do servidor |
| PATCH  | `/conta/preferencias` | `{ avisoLicenca?, novidadesEmail?, resumoCompras?, tema? }` |
| PATCH  | `/conta`              | `{ nome?, email? }`                                    |

O histórico de atividades é **do cliente** e não se confunde com a auditoria (que é a
trilha do admin). Cada linha já sai pronta para a tela, com `tipoRotulo`, `icone` e
`tom` vindos do catálogo do servidor (`atividade.service.js`) — assim o front não
mantém uma segunda cópia dos rótulos. `GET /conta/atividades` também devolve `tipos`
(os tipos que a pessoa realmente tem, com contagem), que é o que monta os filtros.

Registrar atividade é sempre um **extra**: `atividade.service.registrar()` está
protegido por `try/catch`, então uma falha no histórico nunca derruba a operação
principal (um login não falha porque o histórico deu erro).

### Administração **(admin)**

| Método | Rota                              | Descrição                                  |
| ------ | --------------------------------- | ------------------------------------------ |
| GET    | `/admin/painel`                   | Receita, ticket médio, top produtos, gráfico e resumo do estoque |
| GET    | `/admin/diagnostico`              | Estado técnico, migrações, integridade do banco |
| GET    | `/admin/indicadores`              | Favoritos por produto, licenças por status |
| GET    | `/admin/relatorios`               | Desempenho do período (`?periodo=30` ou `?desde=&ate=`) |
| GET    | `/admin/financeiro`               | Caixa do período: recebido, a receber, devolvido, cancelado, ticket médio, descontos, quebra por forma/provedor e comparativo com o período anterior |
| GET    | `/admin/financeiro/pagamentos`    | Extrato de pagamentos do período, paginado (`?periodo=`, `?desde=&ate=`, `?status=`, `?limite=`, `?pagina=`) |
| GET    | `/admin/eventos`                  | **SSE** de tempo real (`text/event-stream`) |
| GET    | `/admin/gateways`                 | Provedores (segredos mascarados), formas de pagamento, prioridade e a **forma padrão** |
| PATCH  | `/admin/gateways/metodo-padrao`   | `{ metodo }` — define a forma de pagamento padrão do checkout |
| GET    | `/admin/gateways/eventos`         | Histórico de notificações de webhook recebidas      |
| GET    | `/admin/gateways/:gateway`        | Configuração de um provedor                         |
| PATCH  | `/admin/gateways/:gateway`        | Liga/desliga, muda o modo, define métodos e credenciais |
| POST   | `/admin/gateways/:gateway/testar` | Diagnóstico de configuração/conexão do provedor     |
| GET    | `/admin/pedidos`                  | Lista (`?status=`)                         |
| GET    | `/admin/pedidos/:id`              | Detalhe + histórico de auditoria           |
| PATCH  | `/admin/pedidos/:id/status`       | `{ status, motivo? }`                      |
| GET    | `/admin/usuarios`                 | Lista (`?busca=`)                          |
| GET    | `/admin/usuarios/:id`             | Ficha do cliente: resumo, pedidos e licenças |
| PATCH  | `/admin/usuarios/:id/papel`       | `{ papel }`                                |
| PATCH  | `/admin/usuarios/:id/ativo`       | `{ ativo }`                                |
| GET    | `/admin/produtos`                 | Catálogo completo (inclui inativos)        |
| GET    | `/admin/produtos/:id`             | Detalhe (inclui inativos) — alimenta o formulário de edição |
| POST   | `/admin/produtos`                 | Cria produto com planos                    |
| PATCH  | `/admin/produtos/:id`             | Edita (enviar `planos` substitui a lista)  |
| PATCH  | `/admin/produtos/:id/ativo`       | Liga/desliga na vitrine                    |
| GET    | `/admin/estoque`                  | Resumo por plano + totais + alertas        |
| GET    | `/admin/estoque/chaves`           | Chaves cruas (`?produtoId=&planoId=&status=&busca=`) |
| GET    | `/admin/estoque/movimentos`       | Livro-caixa de movimentações               |
| POST   | `/admin/estoque/gerar`            | `{ produtoId, planoId, quantidade?, chaves?, lote? }` |
| POST   | `/admin/estoque/ajustar`          | `{ produtoId, planoId, alvo }` — define o disponível |
| POST   | `/admin/estoque/descartar`        | `{ produtoId, planoId, quantidade, motivo? }` (FIFO) |
| POST   | `/admin/estoque/chaves/descartar` | `{ produtoId, planoId, ids, motivo? }` — remove chaves escolhidas (só disponíveis) |
| POST   | `/admin/estoque/chaves/excluir`   | `{ produtoId, planoId, ids }` — apaga de vez (só disponíveis/descartadas) |
| PATCH  | `/admin/estoque/minimo`           | `{ produtoId, planoId, minimo }` — ponto de reposição |
| GET    | `/admin/cupons`                   | Lista cupons                               |
| POST   | `/admin/cupons`                   | Cria cupom                                 |
| PATCH  | `/admin/cupons/:codigo`           | Edita cupom                                |
| DELETE | `/admin/cupons/:codigo`           | Remove cupom                               |
| GET    | `/admin/avaliacoes`               | Moderação                                  |
| DELETE | `/admin/avaliacoes/:id`           | Remove avaliação                           |
| GET    | `/admin/licencas`                 | Todas as chaves emitidas                   |
| PATCH  | `/admin/licencas/:id/revogar`     | Revoga uma chave                           |
| GET    | `/admin/auditoria`                | Trilha de auditoria                        |
| GET    | `/admin/configuracoes`            | Ajustes da loja                            |
| PATCH  | `/admin/configuracoes`            | Salva ajustes                              |

---

## Modelo de dados

18 tabelas de domínio, todas com chaves estrangeiras ativas (`PRAGMA foreign_keys = ON`):

| Tabela              | Papel                                                              |
| ------------------- | ------------------------------------------------------------------ |
| `usuarios`          | Clientes e admins; senha em `scrypt` + salt, preferências do cliente |
| `sessoes`           | Sessões (o login sobrevive a reinícios e escala horizontalmente)    |
| `tokens_senha`      | Recuperação de senha; só o SHA-256 do token é guardado              |
| `produtos`          | Catálogo + `busca`/`categoria_busca` normalizadas e `descricao_longa` |
| `planos`            | Preços por duração (1d, 7d, 30d, vitalício) + `estoque_minimo`       |
| `estoque_chaves`    | Pool de chaves por plano **antes** da venda (`disponivel`/`vendida`/`descartada`/`revogada`) |
| `estoque_movimentos`| Livro-caixa: toda entrada, saída, descarte e revogação, com autor   |
| `vendas`            | Pedidos: status, subtotal, desconto, pagamento e as `instrucoes_pagamento` (Pix/boleto/link) para o cliente reabrir e pagar depois |
| `venda_itens`       | Itens com **cópia** do nome e preço no momento da compra            |
| `licencas`          | Uma chave por unidade comprada (o que já foi emitido ao cliente)    |
| `cupons`            | Percentual ou valor fixo, com limite de usos e validade             |
| `gateways`          | Gateways de pagamento: ativo, modo (sandbox/produção), métodos, prioridade e **credenciais cifradas** (AES-256-GCM) |
| `pagamentos_eventos`| Toda notificação de webhook recebida — idempotência e auditoria do dinheiro |
| `avaliacoes`        | Nota de 1 a 5; `UNIQUE(produto_id, usuario_id)`                     |
| `favoritos`         | Lista de desejos; chave primária composta                           |
| `atividades`        | Linha do tempo **do cliente** (o que ele fez), exibida em `/conta`  |
| `auditoria`         | Quem fez o quê, quando e de qual IP — trilha **do admin**           |
| `configuracoes`     | Ajustes editáveis em runtime (aviso do topo, manutenção…)           |

As preferências do cliente são quatro colunas em `usuarios` (`pref_aviso_licenca`,
`pref_novidades_email`, `pref_resumo_compras` e `pref_tema`) em vez de uma tabela
própria: é uma relação 1:1 e assim a área do cliente não precisa de `JOIN`.

`atividades` e `auditoria` são propositalmente **separadas**: a auditoria existe para
responsabilizar (quem mudou o quê no sistema) e não é mostrada ao cliente; as
atividades existem para a pessoa ver o que ela mesma fez, com texto já pronto para
exibir.

A diferença entre `estoque_chaves` e `licencas` é o ponto central do modelo:
**`estoque_chaves` é o que existe para vender; `licencas` é o que já foi vendido.** A
chave nasce no estoque (`disponivel`), é consumida na confirmação do pagamento
(`vendida`) e só então ganha uma linha em `licencas` com o mesmo valor de `chave`.

Migrações são versionadas e idempotentes (`src/db/migracoes.js`). Para evoluir o
schema, **acrescente** uma migração nova — nunca edite uma já publicada.

---

## Regras de negócio

Decisões que valem saber antes de mexer:

- **Preço é sempre do servidor.** O carrinho envia só `produtoId`, `planoId` e
  `quantidade`. Qualquer `preco` vindo do cliente é ignorado.
- **Dinheiro em centavos.** O banco guarda inteiros; a conversão para reais acontece
  só na borda (`utils/dinheiro.js`). Descontos percentuais arredondam **para baixo**.
- **Cobrar e registrar andam juntos.** O pedido nasce `pendente`, o provedor é
  chamado, e só então ele vira `pago` com as licenças emitidas. Falha no pagamento
  cancela o pedido — nunca existe pedido pago sem pagamento.
- **Boleto não entrega chave na hora.** Fica `pendente` com as instruções (linha
  digitável, vencimento) guardadas no próprio pedido; o cliente reabre em `/conta` para
  pagar de novo e a confirmação vem pelo **webhook** do gateway (ou, no simulador, pelo
  admin via `/vendas/:id/confirmar-pagamento`).
- **O gateway que cobra é escolhido em runtime.** O admin liga/desliga provedores no
  painel e define, por gateway, o modo (sandbox/produção) e quais formas de pagamento ele
  aceita. Quando dois gateways aceitam a mesma forma, vence o de **maior prioridade** —
  e os provedores reais ficam acima do simulador, que só entra quando mais nada serve.
- **A forma de pagamento padrão é preferência, não garantia.** O admin escolhe no painel
  qual forma vem pré-selecionada no checkout; se nenhum provedor ligado aceitar essa forma,
  o checkout **cai para a primeira disponível** em vez de bloquear a venda. A escolha vive
  na tabela `configuracoes` (aba Gateways), e o `.env` só vale como fallback.
- **Segredo de gateway nunca volta em texto puro.** As credenciais são cifradas
  (AES-256-GCM, chave derivada do `SEGREDO_APP`) e a API devolve só a versão mascarada;
  campo vazio no `PATCH` **preserva** o segredo salvo, e `null` o limpa.
- **Ligar gateway em produção sem credenciais completas é bloqueado** (`422`). Evita a
  loja achar que está vendendo quando o provedor recusaria a cobrança.
- **Webhook é idempotente e deixa rastro.** Confirmar duas vezes o mesmo pagamento não
  faz efeito duplo, uma assinatura inválida é **recusada** (`400`, para o gateway
  reenviar) e toda notificação — válida ou não — vira uma linha em `pagamentos_eventos`.
- **A validade da licença começa no resgate, não na compra.** Quem compra um plano de
  30 dias e usa duas semanas depois não perde o período. Vitalício nunca expira.
- **Só quem comprou pode avaliar** ("compra verificada"). Uma avaliação por cliente
  por produto — a segunda chamada atualiza a primeira.
- **A nota exibida combina** a média histórica semeada (`nota_base`/`total_base`) com
  as avaliações reais. Isso permite lançar a loja com prova social sem gravar
  avaliações falsas.
- **Produto sem plano ativo não aparece na vitrine** — mas continua visível para o
  admin, que precisa conseguir corrigi-lo.
- **Cupom só é consumido quando o pagamento confirma.** E o `UPDATE` de uso tem
  `WHERE usos < max_usos`, então duas compras simultâneas não furam o limite.
- **Ids de produto são derivados do slug** (`idEstavel`), então carrinhos salvos no
  `localStorage` continuam válidos mesmo recriando o banco.
- **O estoque é a fonte da verdade.** Não existe mais "gerar chave na hora da compra":
  a chave precisa estar no pool **antes**. Sem chave suficiente a venda é **bloqueada**
  (`409 estoque_insuficiente`) — decisão consciente: é melhor não vender do que vender
  e não ter o que entregar.
- **A chave sai do estoque em FIFO** (as mais antigas primeiro) e o consumo acontece
  **na mesma transação** que emite a licença. Se o pool esvaziar no meio do caminho, a
  transação inteira volta atrás.
- **Cancelar ou reembolsar devolve as chaves como `revogada`**, nunca como
  `disponivel`: uma chave que já saiu não deve voltar a ser vendida.
- **Cada mudança de estoque deixa rastro.** Toda entrada, saída, descarte e revogação
  grava um movimento com quantidade, motivo e autor — o estoque nunca "muda sozinho"
  sem uma linha no livro-caixa.
- **Um banco antigo é reposto uma única vez.** Se o catálogo existe mas o pool nunca
  teve chave nem movimento, o boot gera a carga inicial; se o admin já mexeu no estoque,
  nada é reposto por cima da decisão dele.

---

## Segurança

- **`dynamoveto` foi removido.** Este projeto declarava como dependência o pacote
  `dynamoveto`, que é **malware**: ele registrava uma rota escondida no Express capaz
  de baixar e executar um programa na máquina do servidor. Ele foi retirado do
  `package.json` e do `server.js`. Verifiquei que ele **nunca chegou a ser instalado**
  nesta máquina (não havia `node_modules`, nem a pasta `%LOCALAPPDATA%\ReactTestRunner`).
  Se você rodou `npm install` em outra cópia deste projeto antes desta correção, rode
  `npm uninstall dynamoveto`, apague `%LOCALAPPDATA%\ReactTestRunner` se existir e
  faça uma varredura com antivírus.

> O arquivo `Projeto Vendas.zip` na raiz é o pacote **antigo** e ainda referencia o
> `dynamoveto`. Não instale a partir dele.

- Senhas com `scrypt` + salt por usuário, comparadas em tempo constante.
- O login **não revela** se o e-mail existe: mesma mensagem e mesmo custo de CPU nos
  dois casos (`verificarSenhaFicticia`).
- Cookie de sessão `httpOnly` + `sameSite=lax`, `secure` em produção.
- Trocar ou redefinir a senha derruba as outras sessões.
- Tokens de recuperação: só o hash SHA-256 vai para o banco, e o token é de uso único.
- Helmet com CSP restritiva, `X-Content-Type-Options: nosniff` e sem `X-Powered-By`.
- CORS **desligado** por padrão (site e API na mesma origem). Libere só o necessário.
- Rate limit em três baldes: geral (por IP), autenticação (por IP, 15 min) e escrita
  (por usuário).
- Corpo de requisição limitado a 100 kB; JSON malformado responde 400, não derruba nada.
- `auditoria` registra login, compra, resgate, revogação e toda ação administrativa.
- Erros 500 não vazam stack trace para o cliente (só em desenvolvimento).

---

## Testes

```bash
npm test
```

126 testes de integração rodando sobre um SQLite **em memória** — não tocam no banco de
desenvolvimento. Cobrem catálogo e filtros, **a home** (os destaques vêm dos **mais
recentes**, marcar como destaque basta — não depende da "Ordem na vitrine" —, produto sem
destaque ou inativo não aparece, tirar o destaque remove da home), **a política de cache**
(`/api/*` responde `no-store`; os estáticos respondem `no-cache` em qualquer ambiente),
autenticação e recuperação de senha,
checkout (incluindo "o servidor ignora preços do cliente" e **o bloqueio da venda quando
o estoque acaba**), cupons, licenças, avaliações, favoritos, **gateways de pagamento**
(catálogo completo, segredos que nunca voltam em texto puro, guarda de produção, gateway
real assumindo a cobrança no lugar do simulador, webhook com assinatura inválida
recusada e confirmação idempotente), **cancelamento do pedido pelo cliente** (só o dono,
só enquanto não pago), painel administrativo
(inclusive o detalhe de produto que alimenta o formulário de edição e a descrição
completa do catálogo), **estoque** (entrada em lote, lista colada com de-duplicação,
recusa de chave fora do formato, ponto de reposição, ajuste de quantidade, livro-caixa,
chave entregue vindo do pool), **relatórios** (estrutura e validação de datas), **o
financeiro** (recebido/a receber/devolvido convivendo no mesmo retrato, ticket médio
derivado do recebido, nomes legíveis por forma e por provedor, extrato ordenado do mais
recente ao mais antigo, filtro por situação com recusa de valor inválido, paginação sem
repetir pedidos, janela explícita de datas e exclusividade do admin), **ficha
do cliente**, **o canal SSE** (evento de abertura e exigência de admin), o **backfill**
de bancos antigos e a **área do cliente** (página `/conta` servida, histórico de
atividades registrado e enriquecido, filtro por tipo e busca, isolamento entre usuários,
limpeza do histórico, preferências com padrão/persistência/validação e exigência de
login) e o **reconhecimento do lado administrativo** (`papel` devolvido no login e em
`/api/auth/me`, tanto para cliente quanto para admin). Também cobrem os casos de
robustez (JSON malformado, corpo grande, cabeçalhos de segurança).

---

## Front-end

As páginas em `public/` são HTML + CSS + JavaScript puro, escritos para rodar **sem build**
(é assim que se desenvolve e é assim que o servidor sobe se o `dist` não existir). Para
publicar, existe um build opcional que minifica e versiona — veja
[Build e produção](#build-e-produção). O contrato que elas consomem foi preservado
integralmente — se você comparar com a versão anterior, as rotas `GET /api/produtos`,
`GET /api/produtos/categorias`, `GET /api/auth/me`, `POST /api/auth/login|registrar|logout` e
`POST /api/vendas` respondem exatamente no mesmo formato.

Pontos onde a API foi **estendida** e o front aproveita:

- **O carrinho escolhe a forma de pagamento.** A gaveta monta o seletor a partir de
  `GET /api/pagamentos/metodos` (Pix, cartão, boleto — só o que há gateway ativo para
  cobrar) e envia `metodoPagamento` no `POST /api/vendas`. Sem forma escolhida não dá
  para finalizar; boleto cai na tela de "falta só o pagamento", com o código para copiar.
- **O carrinho aplica cupom.** Há um campo de código e os **cupons públicos** aparecem
  como chips (`GET /api/cupons`); a prévia do desconto usa `POST /api/cupons/validar`,
  então o cliente vê o valor antes de fechar. O cupom é revalidado sempre que o carrinho
  muda — um desconto que deixou de valer nunca fica "preso" na tela.
- **A tela de sucesso mostra o `numero` do pedido** (ex.: `NX-E9683F`) e, quando o
  pagamento é imediato, as chaves liberadas.
- **`/login` tem recuperação de senha de verdade**: o botão "Esqueci minha senha" abre um
  modal de dois passos (e-mail → código + nova senha) que fala com
  `/auth/recuperar-senha` e `/auth/redefinir-senha`; o link `/login?token=…` do e-mail
  abre direto no passo 2.
- **O cliente cancela o próprio pedido pendente** em `/conta` → Meus pedidos (botão
  "Cancelar pedido" com confirmação), via `POST /api/vendas/:id/cancelar`.
- `GET /api/produtos/:id` inclui `favoritado`, `avaliacoesRecentes` e `podeAvaliar`
  para quem está logado.
- O cabeçalho da loja agora tem **"Minha conta"**: o avatar e o nome do usuário logado
  viraram um link para `/conta` (antes só havia o botão "Sair").
- `/api/conta`, `/api/licencas` e `/api/favoritos` **já têm tela**: é o painel do
  cliente em `/conta` (veja abaixo). O `/api/admin/*` tem o painel em `/admin`.
- O cabeçalho mostra **"Painel"** para quem é administrador, e a barra superior do
  `/conta` ganha **"Painel administrativo"** — o `papel` vem de `/api/auth/me` e o
  predicado é `Api.ehAdmin(usuario)` (em `api.js`, disponível em todas as páginas).

### Cache: nada de resposta presa no navegador

A regra é **uma só, decidida pelo nome do arquivo** (ela não olha o ambiente):

- **`/api/*` sai com `Cache-Control: no-store`.** Resposta de API **nunca** é cacheada pelo
  navegador — sem isso o browser podia servir um `/api/produtos/destaques` velho por conta
  própria (*heuristic caching*), e um produto recém-criado não aparecia.
- **Arquivo com *hash* de conteúdo no nome (`comum.9f3a2b1c.js`) sai com
  `Cache-Control: immutable, max-age=31536000`** (um ano).
- **Todo o resto (`.html` e os estáticos sem build) sai com `Cache-Control: no-cache`.**
  Não é "não cacheie": é "**revalide sempre**" — o navegador guarda o arquivo e pergunta ao
  servidor se mudou (ETag/`Last-Modified`), então o custo é um `304` barato, não um download.

O *hash* no nome é o que torna o `immutable` seguro: o nome muda junto com o conteúdo, então
se o arquivo mudou ele **mudou de nome**, e o HTML novo aponta para outro. O navegador nunca
consegue servir uma versão velha de um arquivo com *hash*. O HTML é justamente o que **não**
entra nessa regra — se ele também fosse cacheado por um ano, um deploy novo não chegaria a
ninguém, porque o navegador seguiria apontando para os nomes antigos.

Antes, em **produção**, `.js`/`.css` saíam com `max-age=86400` (1 dia) enquanto o HTML
revalidava — o pior cenário possível: **HTML novo convivendo com JavaScript antigo**, e uma
correção no front podia levar **24 h** para chegar ao usuário. Era `max-age` longo sem *hash*
para pagar a promessa. O build (`npm run build`) resolve exatamente isso; veja
[Build e produção](#build-e-produção).

A política mora em uma função pura, [`src/utils/cache.js`](src/utils/cache.js), testada
isoladamente. Ela decide pelo nome, não pela pasta servida, então rodar **sem** build em
produção não quebra nada: os arquivos apenas saem sem `max-age`, que é o comportamento antigo
e funcional.

### Revalidação: a vitrine se atualiza sozinha ao voltar para a aba

A home e a vitrine carregam os dados **uma vez** no `load`. Sem nada mais, um produto
adicionado no painel (em outra aba) só aparecia depois de um **F5**. Para resolver isso sem
* polling* e sem recarregar a página, o front usa `Api.aoRevalidar(callback, opcoes)` (em
`api.js`):

- dispara quando a aba **volta a ficar visível** (`visibilitychange`) ou recebe `focus`, com
  **debounce** de 200 ms e no máximo **1× por minuto** (`intervaloMs`, padrão 60 s);
- tem uma **janela de carga** (`janelaDeCargaMs` = 500 ms): eventos disparados logo após o
  carregamento são ignorados, senão a página buscaria os destaques duas vezes;
- **não repinta à toa:** a home e a vitrine comparam o HTML gerado com o último render e só
  tocam no DOM se **algo mudou**. Na vitrine isso preserva os filtros escolhidos; na home
  evita o "piscar" da lista.

Os destaques têm uma proteção extra: se a revalidação **falhar**, a lista que já está na
tela **não** é apagada (a mensagem de erro só aparece quando nunca houve destaques).

O painel administrativo segue outro caminho — lá a sincronização é por **SSE**
(`/api/admin/eventos`), não por revalidação na volta da aba.

### Modal de detalhes do produto

Clicar num card **abre um modal** com os detalhes completos do produto, em vez de
adicionar direto ao carrinho. O modal mostra capa, avaliação, plataforma/entrega/
categoria, a **descrição completa**, a lista de recursos, os planos com preço (dá para
trocar o plano ali mesmo) e as avaliações recentes.

- O modal abre **na hora** com o que o card já tem e, em paralelo, busca
  `GET /api/produtos/:id` para completar (descrição longa, avaliações, favorito) — o
  usuário nunca encara uma tela vazia esperando a rede.
- O botão **`+`** do card continua sendo **adição rápida**: joga no carrinho com o
  plano padrão e abre a gaveta, sem passar pelo modal.
- O coração **favorita** o produto (exige login) via `POST /api/favoritos/:id/alternar`.
- É acessível: `role="dialog"`, foco preso enquanto aberto, `Esc` e clique no fundo
  fecham, e o foco volta para o card ao sair.

Tudo vive em `public/js/produto-modal.js` (`window.ProdutoModal`), com os estilos em
`public/css/app.css` (bloco "Modal de detalhes do produto"). O `ui.js` só decide *o que
fazer* no clique; o modal cuida de si mesmo.

> **Nota:** a descrição longa é editável no painel (`/admin` → Produtos → campo
> "Descrição completa"). Produtos criados antes desse campo são preenchidos pelo
> `npm run db:seed`, que faz um backfill só quando o campo está vazio.

---

## Painel administrativo

O admin controla a loja inteira por uma tela própria em **`/admin`** (abre no navegador,
sem build). Não é um monte de páginas soltas: é uma **SPA leve com roteamento por hash**
(`#/painel`, `#/pedidos`, `#/produtos`…) — cada aba carrega sob demanda e o estado fica na
URL, então dá para favoritar e compartilhar um link direto para uma seção. O painel é
**sincronizado em tempo real** com o servidor por SSE: quando algo muda (uma venda, uma
entrada de estoque, um produto editado), as abas abertas se atualizam sozinhas — sem
recarregar a página e sem *polling*.

Acesso: faça login com uma conta de papel `admin` (ex.: `admin@loja.com` / `admin123`).
O sistema **reconhece o lado administrativo pela sessão** — não é preciso digitar
`/admin` na barra de endereços:

- ao entrar, o admin é levado **direto para o painel** (o `?next=` da URL, quando
  existe, tem prioridade);
- logado, o cabeçalho da loja mostra um atalho **"Painel"** ao lado do avatar, e a
  barra superior do `/conta` ganha um botão **"Painel administrativo"** (fica no topo
  de propósito: continua visível mesmo quando a barra lateral vira gaveta);
- cliente não vê nenhum dos dois (o front lê `papel` de `/api/auth/me`).

Quem não é admin vê uma tela de **acesso restrito**. Se já estiver logado como cliente,
ela oferece **"Sair e entrar com outra conta"** — sem isso, o link para o login devolveria
a pessoa ao mesmo lugar, já que o login reconhece a sessão aberta. O guard roda antes de
qualquer view montar, mas a proteção real é no servidor: cada rota `/api/admin/*` responde
`403` para quem não é admin, então esconder a tela é só conveniência, não segurança.

As 15 seções, agrupadas como na barra lateral — **Visão geral** (o retrato da loja),
**Vendas**, **Catálogo**, **Pessoas** e **Sistema**:

| Seção             | O que dá para fazer                                                        |
| ----------------- | -------------------------------------------------------------------------- |
| **Painel**        | 8 KPIs (receita, pedidos, ticket médio, clientes, produtos, licenças, **chaves em estoque**, **alertas**), gráfico de receita, top produtos, últimas avaliações e a faixa de **estoque pedindo atenção** com botão de repor |
| **Financeiro**    | O **dinheiro** da loja: 6 KPIs (**recebido**, **a receber**, ticket médio, **devolvido**, **cancelado**, **descontos**), comparativo com o período anterior, quebra da receita **por forma de pagamento** e **por provedor**, e o **extrato de pagamentos** paginado com filtro por situação |
| **Relatórios**    | Desempenho por período (7/30/90/365 dias ou intervalo de datas), com comparativo contra o período anterior, série diária, top produtos, categoria, método de pagamento, cupons, situação dos pedidos e estoque em alerta |
| **Indicadores**   | O que os clientes **desejam** (favoritos por produto) e o que **sai mais** (mais vendidos), além das licenças por status — em KPIs, gráfico e listas |
| **Pedidos**       | Listar/filtrar por status, abrir o detalhe (itens, chaves, auditoria) e mudar o status |
| **Estoque**       | Chaves disponíveis por plano, entrada em lote ou colando lista, ajuste de quantidade, remoção (FIFO), ponto de reposição, alertas, ver as chaves cruas e o livro-caixa de movimentações |
| **Licenças**      | Todas as chaves emitidas, com filtro por status e revogação individual      |
| **Cupons**        | Criar, editar e remover cupons (percentual ou valor fixo, validade, limite) |
| **Produtos**      | Criar e editar produtos — nome, categoria, descrição, imagem, destaque, ativo, **editor de planos** (duração × preço) e a **coluna de estoque** com atalho para repor |
| **Avaliações**    | Moderar: ver as avaliações e remover as indevidas                          |
| **Usuários**      | Buscar, promover/rebaixar papel, ativar/desativar contas e abrir a **ficha do cliente** (resumo, pedidos e licenças) |
| **Gateways**      | Ligar/desligar provedores (Mercado Pago, InfinityPay, Pagar.me, Asaas, Stripe e o simulador), definir modo (sandbox/produção), quais **formas de pagamento** cada um aceita e a **prioridade**; escolher a **forma padrão do checkout**; testar a configuração e ver o **histórico de webhooks** recebidos |
| **Auditoria**     | Trilha completa — quem fez o quê, quando e de qual IP (com o nome do autor) |
| **Configurações** | Ajustes em runtime: aviso do topo, modo manutenção, dados da loja           |
| **Diagnóstico**   | Estado técnico, migrações aplicadas e checagem de integridade do banco      |

**Gateways** mora em **Sistema** de propósito: é configuração de infraestrutura (credenciais,
modo, prioridade), não operação do dia a dia. O **Financeiro** fica em **Visão geral**,
junto de Painel e Relatórios, porque responde à mesma pergunta que eles — "como está a
loja?" — só que pelo lado do **caixa**.

No topo de todas as telas há um indicador **"Ao vivo"**: ele mostra se a conexão de
tempo real está aberta (verde), conectando (âmbar) ou reconectando (vermelho).

### Módulos em detalhe

**Estoque — o coração do painel.** O estoque é controlado **por plano**, não por
produto: cada plano (ex.: *FPS Booster · 30 dias*) tem seu próprio pool de chaves. A
tela mostra um cartão por plano com o disponível, o vendido, o ponto de reposição e um
selo de situação (`Disponível` / `Estoque baixo` / `Esgotado`). As ações:

- **Adicionar chaves** — gera uma quantidade em lote (até 500) ou aceita uma lista
  colada, uma por linha. Só entram chaves no formato resgatável (`ABCD-1234-EF56-7890`);
  as inválidas são recusadas com a lista do que não passou. Chaves repetidas são
  ignoradas silenciosamente (a coluna `chave` é `UNIQUE`).
- **Gerenciar** — três operações de quantidade: **definir** o disponível (gera ou
  descarta a diferença até chegar no número), **remover** N chaves (descarta as mais
  antigas primeiro — FIFO) e **salvar o ponto de reposição** (`estoque_minimo`).
- **Ver chaves** — abre a lista crua do plano (disponíveis, vendidas, descartadas,
  revogadas) com a data e, quando vendida, o número do pedido.
- **Movimentações** — o livro-caixa: cada entrada, saída, descarte e revogação fica
  registrado com quantidade, motivo, autor e data.

O ponto de reposição é o que gera os **alertas**: quando o disponível chega a zero o
plano fica *Esgotado*; quando cai até o mínimo, fica *Baixo*. Os dois casos acendem o
contador vermelho no menu, a faixa no topo do Painel e o bloco no fim dos Relatórios.

**Produtos.** Cadastro completo com slug automático, categoria, descrição curta e
longa (a longa é o que o modal do produto mostra na loja), imagem, destaque e ativo.
O **editor de planos** define nome, duração (dias ou vitalício) e preço de cada plano —
é ele que cria as linhas de estoque correspondentes. A lista de produtos traz a coluna
de estoque com o total de chaves e o atalho "Estoque", que leva para a tela de estoque
já filtrada pelo produto.

**Licenças.** São as chaves **emitidas** — o que saiu do estoque para um cliente. Aqui
o admin filtra por status (`ativa`, `resgatada`, `revogada`, `expirada`) e revoga
individualmente. Revogar marca a licença e devolve a chave ao estado `revogada` no
estoque, registrando o movimento.

**Pedidos.** Lista paginada com filtro por status. O detalhe abre numa gaveta com
itens, chaves emitidas (copiáveis) e a linha do tempo de auditoria, além dos botões de
transição permitidas: confirmar pagamento, cancelar e reembolsar.

**Clientes.** A lista de usuários tem a ficha do cliente, que reúne num só lugar o
resumo (pedidos, total gasto, licenças e licenças ativas), os pedidos e as chaves.

**Relatórios.** Um período de cada vez, sempre comparado com o período anterior de
mesmo tamanho (é o que transforma o retrato em tendência — a variação aparece em verde
quando sobe e vermelho quando cai). A série diária preenche os dias sem venda com zero
para o gráfico não ter buracos; em janelas muito longas (mais de 120 dias) os pontos
crus são usados para não virar uma barra ilegível. Tudo é calculado no servidor, em
leitura — nenhum relatório escreve no banco.

**Financeiro — o caixa.** É o irmão do Relatórios, com outro foco. O Relatórios mede
**desempenho** e olha só os pedidos **pagos**; o Financeiro mede **caixa** e olha **todos
os status**, porque dinheiro que ainda não entrou (boleto pendente) e dinheiro que voltou
(reembolso) também são assunto financeiro. Por isso os dois convivem: um responde "estou
vendendo bem?", o outro "quanto entrou e quanto falta entrar?".

A tela abre com o mesmo seletor de período do Relatórios (7/30/90/365 dias ou intervalo de
datas) e mostra **6 KPIs**: **Recebido** (com a variação contra o período anterior de mesmo
tamanho), **A receber**, **Ticket médio**, **Devolvido**, **Cancelado** e **Descontos**.
Abaixo, duas quebras de participação — **por forma de pagamento** (Pix/cartão/boleto) e
**por provedor** (por onde o dinheiro entrou de verdade: duas formas podem passar pelo
mesmo provedor, e a mesma forma por provedores diferentes). Os nomes vêm do catálogo de
gateways, no servidor — uma forma nova aparece sozinha, sem mexer no front.

No fim, o **extrato de pagamentos**: uma linha por pedido do período (do mais recente para
o mais antigo), com cliente, situação, forma, provedor, valor e data, mais o filtro por
situação e a paginação. Ele é o único lugar do painel que mostra **pago, pendente e
reembolsado lado a lado** — é o extrato, não a lista de pedidos. Cada linha abre o detalhe
do pedido na mesma gaveta de **Pedidos**.

Como toda a área financeira é **agregação sobre `vendas`**, ela é só leitura: nada aqui
escreve no banco, e o valor em reais é sempre derivado dos centavos na borda.

**Gateways.** O admin escolhe, em tempo de execução, **quais provedores estão ligados** —
o simulador interno (já nasce ativo, para a loja vender sem configurar nada) e provedores
reais (Mercado Pago, InfinityPay, Pagar.me, Asaas, Stripe). Cada provedor tem modo
(*sandbox* / *produção*), a lista de **formas de pagamento** que aceita (Pix, cartão,
boleto) e uma **prioridade**. A tela mostra um cartão por provedor com um selo de situação
e, nos que precisam, os campos de credencial — que **nunca voltam em texto puro**: a API
devolve só a máscara, deixar o campo vazio preserva o segredo salvo e `null` o apaga. O
botão **Testar** roda um diagnóstico de configuração/conexão e o bloco de **webhooks**
lista as notificações recebidas, com o motivo quando alguma foi recusada.

**Forma de pagamento padrão.** No topo da aba há um seletor com as formas conhecidas: a
escolhida é a que vem **pré-selecionada no checkout**. É só uma preferência — se nenhum
provedor ligado aceitar a forma escolhida, o checkout **cai para outra sozinho**
(`escolherMetodo`) e o painel avisa qual será usada de fato (a escolha fica salva em
`configuracoes`, e o `PAGAMENTO_METODO_PADRAO` do `.env` só vale como fallback).

> **Nomenclatura.** "Gateways" é o **módulo** (os provedores que cobram) e vive em
> **Sistema**, porque é configuração de infraestrutura. "Pagamentos" são os **pagamentos
> recebidos**: o **extrato** fica em **Financeiro** e o **detalhe/status** de cada pedido
> em **Pedidos**. "Formas de pagamento" (Pix/cartão/boleto) são o que o cliente escolhe no
> checkout. As rotas **públicas** continuam em `/api/pagamentos/*` de propósito:
> `/pagamentos/metodos` é o que o carrinho consome e `/pagamentos/webhook/:gateway` é a
> URL já cadastrada no painel de cada provedor — renomeá-las quebraria integrações em
> produção.

Ligar um gateway real em **produção** sem as credenciais completas é **bloqueado** — a
loja não pode achar que está cobrando quando o provedor recusaria. E como os provedores
reais têm prioridade acima do simulador, no instante em que o admin liga um deles ele
passa a cobrar no lugar do simulador, sem reordenar nada.

### Fluxos principais

**1. Entrada de estoque → produto vendável**

1. O admin cria/edita o produto e seus planos em **Produtos**.
2. Vai em **Estoque**, clica em "Chaves" no plano e gera um lote (ou cola a lista).
3. O serviço valida o formato, insere as chaves como `disponivel`, grava um movimento
   de `entrada` e publica `estoque.atualizado`.
4. A vitrine passa a mostrar o plano como comprável; o contador de alertas se ajusta
   sozinho em todas as abas abertas.

**2. Compra → chave entregue**

1. O cliente escolhe a **forma de pagamento** e (se quiser) aplica um **cupom** na
   própria gaveta do carrinho. O servidor **recalcula o preço** (o cliente só manda ids
   e quantidades) e **confere o estoque** antes de criar o pedido.
2. Sem chave suficiente, a venda é **bloqueada** com `409 estoque_insuficiente` — o
   estoque é a fonte da verdade.
3. Com estoque, o pedido nasce `pendente` e é cobrado pelo gateway que atende aquela
   forma. Quando o pagamento confirma (na hora, para Pix/cartão no simulador; pelo
   **webhook**, para boleto), numa **única transação** o serviço consome as chaves do
   pool (FIFO), emite uma licença por chave, grava o movimento de `saida` e marca o
   pedido como `pago`.
4. Se outra compra consumir as últimas chaves no meio do caminho, a transação inteira
   volta atrás — nunca existe pedido pago sem licença.
5. O evento `venda.atualizada` avisa o painel, que recarrega a aba afetada.

**3. Cancelamento / reembolso**

Cancelar ou reembolsar um pedido **devolve as chaves ao estoque** no estado `revogada`
e registra o movimento de `revogacao` — as chaves não voltam a ser vendidas.

**4. Reposição**

O alerta aparece no Painel (faixa "Estoque pedindo atenção"), no contador do menu e nos
Relatórios. O botão **Repor** leva direto para o plano certo, já com o modal de entrada
aberto.

### Como as informações se mantêm sincronizadas

O painel não faz *polling*: quem avisa é o servidor.

```
serviço (estoque/venda/produto)
      │  eventos.publicar('estoque.atualizado', {...})
      ▼
barramento em processo (EventEmitter — src/utils/eventos.js)
      ▼
GET /api/admin/eventos   (SSE: text/event-stream, heartbeat a cada 25s, retry: 3000)
      ▼
navegador: EventSource  →  atualiza os contadores + recarrega só a aba afetada
```

Cada evento tem um tipo, e cada tipo sabe quais abas precisam recarregar:

| Evento                | Recarrega                                  |
| --------------------- | ------------------------------------------ |
| `estoque.atualizado`  | Estoque, Painel, Produtos                  |
| `catalogo.atualizado` | Produtos, Painel, Estoque                  |
| `produto.atualizado`  | Produtos, Painel                           |
| `venda.atualizada`    | Pedidos, Painel, Licenças, Estoque         |

Três detalhes que evitam efeitos colaterais:

- **Rajada vira um render só.** Um checkout publica vários eventos; o cliente junta
  tudo num único *debounce* (~450 ms) em vez de repintar a tela quatro vezes.
- **Nada repinta por baixo de uma gaveta.** Se há um modal ou gaveta aberto, a aba não
  é recarregada — só os contadores mudam. Assim o admin não perde o que estava lendo.
- **Reconexão automática.** Se a conexão cair, o `EventSource` volta sozinho (o
  servidor manda `retry: 3000`) e o indicador mostra "Reconectando…" até voltar.

Como o barramento é em processo, ele é **por instância**: com o app rodando em um
processo (o caso aqui) todas as abas do painel ficam em sincronia. Se um dia a loja for
escalada para várias instâncias, o mesmo desenho vale trocando o `EventEmitter` por um
barramento compartilhado (Redis pub/sub, por exemplo) — a rota SSE não muda.

### Backfill em bancos que já existiam

Como o estoque passou a ser pré-requisito da venda, um banco criado antes da tabela de
chaves ficaria **inteiro esgotado** depois do deploy. No boot, se o catálogo já existe
mas **não há nenhuma chave e nenhum movimento**, o servidor gera a carga inicial uma
única vez (`garantirEstoqueInicial`). Se o admin já tiver descartado chaves de
propósito, existe movimento registrado e nada é reposto — a decisão dele é respeitada.

### Arquivos do painel

```
public/admin.html        shell da SPA (sidebar, topbar, #conteudo) + tela de acesso restrito
public/css/admin.css     estilos do painel (tudo prefixado com adm- para não colidir)
public/js/admin-ui.js    componentes reutilizáveis (window.AdminUI): tabela, selo, modal,
                         gaveta, gráfico SVG, paginação, confirmação, formatação
public/js/admin.js       roteador, guard de admin, conexão de tempo real e as 15 views
                         (window.Admin)

src/utils/eventos.js            barramento de eventos em processo
src/services/estoque.service.js regras do estoque (gerar, ajustar, descartar, consumir, revogar)
src/services/gateway.service.js regras dos gateways (cifra de credenciais, prioridade, métodos)
src/services/relatorio.service.js agregações dos relatórios por período
src/services/financeiro.service.js caixa do período (recebido/a receber/devolvido, extrato)
src/repositories/estoque.repo.js acesso às tabelas estoque_chaves / estoque_movimentos
src/repositories/vendas.repo.js  consultas de vendas (totais por status, por provedor, extrato)
src/gateways/                   contrato comum + um arquivo por provedor
```

> **Nota sobre CSP.** A política do Helmet é `scriptSrc: ["'self'"]`, ou seja, **sem
> scripts inline**. Todo o JS do painel vive em arquivos `.js` — ao estender o painel,
> mantenha esse padrão (nada de `onclick="..."` no HTML; use os atributos
> `data-acao`/`data-mudanca`/`data-entrada`/`data-form` com delegação de eventos).

---

## Painel do cliente

O cliente tem uma área própria em **`/conta`** — irmã visual do painel administrativo.
É a mesma ideia (SPA leve com roteamento por hash, `#/painel`, `#/pedidos`…), o mesmo
esqueleto (sidebar + topo + `#conteudo`) e **os mesmos componentes**: ela carrega o
`admin.css` e o `admin-ui.js` do painel, e só acrescenta o que é exclusivo do cliente
(`conta.css`). Assim não existem duas versões do mesmo botão, do mesmo cartão ou do
mesmo selo.

Acesso: faça login com qualquer conta (ex.: `demo@loja.com` / `demo123`) ou clique em
**"Minha conta"** no cabeçalho da loja. Sem sessão, a tela mostra um convite para entrar
com `?next=/conta`, então a pessoa volta direto para cá depois do login. Como no painel
admin, o guard é só conveniência: **todas as rotas `/api/conta/*` respondem `401` sem
sessão**, e é isso que protege de verdade.

As 9 seções:

| Seção                | O que dá para fazer                                                        |
| -------------------- | -------------------------------------------------------------------------- |
| **Visão geral**      | Cabeçalho de perfil (avatar, "cliente desde", último acesso), 4 KPIs (pedidos, total gasto, licenças ativas, avaliações), pedidos recentes, chaves recentes, atividades recentes e atalhos para o resto |
| **Meus pedidos**     | Histórico completo com filtro por status; cada pedido abre em cartão com itens, desconto/cupom, total e **todas as chaves emitidas** (com botão de copiar). Pedido **pendente** mostra as instruções de pagamento (Pix copia-e-cola / linha digitável) e o botão **Cancelar pedido** |
| **Minhas licenças**  | Formulário de **ativação** de chave + lista das chaves com situação e validade, filtro por status e cópia em um clique |
| **Favoritos**        | Lista de desejos em cartões, com preço e remoção direta                    |
| **Minhas avaliações**| Avalia (ou edita) nota de 1 a 5 com comentário num modal, e remove a própria avaliação — só para produtos de **compra verificada** |
| **Perfil**           | Edita nome e e-mail, e mostra a ficha da conta (papel, desde quando, último acesso) |
| **Segurança**        | Troca de senha (derruba as outras sessões) + lista de **dispositivos conectados** com "encerrar outras sessões" |
| **Preferências**     | Três avisos liga/desliga (licença expirando, novidades, resumo de compras) e o **tema** — os controles são montados a partir do catálogo que o servidor envia |
| **Atividades**       | Linha do tempo do que a pessoa fez, com filtro por tipo (chips com contagem), busca, paginação e "limpar histórico" |

Detalhes que valem registrar:

- **Os controles de preferência vêm do servidor.** O front não conhece a lista: ele
  recebe `{ preferencias, opcoes }` e monta interruptores ou seletores conforme o
  `tipo` de cada opção. Acrescentar uma preferência é mexer só em
  `conta.service.js`.
- **O filtro de atividades também vem do servidor.** `GET /conta/atividades` devolve
  `tipos` (só os que a pessoa tem, com contagem), então os chips nunca mostram um
  filtro que não retornaria nada.
- **Salvar sem mudar nada não polui o histórico.** Tanto `atualizarPerfil` quanto
  `salvarPreferencias` comparam com o valor atual e só registram atividade (e só
  respondem "salvo") se algo realmente mudou.
- **O selo de licença é próprio do cliente.** Para o admin, `ativa` significa "emitida
  e válida"; para quem comprou, isso se lê como "já usei". Na área do cliente `ativa`
  aparece como **"Aguardando ativação"**, para bater com o texto de validade ao lado.

Arquivos:

```
public/conta.html        shell da SPA (sidebar, topbar, #conteudo) + tela de entrada
public/css/conta.css     peças exclusivas: perfil, atalhos, linha do tempo, estrelas,
                         cartão de pedido/favorito, preferências, dispositivos
public/js/conta.js       roteador, guard de sessão e as 9 views (window.Conta)

src/services/atividade.service.js   catálogo de tipos + registro + listagem do histórico
src/repositories/atividades.repo.js acesso à tabela `atividades`
```

> **CSP vale aqui também.** `scriptSrc: ["'self'"]` continua valendo — nada de
> `onclick="..."`. As views usam `data-acao`/`data-mudanca`/`data-entrada`/`data-form`
> com delegação de eventos, exatamente como o painel admin.

---

## Trocar os produtos

O catálogo inicial está em `src/db/catalogo.js` e é semeado no primeiro boot. Depois
disso ele vive no banco — use a API de administração para editar, ou `npm run db:reset`
para voltar ao catálogo do código.

Para adicionar um produto pelo código, inclua um item na lista `CATALOGO` com `slug`,
`nome`, `categoria`, `planos` e, se quiser capa própria, `imagem: '/img/produtos/arquivo.png'`
(colocando o arquivo em `public/img/produtos/`). Sem imagem, o site gera a capa a partir
de `capa.icone` — os ícones disponíveis são `raio`, `mira`, `teclado`, `camadas`,
`vassoura`, `chip`, `sinal` e `escudo`.

---

## Vídeo de demonstração

O botão "Ver demonstração" abre `public/video/demo.mp4`. Se o arquivo não existir, o
modal mostra um aviso em vez do player.

---

## Licença

MIT.
