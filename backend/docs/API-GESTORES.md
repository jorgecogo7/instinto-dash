# API dos gestores (IA)

API para os agentes gestores (rodando num servidor Linux, só com `curl`) **lerem os números** dos clientes e **gravarem a "Análise do gestor"** no Sistema Instinto Digital.

- Base: `https://api.instintodigital.com.br/api/gestor`
- Só leitura de métricas e diagnóstico + escrita de análises. **Não existe** rota pra publicar, pausar, ativar ou editar campanha, nem pra ver contrato, saldo, CRM ou dados pessoais de leads.
- A análise só aparece pro Jorge (aba **Análise do gestor** de cada cliente). O cliente nunca vê: nem no login dele, nem no link público, nem no PDF ou no relatório automático.

## 1. Chave de acesso

1. O Jorge abre qualquer cliente no painel > **🧠 Análise do gestor** > **🔑 Acesso dos gestores (API)**.
2. Digita um nome (ex.: `Gestor IA Meta`) e clica em **Gerar chave**.
3. A chave (começa com `igk_`) aparece **uma vez só**. Copie e guarde no servidor dos agentes numa variável de ambiente, por exemplo `GESTOR_API_KEY`. Nunca coloque a chave em código, commit, log ou chat.
4. Pra cortar o acesso: **Revogar** na mesma tela (vale na hora).

Uma chave vale pra todos os clientes. O banco guarda só o hash (SHA-256) da chave. Não precisa configurar nada no hPanel.

Toda chamada leva o cabeçalho:

```
Authorization: Bearer $GESTOR_API_KEY
```

Erros de acesso:

| Código | Quando |
|---|---|
| `503` `not_configured` | Nenhuma chave foi criada ainda (o Jorge precisa gerar uma). |
| `401` `missing_key` | Faltou o cabeçalho `Authorization`. |
| `401` `invalid_key` | Chave errada ou revogada. |

A chave não funciona em nenhuma outra rota do sistema (todas respondem 401). Limite: 600 chamadas por minuto por IP (acima disso, `429`; espere 30 s).

## 2. Endpoints

Datas sempre `AAAA-MM-DD`. Sem `from`/`to` = últimos 30 dias. Período máximo: 400 dias.

### `GET /me`
Confere a chave. Resposta: `{ "label": "Gestor IA Meta", "scopes": ["ler-metricas", "escrever-analises"] }`

### `GET /clients`
Lista de clientes (fonte oficial dos slugs).
```json
{ "clients": [ { "id": "seiza", "name": "Seiza", "niche": "…", "status": "ativo", "platforms": { "meta": true, "google": false } } ] }
```

### `GET /clients/:id/performance?from=&to=`
Meta Ads + Google Ads do período, de uma vez:
```json
{
  "client": { "id": "seiza", "name": "Seiza", "niche": "…" },
  "period": { "from": "2026-09-01", "to": "2026-09-30" },
  "testMode": { "meta": false, "google": false },
  "meta":   { "connected": true, "report": { "totals": {}, "previousTotals": {}, "deltas": {}, "daily": [], "campaigns": [], "ads": [], "breakdowns": {} } },
  "google": { "connected": false, "error": "Google Ads não conectado para este cliente." }
}
```
- `meta.report`: totais do período e do período anterior (investimento, impressões, cliques, CTR, CPC, resultados, custo por resultado), evolução diária, campanhas, conjuntos e anúncios com investimento (com miniatura do criativo).
- `google.report`: campanhas, palavras-chave, termos de pesquisa, investimento diário, parcela de impressões, força do anúncio e variações.
- Se uma plataforma der erro, vem `{ "connected": true, "error": "…" }` e a outra continua normal.
- `testMode: true` = servidor sem credenciais reais (dados de demonstração). **Não analise dados com `testMode: true`.**

### `GET /clients/:id/meta?from=&to=` e `GET /clients/:id/google?from=&to=`
Só uma plataforma (mesmo conteúdo de `report` acima). `409` se a plataforma não estiver conectada, `502` se a Meta/Google recusar.

### `GET /clients/:id/diagnostics?from=&to=` (diagnóstico de leads, só leitura)
Explica **por que os leads chegam desqualificados ou em pouca quantidade**: mostra como cada campanha está montada e o que cada anúncio entregou no período. Também existe só uma plataforma: `/clients/:id/diagnostics/meta` e `/clients/:id/diagnostics/google`. Mesmo `from`/`to` (padrão: últimos 30 dias). Resposta guardada por 5 minutos.

Cada plataforma volta assim:
- `connected: false`: plataforma não conectada nesse cliente.
- `available: false, testMode: true`: servidor sem credenciais reais. **Não vem nenhum dado** (nada é inventado).
- `available: true`: diagnóstico real. `errors` lista as partes que a Meta/Google recusaram (o resto vem normal).

