# API dos gestores (IA)

API para os agentes gestores (rodando num servidor Linux, só com `curl`) **lerem os números** dos clientes e **gravarem a "Análise do gestor"** no Sistema Instinto Digital.

- Base: `https://api.instintodigital.com.br/api/gestor`
- Só leitura de métricas + escrita de análises. **Não existe** rota pra publicar, pausar, ativar ou editar campanha, nem pra ver contrato, saldo, CRM ou dados pessoais de leads.
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

A fonte oficial é sempre `GET /clients` (o slug vem do nome cadastrado e pode ter sufixo se houver nome repetido). Slugs **prováveis**, calculados pelo nome, pra conferir:

| Cliente | Slug provável |
|---|---|
| Abmix | `abmix` |
| Ara Faria Lima | `ara-faria-lima` |
| Arvis | `arvis` |
| Biòs Farmacêutica | `bi-s-farmac-utica` |
| Dado Grifes | `dado-grifes` |
| Dr. Jordão | `dr-jord-o` |
| Dr. Raphael | `dr-raphael` |
| GB Amadora | `gb-amadora` |
| GL Baterias | `gl-baterias` |
| MiKit | `mikit` |
| MyBi | `mybi` |
| Nippon | `nippon` |
| One Touch | `one-touch` |
| Pão & Água | `p-o-gua` |
| Prime Baterias | `prime-baterias` |
| Raquel Bianca | `raquel-bianca` |
| Seiza | `seiza` |
| Síntese Moema | `s-ntese-moema` |

## 5. Rotas do painel (só login do Jorge)

Usadas pela aba; login de cliente recebe `403`.

- `GET /api/analyses/:id` lista as análises do cliente
- `POST /api/analyses/:id` grava uma análise escrita à mão (mesmo corpo)
- `PATCH /api/analyses/:id/:analiseId/suggestions/:sugestaoId` com `{ "status": "aprovada" | "descartada" | "pendente" }`
- `DELETE /api/analyses/:id/:analiseId`
- `GET|POST /api/gestor-access/keys`, `DELETE /api/gestor-access/keys/:keyId` (chaves)
