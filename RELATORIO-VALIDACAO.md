# NEXUS.GG — Relatório de Validação e Documentação do Projeto

**Data da validação:** 30/09/2026
**Escopo:** todas as funcionalidades dos perfis **Cliente** e **Administrador**, do banco à interface.
**Método:** leitura do código + suíte automatizada + validação ponta a ponta sobre a API real + navegação real (Edge) em todas as telas.

> **Atualização (mesmo dia):** as **7 lacunas de interface** da seção 8 foram
> **fechadas** e a loja ganhou um **módulo de gateways de pagamento**. O estado atual
> está na seção 12 (adendo) — a suíte passou a **113 testes** e a navegação real cobre
> os fluxos novos (checkout com forma de pagamento + cupom, recuperação de senha,
> cancelamento de pedido, telas de Gateways e Indicadores).
>
> **Segunda atualização:** o módulo **Gateways** foi movido para o grupo **Sistema** e o
> painel ganhou a seção **Financeiro** (o caixa da loja). O estado atual está na **seção
> 13** — a suíte passou a **120 testes** e a tela de Financeiro foi validada no navegador
> (**62/62 verificações**).
>
> **Terceira atualização:** a seção **"Produtos em destaque"** da home não mostrava um
> produto recém-criado. Foram corrigidas **quatro** causas (ordenação dos destaques, cache
> da API, cache dos estáticos em produção e revalidação na volta da aba). O estado atual
> está na **seção 14** — a suíte passou a **126 testes** e a correção foi validada no
> navegador (**24/24 verificações**).

---

## 1. Sumário executivo

| Bateria | Resultado |
| --- | --- |
| Testes automatizados (`npm test`) | **126 / 126 passando** |
| Validação ponta a ponta da API (cliente + admin) | **91 / 91 passando, 0 falhas** |
| Telas renderizadas no navegador | **41 / 41 verificações sem erro de JavaScript** |
| Aba **Gateways** no navegador (função + layout em 6 larguras) | **49 / 49 passando** |
| Aba **Financeiro** no navegador (função + layout em 6 larguras) | **62 / 62 passando** |
| **Destaques da home** no navegador (tempo real + cache) | **24 / 24 passando** |

**Veredito:** o **backend está 100% funcional** — todos os endpoints, as regras de
negócio e os fluxos completos (compra, licença, cupom, estoque, pagamento por gateway,
moderação) operam corretamente e estão cobertos por teste.

**Nenhum defeito funcional foi encontrado.** As 7 lacunas de interface identificadas
nesta validação **foram fechadas** (ver seção 12) e a loja ganhou um módulo novo de
**gateways de pagamento** (simulador + provedores reais) com painel próprio.

---

## 2. Como a validação foi feita (evidências)

1. **Suíte de testes** — `node --test "testes/*.test.js"` com Node 24, sobre SQLite **em memória**. 126 testes cobrindo catálogo, contas, checkout, cupons, licenças, avaliações, favoritos, estoque, **gateways de pagamento e webhook**, relatórios, **financeiro (caixa e extrato)**, **a home (destaques mais recentes) e a política de cache**, auditoria, SSE e área do cliente.
2. **Validação ponta a ponta da API** — script que sobe a aplicação em processo (`BANCO_ARQUIVO=:memory:` → `conectar()` → `semear()` → `criarApp().listen(0)`) e exercita **cada rota** como cliente e como admin, com asserções de status e de conteúdo: **91 verificações, 91 aprovadas**.
3. **Navegação real** — Edge headless percorrendo as **15 seções do `/admin`**, as **9 seções do `/conta`** e as **4 páginas públicas**, coletando `console.error` e `pageerror`; mais os fluxos novos (checkout com forma de pagamento + cupom, recuperação de senha e cancelamento de pedido): **41/41 verificações sem erro de JavaScript**.

> Durante a validação, 8 itens apareceram como falha e **todos os 8 eram erro do script de teste**, não do sistema (formato de resposta mal assumido, payload errado, sessão invalidada de propósito por um passo anterior). Cada um foi conferido contra o código e contra o teste oficial correspondente, o script foi corrigido e a bateria fechou em 91/91. Isso está registrado aqui porque um relatório que esconde os falsos positivos não serve para nada.

---

## 3. Visão geral

**NEXUS.GG** é uma loja de licenças digitais para gamers, com **entrega automática**: o cliente compra e a chave aparece na tela. Tema escuro com azul.

- **Front-end:** HTML + CSS + JavaScript puro (`public/`), sem framework. Roda sem build em
  desenvolvimento; para publicar, `npm run build` minifica e versiona com *hash* no nome.
- **Back-end:** Node.js + Express 4 + SQLite (`better-sqlite3`, síncrono).
- **Banco:** 18 tabelas de domínio + a tabela de controle de migrações.
- **Contas de demonstração:**
  - Cliente — `demo@loja.com` / `demo123`
  - Admin — `admin@loja.com` / `admin123`

---

## 4. Arquitetura

### 4.1 Stack

| Camada | Tecnologia |
| --- | --- |
| Runtime | Node.js ≥ 20 (validado no Node 24) |
| HTTP | Express 4 |
| Banco | SQLite via `better-sqlite3` (síncrono, sem servidor externo) |
| Sessões | Em banco, cookie `sid` (`httpOnly`) |
| Senhas | `scrypt` + salt por usuário |
| Segurança | Helmet (CSP `scriptSrc: 'self'`), CORS, rate limit em 3 baldes |
| Tempo real | SSE (`EventSource`) com barramento `EventEmitter` em processo |
| Gateways | Provedores **plugáveis**: simulador interno + Mercado Pago, InfinityPay, Pagar.me, Asaas e Stripe; credenciais cifradas em **AES-256-GCM**; webhook com validação de assinatura |
| Testes | `node:test` (nativo, sem dependência) |

### 4.2 Arquitetura em 3 camadas (regra rígida do projeto)

