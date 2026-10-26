const express = require('express');
const crypto = require('crypto');
const formsStore = require('../data/formsStore');
const accountsStore = require('../data/accountsStore');
const formService = require('../services/formService');

const router = express.Router();

// O token da API de Conversões nunca volta pro navegador, nem pro painel:
// o editor só fica sabendo se existe ("__keep__" = manter o que já está salvo).
function forEditor(form) {
  return { ...form, tracking: { ...form.tracking, capiToken: form.tracking?.capiToken ? '__keep__' : '' } };
}

async function uniqueSlug(base, ignoreId) {
  const root = formService.slugify(base) || 'formulario';
  let slug = root;
  for (let i = 2; i < 200; i++) {
    const found = await formsStore.getBySlug(slug);
    if (!found || found.id === ignoreId) return slug;
    slug = `${root}-${i}`;
  }
  return `${root}-${crypto.randomBytes(3).toString('hex')}`;
}

// clientId vazio = formulário da agência. Preenchido, o cliente precisa existir.
async function ensureClientExists(clientId) {
  if (!clientId) return;
  const account = await accountsStore.getById(clientId);
  if (!account) {
    const err = new Error('Cliente não encontrado.');
    err.status = 400;
    throw err;
  }
}

function sendFormError(res, err) {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message || 'Erro ao salvar o formulário.' });
}

// GET /api/forms — lista com os contadores (visitas, inícios, envios, qualificados)
router.get('/', async (req, res) => {
  try {
    const [forms, stats] = await Promise.all([formsStore.getAll(), formsStore.getStats()]);
    res.json(forms
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
      .map((f) => ({ ...forEditor(f), stats: stats[f.id] || { views: 0, starts: 0, completes: 0, qualified: 0 } })));
  } catch (err) {
    console.error(err); res.status(500).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  const form = await formsStore.getById(req.params.id);
  if (!form) return res.status(404).json({ error: 'Formulário não encontrado.' });
  const since = new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10);
  const [stats, daily] = await Promise.all([formsStore.getStats(), formsStore.getDailyStats(form.id, since)]);
  res.json({ ...forEditor(form), stats: stats[form.id] || { views: 0, starts: 0, completes: 0, qualified: 0 }, daily });
});

router.post('/', async (req, res) => {
  try {
    const now = new Date().toISOString();
    const form = formService.normalizeForm(req.body, { id: crypto.randomBytes(8).toString('hex'), createdAt: now });
    await ensureClientExists(form.clientId);
    form.slug = await uniqueSlug(req.body.slug || form.name);
    await formsStore.add(form);
    res.status(201).json(forEditor(form));
  } catch (err) {
    sendFormError(res, err);
  }
});

router.put('/:id', async (req, res) => {
  try {
    const existing = await formsStore.getById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Formulário não encontrado.' });
    const form = formService.normalizeForm(req.body, existing);
    if (form.clientId !== (existing.clientId || null)) await ensureClientExists(form.clientId);
    form.slug = req.body.slug && formService.slugify(req.body.slug) !== existing.slug
      ? await uniqueSlug(req.body.slug, existing.id)
      : existing.slug;
    // Publicar exige pelo menos uma pergunta.
    if (form.status === 'published' && !form.fields.some((f) => f.type !== 'statement')) {
      return res.status(400).json({ error: 'Adicione pelo menos uma pergunta antes de publicar.' });
    }
    await formsStore.save(form);
    res.json(forEditor(form));
  } catch (err) {
    sendFormError(res, err);
  }
});

router.post('/:id/duplicate', async (req, res) => {
  const existing = await formsStore.getById(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Formulário não encontrado.' });
  const now = new Date().toISOString();
  const copy = formService.normalizeForm({ ...existing, name: `${existing.name} (cópia)`, status: 'draft', tracking: { ...existing.tracking, capiToken: '__keep__' } },
    { id: crypto.randomBytes(8).toString('hex'), createdAt: now, tracking: existing.tracking });
  copy.slug = await uniqueSlug(existing.slug);
  await formsStore.add(copy);
  res.status(201).json(forEditor(copy));
});

router.delete('/:id', async (req, res) => {
  const ok = await formsStore.remove(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Formulário não encontrado.' });
  res.status(204).end();
});

// GET /api/forms/:id/responses[?format=csv]
router.get('/:id/responses', async (req, res) => {
  const form = await formsStore.getById(req.params.id);
  if (!form) return res.status(404).json({ error: 'Formulário não encontrado.' });
  const responses = await formsStore.getResponses(form.id);
  if (req.query.format !== 'csv') return res.json(responses);

  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`;
  const questions = form.fields.filter((f) => f.type !== 'statement');
  const head = ['Data', 'Qualificado', 'Pontuação', ...questions.map((q) => q.label), 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];
  const lines = [head.map(cell).join(';')];
  responses.forEach((r) => {
    const byId = Object.fromEntries((r.readable || []).map((x) => [x.fieldId, x.answer]));
    lines.push([
      new Date(r.createdAt).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }),
      r.result?.usesQualification ? (r.result.qualified ? 'Sim' : 'Não') : '',
      r.result?.score ?? '',
      ...questions.map((q) => byId[q.id] ?? ''),
      r.meta?.utm_source, r.meta?.utm_medium, r.meta?.utm_campaign, r.meta?.utm_content, r.meta?.utm_term,
    ].map(cell).join(';'));
  });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="respostas-${form.slug}.csv"`);
  res.send('﻿' + lines.join('\n'));
});

module.exports = router;
