# wealthfolio-brazil-fixed-income

Market data and registration tooling for Brazilian fixed income in [Wealthfolio](https://github.com/wealthfolio/wealthfolio): CDB, LCI, LCA and LCDA titles — post-fixed (% of CDI) and pre-fixed (% p.a.) — priced in BRL from the official CDI series.

The project has two components:

- **Wealthfolio addon** (`src/`) — *Cadastro Renda Fixa*: an in-app wizard that computes the unit price (PU), creates the security with the correct type (Bond, with maturity) and records the purchase, all validated against the live CDI series.
- **Market data API** (`api/`) — a dependency-free Go service that serves the PU to the Wealthfolio custom market data provider, backed by a local cache of the BCB SGS series 12 (daily CDI).

Wealthfolio remains the single source of truth: the API is stateless regarding investments (only the CDI cache), and the addon only writes through the host SDK.

## How the math works

Every title is priced from its emission at a PU base of **BRL 1,000.00**:

- Post-fixed: `PU(D) = 1000 × Π (1 + pct × cdi_k)` over each business day `k` in the window `[emission, D)`.
- Pre-fixed: `PU(D) = 1000 × (1 + rate)^(n/252)`, `n` = business days in the same window.

The convention set (emission day counts, valuation day does not; weekend PU equals the next business day; carnaval runs Monday–Tuesday for the CDI market) was **reverse-engineered from real bank readings** and is enforced by regression suites in two languages — all four reference readings reproduce with error < 1e-6:

| Suite | Where | Runs |
|---|---|---|
| Go tests | `api/` (`go test ./...`) | CI |
| TS fixtures | `pnpm test` (`scripts/check-engine.ts`) | CI |
| Live validation | `node scripts/check-cdi.mjs` | manual (network) |

Real-world tolerance classes: pre-fixed lands within display rounding (one cent observed), long-window post-fixed carries the accumulated rounding of the published series (~0.005% over 8 months observed).

## Quick start

### API (Docker)

```bash
docker compose up -d
curl localhost:8080/healthz
```

The API root (`http://localhost:8080/`) serves a static setup manual with the exact custom provider configuration to paste into Wealthfolio (Settings → Market Data, provider code `brasil-renda-fixa`).

### Addon

```bash
pnpm bundle          # dist/wealthfolio-brazil-fixed-income-<version>.zip
```

Import the zip in Wealthfolio → Settings → Add-ons. The sidebar gains *Cadastro Renda Fixa*: fill in the title (product name, indexer, rate), the purchase (date, amount, and PU or quantity if you bought an existing title — the emission date is solved backwards automatically), the optional maturity, and register. The addon creates the security as a Bond, wires the provider override, syncs the market data and confirms the expected position value.

For addon development: `pnpm dev:server` plus Wealthfolio running with `VITE_ENABLE_ADDON_DEV_MODE=true` (the dev server is discovered on port 3001).

## Repository layout

```
api/        Go market data API (/pu, /history, /solve/emission, /healthz, static manual)
src/        Wealthfolio addon (PU engine in TS + registration wizard)
scripts/    Fixture checkers (hermetic + live) and packaging helpers
docs/       Project phases in Portuguese (working logs: bootstrap contract, investigation,
            design, validation, implementation, end-to-end guide)
```

The `docs/` folder tells the full story: the financial conventions were validated against real fixtures before a line of the API was written, and every claim carries an evidence tag.

## License

MIT