```
routes/  →  traduz HTTP para chamadas de serviço. Nunca tem regra de negócio.
services/ →  regra de negócio. Nunca vê req/res. É o que torna o checkout testável sem HTTP.
repositories/ →  só fala com o banco. Nunca tem regra de negócio.
```

- `app.js` é separado de `server.js` para que os testes subam a aplicação sem abrir porta.
- Erros usam **envelope único**: `{ erro, codigo, detalhes? }`.
- **Dinheiro em centavos (inteiro)** no banco; conversão para reais só na borda (`utils/dinheiro.js`).
- **Migrações são imutáveis**: nunca se edita uma migração publicada, só se acrescenta outra.

### 4.3 Estrutura de pastas

```
server.js                    boot (cria banco, migra, semeia, repõe estoque)
src/
  app.js                     monta o Express (middlewares → API → estáticos → 404/erros)
  config/index.js            lê e valida o ambiente uma única vez
  db/                        conexao · migracoes (7) · semear · catalogo (10 produtos)
  middlewares/               sessao · erros · validar · limites · manutencao · contexto
  repositories/              15 repositórios (acesso a dados)
  routes/                    11 arquivos de rota (inclui pagamentos e webhook)
  services/                  15 serviços (regra de negócio)
  gateways/                  provedores de pagamento (contrato comum + 6 implementações)
  utils/                     datas · dinheiro · erros · eventos · logger · seguranca · cripto · validacao
public/
  index · produtos · login · termos · admin · conta   (6 páginas)
  css/  base · app · home · produtos · login · admin · conta
  js/   api · ui · cart · produto-modal · home · produtos · login
        admin-ui · admin · conta
testes/api.test.js           126 testes de integração
scripts/                     migrar · semear · reiniciar
dados/nexus.db               banco real (fora de produção)
```

### 4.4 Modelo de dados (18 tabelas de domínio)

| Grupo | Tabelas |
| --- | --- |
| Contas | `usuarios`, `sessoes`, `tokens_senha` |
| Catálogo | `produtos`, `planos` |
| Vendas | `vendas`, `venda_itens`, `licencas`, `cupons` |
| Estoque | `estoque_chaves`, `estoque_movimentos` |
| Gateways | `gateways`, `pagamentos_eventos` |
| Interação | `avaliacoes`, `favoritos` |
| Cliente | `atividades` |
| Administração | `auditoria`, `configuracoes` |

**Distinção que não pode ser confundida:**
- `estoque_chaves` = o que existe **para vender** (pool).
- `licencas` = o que **já foi vendido**.
- `auditoria` = trilha **do admin** (responsabilização). `atividades` = o que o **cliente** fez, exibido a ele.

### 4.5 Fluxos principais

**Compra (Pix/Cartão):** carrinho escolhe a forma de pagamento → `POST /api/vendas` → pedido nasce `pendente` → o gateway que atende aquela forma cobra → vira `pago` → chaves consumidas do pool (FIFO, **na mesma transação**) → licenças emitidas → chaves devolvidas na resposta.

**Compra (Boleto):** igual, mas o pedido **fica `pendente` e sem chave**, com as instruções (linha digitável, vencimento) guardadas no pedido. Só depois da confirmação do pagamento — pelo **webhook** do gateway (ou pelo admin, no simulador) — as chaves são liberadas.

**Pagamento por gateway:** o admin liga/desliga provedores no painel; cada um tem modo (sandbox/produção), formas de pagamento aceitas e prioridade. O webhook valida a assinatura, é **idempotente** e registra toda notificação em `pagamentos_eventos`.

**Ciclo da licença:** comprada → `ativa` (sem expiração) → **resgate** → a contagem dos dias do plano **começa aí**. Quem demora a usar não perde prazo.

**Estoque:** o pool é a fonte da verdade. Sem chave disponível, a venda é **bloqueada** (`409 estoque_insuficiente`). Toda mudança grava uma linha em `estoque_movimentos` com autor.

---

## 5. Funcionalidades do CLIENTE — status

Legenda: ✅ **funcionando** · ⚠️ **incompleto** (funciona na API, falta tela) · ❌ **com problema**

### 5.1 Conta e sessão

| # | Funcionalidade | Status | Observação |
| --- | --- | --- | --- |
| C1 | Cadastro com validação (nome, e-mail, senha) | ✅ | 201; nunca devolve senha/hash/salt |
| C2 | Login | ✅ | Erro genérico, sem revelar se o e-mail existe |
| C3 | Logout | ✅ | 204 e a sessão morre de fato |
| C4 | Sessão reconhecida (`/api/auth/me` com `papel`) | ✅ | Base do atalho de admin |
| C5 | Editar perfil (nome e e-mail) | ✅ | Salvar sem mudar nada não registra atividade |
| C6 | Trocar senha (exige a atual) | ✅ | Derruba as outras sessões |
| C7 | Recuperar senha por e-mail | ✅ | Modal de 2 passos no `/login` (e-mail → código + nova senha); `/login?token=…` abre no passo 2. Fora de produção a resposta traz o link de apoio |
| C8 | Sessões/dispositivos conectados | ✅ | Lista e encerra as outras |
| C9 | Histórico de atividades (filtro por tipo e busca) | ✅ | Log dedicado; o cliente pode apagar |

### 5.2 Vitrine e compra