**Meta** (`meta`). Só entra o que está ativo agora ou teve entrega no período. Orçamento e gasto na moeda da conta (`account.currency`).
| Bloco | O que traz |
|---|---|
| `account` | nome, moeda, fuso |
| `totals` | gasto, impressões, cliques, CTR, CPC, resultados e custo por resultado do período |
| `campaigns[]` | `objective`, `buyingType`, `bidStrategy`, `dailyBudget`/`lifetimeBudget`, `budgetLevel` (campanha ou conjunto), `specialAdCategories`, `metrics` |
| `adSets[]` | `optimizationGoal`, `billingEvent`, `bidStrategy`, `bidAmount`, orçamentos, `destinationType`, `promotedObject`, `attribution`, `targeting` (idade, gênero (`todos` quando a Meta manda 0 ou nada), cidades/raio, regiões, CEPs, locais com raio (`places`, ex.: um hospital), bairros (`neighborhoods`), `subcities`, `geoMarkets`, locais excluídos (`excludedGeo`), exclusões, interesses, comportamentos, públicos personalizados e semelhantes, `advantageAudience` ligado/desligado, `placements` automático ou a lista de posicionamentos), `targetingRaw` (objeto completo da Meta), `metrics` (+ `frequency`) |
| `ads[]` | `creative` (`primaryTexts` (em criativo dinâmico sem texto, vem da publicação e `primaryTextSource` = `publicacao`), `headlines`, `descriptions`, `format`, `dynamic`, `thumbnailUrl`, `imageUrl`), `destination` (`type`: `formulario`, `whatsapp`, `instagram_direct`, `perfil_instagram` (CTA para o perfil do Instagram), `messenger`, `site`, `engajamento`; `ctaTypes`, `urls`, `leadFormIds`), `metrics` (gasto, impressões, alcance, cliques, CTR, CPC, CPM, frequência, `resultType`, `results`, `costPerResult`, `actions`) |
| `leadForms[]` | formulários usados pelos anúncios (se a Meta não deixar ler, aparece em `errors` como `leadForm:<id>` com a explicação: o usuário do sistema precisa de acesso à Página dona do formulário): `higherIntent` (`true` = "Maior intenção", `false` = "Mais volume"), `questions` (tipo, rótulo, opções), `customQuestionsCount`, `contextCard`, `thankYouPage`, `leadsCount` |
| `signals[]` | sinais automáticos (regras fixas, não opinião): `form_more_volume`, `form_no_qualifying_question`, `advantage_audience_on`, `placements_auto`, `audience_network`, `high_frequency`, `spend_no_results`, `optimization_mismatch`, `low_ctr` |

**Google** (`google`). Valores em reais (já convertidos de micros).
| Bloco | O que traz |
|---|---|
| `campaigns[]` | `channelType` (SEARCH, PERFORMANCE_MAX…), `biddingStrategy`, `targetCpa`, `dailyBudget`, `network` (pesquisa, Display, parceiros), `impressionShare` (parcela, perdida por orçamento, perdida por classificação), `metrics` |
| `keywords[]` | texto, `matchType` (EXACT, PHRASE, BROAD), status, Índice de qualidade, `metrics` (até 150, por gasto) |
| `negativeKeywords[]` | negativas de campanha e de grupo |
| `searchTerms[]` | termo pesquisado, `status` (ADDED, EXCLUDED, NONE), `matchType`, `metrics` (até 200, por gasto) |
| `ads[]` | `headlines`, `descriptions`, `finalUrls`, `adStrength`, aprovação, `metrics` |
| `conversionActions[]` | ações de conversão ativas: categoria, `primaryForGoal`, contagem (uma ou todas) |
| `signals[]` | `search_with_display`, `search_partners`, `spend_no_conversions`, `broad_match`, `terms_without_conversion`, `weak_primary_conversion` |

Os sinais são ponto de partida. Confirme nos dados antes de virar sugestão.

### `GET /clients/:id/analyses?limit=10`
Análises já gravadas (mais recente primeiro), incluindo se o Jorge aprovou ou descartou cada sugestão. Use pra não repetir sugestão e pra acompanhar o que foi aprovado.

### `POST /clients/:id/analyses`
Grava uma análise nova. Corpo JSON (máx. 100 KB). Textos aceitam markdown simples (`**negrito**`, `*itálico*`, listas com `-` ou `1.`, títulos com `#`).

| Campo | Tipo | Obrigatório | Limite |
|---|---|---|---|
| `title` | texto | não | 160 |
| `author` | texto (nome do gestor) | não (padrão: nome da chave) | 80 |
| `period` | `{ "from": "AAAA-MM-DD", "to": "AAAA-MM-DD" }` | recomendado | |
| `platforms` | `["meta", "google"]` | não | |
| `summary` | Resumo | sim (ou `suggestions`) | 8000 |
| `worked` | O que funcionou | não | 8000 |
| `notWorked` | O que não funcionou | não | 8000 |
| `leadDiagnosis` | Diagnóstico dos leads (por que vêm desqualificados ou poucos) | não | 8000 |
| `suggestions` | lista (máx. 30) | não | |
| `suggestions[].title` | texto | sim | 200 |
| `suggestions[].detail` | texto | não | 4000 |
| `suggestions[].priority` | `alta`, `media` ou `baixa` | não (padrão `media`) | |
| `suggestions[].area` | `copy`, `criativo`, `publico`, `objetivo`, `lance`, `orcamento`, `posicionamento`, `formulario`, `pagina`, `palavras-chave`, `rastreamento`, `outro` | não | |
| `suggestions[].expectedImpact` | texto | não | 300 |
| `nextSteps` | Próximos passos | não | 8000 |

