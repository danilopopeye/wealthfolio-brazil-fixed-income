# 03 — Validação do design (Fase 3)

Status: **concluído — aguardando aprovação (GATE)**. Última atualização: 20/09/2026.

Este arquivo lista explicitamente, para cada afirmação que sustenta o design (`docs/02-design.md`), sua tag de evidência. Nada marcado `[hipótese]` entra na implementação sem virar `[doc]`, `[código]` ou `[fixture]` — as hipóteses remanescentes estão na seção final, com mitigação e fase de fechamento.

Instrução do bootstrap verificada: **o Wealthfolio não passa parâmetros arbitrários além dos placeholders** — confirmado no código (`TemplateContext` em `crates/core/src/custom_provider/model.rs:70-77` é o único canal de parametrização; todo o resto chega pela URL/headers/body templated). Os parâmetros do título viajam dentro do symbol do override, como desenhado.

## `[doc]` — vazio

Nenhuma afirmação do design pendura apenas em documentação. Os itens que o bootstrap carregava como `[doc]` foram todos promovidos a `[código]` na investigação — e um deles foi **corrigido**: "somente GET" é falso na v3.9.0 (GET e POST, ver abaixo).

## `[código]` — confirmado no fonte v3.9.0 (clone em `wealthfolio/`)

1. Placeholders: `{SYMBOL}`, `{currency}`, `{CURRENCY}`, `{TODAY}`, `{FROM}`, `{TO}`, `{ISIN}`, `{MIC}`, `{DATE:fmt}`, `{FROM:fmt}`, `{TO:fmt}`, `{TODAY:fmt}`; `{FROM}`/`{TO}` default = hoje; date-only `%Y %m %d`; `{ISIN}`→symbol; `{MIC}`→vazio — `crates/core/src/custom_provider/model.rs:106-133`.
2. Métodos **GET e POST** com body templated — `model.rs:13-26`, `VALID_HTTP_METHODS`.
3. URL: qualquer host http/https, inclusive rede privada — `model.rs:190-212` (`validate_url`).
4. Headers customizados; valores com prefixo `__SECRET__` resolvidos no keyring — `crates/core/src/quotes/custom_scraper_provider.rs:423-427`, `crates/core/src/custom_provider/service.rs:151-155`.
5. Rate limit do provider custom: 30 req/min, concorrência 2, delay mín. 500 ms — `custom_scraper_provider.rs:465-471`; 1 retry em 5xx/rede (`:112-166`); corpo máx. 10 MB (`model.rs:56`).
6. Shape da fonte: `kind` latest/historical, `format` json/html/html_table/csv, `pricePath`/`datePath`/`dateFormat`/`dateTimezone`/`currencyPath`/`factor`/`invert`/`locale`/`headers`/`method`/`body`/`defaultPrice` — `CustomProviderSource`, `model.rs:306`.
7. Symbol override por provider: `provider_config.overrides["CUSTOM:<code>"].symbol`; schema `z.string()` **sem restrição de charset** — `apps/frontend/src/pages/asset/asset-edit-sheet.tsx:78-81`; runtime: `resolve_symbol`, `custom_scraper_provider.rs:685-697`.
8. Vínculo asset→provider: `CUSTOM_SCRAPER:<code>` / `CUSTOM:<code>` — `crates/core/src/assets/assets_model.rs:746-750`, `crates/core/src/quotes/service.rs:247-253`.
9. Charset do symbol canônico (atividades/import): `[A-Z0-9_]` + **máx. 2 separadores** `.`/`-` — `apps/frontend/src/lib/schemas.ts:181-184`; criação manual pela UI só trim+uppercase — `components/symbol-selector-mobile.tsx:136-142`.
10. JSON `latest`: valor único via JSONPath; número ou **string parseada com locale** (aceita `R$ 1.023,61`) — `custom_provider/service.rs:902` e testes `:1354`, `:1362`; moeda via `currencyPath` com fallback no hint do asset — `custom_scraper_provider.rs:737-758`.
11. JSON `historical`: `pricePath`/`datePath`/ohlcv como **arrays paralelos casados por índice**; máx. 10.000 linhas — `extract_json_rows`, `custom_scraper_provider.rs:1069-1158`. Para `format: json` as duas kinds compartilham o extrator (`:346-363`) — `datePath` funciona também no `latest`.
12. Datas: `%Y-%m-%d` nativo (primeiro de `COMMON_DATE_FORMATS`), `dateFormat` explícito, `dateTimezone` via chrono-tz (`America/Sao_Paulo` ok, conversão ao meio-dia) — `:759-869`; linha sem data → timestamp = agora — `rows_to_quotes`, `:770-789`.
13. Campos não mapeados do JSON são ignorados (só os paths configurados são lidos) → `estimatedDays` na resposta é inofensivo — `extract_json_rows`.
14. Valuation: `market_value = preço × quantity × contract_multiplier` + FX quote_ccy→local/base — `crates/core/src/portfolio/holdings/holdings_valuation_service.rs:311-312,526`; `current_account_valuation.rs:454-457`.
15. Histórico: `{FROM}`/`{TO}` em `%Y-%m-%d` — `custom_scraper_provider.rs:534-560`; fallback latest↔histórico (90 dias, max timestamp) — `:188-252`; reset indisponível p/ custom — `quotes/client.rs:407-413`.
16. Roteamento de instrumento: `Equity`/sem tipo → `EquitySymbol` (**aceito** pelo custom provider); `Bond` → `BondIsin` (**rejeitado**: "Unexpected instrument type") — `crates/core/src/assets/assets_service.rs:788-800`, `custom_scraper_provider.rs:473-484`.
17. Custo/ganho: custo = atividades (`amount = qty × unit_price`) acumulado em lots; ganho = market − cost — `activities_service.rs:6922-6926`, `lots/mod.rs:262-268`, `holdings_valuation_service.rs:541-546`.
18. BRL: `quote_ccy` string livre no asset; default USD apenas sem hint (hint vem do asset) — `assets_model.rs:310`, `custom_scraper_provider.rs:91`.

