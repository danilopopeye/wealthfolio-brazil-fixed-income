# 01 — Investigação (Fase 1)

Status: **matemática fechada; investigação Wealthfolio concluída no código**. Última atualização: 20/09/2026.

Gate da fase: todos os itens abaixo com evidência `[doc]`, `[código]`, `[fixture]` ou `[decisão]` — nada pode seguir para a Fase 2 marcado `[hipótese]`.

Contexto adicional: este repositório contém um experimento em TypeScript na forma de addon do Wealthfolio (`src/`), anterior à redação do `bootstrap.md`. Ele **não é o caminho de produção** (API Go + Custom Market Data Provider) e foi congelado como referência executável da matemática financeira, com a convenção corrigida para a janela `[emissão, D)` validada abaixo.

## Matemática financeira e dados

### 1. Acumulação do CDI no pós-fixado e aplicação do percentual — `[fixture]`

`PU(D) = PU₀ × Π (1 + pct × fator_diário_k)` para cada dia útil `k` da janela, com o `fator_diário` obtido **direto** da série 12 do SGS (já é a taxa efetiva do dia em pontos percentuais, com 8 casas). A forma `(1 + CDI_aa)^(1/252) − 1` do `bootstrap.md` é equivalente: a série 12 publica exatamente esse fator diário.

Validação contra as quatro leituras reais (executável: `node scripts/check-cdi.mjs`, saída de 20/09/2026):

| Fixture | Janela | n | PU calculado | PU real | diff |
|---|---|---|---|---|---|
| Banco A 14/09/2026 | `[13/07, 14/09)` | 44 | 1024,19875524 | 1024,19875526 | −1,86e-8 |
| Banco A 20/09/2026 (domingo) | `[13/07, 20/09)` | 49 | 1026,94758878 | 1026,9475888 | −2,00e-8 |
| Banco B 14/09/2026 | `[13/07, 14/09)` | 44 | 1023,61126354 | 1023,611264 | −4,58e-7 |
| Banco B 19/09/2026 (sábado) | `[13/07, 19/09)` | 49 | 1026,32939347 | 1026,329393 | 4,70e-7 |

Observações: os diffs do Banco A (~2e-8) são da ordem do último dígito exibido (8 casas); os da Banco B (~5e-7), do meio-ULP de 6 casas — consistente com arredondamento de exibição, sem truncamento adicional detectável.

### 2. Convenção de dias úteis — `[fixture]` (parcial)

- **Janela de acumulação `[emissão, D)`: o dia da emissão conta, o dia D não.** Confirmada pelas quatro leituras. A janela alternativa `(emissão, D]` (usada erroneamente na primeira versão do experimento TS) reproduz a Banco A 14/09 com erro −9,3e-3 — reprovada.
- **PU de sábado/domingo = PU do próximo dia útil**: cai naturalmente da janela `[emissão, D)` (a janela termina na sexta anterior) e é consistente com as duas leituras de fim de semana. `[fixture]`
- **Feriados**: ausentes da série (07/09/2026 não aparece; a contagem n=44/49 só fecha sem ele). Fonte do calendário para a API Go: ainda aberta — ver nota abaixo sobre derivar o calendário da própria série.
- Nota de design (candidata a `[decisão]` na Fase 2): o número de dias úteis pode ser derivado das datas da própria série 12, sem calendário ANBIMA embutido. Risco: buracos temporários da série (ver item 4) afetariam a contagem do prefixado — mitigação via cache local e verificação de continuidade.

### 3. Taxa diária, capitalização e arredondamento — `[fixture]`

- Série 12 publica a taxa diária efetiva com 8 casas decimais; o produto direto, sem truncamento intermediário, reproduz as quatro leituras dentro da tolerância 1e-6. Nenhuma convenção adicional de arredondamento foi necessária até esta tolerância.
- Pós-fixado: produto diário. Prefixado: exponencial `n/252` (item 5).

### 4. Primeiro/último dia e CDI de hoje ainda não publicado — `[fixture]` (comportamento) + `[decisão]` pendente

