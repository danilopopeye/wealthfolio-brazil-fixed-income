# 01 — Investigação (Fase 1)

Status: **em andamento**. Última atualização: 20/09/2026.

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

## Wealthfolio (itens 1–10 do bootstrap) — **EM ABERTO**

Nada investigado ainda na versão instalada. O experimento do addon não responde nenhum destes itens (arquitetura diferente). O código da versão instalada está disponível localmente em `wealthfolio/` (clone do upstream, v3.9.0 — ver `wealthfolio/package.json`). Estado atual:

- `[doc]` carried do bootstrap, a re-verificar na versão instalada: placeholders `{SYMBOL}`/`{CURRENCY}`/`{ISIN}`/`{MIC}`/`{TODAY}`/`{FROM}`/`{TO}`/`{DATE:formato}`; somente GET; headers customizados com `__SECRET__` no keyring; symbol override por security na aba Market Data.
- Pendentes (método: documentação upstream + código da versão instalada — descobrir qual é): formato exato do JSON esperado (item 5), interpretação de `price` (5), combinação `quantity × price` (6), histórico `FROM`/`TO` (7), limitações BRL (8), securities manuais (9), efeito de compra com preço ≠ PU do dia / liquidação D+1 (10), caracteres permitidos e validação do symbol (4).
- Item 3 (parâmetros além dos placeholders no symbol override): pendente — a hipótese de trabalho continua sendo codificar os parâmetros no symbol (`CDI-104.50-20260713`), validada apenas como *parseável*, não como aceita pelo Wealthfolio `[hipótese]`.

## Outros itens carried

- Liquidação D+1 da compra (preço pago em 11/09 = PU de 14/09 nos dois títulos): `[hipótese]` — relacionado ao item 10 acima.
- Tolerância 1e-6 por PU: mantida `[decisão]`; as quatro leituras fecham com folga de uma a duas ordens de magnitude.

## Status do código TS (experimento congelado) — `[decisão]`

- `src/lib/cdb.ts`: convenção corrigida para `[emissão, D)`; inclui `calculateCdb` (pós-fixado) e `calculatePreFixedCdb` (prefixado). Referência executável para a portabilidade para Go.
- `src/lib/sgs.ts`: cliente da série 12 (formato, parsing, sem auth) — insumo do item 7 acima.
- `scripts/check-cdi.mjs`: harness de regressão das quatro fixtures + sanidade 2024 + exemplo. Saida de 20/09/2026: 4/4 PASS.
- `manifest.json` com permissão de rede e `src/hooks/`: restos do experimento de addon, sem papel no caminho de produção.

## Próximos passos

1. Re-executar `scripts/check-cdi.mjs` após a série 12 publicar 18/09/2026 → promover o CDI retro-inferido a `[fixture]` e remover o backfill do harness.
2. Cross-check do acumulado 2024 (10,8760%) contra fonte oficial (CETIP/BCB).
3. Investigar os itens 1–10 do Wealthfolio na versão instalada (código já clonado em `wealthfolio/`, v3.9.0) — maior bloco em aberto da fase.
4. Fechados os itens acima, seguir para `docs/02-design.md` (Fase 2).