Resposta `201` com a análise gravada (com `id`). Toda sugestão entra como `pendente`; só o Jorge aprova ou descarta no painel.

Regras de conteúdo: não invente números (use só o que veio da API), sem travessão (—), sem prometer resultado.

## 3. Exemplos com curl

```bash
export GESTOR_API_KEY='...'   # a chave gerada no painel (nunca no código)
API=https://api.instintodigital.com.br/api/gestor

# conferir a chave
curl -s -H "Authorization: Bearer $GESTOR_API_KEY" $API/me

# lista de clientes (slugs)
curl -s -H "Authorization: Bearer $GESTOR_API_KEY" $API/clients

# números de setembro
curl -s -H "Authorization: Bearer $GESTOR_API_KEY" "$API/clients/seiza/performance?from=2026-09-01&to=2026-09-30"

# diagnóstico dos leads (montagem das campanhas + entrega por anúncio)
curl -s -H "Authorization: Bearer $GESTOR_API_KEY" "$API/clients/seiza/diagnostics?from=2026-09-01&to=2026-09-30"
curl -s -H "Authorization: Bearer $GESTOR_API_KEY" "$API/clients/seiza/diagnostics/meta?from=2026-09-01&to=2026-09-30"

# análises anteriores
curl -s -H "Authorization: Bearer $GESTOR_API_KEY" "$API/clients/seiza/analyses?limit=5"

# gravar análise
curl -s -X POST -H "Authorization: Bearer $GESTOR_API_KEY" -H 'Content-Type: application/json' \
  "$API/clients/seiza/analyses" --data @- <<'JSON'
{
  "author": "Gestor Seiza",
  "title": "Setembro: custo por lead caiu, qualidade precisa subir",
  "period": { "from": "2026-09-01", "to": "2026-09-30" },
  "platforms": ["meta"],
  "summary": "Resumo do mês com os números do período.",
  "worked": "- O que deu certo",
  "notWorked": "- O que não deu certo",
  "leadDiagnosis": "Por que os leads vêm desqualificados ou em pouco volume.",
  "suggestions": [
    { "title": "Mudar o formulário para maior intenção", "detail": "Como e por quê.", "priority": "alta", "area": "formulario", "expectedImpact": "Menos leads, mais qualificados" }
  ],
  "nextSteps": "1. Primeiro passo\n2. Revisar em 7 dias"
}
JSON
```

## 4. Slugs dos clientes

A fonte oficial é sempre `GET /clients` (o slug vem do nome cadastrado e pode ter sufixo se houver nome repetido). Slugs conferidos em produção em 23/10/2026:

| Cliente | Slug | Plataformas |
|---|---|---|
| Abmix | `abmix` | Meta |
| Ara Faria Lima | `ara-faria-lima` | Meta |
| Arvis | `arvis` | Meta |
| Biòs Farmacêutica | `bi-s-farmac-utica-1792699638040` | Meta |
| Boxe Training | `boxe-training` | Meta |
| Dado Grifes | `dado-grifes` | Meta |
| Dr. Jordão | `dr-jord-o` | Meta |
| Dr. Raphael | `dr-raphael` | Meta |
| Dra. Mara Lise | `dra-mara-lise` | nenhuma |
| GB Amadora | `gb-amadora` | Meta |
| GL Baterias | `gl-baterias` | Google |
| MiKit | `bi-s-farmac-utica` | Meta |
| MyBi | `mybi` | Meta |
| Nippon | `nippon` | Meta |
| One Touch | `one-touch` | Meta e Google |
| Pão & Água | `p-o-gua` | Meta |
| Prime Baterias | `prime-baterias` | Google |
| Raquel Bianca | `raquel-bianca` | nenhuma |
| Seiza | `seiza` | Meta |
| Síntese Moema | `s-ntese-moema` | Meta |

Atenção: o slug do MiKit é `bi-s-farmac-utica` (herdado de um nome antigo) e o da Biòs tem sufixo.

## 5. Rotas do painel (só login do Jorge)

Usadas pela aba; login de cliente recebe `403`.

- `GET /api/analyses/:id` lista as análises do cliente
- `POST /api/analyses/:id` grava uma análise escrita à mão (mesmo corpo)
- `PATCH /api/analyses/:id/:analiseId/suggestions/:sugestaoId` com `{ "status": "aprovada" | "descartada" | "pendente" }`
- `DELETE /api/analyses/:id/:analiseId`
- `GET|POST /api/gestor-access/keys`, `DELETE /api/gestor-access/keys/:keyId` (chaves)