| # | Funcionalidade | Status | Observação |
| --- | --- | --- | --- |
| C10 | Catálogo com busca, categoria, destaque e ordenação | ✅ | Busca ignora acentos e maiúsculas |
| C11 | Detalhe do produto (modal) com descrição completa | ✅ | Abre na hora e completa em paralelo |
| C12 | Carrinho (adicionar, alterar quantidade, remover) | ✅ | Persistido em `localStorage` |
| C13 | Escolher forma de pagamento (Pix/Cartão/Boleto) | ✅ | O carrinho monta o seletor com `GET /api/pagamentos/metodos` e envia `metodoPagamento`; boleto cai na tela de instruções |
| C14 | Aplicar cupom no checkout | ✅ | Campo de código + chips de cupons públicos; prévia do desconto por `POST /api/cupons/validar` e revalidação a cada mudança do carrinho |
| C15 | Ver cupons disponíveis | ✅ | `GET /api/cupons` alimenta os chips da gaveta |
| C16 | Checkout Pix/Cartão entrega a chave na hora | ✅ | Verificado ponta a ponta |
| C17 | Checkout Boleto fica pendente e sem chave | ✅ | Regra de negócio respeitada |
| C18 | Preço sempre recalculado no servidor | ✅ | Preço forjado no corpo é ignorado |
| C19 | Bloqueio quando o estoque acaba | ✅ | 409 `estoque_insuficiente` |
| C20 | Meus pedidos (lista e detalhe) | ✅ | Pedido só é visível para o dono (404 para terceiros) |
| C21 | Cancelar pedido ainda não pago | ✅ | Botão "Cancelar pedido" em `/conta` → Meus pedidos, com confirmação; só o dono e só enquanto pendente |

### 5.3 Licenças, avaliações e favoritos

| # | Funcionalidade | Status | Observação |
| --- | --- | --- | --- |
| C22 | Minhas licenças (lista + contadores) | ✅ | Resposta `{ quantidade, ativas, chaves }` |
| C23 | Resgatar/ativar chave | ✅ | Validade passa a contar do resgate |
| C24 | Chave de outro usuário não pode ser resgatada | ✅ | 403 |
| C25 | Chave em formato inválido é rejeitada | ✅ | 400 |
| C26 | Favoritar / desfavoritar / listar | ✅ | Alternar é idempotente |
| C27 | Avaliar produto comprado (compra verificada) | ✅ | Só quem comprou (403 caso contrário) |
| C28 | Uma avaliação por cliente/produto | ✅ | Reenvio **atualiza** a mesma avaliação |
| C29 | Validar nota (1–5) e comentário (máx. 600) | ✅ | **Não há mínimo** de comentário (ver §9) |

### 5.4 Área `/conta` (9 seções)

| Seção | Status | Observação |
| --- | --- | --- |
| Visão geral | ✅ | KPIs, pedidos recentes, chaves recentes, atalhos |
| Meus pedidos | ✅ | Paginação e filtro por status |
| Minhas licenças | ✅ | Resgate em linha; layout de 2 linhas para o código |
| Favoritos | ✅ | Cartões com preço e ação |
| Minhas avaliações | ✅ | Criar/editar/remover |
| Perfil | ✅ | Nome, e-mail e ficha da conta |
| Segurança | ✅ | Troca de senha + dispositivos conectados |
| Preferências | ✅ | 4 preferências (aviso de licença, novidades, resumo, tema) |
| Atividades | ✅ | Linha do tempo, filtro por tipo e busca, limpar histórico |

---

## 6. Funcionalidades do ADMIN — status

### 6.1 Sessão e visão geral

| # | Funcionalidade | Status | Observação |
| --- | --- | --- | --- |
| A1 | Login e reconhecimento do papel admin | ✅ | Redireciona direto ao painel; cliente recebe 403 em `/api/admin/*` |
| A2 | Painel (receita, ticket médio, top produtos, gráfico) | ✅ | Período configurável |
| A3 | Relatórios (7/30/90/365 dias ou intervalo) | ✅ | Sempre comparado ao período anterior; valida intervalo invertido |
| A4 | Diagnóstico (estado técnico, migrações, integridade) | ✅ | |
| A5 | Indicadores (favoritos por produto, licenças por status) | ✅ | View **Indicadores**: KPIs, gráfico e listas de "desejados" e "mais vendidos" |
| A6 | Tempo real (SSE) | ✅ | Handshake `pronto` + `estoque.atualizado` recebidos; 401 sem sessão |
| A43 | **Financeiro** — caixa do período | ✅ | View **Financeiro** (`GET /admin/financeiro`): recebido, a receber, ticket médio, devolvido, cancelado e descontos, com comparativo contra o período anterior e quebra por forma de pagamento e por provedor (nomes legíveis do catálogo) |
| A44 | **Extrato de pagamentos** | ✅ | `GET /admin/financeiro/pagamentos`: uma linha por pedido do período, do mais recente ao mais antigo, com filtro por situação e paginação; é o único lugar do painel que mostra **pago, pendente e reembolsado juntos** |

### 6.2 Vendas

| # | Funcionalidade | Status | Observação |
| --- | --- | --- | --- |
| A7 | Listar pedidos e filtrar por status | ✅ | |
| A8 | Detalhe do pedido (com histórico de auditoria) | ✅ | |
| A9 | Mudar status do pedido | ✅ | |
| A10 | **Confirmar pagamento de boleto pendente** | ✅ | O botão "Confirmar pagamento" usa `PATCH status`, que **delega para `confirmarPagamento`** e emite as chaves corretamente (verificado no código e no E2E) |
| A11 | Reembolsar/cancelar pedido (revoga as licenças) | ✅ | Chaves voltam como `revogada`, nunca `disponivel` |

### 6.3 Catálogo e promoções

| # | Funcionalidade | Status | Observação |
| --- | --- | --- | --- |
| A12 | Listar produtos (inclui inativos) com `X-Total-Count` | ✅ | |
| A13 | Criar produto com planos | ✅ | |
| A14 | Editar produto (UPSERT de planos) | ✅ | Nunca DELETE+INSERT — orfanaria as chaves do pool |
| A15 | Ativar/desativar produto | ✅ | Produto sem plano ativo sai da vitrine |
| A16 | Editar a descrição completa (modal do produto) | ✅ | Até 4000 caracteres, sem quebra de linha |
| A17 | Cupons: criar, editar, remover | ✅ | Percentual e valor fixo, mínimo, limite de usos, validade |
| A18 | Cupom aparece para o cliente e desconta | ✅ | Desconto confirmado no checkout |

### 6.4 Estoque e licenças

