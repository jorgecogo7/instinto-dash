const express = require('express');
const crypto = require('crypto');
const accountsStore = require('../data/accountsStore');
const googleService = require('../services/googleService');
const metaService = require('../services/metaService');
const leadsStore = require('../data/leadsStore');
const instagramService = require('../services/instagramService');
const formsStore = require('../data/formsStore');
const formService = require('../services/formService');
const { visibilityOf } = require('../lib/clientAccess');

const router = express.Router();

function sanitizeString(value, maxLength) {
  if (typeof value !== 'string') return null;
  return value.trim().slice(0, maxLength) || null;
}

// GET /api/public/:token — usado pelo link que você manda pro cliente.
// Não exige login nem chave de API (de propósito — é o link que o
// CLIENTE abre). Só devolve dados daquele cliente específico, nunca a
// lista completa, e nunca campos internos (contrato, saldo pix, etc.).
router.get('/:token', async (req, res) => {
  const account = await accountsStore.getByShareToken(req.params.token);
  if (!account) return res.status(404).json({ error: 'Link inválido ou expirado.' });

  const safeAccount = {
    name: account.name,
    niche: account.niche,
    status: account.status,
    metaConnected: account.meta?.status === 'connected',
    googleConnected: account.google?.status === 'connected',
    instagramConnected: account.instagramApi?.status === 'connected',
  };

  const [metaData, googleData] = await Promise.allSettled([
    account.meta?.status === 'connected' ? metaService.getCampaignsWithAds(account.meta.adAccountId) : null,
    account.google?.status === 'connected' ? googleService.getAccountReport(account.google.customerId) : null,
  ]);

  res.json({
    account: safeAccount,
    meta: metaData.status === 'fulfilled' ? metaData.value : null,
    google: googleData.status === 'fulfilled' ? googleData.value : null,
  });
});

/* ---------- Formulários próprios (link público /f/slug) ---------- */

async function publishedForm(slug) {
  const form = await formsStore.getBySlug(String(slug || '').slice(0, 80));
  return form && form.status === 'published' ? form : null;
}

// GET /api/public/forms/:slug — definição pública do formulário (sem pontos/token).
router.get('/forms/:slug', async (req, res) => {
  try {
    const form = await publishedForm(req.params.slug);
    if (!form) return res.status(404).json({ error: 'Este formulário não existe ou não está publicado.' });
    res.json(formService.publicForm(form));
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Não foi possível abrir o formulário agora.' });
  }
});

// POST /api/public/forms/:slug/event { type: 'view' | 'start' } — contadores da taxa de conversão.
router.post('/forms/:slug/event', async (req, res) => {
  try {
    const form = await publishedForm(req.params.slug);
    if (!form) return res.status(404).json({ error: 'Formulário não encontrado.' });
    if (['view', 'start'].includes(req.body.type)) await formsStore.bumpStat(form.id, req.body.type);
    res.json({ ok: true });
  } catch (err) {
    console.error(err); res.status(500).json({ ok: false });
  }
});

