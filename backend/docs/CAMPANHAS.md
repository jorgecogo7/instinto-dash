# Campanhas (v1)

The agency builds a draft per client, sends it for approval, and only the admin publishes.
Publishing **always creates everything PAUSED** on Meta or Google. Nothing spends money until
someone activates it in the platform's manager.

Clients never see this: the tab is hidden in client mode and on the public link, and every
route below uses `requireAdminAuth`, so a client token gets 403 and no token gets 401.

## Status flow

`draft` → `pending_approval` → `publishing` → `published` | `failed`

- Editing (PATCH) a `pending_approval` or `failed` draft sends it back to `draft`.
- `publish` requires `pending_approval` and `role === 'admin'`. The `publishing` lock is atomic,
  so two simultaneous clicks give 200 + 409.
- `published` cannot be edited or deleted.
- Every step is recorded in `log[]` with `at`, `by`, `role`, `action`, `detail`.

## Endpoints (base: `/api/campaigns/:clientId`, header `Authorization: Bearer <token>`)

| Method | Path | What it does |
|---|---|---|
| GET | `/` | Client summary (name, currency, linked accounts), `capabilities` (mode mock/real, what is missing for real publishing) and the list of drafts. `?check=1` also checks whether the Meta token has `ads_management`. |
| GET | `/drafts/:id` | Full draft plus `problems[]` (what is still missing before approval can be requested). |
| POST | `/drafts` | `{ platform: "meta"\|"google", name, notes?, spec }` |
| PATCH | `/drafts/:id` | Same body (partial). |
| DELETE | `/drafts/:id` | Not allowed for publishing/published drafts. |
| POST | `/drafts/:id/request-approval` | `{ note? }`. 422 with `problems[]` if invalid. |
| POST | `/drafts/:id/reject` | `{ note }`. Admin only. Goes back to draft. |
| POST | `/drafts/:id/publish` | Admin only. 200 `published`, 502 `failed`, 409 if real publishing is disabled or misconfigured. |
| POST | `/assets` | `{ name, dataUrl }` JPG/PNG up to 5 MB. Returns `{ id, size, mime }`. |
| GET | `/assets/:assetId` | The image bytes (admin only). |

Everything is scoped by `client_id`: a draft or asset from another client gives 404.