| # | Funcionalidade | Status | Observação |
| --- | --- | --- | --- |
| A19 | Resumo do estoque por plano + alertas de reposição | ✅ | |
| A20 | Adicionar chaves (quantidade gerada ou lista colada) | ✅ | Duplicadas são ignoradas; formato inválido é rejeitado |
| A21 | Ponto de reposição por plano | ✅ | |
| A22 | Ajustar a quantidade disponível | ✅ | Gera/descarta a diferença |
| A23 | Descartar chaves (FIFO, com motivo) | ✅ | |
| A24 | Ver chaves cruas e livro-caixa de movimentos | ✅ | Toda mudança tem autor e motivo |
| A25 | Listar licenças emitidas e revogar | ✅ | |
| A26 | Bloqueio de venda sem estoque | ✅ | 409 verificado |

### 6.5 Gateways

| # | Funcionalidade | Status | Observação |
| --- | --- | --- | --- |
| A35 | Listar gateways com situação e prioridade | ✅ | Simulador + 5 provedores reais; selo por gateway |
| A36 | Ligar/desligar gateway e escolher o modo | ✅ | *sandbox* / *produção*; em produção exige credenciais completas (422 se faltar) |
| A37 | Definir as formas de pagamento de cada gateway | ✅ | Pix, cartão, boleto — é o que alimenta `GET /api/pagamentos/metodos` |
| A38 | Guardar credenciais com segurança | ✅ | Cifradas em AES-256-GCM; a API só devolve a máscara; campo vazio preserva, `null` limpa |
| A39 | Testar a configuração do gateway | ✅ | `POST /admin/gateways/:gateway/testar` |
| A40 | Ver o histórico de webhooks | ✅ | Toda notificação recebida, com validade e motivo |
| A41 | Escolher a **forma de pagamento padrão** do checkout | ✅ | Seletor no topo da aba → `PATCH /admin/gateways/metodo-padrao`; a escolhida vem pré-selecionada no carrinho |
| A42 | Avisar quando a forma escolhida não tem provedor ligado | ✅ | O seletor entra em alerta, marca a opção "(sem provedor)" e diz qual forma o checkout usará de fato |

### 6.6 Pessoas e sistema

| # | Funcionalidade | Status | Observação |
| --- | --- | --- | --- |
| A27 | Listar e buscar usuários | ✅ | |
| A28 | Ficha do cliente (resumo, pedidos, licenças) | ✅ | |
| A29 | Promover/rebaixar papel | ✅ | Auto-rebaixamento bloqueado (422) |
| A30 | Ativar/desativar conta | ✅ | |
| A31 | Moderação de avaliações | ✅ | |
| A32 | Auditoria com filtro por entidade e ação | ✅ | Identifica o autor de cada ação |
| A33 | Configurações da loja | ✅ | Inclui aviso do topo, modo manutenção e texto |
| A34 | Modo manutenção | ✅ | Bloqueia a loja para clientes; admins continuam entrando |

---

## 7. API — mapa completo (85 handlers)

**Público / plataforma:** `GET /api/status` · `GET /api/saude` · `GET /api/produtos` · `/categorias` · `/destaques` · `/:id` (id **ou** slug) · `GET /api/cupons` · `POST /api/cupons/validar` · `GET /api/pagamentos/metodos` · `POST /api/pagamentos/webhook/:gateway` · `GET /api/avaliacoes/produto/:id`

**Auth:** `POST /api/auth/login` · `/registrar` · `/logout` · `/recuperar-senha` · `/redefinir-senha` · `GET /api/auth/me` · `/sessoes` · `PATCH /api/auth/senha` · `POST /api/auth/sessoes/encerrar-outras`

**Cliente:** `POST /api/vendas` · `GET /api/vendas` · `/:id` · `POST /:id/cancelar` · `GET /api/licencas` · `/resumo` · `POST /api/licencas/resgatar` · `GET|POST|DELETE /api/favoritos[/:produtoId]` · `POST /:produtoId/alternar` · `GET /api/avaliacoes/minhas` · `POST /api/avaliacoes` · `DELETE /api/avaliacoes/:id` · `GET|PATCH /api/conta` · `/pedidos` · `/dispositivos` · `/atividades` · `/preferencias`

**Admin** (tudo exige papel `admin`): `/painel` · `/relatorios` · `/financeiro` (+ `/pagamentos`) · `/diagnostico` · `/indicadores` · `/gateways` (+ `PATCH /metodo-padrao`, `/:gateway`, `/:gateway/testar`, `/eventos`) · `/pedidos` (+ `/:id`, `PATCH /:id/status`) · `/usuarios` (+ `/:id`, `PATCH /:id/papel`, `PATCH /:id/ativo`) · `/produtos` (+ `/:id`, `PATCH /:id`, `PATCH /:id/ativo`) · `/cupons` (+ `PATCH`/`DELETE /:codigo`) · `/avaliacoes` (+ `DELETE /:id`) · `/licencas` (+ `PATCH /:id/revogar`) · `/estoque` (+ `/chaves`, `/movimentos`, `POST /gerar`, `POST /descartar`, `POST /ajustar`, `PATCH /minimo`) · `/auditoria` · `/configuracoes` · `/eventos` (SSE)

**Extra:** `POST /api/vendas/:id/confirmar-pagamento` (admin) — confirma um pedido pendente (é o que o admin usa no simulador; em produção quem confirma é o webhook do gateway).

---

## 8. Lacunas — fechadas

Quando esta validação foi feita, existiam 7 lacunas de interface: recursos que já
funcionavam na API mas que o usuário ainda não alcançava pela tela. **Todas foram
fechadas** (detalhes na seção 12).

