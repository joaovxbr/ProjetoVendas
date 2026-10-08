# ESTADO.md — NEXUS.GG

Situação do trabalho em **02/10/2026**. Atualizar a cada marco.

## Concluído nesta etapa (02/10/2026)

**Build do front** — era o último item pendente, agora fechado.

| Entrega | Onde |
| --- | --- |
| Política de cache (função pura, fora do Express) | `src/utils/cache.js` |
| Build: minifica, versiona, reescreve o HTML | `scripts/build.js` |
| Pacote de deploy (lista branca + `.zip`) | `scripts/pacotar.js` |
| Servidor serve `dist/public` em produção, `public` em dev | `src/app.js` |
| Aviso de boot quando produção sobe sem build | `server.js` (`verificarFront`) |
| Testes (16 novos) | `testes/build.test.js` |
| `build` e `pack` no `package.json`, `esbuild` em devDeps | `package.json` |
| `dist/` fora do versionamento | `.gitignore` |
| Seção "Build e produção" + correções de "sem build" | `README.md`, `RELATORIO-VALIDACAO.md` |

### Como funciona

- **Dev:** serve `public/` direto, sem build. Editar e recarregar.
- **Produção com `dist/`:** serve `dist/public/` — minificado, com hash no nome, `immutable` de 1 ano.
- **Produção sem `dist/`:** **avisa no boot** e serve `public/`. Não quebra.

Regra de cache: arquivo **com hash** no nome → `immutable, max-age=31536000`.
Todo o resto, HTML inclusive → `no-cache`. A decisão é pelo **nome**, não pelo ambiente.

### Ganho medido

- Painel admin, 1ª visita: 8 → 4 requisições, 77,1 → 52,1 KB gzip (**−32 %**)
- Painel admin, 2ª visita: **0 bytes**
- Site inteiro (js+css): 21 → 14 arquivos, 514,2 → 448,1 KB (−12,8 %)

## Verificação feita

- `npm test` — **158/158** (era 142; +16)
- `node --check` em todos os arquivos novos e editados
- Build roda nas 6 páginas: 2 JS + 2 CSS cada, sintaxe de cada bundle validada com `vm.Script`, ordem comum→página preservada
- Cabeçalhos via HTTP em `NODE_ENV=production`: HTML `no-cache`, assets `immutable`, `/js/api.js` cru **404** (não é mais servido)
- Três caminhos de boot conferidos em processos separados: dev, produção com build, produção sem build
- `npm run pack` → `dist/nexus-gg-deploy.zip`, 103 arquivos, estrutura conferida; nenhum `.env`, `dados/` ou `node_modules`

## Pendente

- **Regressão visual headless** (390 px e 320 px, nas 6 páginas e nas abas do painel) — o
  navegador do Claude pane estava indisponível durante toda a sessão
  (`claude-opus-5 is temporarily unavailable`). Fica como conferência a fazer; o build não
  toca em HTML, CSS de layout ou ordem de execução, e os bundles foram validados por sintaxe,
  então o risco é baixo — mas não foi visto.

## Não mexer

- `tmp-verificar-financeiro.js` e `tmp-prints/` — pré-existentes, preservados.
- `Projeto Vendas.zip` na raiz — **pacote antigo contaminado, nunca instalar a partir dele.**