### Meta `spec`
`objective` (mensagens, trafego, cadastros, vendas, alcance), `pixelId` (cadastros/vendas),
`specialAdCategory`, `budgetType` (daily | lifetime), `budget` (in the client's currency),
`startDate`, `endDate` (yyyy-mm-dd, São Paulo time), `audience { countries[], cities[], ageMin,
ageMax, gender, interests[], advantage }`, `placements { mode: auto|manual, positions[] }`,
`creative { assetId, primaryText, headline, description, cta, link }`, `dsa { beneficiary, payor }`
(required if an EU country is targeted).

Optional, for several ad sets and ads in one campaign:

- `creativeEnhancements`: `"opt_out"` asks Meta to turn off Advantage+ creative enhancements
  on every ad (`degrees_of_freedom_spec.creative_features_spec`, one `enroll_status: OPT_OUT`
  per feature). Omit it, or send `"default"`, to leave the API default. Aliases accepted on
  input: `advantageCreative: false`, `optOutAdvantageCreative: true`.
- `adSets[]`: each item is `{ name, audience?, placements?, ads[] }`.
  - `name` is sent to Meta as the ad set name (required, unique in the campaign).
  - `audience` and `placements` are optional overrides. Missing fields inherit the campaign
    `audience` / `placements`. An empty `interests` list inherits the campaign interests;
    a non-empty list replaces them. `advantage: false` keeps Advantage+ audience off.
  - `ads[]`: `{ name, creative: { assetId, primaryText, headline, description, cta?, link? }, creativeEnhancements? }`.
    `name` is the ad name on Meta. Empty `link` / `cta` inherit `creative` at campaign level.
    Up to 25 ad sets and 25 ads per set.

Without `adSets`, publishing still creates one ad set named `<campaign> | Conjunto` and one
ad named `<campaign> | Anúncio`. With `adSets`, those suffixes are not added: the names in
the draft are the names Meta receives. The campaign name is always the draft `name`.

Publishing creates, all **PAUSED** (never ACTIVE): one image upload per distinct asset,
then the campaign (CBO), then each ad set, then each ad's creative and ad.
Instagram-only delivery is `placements.mode: "manual"` with only `instagram_*` positions.
Cities and interests are looked up by name on Meta; what isn't found shows up as a warning.
On a partial failure, what was already created stays paused. IDs are in `publish.ids` and
`publish.created` (`{ type, name, id }`), and on failure also in `publish.partialIds`.
**Retrying creates new objects**, so check the manager first.

Example shape (values are the draft; nothing here is hardcoded in the product):

```json
{
  "name": "[Rota] [Leads] [Landing Page]",
  "platform": "meta",
  "spec": {
    "objective": "cadastros",
    "pixelId": "1093864316811167",
    "budgetType": "daily",
    "budget": 50,
    "startDate": "2026-11-05",
    "creativeEnhancements": "opt_out",
    "audience": { "countries": ["BR"], "cities": ["São Paulo"], "ageMin": 25, "ageMax": 50, "gender": "all", "advantage": false },
    "placements": { "mode": "manual", "positions": ["instagram_feed", "instagram_stories", "instagram_reels"] },
    "creative": { "link": "https://rotadeliveryads.com.br", "cta": "LEARN_MORE" },
    "adSets": [
      {
        "name": "00 [Insta] [H/M] [25-50] [Donos de Restaurante] [Cidades]",
        "audience": { "interests": ["Restaurant management"] },
        "ads": [
          { "name": "04.11.2026 AD01", "creative": { "assetId": "<id da imagem>", "primaryText": "...", "headline": "...", "description": "..." } }
        ]
      }
    ]
  }
}
```

Save with `POST /drafts` or `PATCH /drafts/:id`, then `POST /drafts/:id/request-approval`,
then `POST /drafts/:id/publish` (admin). The response `publish.created` lists every
paused campaign, ad set, creative and ad.

### Google `spec` (Search only in v1)
`budget` (daily), `startDate`, `endDate`, `bidding` (maximize_clicks | maximize_conversions |
manual_cpc), `cpcBid`, `country`, `cities[]`, `language`, `searchPartners`,
`keywords[]` (plain text = broad, `"frase"` = phrase, `[exata]` = exact; objects `{text, match}`
are accepted too), `negatives[]`, `finalUrl`, `headlines[]` (3 to 15, max 30 chars),
`descriptions[]` (2 to 4, max 90 chars), `path1`, `path2`.

Publishing is a single atomic `googleAds:mutate` (budget, campaign, criteria, ad group,
keywords, RSA). It either creates everything or nothing.

## Modes

- `USE_MOCK_DATA=true`: publishing is simulated. IDs are `SIMULADO-...`, and
  `publish.requests` shows the exact calls that would be made (without the token).
- Real: needs `USE_MOCK_DATA=false` **and** `CAMPAIGNS_PUBLISH_ENABLED=true`, plus credentials.
  Otherwise publish returns 409 listing what is missing.

## Deploy

No new environment variable and no database migration. Drafts stay JSON in
`campaign_drafts.data`. Production (`api.instintodigital.com.br`) needs a redeploy
of this Node app on hPanel. The dashboard (`index.html`, `dash.instintodigital.com.br`)
needs a redeploy too, or the new form will not show; the API already accepts `adSets`
before the UI is updated. Publishing still requires the existing
`USE_MOCK_DATA=false` and `CAMPAIGNS_PUBLISH_ENABLED=true`. Do not turn objects ACTIVE
from this module.

## For future traffic-management agents

The endpoints are already the API an agent would use: create/edit drafts and request
approval. `publish` and `reject` check `req.user.role === 'admin'`. An agent token with
its own role (for example `agent`, restricted to one `clientId`) needs a change in
`middleware/adminAuth.js`, and it can never publish without a human.
