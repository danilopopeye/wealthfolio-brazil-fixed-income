# 05 — Teste ponta a ponta (Fase 5)

Status: **roteiro pronto para execução manual**. Última atualização: 20/09/2026.

Fluxo validado por este roteiro: `Wealthfolio → Custom Market Data Provider → API Go → fonte do CDI → cálculo → JSON → Wealthfolio`. Os valores esperados abaixo são os das fixtures reais (`docs/bootstrap.md`) e da execução ao vivo de 20/09/2026.

## 0. Subir a API

```bash
docker compose up -d        # ou: cd api && go run .
curl localhost:8080/pu/CDI-104.50-20260713
# {"currency":"BRL","date":"2026-09-20","estimatedDays":1,"price":1026.94758878,...}
```

Se `API_KEY` estiver configurada, todos os curls levam `-H "X-API-Key: ..."` e o provider recebe headers (ver 1.3).

## 1. Custom Provider no Wealthfolio

Settings → Market Data → adicionar custom provider. Código `cdb` (minúsculo), nome sugestivo (`CDB Brasil (BCB)`), habilitado.

### 1.1 Fonte latest (cotação do dia)

| Campo | Valor |
|---|---|
| kind | `latest` |
| format | `json` |
| url | `http://localhost:8080/pu/{SYMBOL}` |
| pricePath | `$.price` |
| datePath | `$.date` |
| currencyPath | `$.currency` |

### 1.2 Fonte historical

| Campo | Valor |
|---|---|
| kind | `historical` |
| format | `json` |
| url | `http://localhost:8080/history/{SYMBOL}?from={FROM}&to={TO}` |
| pricePath | `$.prices[*]` |
| datePath | `$.dates[*]` |
| dateFormat | `%Y-%m-%d` |
| dateTimezone | `America/Sao_Paulo` |

### 1.3 Headers (somente se `API_KEY` ligada)

Em ambas as fontes: `{"X-API-Key": "__SECRET__cdb_api_key"}` — o prefixo `__SECRET__` manda o valor para o keyring do sistema.

### 1.4 Testar antes de sair da tela

Botão de teste com symbol `CDI-104.50-20260713`:
- latest → price `1026.94758878` (em 20/09; `estimatedDays` reflete o carry)
- historical com from `2026-09-10` / to `2026-09-20` → 7 linhas (dias úteis, sem 07/09), primeira 1023.09 (10/09), última 1026.40 (18/09)

## 2. Cadastrar os CDBs (assets)

Um asset por título. Campos essenciais:

| Campo | CDB Banco A | CDB Banco B |
|---|---|---|
| Symbol canônico | `CDB-BANCOA-1045` | `CDB-BANCOB-1430` |
| Nome | `CDB Banco A 104,50% CDI jul/2027` | `CDB Banco B 14,30% a.a. jul/2030` |
| instrumentType | **Equity** | **Equity** |
| Moeda | `BRL` | `BRL` |
| Exchange | `MANUAL` | `MANUAL` |
| Quote mode | `MARKET` | `MARKET` |

Notas:
- **Não usar Bond**: `InstrumentType::Bond` roteia para `BondIsin`, que o custom provider rejeita ("Unexpected instrument type") — investigação 01, item 9.
- O vencimento fica no nome/notas (não há campo de maturity fora do tipo Bond).
- Os symbols canônicos respeitam a regex de atividades (máx. 2 separadores) — seguros inclusive em import de CSV.

**Aba Market Data do asset**: provider preferido `cdb`; na linha de override do provider, symbol `CDI-104.50-20260713` (Banco A) e `PRE-14.30-20260713` (Banco B). É deste override que o `{SYMBOL}` da URL é preenchido.

## 3. Registrar as compras