| # | Lacuna | Status | Onde ficou |
| --- | --- | --- | --- |
| L1 | Checkout não oferecia escolha de pagamento | ✅ fechada | Seletor de formas em `public/js/cart.js` (gaveta), alimentado por `GET /api/pagamentos/metodos` |
| L2 | Carrinho não tinha campo de cupom | ✅ fechada | Campo + chips de cupons e prévia por `POST /api/cupons/validar` |
| L3 | Recuperação de senha sem tela | ✅ fechada | Modal de 2 passos em `public/js/login.js` + `public/login.html` |
| L4 | Cliente não cancelava pedido pela tela | ✅ fechada | Botão "Cancelar pedido" em `/conta` → Meus pedidos |
| L5 | Cupons disponíveis não eram exibidos | ✅ fechada | Chips de `GET /api/cupons` na gaveta do carrinho |
| L6 | Indicadores não tinham tela | ✅ fechada | View **Indicadores** em `/admin` |
| L7 | `/api/produtos/destaques` era alias morto | ✅ fechada | A home passou a consumir o atalho (`home.js`) |

---

## 9. Observações para manutenção

1. **Pagamento por gateway, escolhido em runtime.** O simulador interno já nasce ativo (aprova Pix e cartão na hora e deixa boleto pendente), então a loja vende sem configurar nada. Para usar um provedor real, o admin liga o gateway no painel e informa as credenciais — os adaptadores ficam em `src/gateways/` (Mercado Pago, InfinityPay, Pagar.me, Asaas, Stripe), todos atrás do mesmo contrato (`gateways/base.js`).
2. **O webhook é real.** `POST /api/pagamentos/webhook/:gateway` valida a assinatura, é idempotente e registra toda notificação em `pagamentos_eventos`. No simulador, o admin ainda pode confirmar manualmente por `/vendas/:id/confirmar-pagamento`.
3. **Recuperação de senha devolve o token na resposta fora de produção** (para ser testável). Em produção, é obrigatório ligar o envio por e-mail e **remover esse campo**.
4. **Avaliação não tem tamanho mínimo de comentário** — só máximo (600). Hoje `"x"` é um comentário válido. Se a intenção era exigir um mínimo, é uma linha em `src/services/avaliacao.service.js`.
5. **Cache: uma regra só, decidida pelo nome do arquivo.** `/api/*` sai com **`Cache-Control: no-store`** (resposta de API nunca é cacheada pelo navegador). Os estáticos follow: arquivo **com *hash* de conteúdo no nome** (`comum.9f3a2b1c.js`, gerado por `npm run build`) sai com **`immutable, max-age=31536000`**; todo o resto (`.html` e os arquivos sem build) sai com **`no-cache`** (= revalide sempre: o navegador guarda, mas pergunta ao servidor via ETag/`Last-Modified` — um `304` barato, não um download). O *hash* é o que torna o `immutable` seguro: o nome muda junto com o conteúdo, então o navegador nunca serve versão velha. O HTML fica de fora de propósito — se fosse cacheado por um ano, um deploy novo não chegaria a ninguém. Antes, em **produção**, `.js`/`.css` saíam com `max-age=86400` enquanto o HTML revalidava — o pior caso, **HTML novo + JavaScript antigo**, e uma correção podia levar 24 h para chegar ao usuário. A política mora em `src/utils/cache.js`.
6. **O barramento de eventos é por instância** (`EventEmitter` em processo). Com mais de uma instância do servidor, trocar por Redis pub/sub — a rota SSE não muda.
7. **`npm run rebuild`** recompila o `better-sqlite3` para o Node atual. Ele é um módulo **nativo**: instalar no Node 22 e rodar no 24 causa `ERR_DLOPEN_FAILED`.
8. **Nunca editar uma migração já publicada** — acrescentar uma nova em `src/db/migracoes.js`. São 7 hoje.
9. **`substituirPlanos` é UPSERT de propósito.** Voltar para DELETE+INSERT apagaria os planos e **orfanaria as chaves** do estoque.
10. **Backfill do estoque não pode ser removido.** Num banco que já existia, a migração do estoque cria tabelas vazias e a loja inteira para de vender; `server.js` repõe no boot quando o pool nunca foi inicializado — mas respeita um estoque esvaziado de propósito pelo admin.
11. **Rate limit é desligado em ambiente de teste** (`skip: () => config.testes`), então os testes não sofrem 429.
12. **Segurança:** login não revela se o e-mail existe; trocar/redefinir senha derruba as outras sessões; tokens de recuperação guardam só o SHA-256 e são de uso único; cliente recebe 403 em `/api/admin/*`; CSP do Helmet é `scriptSrc: 'self'` — **nada de `onclick` inline**, usar delegação por `data-acao`.
13. **`dynamoveto` era malware** e foi removido. O `Projeto Vendas.zip` na raiz é o pacote antigo contaminado — **não instalar a partir dele**.

---

## 10. Como rodar e verificar

```bash
npm start          # sobe o servidor (cria banco, semeia e repõe estoque no 1º boot)
npm run dev        # nodemon
npm test           # 126 testes de integração (SQLite em memória, não toca nos dados)
npm run db:migrate / db:seed / db:reset
npm run rebuild    # recompila o better-sqlite3 para o Node atual
```

> **Rodar os testes exige o Node 24** (o `better-sqlite3` é nativo e o binário depende do ABI):
> `"/c/Program Files/nodejs/node.exe" --test "testes/*.test.js"` — o glob **precisa** das aspas.

Páginas: `/` · `/produtos` · `/login` · `/termos` · `/conta` (cliente) · `/admin` (administrador).

---

## 11. Conclusão

O sistema está **operacional e consistente** nos dois perfis. A arquitetura em três camadas se sustenta na prática: as regras de negócio que mais importam — preço recalculado no servidor, estoque como fonte da verdade, licença contada a partir do resgate, boleto sem entrega antecipada, cupom consumido só na confirmação, compra verificada para avaliar — **todas passaram na validação**.

O trabalho que restava não era de correção, era de **interface**: fechar as 7 lacunas da
seção 8, começando pelo checkout (formas de pagamento e cupom). **Isso foi feito** — ver
o adendo abaixo.

---

## 12. Adendo — lacunas fechadas e módulo de gateways

Depois da validação, a interface foi completada e a cobrança ganhou profundidade. Nada
do que já passou na seção 11 regrediu; o que mudou foi somado.

