/**
 * Leads de formulário instantâneo da Meta (Instant Form).
 *
 * O webhook da Página manda leadgen_id, ad_id e adgroup_id. O nome e o
 * telefone vêm de uma leitura do lead (uma chamada, guardada por 24 h).
 * A Página precisa ser a mesma cadastrada em Integrações (meta.pageId),
 * senão o lead não entra no CRM de outro cliente.
 */

const cache = require('../lib/cache');
const accountsStore = require('../data/accountsStore');
const metaService = require('./metaService');
const crm = require('./crmService');

const LEAD_TTL = 24 * 60 * 60;

async function accountForPage(pageId) {
  const id = String(pageId || '').trim();
  if (!id) return null;
  const accounts = await accountsStore.getAll();
  return accounts.find((a) => String((a.meta && a.meta.pageId) || '') === id) || null;
}

async function fetchLead(leadId) {
  const id = String(leadId || '').trim();
  if (!id || !metaService.hasRealCredentials()) return null;
  const key = `meta:lead:${id}`;
  const hit = cache.get(key);
  if (hit) return hit.miss ? null : hit;
  const fields = [
    'created_time,id,ad_id,adset_id,campaign_id,campaign_name,adset_name,ad_name,form_id,field_data,platform',
    'created_time,id,ad_id,adset_id,campaign_id,form_id,field_data',
  ];
  for (const field of fields) {
    try {
      const json = await metaService.graphGet(id, { fields: field });
      if (json && json.id) {
        cache.set(key, json, LEAD_TTL);
        return json;
      }
    } catch (e) {
      console.warn('Instant Form: leitura do lead falhou:', e.message);
    }
  }
  cache.set(key, { miss: true }, 15 * 60);
  return null;
}

function leadFromWebhook(value, fetched) {
  const base = fetched && typeof fetched === 'object' ? { ...fetched } : {};
  base.id = base.id || value.leadgen_id || value.lead_id || null;
  base.ad_id = base.ad_id || value.ad_id || null;
  base.adset_id = base.adset_id || value.adgroup_id || null;
  base.form_id = base.form_id || value.form_id || null;
  base.created_time = base.created_time || value.created_time || null;
  if (Array.isArray(value.field_data) && !Array.isArray(base.field_data)) base.field_data = value.field_data;
  return base;
}

async function ingestValue(value) {
  if (!value || typeof value !== 'object') return { ignored: true };
  const account = await accountForPage(value.page_id);
  if (!account) return { ignored: true };
  let fetched = null;
  if (value.lead && typeof value.lead === 'object') fetched = value.lead;
  else if (value.leadgen_id || value.lead_id) fetched = await fetchLead(value.leadgen_id || value.lead_id);
  const lead = leadFromWebhook(value, fetched);
  if (!lead.id && !lead.ad_id && !(Array.isArray(lead.field_data) && lead.field_data.length)) return { ignored: true };
  const deal = await crm.addFromInstantForm(account.id, lead);
  return { created: true, clientId: account.id, dealId: deal && deal.id };
}

async function handleWebhook(body) {
  const result = { created: 0, ignored: 0 };
  if (!body || body.object !== 'page' || !Array.isArray(body.entry)) return result;
  for (const entry of body.entry) {
    for (const change of entry.changes || []) {
      if (!change || change.field !== 'leadgen') continue;
      const r = await ingestValue(change.value || {});
      if (r.created) result.created += 1;
      else result.ignored += 1;
    }
  }
  return result;
}

module.exports = { handleWebhook, ingestValue, fetchLead, accountForPage, leadFromWebhook };
