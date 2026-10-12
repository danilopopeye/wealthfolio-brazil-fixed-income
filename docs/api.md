# brazil-fixed-income

API de market data para renda fixa brasileira: devolve o **PU** (preço unitário, base R$ 1.000,00 na emissão) de CDB, LCI, LCA e LCDA — pós-fixados (% do CDI) e prefixados (% a.a.), valores brutos. Fonte: [série 12 (Taxa de juros — CDI) do SGS/BCB](https://api.bcb.gov.br/dados/serie/bcdata.sgs.12/dados?formato=json&dataInicial=01/01/2024&dataFinal=31/12/2024), com cache local.

## Configuração no Wealthfolio (uma única vez)

Em **Settings → Market Data**, crie um custom provider com código `brazil-fixed-income` e as duas fontes abaixo (troque `HOST` pelo endereço desta API):

| Campo | Fonte latest | Fonte historical |
|---|---|---|
| kind | `latest` | `historical` |
| format | `json` | `json` |
| url | `http://HOST:8080/pu/{SYMBOL}` | `http://HOST:8080/history/{SYMBOL}?from={FROM}&to={TO}` |
| pricePath | `$.price` | `$.prices[*]` |
| datePath | `$.date` | `$.dates[*]` |
| dateFormat | — | `%Y-%m-%d` |
| dateTimezone | — | `America/Sao_Paulo` |

> Se a API estiver com `API_KEY` configurada, adicione o header `{"X-API-Key": "__SECRET__..."}` em ambas as fontes (o prefixo `__SECRET__` guarda o valor no keyring).

## Gramática do symbol

`^(CDI|PRE)-\d{1,3}(\.\d{2})?-\d{8}$` — indexador, taxa contratada e data de emissão:

| Symbol | Significado |
|---|---|
| `CDI-104.50-20260713` | 104,50% do CDI, emissão 13/07/2026 |
| `CDI-100-20251226` | 100% do CDI (taxa inteira vale) |
| `PRE-14.30-20260713` | 14,30% a.a. prefixado |

## Endpoints

| Endpoint | Descrição |
|---|---|
| `GET /pu/{SYMBOL}` | PU de hoje (janela [emissão, hoje); fim de semana = próximo dia útil) |
| `GET /history/{SYMBOL}?from=&to=` | série do PU, uma linha por dia útil |
| `GET /solve/emission?kind=&rate=&pu=&settlement=` | descobre a data de emissão a partir do PU pago |
| `GET /healthz` | estado do cache e da fonte |

## Notas

- Valores brutos, sem IR/IOF; PU de emissão = 1.000,00.
- `estimatedDays` > 0: dias de CDI do final da série ainda não publicados pelo BCB (taxa carregada da última confirmada, limite configurável).
- Datas em `YYYY-MM-DD`; fuso de referência `America/Sao_Paulo`.