| | Banco A | Banco B |
|---|---|---|
| Tipo | BUY | BUY |
| Data | 11/09/2026 | 11/09/2026 |
| unitPrice | `1024.19875526` (PU de 14/09 — conferir com o extrato; a Banco B exibiu 2 casas) | `1023.61` |
| quantity | valor aplicado ÷ unitPrice | idem |

Exemplo com R$ 5.000,00 em cada: Banco A `4.88191`, Banco B `4.88480`. O custo fica nos lots; o ganho sairá contra o PU corrente.

## 4. Critérios de aceite

1. Preço atual do asset: Banco A ≈ `1026.95`, Banco B ≈ `1026.33` (domingo 20/09 — PU do próximo dia útil).
2. Valor da posição = quantity × PU: R$ 5.000 → Banco A ≈ `R$ 5.013,45`, Banco B ≈ `R$ 5.013,42`.
3. Histórico no gráfico: um ponto por dia útil desde a emissão; **sem** 07/09; primeiro ponto `1000.00` em 13/07.
4. Ganho não realizado ≈ +0,27% (Banco A) e +0,26% (Banco B) — uma semana de CDI a 104,5%.
5. `/healthz` com `source.ok=true` e `cdi.lastDate` avançando conforme a série publica.

## 5. Troubleshooting

| Sintoma | Causa provável |
|---|---|
| Preço não chega | override de symbol vazio/errado na aba Market Data (é dali que vem o `{SYMBOL}`) |
| 401 nos testes | `API_KEY` definida sem header no provider (1.3) |
| 503 no pós-fixado | fonte BCB fora + cache frio (o prefixado não depende da fonte) |
| PU "parado" | série pública atrasada (lag CETIP→SGS): ver `estimatedDays`/`/healthz`; K=3 de carry |
| Histórico vazio | janela pedida inteira antes da emissão (comportamento correto, D6) |
| Diferença de centavos vs extrato | PU bruto, sem IR/IOF; arredondamentos de exibição do banco |
| Compra “sumiu” da posição | campo de data digitado como `11/09/2026` pode virar `2026-11-09` (MM/DD) — usar o seletor de calendário ou ISO `2026-09-11`; atividade futura não entra na posição atual |

## 6. Checklist final da Fase 5

- [ ] API de pé e `/healthz` ok
- [ ] Provider criado e testado (latest + historical)
- [ ] Assets criados com override correto
- [ ] Compras registradas com unitPrice = PU de liquidação
- [ ] Posições batendo com os valores esperados
- [ ] Resgate futuro: registrar SELL na data de vencimento pelo PU final (mesma mecânica)

## Apêndice A — Rodando o Wealthfolio local (upstream v3.9.0)

O clone de referência está em `wealthfolio/`. Três modos, todos com banco novo e vazio (os cadastros deste roteiro valem para o banco do modo escolhido):

**A. Web mode (browser + backend Axum; recomendado para o teste):**

```bash
cd wealthfolio
pnpm install
cp .env.web.example .env.web
pnpm run dev:web          # http://localhost:1420
```

Se o backend reclamar de `WF_SECRET_KEY`: `openssl rand -base64 32` no `.env.web`.

**B. Desktop (Tauri):**

```bash
cd wealthfolio
cp .env.example .env      # DATABASE_URL=../db/wealthfolio.db
pnpm tauri dev             # primeira compilação Rust é longa
```

**C. Docker dev (sem Rust local):**

```bash
cd wealthfolio
printf 'WF_SECRET_KEY=%s\n' "$(openssl rand -base64 32)" > .env.docker
docker compose --env-file .env.docker -f compose.yml -f compose.dev.yml up
# http://localhost:8088
```

**Endereço da cdb-api nas fontes do provider, por modo:**

| Modo | URL da fonte |
|---|---|
| A (web local) / B (tauri) | `http://localhost:8080/...` |
| C (docker) | `http://host.docker.internal:8080/...` (container não resolve `localhost` do host) |
| App instalado (desktop) | `http://localhost:8080/...` |
