# 04 — Implementação (Fase 4)

Status: **implementada**. Última atualização: 20/09/2026.

API Go em `api/` — binário único, apenas stdlib (zero dependências externas), seguindo o design de `docs/02-design.md`. O critério de aceitação do bootstrap está cumprido: **as quatro leituras reais são reproduzidas pela própria API** (regressão em `api/fixtures_test.go` e verificação ao vivo abaixo).

## Como rodar

Local (requer Go ≥ 1.27):

```bash
cd api && go run .
# ou
cd api && go build -o cdbapi . && ./cdbapi
```

Com compose (builda a imagem e sobe com volume de cache e healthcheck):

```bash
docker compose up -d
```

Configuração por env:

| Variável | Default | Descrição |
|---|---|---|
| `LISTEN_ADDR` | `:8080` | endereço de escuta |
| `API_KEY` | (vazio) | se definida, exige header `X-API-Key` em `/pu` e `/history` (`/healthz` fica aberto) |
| `CACHE_PATH` | `cache/cdi.json` | arquivo de cache do CDI (rename atômico) |
| `SGS_BASE_URL` | série 12 oficial | fonte do CDI |
| `REFRESH_MIN_INTERVAL` | `30m` | intervalo mínimo entre refreshes |
| `CARRY_FORWARD_MAX` | `3` | K do carry-forward (design D2) |
| `HOLIDAYS_PATH` | (vazio) | arquivo com feriados extras (YYYY-MM-DD por linha) |

## Endpoints

```
GET /healthz
GET /                            → assistente de cadastro (calculadora de symbol/emissão/PU/quantidade)
GET /pu/{SYMBOL}                  → {"symbol","date","price","currency","estimatedDays"}
GET /history/{SYMBOL}?from=&to=   → {"symbol","currency","from","to","dates":[],"prices":[],"estimatedDays"}
GET /solve/emission?kind=&rate=&pu=&settlement= → descobre a data de emissão a partir do PU pago
```

Notas de comportamento da fonte: a API do SGS rejeita janelas acima de 10 anos em séries diárias (HTTP 406, observado em 06/10/2026) — o cliente fatia em blocos de 9 anos — e a latência é errática (0,3 s a 18 s para a mesma janela). Por isso o backfill roda desacoplado do request (context próprio, timeout generoso): se o provider do Wealthfolio (15 s) desistir de uma chamada com cache frio, o backfill continua e o sync seguinte encontra o cache quente. O progresso parcial por bloco é persistido mesmo em caso de falha.

Saída real de 20/09/2026 (fonte pública ainda sem o CDI de 18/09 — carry-forward atuando):

```
$ curl localhost:8080/pu/CDI-104.50-20260713
{"currency":"BRL","date":"2026-09-20","estimatedDays":1,"price":1026.9475887800488,...}

$ curl localhost:8080/pu/PRE-14.30-20260713
{"currency":"BRL","date":"2026-09-20","estimatedDays":0,"price":1026.3293934700453,...}
```

Alvos: 1026,9475888 (leitura Banco A 20/09) e 1026,329393 (Banco B 19/09) — reproduzidos ✓.

## Verificação

```bash
cd api && go test ./...    # 17 testes: 4 fixtures, parser, calendário, API (auth, clamps, 503, carry)
./cdbapi holidays-check    # diff do calendário computado vs série 12 real (últimos 3 anos)
```

O `holidays-check` é a ferramenta de manutenção do calendário (design D3): imprime `missing obs`/`extra obs` para qualquer divergência entre os feriados computados e o que a série publicou. Foi com ele (na fase de investigação, versão Node) que se descobriu que o carnaval do CDI é seg+ter, com quarta de cinzas útil.

## Configuração do Wealthfolio

1. Settings → Market Data → criar custom provider (código `cdb`) com duas fontes `[código 01, item 1`]:

   | Campo | latest | historical |
   |---|---|---|
   | kind | `latest` | `historical` |
   | format | `json` | `json` |
   | url | `http://<host>:8080/pu/{SYMBOL}` | `http://<host>:8080/history/{SYMBOL}?from={FROM}&to={TO}` |
   | pricePath | `$.price` | `$.prices[*]` |
   | datePath | `$.date` | `$.dates[*]` |
   | dateFormat / dateTimezone | — | `%Y-%m-%d` / `America/Sao_Paulo` |
   | headers | `{"X-API-Key":"__SECRET__cdb_api_key"}` (se auth ligada) | idem |

2. Por CDB (resumo; roteiro detalhado com telas na Fase 5): asset com symbol canônico limpo, `instrumentType` **Equity**, `quoteCcy` BRL, exchange MANUAL, `quoteMode` MARKET, provider `CUSTOM:cdb`, e **override de symbol** com o symbol parametrizado.

## Exemplos de securities (os dois títulos reais)

| Campo | Banco A | Banco B |
|---|---|---|
| Symbol canônico | `CDB-BANCOA-1045` | `CDB-BANCOB-1430` |
| Override (`CUSTOM:cdb`) | `CDI-104.50-20260713` | `PRE-14.30-20260713` |
| quantity | valor aplicado ÷ 1024,19875526 | valor aplicado ÷ 1023,61 |
| Compra | data 11/09, unitPrice = PU de 14/09 | idem |

## Mapa do código

| Arquivo | Papel |
|---|---|
| `api/symbol.go` | parser/validador do symbol (D5) |
| `api/calendar.go` | calendário de dias úteis: feriados nacionais computados (Páscoa + fixos + 20/11 desde 2024) + extras opcionais (D3) |
| `api/sgs.go` | cliente da série 12 (fetch incremental, 1 retry) |
| `api/cache.go` | cache JSON atômico (D1) |
| `api/engine.go` | PU, carry-forward (D2), janela `[emissão, D)` |
| `api/server.go` | HTTP, `X-API-Key`, clamps do histórico (D6), `/solve/emission` |
| `api/wizard.go` + `static/index.html` | assistente de cadastro em `/` (embutido no binário) |
| `api/main.go` | env, wiring, graceful shutdown, subcommand `holidays-check` |

## Pendências herdadas

- H1 (CDI 18/09 = 0,050788 retro-inferido): fechará sozinha quando a série publicar — o harness Node e os testes Go usam o valor real quando existir; o `holidays-check` também serve de conferência.
- Formato final do `compose.yaml` do ambiente: ajustar à convenção local se necessário.