### 12.1 Lacunas fechadas

| Lacuna | O que foi feito |
| --- | --- |
| **L1 — forma de pagamento** | A gaveta do carrinho monta um seletor (Pix / cartão / boleto) a partir de `GET /api/pagamentos/metodos` e envia `metodoPagamento` no checkout. Sem forma escolhida, o botão de finalizar fica bloqueado; boleto leva à tela "falta só o pagamento", com o código copiável |
| **L2 — cupom no carrinho** | Campo de código + chips dos cupons públicos (`GET /api/cupons`), com prévia do desconto (`POST /api/cupons/validar`) e revalidação a cada mudança do carrinho |
| **L3 — recuperação de senha** | Modal de 2 passos no `/login` (e-mail → código + nova senha); o link `/login?token=…` abre direto no passo 2 |
| **L4 — cancelar pedido** | Botão "Cancelar pedido" com confirmação em `/conta` → Meus pedidos, para pedidos ainda não pagos |
| **L5 — cupons visíveis** | Os cupons ativos aparecem como chips na gaveta |
| **L6 — indicadores** | Nova view **Indicadores** no `/admin` (KPIs, gráfico, "desejados" e "mais vendidos") |
| **L7 — destaques** | A home passou a consumir `GET /api/produtos/destaques` |

### 12.2 Módulo de gateways de pagamento (novo)

- **`src/gateways/`** — contrato comum (`base.js`) + catálogo (`catalogo.js`) + um
  adaptador por provedor: simulador, Mercado Pago, InfinityPay, Pagar.me, Asaas, Stripe.
- **`src/services/gateway.service.js`** — catálogo no banco, prioridade (provedores reais
  acima do simulador), métodos por gateway, cifra das credenciais e diagnóstico.
- **Credenciais cifradas** em AES-256-GCM (`utils/cripto.js`, chave derivada do
  `SEGREDO_APP`). A API devolve só a máscara; campo vazio preserva o segredo, `null` limpa.
- **Guarda de produção:** ligar um gateway real em produção sem credenciais completas é
  bloqueado (`422`).
- **Webhook** (`POST /api/pagamentos/webhook/:gateway`): valida a assinatura, recusa
  notificação inválida com `400` (para o gateway reenviar), é **idempotente** e registra
  todo evento em `pagamentos_eventos`.
- **Instruções de pagamento** guardadas no pedido (`vendas.instrucoes_pagamento`), então o
  cliente reabre um boleto pendente em `/conta` e paga de novo se precisar.
- **Migrações 6 e 7** criam `gateways`, `pagamentos_eventos` e a coluna de instruções.
- **Nova view Gateways** no `/admin` (o painel passou de 12 para **14 seções**).

### 12.3 Verificação do que foi somado

- **`npm test` → 113/113** (eram 94). Os novos cobrem: catálogo de gateways, segredos que
  nunca voltam em texto puro, guarda de produção, gateway real assumindo a cobrança,
  webhook com assinatura inválida recusada e confirmação idempotente, cancelamento do
  pedido pelo cliente (dono, não pago), o bloqueio de escrita com `Origin` de outro site
  e a **forma de pagamento padrão** (escolhida no painel, recusa de valor inválido).
- **Validador de API** (app em processo) → verificações de pagamentos e indicadores
  aprovadas.
- **Navegador real (Edge)** → **41/41 verificações sem erro de JavaScript**, cobrindo as
  14 views do `/admin` (com Gateways e Indicadores), o carrinho (formas de pagamento,
  cupom e desconto no resumo), a recuperação de senha e o cancelamento de pedido no
  `/conta`. O único `401` observado é o `/api/auth/me` anônimo — esperado.

### 12.4 Nomenclatura e forma de pagamento padrão

**O módulo virou "Gateways".** O termo "pagamentos" ficou reservado para os **pagamentos
recebidos** (pedidos e confirmações, que vivem em **Pedidos**). A aba, a rota
(`/api/admin/gateways`) e o código foram renomeados; o endereço antigo (`#/pagamentos`)
continua valendo por um alias no roteador, e as rotas **públicas** (`/api/pagamentos/*`)
foram mantidas de propósito — são o contrato do carrinho e a URL de webhook já cadastrada
no painel de cada provedor.

**Forma de pagamento padrão configurável.** No topo da aba há um seletor com as formas
conhecidas; a escolhida passa a vir **pré-selecionada no checkout**. É uma preferência, não
uma garantia: se nenhum provedor ligado aceitar a forma escolhida, o checkout **cai para a
primeira disponível** em vez de bloquear a venda, e o painel avisa qual será usada de fato
(marcando a opção "(sem provedor)"). A escolha é gravada em `configuracoes` via
`gatewayService.definirMetodoPadrao()` (com auditoria `gateway.metodo_padrao`); o
`PAGAMENTO_METODO_PADRAO` do `.env` só vale como fallback. O diagnóstico passou a reportar
o valor **efetivo** (o do painel), para não contradizer a aba Gateways.

**Verificação (49/49 no navegador).** Três scripts com o app em processo e Edge headless:

- **Função (25):** a rota antiga `#/pagamentos` redireciona para `#/gateways` e o menu diz
  "Gateways"; o seletor lista as 3 formas, começa em Pix e o cartão do Pix traz o selo
  "Padrão no checkout"; trocar para boleto persiste no servidor (`metodoPadrao`) e no
  checkout público (`padrao`); **caso sem provedor:** desligando o simulador e ligando só a
  Stripe (que só aceita cartão), o boleto escolhido fica "(sem provedor)", o seletor entra
  em alerta, a nota diz que o checkout usará cartão e o destaque da vitrine migra para o
  cartão; método inválido é recusado com `400 dados_invalidos` e a recusa diz o que é
  aceito; nenhum erro de JavaScript na tela.
- **Layout (18):** 3 medições × 6 larguras (760, 900, 1024, 1180, 1366 e 1600px) — sem
  rolagem horizontal, sem transbordo no seletor e sem cartão estourando.
