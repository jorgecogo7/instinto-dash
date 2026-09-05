# Instinto Dash — Backend

Backend do dashboard, estruturado para múltiplas contas de clientes
(Meta Ads e Google Ads). Hoje roda 100% com dados de exemplo — assim que
você tiver as credenciais (veja o `GUIA-DE-SETUP.md` do projeto), é só
preencher o `.env` que os dados reais entram sem mudar a estrutura.

## Como rodar

```bash
npm install
cp .env.example .env
npm start
```

O servidor sobe em `http://localhost:4000`.

## Endpoints

- `GET /api/health` — checagem simples, mostra se o modo mock está ativo.
- `GET /api/accounts` — lista os clientes com status de conexão (Meta /
  Google / Instagram) e os dados de gestão (nicho, valor de contrato,
  orçamento diário, status, responsável) usados na aba "Clientes".
- `POST /api/accounts` — cadastra um novo cliente (o que o botão
  "+ Novo cliente" do frontend vai chamar quando estiver ligado ao backend).
- `PATCH /api/accounts/:id` — edita campos de um cliente (ex: mudar valor
  de contrato ou status).
- `GET /api/meta/:clientId/campaigns` — campanhas → conjuntos de anúncios →
  anúncios de um cliente, com métricas e o `targetPerformancePct` (usado
  no dashboard para colorir a barra de performance).
- `GET /api/google/:clientId/report` — campanhas, palavras-chave (com
  Quality Score) e Auction Insights de um cliente.
- `GET /api/insights/:clientId?platform=meta|google` — sugestões de
  melhoria geradas por IA (segmentação, nível de anúncio e copy) a partir
  dos dados reais da conta. Precisa de `ANTHROPIC_API_KEY` no `.env` —
  sem ela, devolve um erro explicando isso em vez de inventar uma análise.
- `POST /api/sync` — sincroniza todas as contas em fila (uma por vez, com
  pausa entre elas) e preenche o cache. Em produção, isso deve rodar
  automaticamente a cada 30–60 minutos via cron, em vez de manual.

## Arquitetura, em uma frase por peça

- `src/data/accounts.js` — registro dos clientes (viraria uma tabela no
  banco de dados).
- `src/services/metaService.js` / `googleService.js` — única camada que
  fala com as APIs externas. É o único lugar que muda quando as
  credenciais reais chegarem (já tem o código real comentado, só
  descomentar).
- `src/lib/cache.js` — evita bater na API do Meta/Google a cada vez que
  alguém abre o dashboard.
- `src/lib/syncQueue.js` — evita estourar rate limit processando contas
  em paralelo; sincroniza uma de cada vez.
- `src/routes/*` — a API que o frontend consome.

## Próximo passo real

Este backend ainda não tem banco de dados nem autenticação de usuário —
está no ponto certo para ganhar essas duas coisas assim que o dashboard
for além de protótipo.

**Google Ads já está ativado de verdade** (campanhas e palavras-chave —
Auction Insights ainda usa dados de exemplo, é uma parte mais avançada
da API). Para testar com uma conta real, edite `src/data/accounts.js` e
troque o `customerId` de algum cliente por um ID de conta que já esteja
vinculado à sua MCC (formato `000-000-0000`, sem aspas de sobra) — sem
isso, o teste falha porque os IDs no arquivo hoje são placeholders.

**Meta Ads ainda usa dados de exemplo**, esperando App ID, App Secret e
o token do Usuário de Sistema.
