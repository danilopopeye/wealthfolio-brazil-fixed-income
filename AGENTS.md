# AGENTS.md

Renda fixa brasileira para o Wealthfolio: uma API Go de market data (`api/`) e um addon de cadastro (`src/`). Código e Git em inglês; conversa pode ser em português.

## Layout

- `api/` — API Go (provider de market data: `/pu`, `/history`, `/solve/emission`, `/healthz`; manual estático em `/`). Testes: `cd api && go test ./...` (fixtures embutidas, hermético).
- `src/` — addon do Wealthfolio (Cadastro Renda Fixa): engine TS de PU em `src/lib/engine.ts` + wizard em `src/pages/`. Gate local: `pnpm check`.
- `scripts/` — `check-engine.ts` (fixtures herméticas, roda no `pnpm test`/CI) e `check-cdi.mjs` (validação ao vivo contra o SGS — requer rede, manual).
- `docs/` — `bootstrap.md` é o contrato do projeto (regras de evidência `[código]`/`[fixture]`/`[decisão]`/`[hipótese]`); `01`–`05` são as fases executadas.
- `wealthfolio/` — clone do upstream v3.9.0 **gitignored**: ferramentas que respeitam .gitignore não o veem — busque sempre com path explícito (ex.: `wealthfolio/crates/...`). É a fonte para evidências do lado do host.

## Regras vivas

- A matemática de PU existe em 4 lugares que fecham juntos: `api/*_test.go`, `scripts/check-engine.ts`, `scripts/check-cdi.mjs` e as fixtures de `docs/bootstrap.md`. Mudou um, os suites têm que fechar antes do commit.
- Versão do addon: `manifest.json` é a fonte única (`pnpm bundle` sincroniza `package.json` e gera o zip).
- Diagnóstico do Wealthfolio local (modo web): sqlite somente-leitura em `wealthfolio/db/web-dev.db`.
- Addons não alcançam localhost/IPs privados (proteção SSRF do host): o addon busca o CDI direto do BCB e calcula client-side — a API Go serve o provider, o addon serve o cadastro.