- Primeiro dia: a emissão conta (fixtures). Último dia: D não conta; em fim de semana, PU = próximo dia útil.
- O CDI do dia só existe no fim do dia, e a série 12 do BCB pode ficar atrás da CETIP: **em 20/09/2026 (domingo) a série 12 terminava em 17/09** — o CDI de sexta 18/09 (0,050788, retro-inferido da leitura Banco A de 20/09 com erro 2e-8) ainda não tinha sido ingerido. Implicações para a API: (a) resposta para "hoje" deve usar o último fator disponível; (b) o cache local precisa tolerar lag da fonte pública. Re-executar `scripts/check-cdi.mjs` quando a série publicar 18/09 para promover o valor retro-inferido a `[fixture]`.
- Datas anteriores à emissão: ainda sem resposta `[hipótese]` — proposta para a Fase 2: PU(D) = PU₀ para D = emissão (janela vazia) e erro 4xx para D < emissão.

### 5. Cálculo do prefixado — `[fixture]`

`PU(D) = 1000 × (1 + taxa)^(n/252)` com `n` = dias úteis em `[emissão, D)`. Reproduz as duas leituras Banco B com erro < 5e-7 (tabela do item 1). Reconfirmado executando o harness em 20/09/2026.

### 6. Bruto vs. líquido — `[fixture]` (carried)

Os PUs reais são brutos (o prefixado bate sem desconto de IR/IOF). Mantido bruto, salvo demonstração de necessidade no lado Wealthfolio.

### 7. Fonte da série do CDI — `[fixture]` (existência/formato) + abertos

- **Série 12 do SGS ("Taxa de juros - CDI", diária)**: `https://api.bcb.gov.br/dados/serie/bcdata.sgs.12/dados?formato=json&dataInicial=DD/MM/YYYY&dataFinal=DD/MM/YYYY`. Pública, sem autenticação, GET, JSON. Retorna **apenas dias úteis** com valor publicado; `valor` é string com ponto decimal em % a.d. Exemplos reais: 14–16/09/2026 = `0.051660`; 17/09/2026 = `0.050788`.
- Sanidade de acumulação: produto direto da série em 2024 = **10,8760%** (253 dias úteis). Série 4391 (CDI acumulado no mês) bate por cima: set/2026 = 0,62% vs 0,6156% calculado pela série 12 (truncamento). Cross-check contra número oficial do acumulado 2024: pendente `[hipótese]`.
- Variante útil: `.../dados/ultimos/N?formato=json`.
- Limites de requisição/rate limit: não testado `[hipótese]`.
- Estratégia de cache incremental e comportamento com a fonte fora do ar: Fase 2 (o lag CETIP→SGS do item 4 é insumo direto).
- Fuso `America/Sao_Paulo` `[decisão]` (carried do bootstrap). Os cálculos validados acima usaram datas locais BR; a API Go deve fixar o fuso explicitamente.

## Wealthfolio (itens 1–10 do bootstrap) — investigado no código v3.9.0

Código da versão instalada: clone em `wealthfolio/` (upstream v3.9.0, `wealthfolio/package.json`). Todos os itens abaixo são `[código]` com `arquivo:linha` no clone.

### 1. Criar e configurar um Custom Market Data Provider

Settings → Market Data → formulário de custom provider (`apps/frontend/src/pages/settings/market-data/custom-provider-form.tsx`, `source-config-panel.tsx`; exemplos prontos em `provider-templates.ts`). Cada provider tem fontes (`sources`) com: `kind` = `latest`|`historical`, `format` = `json`|`html`|`html_table`|`csv`, `url` (template), `pricePath`, `datePath`/`dateFormat`/`dateTimezone`, `currencyPath`, `factor`, `invert`, `locale`, `headers` (JSON), `method`, `body`, `open/high/low/volumePath`, `defaultPrice` — `CustomProviderSource` em `crates/core/src/custom_provider/model.rs:306`. Persistência em `market_data_custom_providers` (`crates/storage-sqlite/src/db/portable.rs:754`). Há botão de teste (chama `test_source`, `crates/core/src/custom_provider/service.rs:127`).

### 2. Placeholders e HTTP

