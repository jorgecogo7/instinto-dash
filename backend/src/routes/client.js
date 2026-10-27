const express = require('express');
const formsStore = require('../data/formsStore');
const metaService = require('../services/metaService');
const googleService = require('../services/googleService');
const instagramService = require('../services/instagramService');
const accountsStore = require('../data/accountsStore');
const { visibilityOf } = require('../lib/clientAccess');
const { hasInstagramLink, instagramUnlinked } = require('../lib/integrationLink');

const router = express.Router();

// Tudo aqui passa pelo requireClientAuth (req.client = conta do cliente logado).
// Cada rota confere a visibilidade que a agência liberou — esconder só na tela não basta.

function platformsOf(account, vis) {
  const mOn = account.meta?.status === 'connected';
  const gOn = account.google?.status === 'connected';
  const model = account.dashboardModel || 'auto';
  const wanted = model === 'meta' ? ['meta'] : model === 'google' ? ['google']
    : model === 'combined' ? ['meta', 'google'] : [...(mOn ? ['meta'] : []), ...(gOn ? ['google'] : [])];
  return wanted.filter((p) => (p === 'meta' ? mOn && vis.ads_meta : gOn && vis.ads_google) && vis.ads);
}

router.get('/me', (req, res) => {
  const a = req.client;
  const vis = visibilityOf(a);
  res.json({
    id: a.id,
    name: a.name,
    niche: a.niche,
    username: a.clientAuth.username,
    visibility: vis,
    platforms: platformsOf(a, vis),
    goals: vis.ads_goals ? (a.goals || {}) : {},
    hasInstagram: hasInstagramLink(a),
  });
});

router.get('/:kind(meta|google|instagram)', async (req, res) => {
  const a = req.client;
  const vis = visibilityOf(a);
  const range = { from: req.query.from, to: req.query.to };
  try {
    if (req.params.kind === 'instagram') {
      if (!vis.social) return res.status(403).json({ error: 'Esta seção não está liberada para você.' });
      let igUserId = instagramUnlinked(a) ? null : (a.instagramApi?.igUserId || a.meta?.igBusinessId || null);
      if (!igUserId && a.meta?.pageId && !instagramUnlinked(a)) {
        const ig = await metaService.findInstagramForPage(a.meta.pageId);
        if (ig) { igUserId = ig.id; await accountsStore.update(a.id, { meta: { ...a.meta, igBusinessId: ig.id } }); }
      }
      const report = await instagramService.getOrganicReport(igUserId, range);
      return res.json({ ...report, igConfigured: Boolean(igUserId) });
    }
    if (!platformsOf(a, vis).includes(req.params.kind)) return res.status(403).json({ error: 'Esta seção não está liberada para você.' });
    if (req.params.kind === 'meta') return res.json(await metaService.getAccountReport(a.meta.adAccountId, { ...range, fresh: req.query.fresh === '1' }));
    return res.json(await googleService.getAccountReport(a.google.customerId, range));
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'Não foi possível carregar os dados agora. Tente de novo em instantes.' });
  }
});

/* ---------- Formulários do cliente (só leitura) ---------- */
function formForClient(f) {
  const { tracking, integrations, ...rest } = f;
  return { ...rest, tracking: { metaPixelId: tracking?.metaPixelId || '' } };
}

async function ownForm(req, res) {
  if (!visibilityOf(req.client).forms) { res.status(403).json({ error: 'Esta seção não está liberada para você.' }); return null; }
  const form = await formsStore.getById(req.params.id);
  if (!form || form.clientId !== req.client.id) { res.status(404).json({ error: 'Formulário não encontrado.' }); return null; }
  return form;
}

router.get('/forms', async (req, res) => {
  if (!visibilityOf(req.client).forms) return res.status(403).json({ error: 'Esta seção não está liberada para você.' });
  try {
    const [forms, stats] = await Promise.all([formsStore.getAll(), formsStore.getStats()]);
    res.json(forms.filter((f) => f.clientId === req.client.id)
      .sort((x, y) => String(y.updatedAt).localeCompare(String(x.updatedAt)))
      .map((f) => ({ ...formForClient(f), stats: stats[f.id] || { views: 0, starts: 0, completes: 0, qualified: 0 } })));
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Erro ao carregar os formulários.' });
  }
});

router.get('/forms/:id', async (req, res) => {
  const form = await ownForm(req, res);
  if (!form) return;
  const stats = (await formsStore.getStats())[form.id] || { views: 0, starts: 0, completes: 0, qualified: 0 };
  res.json({ ...formForClient(form), stats });
});

router.get('/forms/:id/responses', async (req, res) => {
  const form = await ownForm(req, res);
  if (!form) return;
  // Reaproveita a exportação da rota da agência (mesmo formato).
  req.url = `/${form.id}/responses${req.query.format === 'csv' ? '?format=csv' : ''}`;
  return require('./forms').handle(req, res, () => res.status(404).end());
});

module.exports = router;
