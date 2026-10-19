# Integração Wealthfolio ↔ CDBs brasileiros (market data provider)

## Objetivo

Criar uma API pequena, em Go, que devolva o **PU (preço unitário)** de CDBs brasileiros para o Custom Market Data Provider do Wealthfolio.

O objetivo NÃO é criar um sistema de gestão de investimentos. O Wealthfolio continua sendo a fonte de verdade para cadastro das securities, quantidade, custo, datas de compra, carteira e histórico de transações. A API é **stateless em relação aos investimentos**: nenhum banco com cadastro de CDBs, apenas cache do CDI.

**Escopo:** CDB sem liquidez diária, pós-fixado (% do CDI) e prefixado (% a.a.), em BRL, valor bruto (sem IR/IOF, salvo se a Fase 1 demonstrar necessidade).

**Fora de escopo:** IPCA+, LCI/LCA, liquidez diária, aportes ou resgates parciais no mesmo título.

## Contexto

Já existe um Custom Market Data Provider para Tesouro Direto funcionando: uma API pública já fornecia os valores e o provider consome o JSON diretamente. Para CDBs não existe API pública com o valor atualizado de cada título, então a API a ser criada calcula o valor a partir dos parâmetros do título e da série histórica do CDI.

## Regras de evidência (valem para tudo)

Toda afirmação sobre o Wealthfolio ou sobre matemática financeira leva uma tag e uma fonte (URL, `arquivo:linha` ou fixture):

- `[doc]` confirmado na documentação
- `[código]` confirmado no código-fonte da versão instalada
- `[fixture]` confirmado por dado real (seção abaixo)
- `[decisão]` decisão do projeto
- `[hipótese]` ainda não verificado

Nada marcado `[hipótese]` entra na implementação sem virar `[doc]`, `[código]` ou `[fixture]`. Não usar exemplos antigos como base: usar a documentação e o código da versão atual instalada (descobrir qual é).

## Decisões já tomadas

- Stack: **Go**; deploy via **`compose.yaml`**, no mesmo formato dos outros serviços do ambiente.
- Solução mais simples possível: um adaptador (`parâmetros do título + CDI → PU → JSON`). Sem microserviços nem arquitetura desnecessária.
- Cache local do CDI: não baixar a série inteira a cada requisição, atualizar apenas o necessário, e continuar funcionando com dados em cache se a fonte externa estiver fora do ar.
- Sem depender de API paga.
- Segurança: API key fixa em header. Pode ser implementada depois do núcleo, mas o design não deve impedi-la. Nada sensível na URL nem nos logs.

## Responsabilidades

- **Wealthfolio:** cadastro do ativo, quantidade, custo, datas de compra, carteira, histórico de transações, composição.
- **API:** obter o CDI, calcular o PU e devolver market data. Nada além disso.

## Modelo de dados (a validar na Fase 2)

Cada CDB é um título com **PU base R$ 1.000,00 na data de emissão**. No Wealthfolio:

- `quantity` = número de títulos;
- preço da compra = PU pago;
- market price = PU do dia.

A API devolve o PU. O symbol carrega **apenas** indexador, taxa/percentual e data de emissão. Data de compra e valor aplicado ficam só no Wealthfolio, nunca no symbol.

Symbol candidato, usado como **symbol override do provider** na aba Market Data (o ticker canônico do ativo continua limpo). `[hipótese]` até verificar caracteres permitidos e validação:

- `CDI-104.50-20260713` → pós-fixado, 104,50% do CDI, emissão 13/07/2026
- `PRE-14.30-20260713` → prefixado, 14,30% a.a., emissão 13/07/2026

O prefixo (`CDI-`, `PRE-`) deixa a extensão para outros tipos possível sem construí-la agora.

## O que já se sabe sobre o Wealthfolio

Re-verificar na versão instalada:

- `[doc]` O provider customizado usa URL template com os placeholders `{SYMBOL}`, `{CURRENCY}`, `{ISIN}`, `{MIC}`, `{TODAY}`, `{FROM}`, `{TO}` e `{DATE:formato}`.
- `[doc]` Somente requisições GET. Headers customizados são suportados; valores prefixados com `__SECRET__` são guardados no keyring do sistema.
- `[doc]` Existe override de símbolo por provider na aba Market Data do ativo.
- Ainda **não verificado:** formato exato do JSON esperado; suporte e formato de histórico; como price e quantity viram valor da posição; limitações de BRL e de ativos manuais; caracteres permitidos e validação do symbol.

## Matemática financeira

Hipóteses de partida (validar com fontes e fixtures, não assumir):

- **Contagem de dias:** `n` = dias úteis em `[emissão, D)`. O dia da emissão conta, o dia D não. O PU de sábado ou domingo é o do próximo dia útil.
- **Janela vazia:** PU em ou antes da emissão = 1000, sem nenhuma taxa de CDI (título D+1 cadastrado na data da compra). `[decisão]` validada por fixture no Go e no check-engine.
- **Prefixado:** `PU(D) = 1000 × (1 + taxa)^(n/252)`. `[fixture]` confirmado nas duas leituras da Banco B.
- **Pós-fixado:** `PU(D) = 1000 × Π (1 + pct × ((1 + CDI_k)^(1/252) − 1))`, sobre cada dia útil `k` em `[emissão, D)`. `[hipótese]`: pesquisar a convenção de arredondamento/truncamento do fator diário e qual série do CDI é a correta.
- **Calendário:** feriados nacionais/ANBIMA (07/09/2026 é feriado). Pesquisar a fonte e como mantê-la atualizada.
- **CDI do dia:** só é publicado no fim do dia. Definir o que a API devolve para hoje e para datas ainda sem taxa.
- **Bruto:** `[fixture]` os PUs reais são brutos (o prefixado bate sem IR).
- **Datas anteriores à emissão:** sem resposta.
- **Fuso:** `America/Sao_Paulo`.

## Fixtures reais (critério de aceitação)

Emissão dos dois títulos: **13/07/2026**, PU = 1000,00.

**CDB Banco A jul/2027, 104,50% do CDI**

| Data | PU |
|---|---|
| 14/09/2026 | 1024,19875526 |
| 20/09/2026 | 1026,9475888 |

**CDB Banco B jul/2030, 14,30% a.a.**

| Data | PU |
|---|---|
| 14/09/2026 | 1023,611264 |
| 19/09/2026 | 1026,329393 |

Notas:

- As compras foram em **11/09/2026 (sexta)**. O preço pago coincide com o PU de 14/09 (próximo dia útil) nos dois títulos. `[hipótese]` liquidação em D+1. Esses valores NÃO são leituras de mercado de 11/09 e não entram como fixtures. O preço da compra Banco B aparece com 2 casas (1023,61).
- Banco B: `n=44` em 14/09 e `n=49` em 19/09 reproduzem os valores com erro < 1e-6.
- Banco A: pendente da série real do CDI. Sanidade: com `n=44/49`, o CDI médio implícito é ~14,00% a.a. até 14/09 e ~13,80% nos 5 dias úteis seguintes. Com `n=43`, seria ~14,35% no primeiro trecho. A série real do CDI deve decidir.
- Tolerância inicial: 1e-6 por PU; só rever com justificativa documentada (ex.: convenção de arredondamento).

**O projeto não está pronto até as quatro leituras serem reproduzidas pela API.**

## API

Mínima. Formato de resposta, placeholders usados e histórico só são definidos depois de verificar o que o Wealthfolio espera. Se o provider suportar histórico (`FROM`/`TO`), a mesma API devolve a série do PU no intervalo; se não suportar, não implementar.

## Fases

Cada fase gera um arquivo em `docs/` e para no gate indicado. NÃO começar a codificar antes do gate da Fase 3.

### Fase 1 — Investigação → `docs/01-investigacao.md`

**Wealthfolio** (responder cada item com tag de evidência):