- Suportados (`crates/core/src/custom_provider/model.rs:106-133`): `{SYMBOL}`, `{currency}`, `{CURRENCY}`, `{TODAY}`, `{FROM}`, `{TO}`, `{ISIN}`, `{MIC}`, `{DATE:formato}`, `{FROM:formato}`, `{TO:formato}`, `{TODAY:formato}`. `{FROM}`/`{TO}` default = hoje quando ausentes; date-only aceitam `%Y %m %d`; `{ISIN}` cai para o symbol; `{MIC}` cai para vazio.
- **Métodos GET e POST** (`model.rs:13-26`, `VALID_HTTP_METHODS`) — **corrige o `[doc]` "somente GET"** do bootstrap. POST com body templated e `Content-Type: application/json` automático.
- URLs http/https quaisquer, inclusive rede privada (`validate_url`, `model.rs:190-212`); browser-like User-Agent; resposta máx. 10 MB.
- Rate limit do provider custom: 30 req/min, concorrência 2, delay mín. 500 ms (`crates/core/src/quotes/custom_scraper_provider.rs:465-471`); 1 retry em 5xx/erro de rede (`:112-166`).

### 3. Symbol override por security e parâmetros extras

- A aba Market Data do asset grava `provider_config` com `preferred_provider: "CUSTOM_SCRAPER"` + `custom_provider_code` (`crates/core/src/assets/assets_model.rs:746-750`; UI seleciona `CUSTOM:<id>`, `asset-edit-sheet.tsx:507`).
- Override de symbol por provider: `provider_config.overrides["CUSTOM:<code>"].symbol`, resolvido em runtime por `resolve_symbol` (`custom_scraper_provider.rs:685-697`). O schema do override é `z.object({ provider: z.string(), symbol: z.string() })` — **sem restrição de charset** (`asset-edit-sheet.tsx:78-81`).
- Parâmetros além dos placeholders **não existem** — a rota é codificá-los no symbol do override, como planejado no bootstrap. Com `custom_provider_code` setado a fonte nem precisa de `{SYMBOL}` na URL (`find_sources`, `:635-658`), mas o normal é usar `{SYMBOL}` para diferenciar assets.

### 4. Caracteres permitidos e validação do symbol

Dois níveis:

- **Symbol canônico** (atividades/import): `/^(?=.{1,100}$)(CASH:[A-Z]{3}|[A-Z0-9_]+([.-][A-Z0-9_]+){0,2})$/` (`apps/frontend/src/lib/schemas.ts:181-184`) — maiúsculas/números/`_`, **máx. 2 separadores** `.`/`-`. `CDI-104.50-20260713` **reprova** (3 separadores); `CDI-10450-20260713` passa. Criação manual pela UI só faz trim+uppercase, sem regex (`components/symbol-selector-mobile.tsx:136-142`).
- **Symbol do override**: livre (`z.string()`, item 3).

Consequência para o design (Fase 2): symbol canônico limpo (ex. `CDB-BANCOB-1430`) + override carregando o symbol parametrizado completo (`CDI-104.50-20260713`).

### 5. Formato JSON esperado e interpretação do price

- `latest`: um valor via JSONPath em `pricePath` — número JSON ou **string parseada com locale** (`parse_number_string` aceita `R$ 1.023,61` com locale pt → convenção europeia; `custom_provider/service.rs:902`, testes `:1354`, `:1362`). Moeda opcional via `currencyPath` (fallback: `quote_ccy` do asset). Transformações `factor` e `invert` (`custom_scraper_provider.rs:727-735`).
- `historical`: `pricePath` → array de preços; `datePath` → array de datas **casado por índice**; idem open/high/low/volume (`extract_json_rows`, `:1069-1158`); máx. 10.000 linhas. Datas `%Y-%m-%d` nativas ou `dateFormat` explícito; `dateTimezone` aceita `America/Sao_Paulo` (conversão ao meio-dia local, `:759-789`). Linha sem data → timestamp = agora.
- Um contrato JSON mínimo viável: `{ "dates": [...], "prices": [...] }` com `pricePath=$.prices[*]`, `datePath=$.dates[*]`.

### 6. Como quantity e price viram valor da posição

`market_value = preço × quantity × contract_multiplier` com FX `quote_ccy` → moeda local/base (`crates/core/src/portfolio/holdings/holdings_valuation_service.rs:311-312,526`; `current_account_valuation.rs:454-457`). Para `AssetKind::Investment`, `quantity` vem dos lots de atividades. Preço sem minor-unit normalization automática por moeda (`normalize_amount`).

### 7. Histórico (FROM/TO)

Provider custom declara `supports_historical` (`custom_scraper_provider.rs:446-463`); `get_historical_quotes(start, end)` chama a fonte `historical` com `{FROM}`/`{TO}` em `%Y-%m-%d` (`:534-560`). Fallbacks: fonte `latest` devolve 1 ponto; e "latest" sem fonte própria busca histórico dos últimos 90 dias e pega o timestamp máximo (`:188-252`). Reset de histórico indisponível para custom providers (`quotes/client.rs:407-413`).