## `[fixture]` — confirmado por dados reais

1. Série 12 do SGS: endpoint público, sem auth, GET/JSON, **só dias úteis**, `valor` string % a.d. — execuções de 20/09/2026; reproduzível via `scripts/check-cdi.mjs`.
2. Janela `[emissão, D)` (emissão conta, D não): **4/4 leituras < 1e-6** — Banco A 14/09 (n=44, −1,86e-8), Banco A 20/09 (n=49, −2,0e-8), Banco B 14/09 (n=44, −4,58e-7), Banco B 19/09 (n=49, +4,70e-7). Janela alternativa `(emissão, D]` **reprovada** (−9,3e-3).
3. Feriado 07/09/2026 ausente da série; n=44/49 só fecha sem ele.
4. PU de fim de semana = PU do próximo dia útil (cai da janela) — leituras de sáb 19/09 e dom 20/09.
5. Prefixado `1000×(1+i)^(n/252)` confirmado nas duas leituras Banco B.
6. Acumulado 2024: série 12 = 10,8760% vs série 4391 mensal = 10,8881% (Δ 0,012pp = truncagem mensal em 2 casas). Série 4392 não é acumulado-no-ano; descartada.
7. Lag CETIP→SGS: em 20/09/2026 (domingo) a série terminava em 17/09 — o CDI de 18/09 já estava embutido na leitura do app. Base empírica do carry-forward (D2).
8. PUs reais são brutos (prefixado bate sem IR/IOF).

## `[decisão]` — decisões do projeto

| # | Decisão |
|---|---|
| D1 | Cache em arquivo JSON único com rename atômico (sem banco) |
| D2 | Carry-forward da última taxa ≤ K dias úteis (default 3) no fim da série, com `estimatedDays`; nunca no meio da série |
| D3 | Calendário de dias úteis desacoplado da série: fins de semana + `holidays.txt` (passado regenerável por diff da série 12; futuro mantido manualmente) |
| D4 | Aritmética `float64`; tolerância de aceite 1e-6 por PU |
| D5 | Symbol `^(CDI\|PRE)-\d{1,3}\.\d{2}-\d{8}$` no override; canônico limpo no asset |
| D6 | `from < emissão` → clamp; intervalo vazio → 200 com arrays vazios; `from > to` → 400 |
| D7 | Auth opcional por header `X-API-Key`; nada sensível em URL/log |
| D8 | Carried do bootstrap: Go + compose, PU base 1.000 na emissão, valor bruto, fuso `America/Sao_Paulo`, stateless quanto a investimentos, sem API paga |
| D9 | `D = emissão` → PU 1000; `D < emissão` → 400 |
| D10 | Endpoints `/healthz`, `/pu/{SYMBOL}`, `/history/{SYMBOL}?from&to`; contrato JSON conforme item 5 do design |
| D11 | Histórico com uma linha por dia útil D (ritmo da série, não dia corrido) |
| D12 | Backfill sob demanda para datas anteriores ao cache; 503 se a fonte falhar e não houver dado |

## `[hipótese]` — remanescentes (nenhuma bloqueia a implementação)

| # | Hipótese | Mitigação / quando fecha |
|---|---|---|
| H1 | CDI de 18/09/2026 = 0,050788 (retro-inferido da fixture Banco A) | Re-executar `scripts/check-cdi.mjs` quando a série 12 publicar; harness já usa o valor real quando existe |
| H2 | Liquidação D+1 institucional (preço pago = PU de 14/09) | Não afeta a API; mecanismo no Wealthfolio já é `[código]` |
| H3 | Rate limit real do SGS não testado | Refresh ≥ 30 min + cache tornam o risco irrelevante; `/healthz` expõe falhas |
| H4 | Feriados futuros do `holidays.txt` incompletos | Lista nacional+ANBIMA divulgada com antecedência; manutenção anual documentada; regressão por diff |
| H5 | Comportamento do Wealthfolio em runtime com BRL (exibição, FX, sync) | Fase 5 — roteiro manual ponta a ponta |

---

## GATE — PARE AQUI

**Fase 4 (implementação Go) só começa após aprovação explícita desta validação.** Com o ok: API, cálculo, cache, testes (fixtures como regressão), `compose.yaml` e o roteiro de configuração do Wealthfolio.