1. Como criar um Custom Market Data Provider e configurar a URL.
2. Placeholders suportados (confirmar os de `[doc]` na versão instalada).
3. Como funciona o symbol override por security e se dá para passar parâmetros além dos placeholders.
4. Caracteres permitidos e validação do symbol.
5. Formato JSON esperado e como o `price` é interpretado.
6. Como `quantity` e `price` se combinam no valor da posição.
7. Como funciona o histórico (`FROM`/`TO`) e o formato esperado.
8. Limitações para BRL.
9. Limitações para securities manuais/customizadas.
10. Como uma compra registrada com preço diferente do PU do dia (D+1) afeta custo e ganho.

**Matemática financeira e dados:**

1. Acumulação do CDI no pós-fixado e como o percentual é aplicado.
2. Convenção de dias úteis e calendário (fonte, manutenção).
3. Taxa diária, capitalização e arredondamento/truncamento do fator.
4. Tratamento do primeiro e do último dia, e do CDI de hoje ainda não publicado.
5. Cálculo do prefixado.
6. Bruto vs. líquido: manter bruto, salvo se o Wealthfolio precisar de algo além do bruto para representar corretamente o preço. IR e IOF só entram se essa necessidade for demonstrada.
7. Fonte da série do CDI: existência, limites, formato, estratégia de cache incremental e comportamento com a fonte fora do ar. Candidatas: séries do SGS do Banco Central (CDI diário e CDI anualizado base 252) e B3. Verificar se realmente existem e estão disponíveis antes de escolher.

### Fase 2 — Design → `docs/02-design.md`

Proposta mínima, separando conceitualmente:

- integração com a fonte do CDI;
- cache;
- cálculo financeiro;
- parser/validação do symbol;
- API HTTP;
- configuração do Wealthfolio.

Definir: formato do symbol, endpoints, JSON de resposta, estratégia de cache, algoritmo de cálculo, tratamento de datas, testes, e como tratar a diferença entre PU(D) e o preço de compra com liquidação D+1 (compra em 11/09 registrada a PU de 14/09).

### Fase 3 — Validação do design → `docs/03-validacao.md`

Lista explícita do que é `[doc]`, `[código]`, `[fixture]`, `[decisão]` e `[hipótese]`. Não assumir que o Wealthfolio passa parâmetros arbitrários além dos placeholders documentados.

**PARE AQUI e espere aprovação.**

### Fase 4 — Implementação

API, cálculo, cache, testes, `compose.yaml`, configuração do Custom Market Data Provider e exemplos de securities.

### Fase 5 — Teste ponta a ponta

Fluxo: `Wealthfolio → Custom Market Data Provider → API → fonte do CDI → cálculo → JSON → Wealthfolio`.

Entregar um **roteiro manual passo a passo** (eu executo no Wealthfolio): cadastrar um CDB novo, configurar o symbol override e conferir a posição. Documentar exatamente como cadastrar um CDB novo.

## Testes

**Pós-fixado:** 100% e 110% do CDI; emissões em datas diferentes; períodos sem dia útil; feriados; emissão recente e antiga.

**Prefixado:** taxas e períodos diferentes; fins de semana; períodos longos.

**API:** parâmetros válidos e inválidos; symbol malformado ou desconhecido; CDI indisponível (com e sem cache); data inválida; moeda diferente de BRL; erro da fonte externa.

As quatro fixtures reais entram como testes de regressão. "A fórmula parece correta" não é validação.

## Critérios de sucesso

Consigo:

1. Criar um CDB no Wealthfolio.
2. Configurar o symbol override do provider uma única vez, sem cadastrar o mesmo investimento em outro lugar.
3. O Wealthfolio chamar automaticamente a API.
4. A API obter o CDI quando necessário e calcular o PU.
5. Retornar o preço no formato esperado.
6. O Wealthfolio mostrar corretamente o valor da posição.
7. Opcionalmente, consultar o histórico.

## Princípio geral

O Wealthfolio já gerencia os investimentos. A API é essencialmente um adaptador: parâmetros do título mais a série do CDI viram o PU, devolvido em JSON para o Wealthfolio. Antes de qualquer decisão importante sobre matemática financeira ou comportamento do Wealthfolio, pesquise e apresente a evidência.