### 8. Limitações para BRL

Nenhuma restrição encontrada `[código]`: `quote_ccy` é string livre no asset (`BRL` ok, `assets_model.rs:310`); FX para moeda de exibição via `get_fx_rate_or_fallback` (`holdings_valuation_service.rs:314`); default `USD` só quando não há hint (o hint vem do asset). Valores como strings `R$ 1.023,61` são parseáveis com locale (item 5). Validação em runtime com BRL fica para a Fase 5.

### 9. Securities manuais/customizadas

- `QuoteMode::Market|Manual` (`assets_model.rs:60-64`): Manual = preços digitados; para CDB usamos **Market** + custom provider.
- Criação manual: trim+uppercase, exchange `MANUAL`, tipos EQUITY/CRYPTO/OTHER na UI (`symbol-selector-mobile.tsx:74-146`).
- **`InstrumentType::Bond` roteia para `ProviderInstrument::BondIsin`, que o custom provider rejeita** ("Unexpected instrument type", `custom_scraper_provider.rs:473-484`; mapeamento em `assets_service.rs:788-800`). Equity ou sem tipo → `EquitySymbol`, aceito. O asset Bond tem campos de maturity/coupon (`asset-bond-spec.ts`), mas é incompatível com o custom provider — **CDB deve ser `Equity` (ou sem tipo) com `quote_ccy` BRL**.

### 10. Compra com preço diferente do PU do dia (D+1)

Custo vem das atividades: `amount = quantity × unit_price` (`activities_service.rs:6922-6926`), acumulado em lots com custo por unidade na quote_ccy (`lots/mod.rs:262-268`); ganho não realizado = market_value − cost_basis (`holdings_valuation_service.rs:541-546` para alternativos; lot-tracked análogo). Registrar a compra de 11/09 com o preço efetivamente pago (= PU de 14/09) produz custo e ganho corretos com o PU corrente — o mecanismo no Wealthfolio é `[código]`; a liquidação D+1 em si permanece `[hipótese]` (institucional).

## Outros itens carried

- Tolerância 1e-6 por PU: mantida `[decisão]`; as quatro leituras fecham com folga de uma a duas ordens de magnitude.
- Cross-check do acumulado 2024 (fechado em 20/09/2026): produto da série 12 = **10,8760%**; produto da série 4391 (acumulado mensal oficial, 12 meses truncados em 2 casas) = **10,8881%** — diferença de 0,012pp, consistente com o ruído das truncagens. A série 4392 não é acumulado-no-ano (nem YTD nem 12m rolante) e foi descartada para este fim.

## Status do código TS (experimento congelado) — `[decisão]`

- `src/lib/cdb.ts`: convenção corrigida para `[emissão, D)`; inclui `calculateCdb` (pós-fixado) e `calculatePreFixedCdb` (prefixado). Referência executável para a portabilidade para Go.
- `src/lib/sgs.ts`: cliente da série 12 (formato, parsing, sem auth) — insumo do item 7 acima.
- `scripts/check-cdi.mjs`: harness de regressão das quatro fixtures + sanidade 2024 + exemplo. Saida de 20/09/2026: 4/4 PASS.
- `manifest.json` com permissão de rede e `src/hooks/`: restos do experimento de addon, sem papel no caminho de produção.

## Próximos passos

1. Re-executar `scripts/check-cdi.mjs` após a série 12 publicar 18/09/2026 → promover o CDI retro-inferido a `[fixture]` e remover o backfill do harness.
2. Itens residuais de evidência: nenhuma hipótese bloqueante resta na matemática; no lado Wealthfolio, a validação em runtime com BRL (item 8) e o fluxo completo de cadastro ficam para a Fase 5 (roteiro manual).
3. Seguir para `docs/02-design.md` (Fase 2) — insumos principais: contrato JSON mínimo (`{"dates":[...],"prices":[...]}`), symbol canônico limpo + override parametrizado, asset `Equity` + `quote_ccy` BRL + `CUSTOM:<code>`, e a decisão sobre derivar dias úteis da própria série 12.
4. Gate da Fase 3 (`docs/03-validacao.md`) antes de qualquer código Go.