- **Diagnóstico (6):** o card "Pagamento e ambiente" mostra "Forma padrão", "No checkout" e
  "Formas na vitrine" com nomes legíveis (Pix, não `pix`), sem o rótulo antigo "Método
  padrão", e sem erro de JavaScript.

**Defeito de layout corrigido (pré-existente).** A verificação em 6 larguras pegou um bug
real na vitrine: `.adm-vitrine__meta` era `flex: none`, então o bloco de selos ficava com a
largura do `max-content` e **vazava para fora da borda do cartão** quando o cartão era
estreito (325px de caixa contra 426px de selos). Corrigido com `max-width: 100%` no bloco —
os selos passam a quebrar entre si em vez de estourar. Nenhuma largura testada estoura agora.

---

## 13. Adendo — Gateways em Sistema e a seção Financeiro

**O que motivou.** Duas coisas: (a) **Gateways** é configuração de infraestrutura — credenciais,
modo, prioridade —, então não pertence ao grupo **Vendas** (operação do dia a dia); foi para
**Sistema**. (b) O painel não tinha um lugar para o **dinheiro**: o "financeiro" só existia
como campos soltos dentro de Painel, Relatórios e Diagnóstico. Como a nomenclatura passou a
separar **gateway** (provedor que cobra) de **pagamentos** (pagamentos recebidos), a parte
financeira precisava de casa própria.

### 13.1 O que mudou

- **Menu:** `Gateways` saiu de **Vendas** e entrou em **Sistema**; entrou uma seção
  **Financeiro** em **Visão geral**. O painel passou de **14 para 15 seções**.
- **Backend:** `GET /admin/financeiro` (o caixa do período) e
  `GET /admin/financeiro/pagamentos` (o extrato, paginado). Três consultas novas em
  `vendas.repo.js` (`totaisPorStatusNoPeriodo`, `porProvedorNoPeriodo`,
  `listarPagamentosNoPeriodo`) e um serviço novo, `financeiro.service.js`.
- **Frontend:** a view **Financeiro** em `admin.js` (barra de período, 6 KPIs, duas quebras
  de participação e o extrato com filtro e paginação). Ela reage ao evento SSE
  `venda.atualizada`, então o caixa se atualiza sozinho quando um pagamento entra ou é
  estornado.

### 13.2 A divisão com os Relatórios

Não é duplicação — é **foco** diferente:

| | Relatórios | Financeiro |
| --- | --- | --- |
| Pergunta | "estou vendendo bem?" | "quanto entrou e quanto falta entrar?" |
| Universo | só pedidos **pagos** | **todos** os status |
| Entrega | tendência, série diária, top produtos, categorias, cupons | recebido, a receber, devolvido, cancelado, descontos, extrato |

É por isso que os dois convivem: o Relatórios esconde o boleto pendente (não é desempenho),
e o Financeiro precisa dele (é caixa a receber). O **ticket médio** do Financeiro é derivado
do recebido (`recebido.valorCentavos / recebido.pedidos`), nunca um número solto.

### 13.3 Verificação (62/62 no navegador)

Um script com o app em processo (`BANCO_ARQUIVO=:memory:` + `semear()`) e Edge headless,
semeando **28 pedidos no pix + 1 boleto + 1 estorno** pela própria API antes de olhar a tela
(para não validar só o estado vazio):

- **Menu (3):** `Gateways` está em **Sistema** e **não** em Vendas; `financeiro` está em
  **Visão geral**. E o item Gateways, da nova posição, abre a view.
- **Tela (11):** título, os 6 KPIs presentes e os valores batendo com a API (`Recebido`,
  `A receber`, `Devolvido`), quebra por forma mostrando "Pix" e por provedor mostrando
  "Simulador interno", com os nomes legíveis.
- **Extrato (8):** 25 linhas na 1ª página, "29 registro(s) · página 1 de 2", a 1ª linha com
  valor em reais e data (relativa no texto, absoluta no `title`), 4 linhas na 2ª página.
- **Filtros (6):** "Devolvidos" → 1 linha marcada como Reembolsado e a paginação em 1 de 1
  com os dois botões desabilitados; "A receber" → 1 linha; trocar para 7 dias mantém o
  recebido (tudo é de hoje) e o subtítulo acompanha.
- **Sem erro de JS (1)** e **layout (18):** 3 medições × 6 larguras (760 a 1600px) — sem
  rolagem horizontal, sem bloco estourando e sem KPI recortando o próprio conteúdo.

> **Nota sobre os falsos positivos desta bateria.** Três asserções nasceram erradas e
> **nenhuma era defeito do sistema**: (1) o "Quando" do extrato mostra tempo **relativo**
> ("agora há pouco") com a data absoluta no `title` — o regex procurava `dd/mm/aaaa` no
> texto; (2) a paginação com 1 resultado **continua na tela** (convenção de Pedidos,
> Usuários, Auditoria e Relatórios) — a asserção esperava que sumisse; (3) o `.adm-kpi` acusa
> 40px de `scrollWidth` por causa de um **brilho decorativo** (`::after` em `right:-40px`)
> recortado de propósito pelo `overflow: hidden` do cartão — e Relatórios mostra exatamente
> os mesmos 40px. O script foi corrigido nas três.

### 13.4 Defeito corrigido no caminho (pré-existente)

O subtítulo de período dizia **"Ultimos 7 dias"**, sem acento, enquanto o seletor logo acima
dizia "Últimos 7 dias". O erro estava em `montarJanela()` (`relatorio.service.js`) e afetava
**Relatórios e Financeiro** — corrigido para `Últimos ${periodo} dias`. Nenhum teste quebrou
(o único que fixava a string era um script temporário).

### 13.5 Suíte