// POST /api/public/forms/:slug/submit — grava a resposta, calcula a
// qualificação no servidor e devolve qual tela final mostrar.
router.post('/forms/:slug/submit', async (req, res) => {
  if (req.body.website) return res.json({ ok: true, qualified: false, disqualified: false }); // honeypot
  try {
    const form = await publishedForm(req.params.slug);
    if (!form) return res.status(404).json({ error: 'Formulário não encontrado.' });

    const answers = formService.cleanAnswers(form, req.body.answers);
    if (!Object.keys(answers).length) return res.status(400).json({ error: 'Responda pelo menos uma pergunta.' });

    const result = formService.evaluate(form, answers);
    const readable = formService.answersReadable(form, answers);
    const contact = formService.contactFrom(form, answers);
    const m = req.body.meta || {};
    const pick = (k, max = 200) => (typeof m[k] === 'string' ? m[k].slice(0, max) : undefined);
    const meta = {
      utm_source: pick('utm_source'), utm_medium: pick('utm_medium'), utm_campaign: pick('utm_campaign'),
      utm_content: pick('utm_content'), utm_term: pick('utm_term'), fbclid: pick('fbclid', 500), gclid: pick('gclid', 500),
      referrer: pick('referrer', 500), url: pick('url', 800), fbp: pick('fbp'), fbc: pick('fbc', 500),
      ip: (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim(),
      userAgent: String(req.headers['user-agent'] || '').slice(0, 300),
    };
    const eventIds = req.body.eventIds || {};
    const response = {
      id: crypto.randomBytes(8).toString('hex'),
      formId: form.id,
      createdAt: new Date().toISOString(),
      answers, readable, contact, result, meta,
    };
    await formsStore.addResponse(form.id, response);
    await formsStore.bumpStat(form.id, 'complete');
    if (result.qualified) await formsStore.bumpStat(form.id, 'qualified');

    if (form.integrations.createCrmLead) {
      const temperature = !result.usesQualification ? null : result.qualified ? 'quente' : 'frio';
      await leadsStore.add({
        id: crypto.randomBytes(8).toString('hex'),
        name: contact.name || 'Sem nome', email: contact.email || null, phone: contact.phone || null,
        company: contact.company || null, niche: null, budget: null,
        message: readable.map((x) => `${x.question}: ${x.answer}`).join('\n').slice(0, 4000),
        source: `formulario:${form.slug}`, stage: 'novo', owner: null, notes: null,
        score: result.usesQualification ? result.score : null, temperature,
        reasoning: result.reasons.join(' · ') || null, nextAction: null, scoredAt: null, convertedAccountId: null,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      }).catch((e) => console.warn('Lead do formulário não entrou no CRM:', e.message));
    }

    // API de Conversões e webhook não seguram a resposta do lead.
    const url = meta.url || '';
    const safeEventId = (v) => (typeof v === 'string' ? v.slice(0, 80) : undefined);
    formService.sendCapi(form, { eventName: form.tracking.leadEvent, eventId: safeEventId(eventIds.lead) || response.id, contact, meta, url });
    if (result.usesQualification) {
      formService.sendCapi(form, {
        eventName: result.qualified ? form.tracking.qualifiedEvent : form.tracking.disqualifiedEvent,
        eventId: safeEventId(eventIds.qualification) || `${response.id}-q`, contact, meta, url,
      });
    }
    formService.sendWebhook(form, {
      form: { id: form.id, slug: form.slug, name: form.name },
      responseId: response.id, createdAt: response.createdAt,
      contact, answers: readable, qualified: result.qualified, score: result.score, utm: {
        source: meta.utm_source, medium: meta.utm_medium, campaign: meta.utm_campaign, content: meta.utm_content, term: meta.utm_term,
      },
    });

    res.json({ ok: true, qualified: result.qualified, disqualified: result.disqualified, usesQualification: result.usesQualification });
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Não foi possível enviar agora. Tente novamente em instantes.' });
  }
});

// Plataformas que o painel do cliente mostra (mesma regra do painel interno).
function wantedPlatforms(account) {
  const mOn = account.meta?.status === 'connected';
  const gOn = account.google?.status === 'connected';
  const model = account.dashboardModel || 'auto';
  const wanted = model === 'meta' ? ['meta'] : model === 'google' ? ['google']
    : model === 'combined' ? ['meta', 'google'] : [...(mOn ? ['meta'] : []), ...(gOn ? ['google'] : [])];
  const vis = visibilityOf(account);
  if (!vis.ads) return [];
  return wanted.filter((p) => (p === 'meta' ? mOn && vis.ads_meta : gOn && vis.ads_google));
}

// GET /api/public/:token/info — dados básicos pro painel do cliente (link
// compartilhado). Nada interno: sem contrato, saldo, IDs de conta etc.
router.get('/:token/info', async (req, res) => {
  const account = await accountsStore.getByShareToken(req.params.token);
  if (!account) return res.status(404).json({ error: 'Link inválido ou expirado.' });
  res.json({
    name: account.name,
    niche: account.niche,
    platforms: wantedPlatforms(account),
    dashboardModel: account.dashboardModel || 'auto',
    hasInstagram: visibilityOf(account).social && Boolean(account.instagramApi?.igUserId || account.meta?.igBusinessId || account.meta?.pageId),
    visibility: visibilityOf(account),
  });
});

// GET /api/public/:token/(meta|google|instagram)?from&to — os mesmos
// relatórios do painel interno, só daquele cliente.
router.get('/:token/:kind(meta|google|instagram)', async (req, res) => {
  const account = await accountsStore.getByShareToken(req.params.token);
  if (!account) return res.status(404).json({ error: 'Link inválido ou expirado.' });
  const range = { from: req.query.from, to: req.query.to };
  const kind = req.params.kind;
  try {
    if (kind === 'meta') {
      if (!wantedPlatforms(account).includes('meta')) return res.status(409).json({ error: 'Meta Ads não está ativo neste painel.' });
      return res.json(await metaService.getAccountReport(account.meta.adAccountId, range));
    }
    if (kind === 'google') {
      if (!wantedPlatforms(account).includes('google')) return res.status(409).json({ error: 'Google Ads não está ativo neste painel.' });
      return res.json(await googleService.getAccountReport(account.google.customerId, range));
    }
    if (!visibilityOf(account).social) return res.status(403).json({ error: 'Esta seção não está liberada.' });
    let igUserId = account.instagramApi?.igUserId || account.meta?.igBusinessId || null;
    if (!igUserId && account.meta?.pageId) {
      const ig = await metaService.findInstagramForPage(account.meta.pageId);
      if (ig) {
        igUserId = ig.id;
        await accountsStore.update(account.id, { meta: { ...account.meta, igBusinessId: ig.id } });
      }
    }
    const report = await instagramService.getOrganicReport(igUserId, range);
    return res.json({ ...report, igConfigured: Boolean(igUserId) });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'Não foi possível carregar os dados agora. Tente de novo em instantes.' });
  }
});

