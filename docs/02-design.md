# 02 — Design (Fase 2)

Status: **proposta para validação**. Última atualização: 20/09/2026.

Insumos: `docs/01-investigacao.md` (evidências `[código]`/`[fixture]`), `docs/bootstrap.md`. Princípios: stateless em relação aos investimentos, adaptador mínimo, sem microserviços, sem API paga.

## Visão geral

```
Wealthfolio (fonte de verdade: qty, custo, datas, carteira)
   │  Custom Market Data Provider "cdb"
   │  latest:     GET http://<host>:<port>/pu/{SYMBOL}
   │  historical: GET http://<host>:<port>/history/{SYMBOL}?from={FROM}&to={TO}
   ▼
API Go (este projeto) ─── cache local (arquivo JSON, PU nada)
   │  GET série 12 do SGS (incremental, com atraso mínimo)
   ▼
PU em JSON ──► Wealthfolio: position = quantity × price (+FX p/ exibição)
```

Responsabilidades: obter o CDI, calcular o PU, devolver market data. Nada além.

## 1. Integração com a fonte do CDI

- Fonte: série 12 do SGS (`[fixture]` 01, item 7): pública, GET, JSON, só dias úteis, `valor` em % a.d. como string.
- Fetch incremental: `?dataInicial=<último dia em cache + 1>&dataFinal=<hoje>`; nunca a série inteira por requisição.
- Gatilho de refresh: sob demanda, no mínimo a cada `REFRESH_MIN_INTERVAL` (default 30 min; a série é diária) e no boot.
- Falhas da fonte: timeout curto (5 s), 1 retry; em caso de falha, responde com o cache e expõe a defasagem em `/healthz`. A API continua de pé com a fonte fora `[decisão]`.
- Lag CETIP→SGS (`[fixture]` 01, item 4 — série sem 18/09 num domingo): para dias úteis ausentes no **final** da série, aplica *carry-forward* da última taxa por no máximo `K` dias úteis (default 3), contando os dias estimados em `estimatedDays` da resposta e em `/healthz`. O CDI fica constante por semanas (Selic definida em reuniões), então o carry é quase sempre exato; acima de K, o PU simplesmente para no último dia confirmado. Nunca fabricar taxa fora do final da série (sem backfill no meio) `[decisão]`.

## 2. Cache

- Armazenamento: **arquivo JSON único** (`CACHE_PATH`, default `./cache/cdi.json`), escrito com rename atômico (tmp+rename); carregado no boot; em memória, um map `data → taxa` `[decisão]` — rejeitada SQLite: volume é ~250 linhas/ano, não justifica dependência.
- Formato: `{"updatedAt": "...", "rates": {"2026-09-17": 0.050788, ...}}` (taxas como % a.d., ponto decimal).
- Backfill histórico: se uma requisição precisar de datas anteriores ao início do cache, busca o trecho faltante do SGS na hora; se a fonte falhar e não houver dado, `503` com mensagem clara.
- O cache não guarda nada de investimentos — apenas CDI `[decisão]`.

## 3. Cálculo financeiro

Validado pelas quatro fixtures `[fixture]` (01, item 1):

- Pós-fixado (`CDI-`): `PU(D) = 1000 × Π (1 + pct × fator_k)` para cada dia útil `k` da janela, `fator_k = taxa_k/100` da série 12 (taxa efetiva do dia, 8 casas).
- Prefixado (`PRE-`): `PU(D) = 1000 × (1 + taxa)^(n/252)`, `n` = dias úteis na janela.
- **Janela `[emissão, D)`**: emissão conta, D não `[fixture]`. Fim de semana/feriado como D termina naturalmente na sexta anterior → PU de sáb/dom = PU do próximo dia útil `[fixture]`.
- Calendário de dias úteis: **desacoplado da série 12** `[decisão]` — motivo: o prefixado conta dias sem precisar de taxa, e a série pode estar atrasada (caso 18/09). Implementação: fins de semana + arquivo de feriados `holidays.txt` (uma data YYYY-MM-DD por linha), com a parte **passada** regenerável por diff da própria série 12 contra os dias de semana (fiel ao calendário CDI real) e a parte **futura** mantida manualmente (feriados nacionais + ANBIMA, divulgados com meses de antecedência).
- Datas: `D = emissão` → PU = 1000,00 (janela vazia) `[decisão]`; `D < emissão` → `400`; datas são ingênuas (sem hora), "hoje" no fuso `America/Sao_Paulo` (embutir `time/tzdata` no binário) `[decisão]` carried.
- Precisão: `float64` ao longo de tudo (mesma aritmética da referência TS que reproduziu as fixtures em 1e-8); tolerância de aceite 1e-6 por PU `[decisão]`.
- Bruto, sem IR/IOF `[fixture]` carried.