**`npm test` → 120/120** (eram 113). Os 7 testes novos cobrem: `/admin/financeiro` exclusivo
do admin (403 `sem_permissao`), o retrato do caixa (recebido/a receber/devolvido convivendo,
ticket médio derivado, nomes legíveis por forma e por provedor, todos os status presentes,
comparativo com o período anterior), o extrato (ordem do mais recente ao mais antigo, forma
do item, as três situações juntas), o filtro por situação com recusa de valor inválido
(400 `dados_invalidos`), a paginação sem repetir pedidos e a janela explícita de datas
(intervalo válido, intervalo invertido recusado e formato de data inválido recusado).

---

## 14. Adendo — "Produtos em destaque" não atualizava com um produto novo

**O sintoma relatado.** O usuário criou um produto, marcou como destaque e ele **não apareceu**
na seção "Produtos em destaque" da home. Um F5 também não resolvia. O pedido foi investigar
**todas** as causas possíveis (sincronização de dados, cache, atualização de estado,
revalidação) e corrigir tudo — incluindo problemas semelhantes em outras seções.

**Havia quatro causas independentes.** Cada uma sozinha já bastava para esconder o produto;
corrigir só uma não resolveria o problema.

### 14.1 Causa 1 — a ordenação dos destaques (a raiz)

`catalogo.service.destaques()` pedia a lista com `ordem: 'relevancia'`, cujo desempate é
`ordem ASC`. Mas todo produto novo entra no catálogo com a **maior** `ordem`
(`proximaOrdem()` = `MAX(ordem)+1`), ou seja, **no fim**. Como o seed já ocupava as três
primeiras posições (0/1/2), um destaque recém-criado **nunca** entrava no top 3 — nem com F5,
nem com o cache limpo. Era um problema de **seleção no servidor**, não de tela.

**Correção:** a home passou a pedir os **destaques mais recentes** —
`destaques()` usa `ordem: 'recentes'` → `criado_em DESC, ordem DESC, nome ASC`. O `ordem DESC`
como desempate existe para o caso de produtos criados no **mesmo milissegundo** (o seed cria
três de uma vez). O campo "Ordem na vitrine" continua mandando no catálogo (`/api/produtos`);
a home **ignora** esse campo de propósito.

### 14.2 Causa 2 — cache da API

As respostas de `/api/*` não mandavam `Cache-Control` — só um ETag fraco. O navegador podia
aplicar **heuristic caching** e servir um `/api/produtos/destaques` velho sem nem consultar o
servidor. **Correção:** `no-store` para todo `/api/*` (um middleware antes do rate limit).

### 14.3 Causa 3 — cache dos estáticos em produção

Em produção, `.js`/`.css` saíam com `max-age=86400` (1 dia) e o HTML revalidava. Resultado: se
uma correção de front fosse necessária, o usuário ficaria com **HTML novo + JavaScript antigo**
por até 24 h — a tela pareceria "ignorar" o código. **Correção em duas etapas:** primeiro os
estáticos passaram a sair com `no-cache` em **qualquer** ambiente (revalidação por
ETag/`Last-Modified`, custo de um `304`), já que `max-age` longo era uma promessa incumprível
sem *hash* no nome; depois o build (`npm run build`) passou a gerar os arquivos com *hash* de
conteúdo, o que permitiu devolver o cache longo — agora com `immutable` — **só** para quem o
pode pagar. O HTML continua `no-cache`, porque é ele que aponta para os assets.

### 14.4 Causa 4 — estado do cliente / revalidação

A home e a vitrine buscavam os dados **uma vez** no `load`. Um produto criado no painel (em
outra aba) só aparecia com F5. **Correção:** novo helper `Api.aoRevalidar(callback, opcoes)`
em `api.js`, que dispara na volta à aba (`visibilitychange`/`focus`), com **debounce** de
200 ms, no máximo 1×/minuto e uma **janela de carga** de 500 ms (ignora eventos logo após o
carregamento). A home e a vitrine **só repintam se o HTML mudou** (comparação com o último
render) — na vitrine isso preserva os filtros; na home evita o "piscar". A home ainda
**não apaga** a lista visível se a revalidação falhar.

### 14.5 Outras seções verificadas

- **Modal do produto:** já busca `GET /api/produtos/:id` a cada abertura — a única defasagem
  é cosmética (preço/estoque mostrado no card até abrir).
- **Login:** não tem conteúdo dinâmico de produto.
- **Painel `/admin`:** já é sincronizado por **SSE** (não usa revalidação na volta da aba).

### 14.6 Deixar o painel honesto

O que causou a confusão original foi o rótulo do formulário. O campo "Ordem na vitrine" parecia
governar a home. Agora o texto de "Destaque na home" diz que a home mostra **os 3 destaques
mais recentes — marcar já faz aparecer**, e o campo "Ordem na vitrine" avisa que **a home não
usa esse campo**.

### 14.7 Verificação

- **Reprodução primeiro:** um script criou um produto com `destaque: true` e confirmou que ele
  **não** aparecia em `/api/produtos/destaques`; depois do fix, apareceu.
- **`npm test` → 126/126** (eram 120). Seis testes novos: os destaques vêm dos mais recentes;
  marcar como destaque basta (não depende da "Ordem na vitrine"); produto sem destaque ou
  inativo não aparece; tirar o destaque remove da home; `/api/*` responde `no-store`; os
  estáticos respondem `no-cache` em qualquer ambiente.
- **Navegador (Edge headless), 24/24:** o produto novo aparece na home **ao voltar para a
  aba** (sem F5) e **entra na frente** por ser o mais recente; a página **não recarrega**; o
  carregamento inicial pede os destaques **uma vez só** (sem duplicar); a vitrine também ganha
  o produto; a revalidação **não perde a categoria escolhida**. Zero erro de JavaScript.
  Print em `tmp-prints/home-destaques.png`.
- **Armadilhas do próprio teste (nenhuma era defeito do sistema):** em headless o Edge mantém
  toda aba `visible`, então `bringToFront()` **não** dispara `visibilitychange` — o evento teve
  de ser disparado à mão; e a revalidação disparada logo após o `load` é (corretamente)
  engolida pela janela de carga, então o teste precisou esperar ~700 ms antes de simular a
  volta à aba.