// POST /api/public/leads — o formulário de Captação & CRM que qualquer
// visitante preenche (link público, sem login, sem chave de API — de
// propósito). Só escreve um lead novo com estágio "novo"; não lê nem
// devolve dados de ninguém, então não tem o risco de vazamento que o
// GET acima tem que tomar cuidado com.
router.post('/leads', async (req, res) => {
  // honeypot: campo escondido no formulário que só um bot preenche.
  // Gente de verdade nunca vê nem toca nesse campo.
  if (req.body.website) return res.status(201).json({ ok: true });

  const name = sanitizeString(req.body.name, 120);
  if (!name) return res.status(400).json({ error: 'Informe seu nome.' });

  const email = sanitizeString(req.body.email, 160);
  const phone = sanitizeString(req.body.phone, 40);
  if (!email && !phone) return res.status(400).json({ error: 'Informe pelo menos um contato (e-mail ou telefone).' });

  try {
    const lead = {
      id: crypto.randomBytes(8).toString('hex'),
      name,
      email,
      phone,
      company: sanitizeString(req.body.company, 120),
      niche: sanitizeString(req.body.niche, 80),
      budget: sanitizeString(req.body.budget, 60),
      message: sanitizeString(req.body.message, 2000),
      source: 'formulario-publico',
      stage: 'novo',
      owner: null,
      notes: null,
      score: null,
      temperature: null,
      reasoning: null,
      nextAction: null,
      scoredAt: null,
      convertedAccountId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await leadsStore.add(lead);
    res.status(201).json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Não foi possível enviar agora. Tente novamente em instantes.' });
  }
});

module.exports = router;