## 4. Parser/validação do symbol

Formato (idêntico ao candidato do bootstrap, agora com charset verificado):

```
CDI-104.50-20260713   → 104,50% do CDI, emissão 13/07/2026
PRE-14.30-20260713    → 14,30% a.a., emissão 13/07/2026
```

- Regex: `^(CDI|PRE)-\d{1,3}\.\d{2}-\d{8}$` — exatamente 2 decimais na taxa (inequívoco), data válida (calendário real), emissão não no futuro, prefixo desconhecido → `400` `[decisão]`.
- O symbol parametrizado inteiro vive **no override do provider** (`provider_config.overrides["CUSTOM:cdb"].symbol`, charset livre `[código]` 01, item 3); o symbol canônico do asset fica limpo (ex. `CDB-BANCOB-1430`), respeitando a regex de atividades (máx. 2 separadores `[código]` 01, item 4).

## 5. API HTTP

Go stdlib (`net/http`), binário único, sem framework `[decisão]`.

| Endpoint | Resposta |
|---|---|
| `GET /healthz` | `{"status":"ok","cdi":{"lastDate":"2026-09-17","lastRate":0.050788,"estimatedDays":1},"cacheUpdatedAt":"..."}` |
| `GET /pu/{SYMBOL}` | `{"symbol":"CDI-104.50-20260713","date":"2026-09-20","price":1026.94758878,"currency":"BRL","estimatedDays":0}` |
| `GET /history/{SYMBOL}?from=2026-09-01&to=2026-09-20` | `{"symbol":"...","currency":"BRL","from":"...","to":"...","dates":["2026-09-01",...],"prices":[1024.19,...],"estimatedDays":0}` |

- Mapeamento no Wealthfolio (`[código]` 01, itens 5 e 7): `latest` com `pricePath=$.price`, `currencyPath=$.currency`, `datePath=$.date`; `historical` com `pricePath=$.prices[*]`, `datePath=$.dates[*]`, `dateFormat=%Y-%m-%d`, `dateTimezone=America/Sao_Paulo`. Para `format: json` as duas kind percorrem o mesmo extrator (`extract_json_rows` → `rows_to_quotes`, `custom_scraper_provider.rs:346-363`), então o `datePath` funciona também na fonte latest (array de 1 elemento casado por índice) — o quote ganha timestamp real em vez de "agora" `[código]`.
- Histórico: uma linha por **dia útil D** (não por dia de CDI), de `max(from, emissão)` até `min(to, último dia avaliável)`; `from`/`to` opcionais (default emissão/hoje); `from < emissão` → clamp; `from > to` já no request original → `400`; janela vazia após o clamp (incluindo `to < emissão`) → `200` com arrays vazios `[decisão]`.
- Autenticação: `X-API-Key` fixa se `API_KEY` configurada (desligada = modo local); o provider custom do Wealthfolio envia headers arbitrários `[código]`, valor guardável com prefixo `__SECRET__` no keyring. Nada sensível em URL ou log `[decisão]` carried.
- Erros: `400` symbol/date inválidos; `503` CDI insuficiente (janela anterior ao cache com fonte fora); JSON de erro `{"error":"..."}`.
- Config por env: `LISTEN_ADDR` (default `:8080`), `API_KEY` (opcional), `CACHE_PATH`, `SGS_BASE_URL` (default oficial), `REFRESH_MIN_INTERVAL`, `CARRY_FORWARD_MAX` (K), `HOLIDAYS_PATH`.
- `compose.yaml`: serviço único, volume para `CACHE_PATH`, healthcheck em `/healthz`, `time/tzdata` embutido (sem dependência de tz do host). Ajustar ao formato dos outros serviços do ambiente na Fase 4 `[decisão]`.

## 6. Configuração do Wealthfolio

1. Settings → Market Data → criar custom provider código `cdb` com duas fontes (`[código]` 01, item 1):

   | Campo | latest | historical |
   |---|---|---|
   | kind | `latest` | `historical` |
   | format | `json` | `json` |
   | url | `http://<host>:<port>/pu/{SYMBOL}` | `http://<host>:<port>/history/{SYMBOL}?from={FROM}&to={TO}` |
   | pricePath | `$.price` | `$.prices[*]` |
   | datePath | — | `$.dates[*]` |
   | dateFormat / dateTimezone | — | `%Y-%m-%d` / `America/Sao_Paulo` |
   | headers | `{"X-API-Key":"__SECRET__cdb_api_key"}` (se auth ligada) | idem |

2. Por CDB: asset com symbol canônico limpo, `instrumentType` **Equity** (Bond roteia para BondIsin e o custom provider rejeita `[código]` 01, item 9), `quoteCcy` BRL, exchange MANUAL, `quoteMode` MARKET, provider preferido `CUSTOM:cdb`, override de symbol = `CDI-104.50-20260713`. Roteiro passo a passo com telas fica para a Fase 5 `[decisão]`.

## 7. Compra com liquidação D+1

Registrar a atividade de compra na data da ordem (11/09) com `unitPrice` = **PU do dia de liquidação** (14/09 — o preço efetivamente pago, confirmado pelas fixtures). O custo e o ganho saem corretos: custo = qty × unitPrice nos lots; ganho = valor de mercado − custo (`[código]` 01, item 10). A API não trata nada disso — é transparente para ela.

## 8. Testes

- **Matemática** (unit): as quatro fixtures como regressão (rates embutidas no teste, incluindo o 18/09 retro-inferido até a série publicar); 100%/110% do CDI; emissões em datas diferentes; janelas só de fim de semana; D = emissão; prefixado curto/longo.
- **Parser**: símbolos válidos/inválidos (prefixo, decimais, data impossível, emissão futura, case).
- **Calendário**: 07/09/2026 feriado; carry-forward com K; fim de série defasado.
- **API** (httptest): a matriz do bootstrap — parâmetros válidos/inválidos, symbol malformado, CDI indisponível com e sem cache, `from>to`, erro da fonte externa, `X-API-Key` correta/incorreta.
- Fase 5: roteiro manual ponta a ponta no Wealthfolio.

## 9. Registro de decisões

| # | Decisão | Alternativa rejeitada |
|---|---|---|
| D1 | Cache em arquivo JSON atômico | SQLite (volume minúsculo, dependência a menos) |
| D2 | Carry-forward ≤ K dias no fim da série, com `estimatedDays` | Recusar cálculo (quebraria o PU de fim de semana exibido pelos apps) |
| D3 | Calendário desacoplado (fins de semana + `holidays.txt`, passado regenerável da série 12) | Derivar n da própria série (frágil ao lag) |
| D4 | `float64` ponta a ponta, tolerância 1e-6 | decimal/bignum (fixtures fecham em 1e-8 em float64) |
| D5 | Taxa com exatamente 2 decimais no symbol | Formato livre (ambíguo) |
| D6 | `from < emissão` → clamp; janela vazia após o clamp (inclusive `to < emissão`) → 200 com arrays vazios; `from > to` já no request → 400 | 400 em pergunta legítima (hostil ao sync do Wealthfolio) |
| D7 | Auth opcional por `X-API-Key` | Sem auth sempre (feio se exposto) / OAuth (desnecessário) |

## Pendências para a Fase 3

- Formato exato do `compose.yaml` do ambiente (adaptar na Fase 4; não bloqueia design).
