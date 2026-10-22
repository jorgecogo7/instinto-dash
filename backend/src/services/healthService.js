/**
 * Saúde das contas: confere todas as contas conectadas e gera alertas de
 *  - saldo pré-pago (Pix) acabando — e quanto falta pra cobrir 7 dias;
 *  - conta bloqueada / pagamento recusado (cartão) / limite de gastos atingido;
 *  - anúncios reprovados ou com problema em campanhas ativas;
 *  - conta sem veicular há dias.
 * Roda sozinho de tempos em tempos (server.js) e também sob demanda.
 */
const accountsStore = require('../data/accountsStore');
const healthStore = require('../data/healthStore');
const metaService = require('./metaService');
const googleService = require('./googleService');

const COVER_DAYS = 7;        // saldo deve cobrir pelo menos 7 dias
const CRITICAL_DAYS = 2;     // até 2 dias de saldo = crítico
const WARNING_DAYS = 5;      // até 5 dias = atenção

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const brl = (v) => (v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

// Datas no fuso de São Paulo (UTC-3).
function spDate(offsetDays = 0) {
  return new Date(Date.now() - 3 * 3600e3 - offsetDays * 864e5).toISOString().slice(0, 10);
}

// "Saldo disponível (R$ 1.234,56 BRL)" / "Available balance (R$1,234.56 BRL)" → 1234.56
function parseMoney(str) {
  if (!str) return null;
  const m = String(str).match(/(-?\d[\d.,]*)\s*(?:BRL|\))/) || String(str).match(/R\$\s*(-?\d[\d.,]*)/);
  if (!m) return null;
  let s = m[1];
  const lastComma = s.lastIndexOf(','), lastDot = s.lastIndexOf('.');
  if (lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(/,/g, '');
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

// Dias seguidos sem gasto, contando de ontem pra trás (hoje ainda está em andamento).
function zeroStreak(byDate) {
  if (num(byDate[spDate(0)]) > 0) return { days: 0, lastSpend: spDate(0) };
  let days = 0, lastSpend = null;
  for (let i = 1; i <= 14; i++) {
    const d = spDate(i);
    if (num(byDate[d]) > 0) { lastSpend = d; break; }
    days++;
  }
  return { days, lastSpend };
}

function avgDaily(byDate, fallback) {
  const vals = [];
  for (let i = 1; i <= 7; i++) { const v = num(byDate[spDate(i)]); if (v > 0) vals.push(v); }
  if (vals.length) return vals.reduce((a, b) => a + b, 0) / vals.length;
  return num(fallback) || 0;
}

function alert(platform, type, severity, title, detail, extra = {}) {
  return { id: `${platform}:${type}`, platform, type, severity, title, detail, ...extra };
}

/* ---------- Saldo pré-pago ---------- */
function balanceAlerts(platform, balance, daily, manual) {
  if (balance == null) return [];
  const src = manual ? ' (saldo informado manualmente no cadastro)' : '';
  if (balance <= 0.5) {
    return [alert(platform, 'balance', 'critical', 'Saldo zerado', `A conta está sem saldo${src}. Os anúncios param de rodar até uma nova recarga.${daily ? ` Para cobrir ${COVER_DAYS} dias, recarregue ${brl(Math.ceil(daily * COVER_DAYS / 10) * 10)}.` : ''}`, { balance, daily, shortfall: daily ? Math.ceil(daily * COVER_DAYS / 10) * 10 : null })];
  }
  if (!daily) return [];
  const days = balance / daily;
  if (days > WARNING_DAYS) return [];
  const shortfall = Math.max(0, Math.ceil((daily * COVER_DAYS - balance) / 10) * 10);
  const sev = days <= CRITICAL_DAYS ? 'critical' : 'warning';
  const left = days < 1 ? 'menos de 1 dia' : `~${Math.floor(days)} ${Math.floor(days) === 1 ? 'dia' : 'dias'}`;
  return [alert(platform, 'balance', sev, `Saldo acabando — faltam ${brl(shortfall)}`,
    `Saldo de ${brl(balance)} dá para ${left} no ritmo atual (${brl(daily)}/dia). Faltam ${brl(shortfall)} para cobrir ${COVER_DAYS} dias${src}.`,
    { balance, daily, daysLeft: days, shortfall })];
}

/* ---------- Meta ---------- */
const META_STATUS = {
  2: ['critical', 'Conta de anúncios desativada', 'A Meta desativou a conta — nenhum anúncio está rodando.'],
  3: ['critical', 'Pagamento recusado — conta parada', 'A Meta não conseguiu cobrar (cartão recusado ou saldo pendente). Os anúncios estão parados até o pagamento ser regularizado em Configurações de pagamento.'],
  7: ['warning', 'Conta em análise de risco', 'A Meta está analisando a conta; a veiculação pode ficar limitada.'],
  8: ['critical', 'Pagamento pendente', 'Há um pagamento pendente de quitação; a conta pode parar a qualquer momento.'],
  9: ['warning', 'Pagamento falhou — período de carência', 'A última cobrança falhou. A conta ainda roda por pouco tempo; atualize a forma de pagamento.'],
  100: ['critical', 'Conta em encerramento', 'A conta está com encerramento pendente.'],
  101: ['critical', 'Conta encerrada', 'A conta de anúncios foi encerrada.'],
};
const DISABLE_REASONS = {
  1: 'violação das políticas de anúncios', 2: 'revisão de propriedade intelectual', 3: 'problema de pagamento (risco)',
  4: 'conta encerrada', 5: 'revisão de anúncios', 6: 'integridade do negócio', 7: 'encerramento permanente',
};

async function checkMeta(account) {
  const act = metaService.normalizeAdAccountId(account.meta.adAccountId);
  if (!act) return { alerts: [] };
  const out = { alerts: [], info: {} };
  const baseFields = 'name,account_status,disable_reason,is_prepay_account,spend_cap,amount_spent,currency';
  let acc;
  try { acc = await metaService.graphGet(act, { fields: `${baseFields},funding_source_details` }); }
  catch (e) { acc = await metaService.graphGet(act, { fields: baseFields }); }

  const [daily, campaigns, badAds] = await Promise.all([
    metaService.graphGetAll(`${act}/insights`, {
      time_range: JSON.stringify({ since: spDate(14), until: spDate(0) }), time_increment: '1', fields: 'spend', limit: '50',
    }).catch(() => []),
    metaService.graphGetAll(`${act}/campaigns`, { fields: 'id', effective_status: '["ACTIVE"]', limit: '100' }, 2).catch(() => null),
    metaService.graphGetAll(`${act}/ads`, {
      fields: 'name,effective_status,ad_review_feedback,campaign{name,effective_status},adset{effective_status}',
      effective_status: '["DISAPPROVED","WITH_ISSUES"]', limit: '100',
    }, 2).catch(() => []),
  ]);

  const byDate = {};
  daily.forEach((r) => { byDate[r.date_start] = num(r.spend); });
  const avg = avgDaily(byDate, account.dailyBudget);
  const streak = zeroStreak(byDate);
  out.info = { daily: avg, lastSpend: streak.lastSpend, activeCampaigns: campaigns ? campaigns.length : null, accountStatus: acc.account_status };

  // Status da conta / pagamento
  const st = META_STATUS[acc.account_status];
  if (st) {
    const reason = acc.account_status === 2 && DISABLE_REASONS[acc.disable_reason] ? ` Motivo: ${DISABLE_REASONS[acc.disable_reason]}.` : '';
    out.alerts.push(alert('meta', 'status', st[0], st[1], st[2] + reason));
  }

  // Saldo pré-pago (Pix/boleto): primeiro o que a Meta informa; se não vier, o do cadastro.
  const isPrepay = acc.is_prepay_account === true || account.payment === 'pix';
  if (isPrepay) {
    const fromMeta = parseMoney(acc.funding_source_details && acc.funding_source_details.display_string);
    const manual = fromMeta == null && account.pixBalance != null;
    const balance = fromMeta != null ? fromMeta : (account.pixBalance != null ? num(account.pixBalance) : null);
    out.info.balance = balance;
    out.info.balanceSource = fromMeta != null ? 'meta' : manual ? 'manual' : null;
    out.alerts.push(...balanceAlerts('meta', balance, avg, manual));
  }

  // Limite de gastos da conta (spend_cap, em centavos)
  const cap = num(acc.spend_cap) / 100, spent = num(acc.amount_spent) / 100;
  if (cap > 0) {
    const left = cap - spent;
    out.info.spendCapLeft = left;
    if (left <= 1) out.alerts.push(alert('meta', 'spendcap', 'critical', 'Limite de gastos da conta atingido', `A conta bateu o limite de gastos de ${brl(cap)} e parou de veicular. Aumente ou remova o limite em Configurações de pagamento.`));
    else if (avg && left < avg * 3) out.alerts.push(alert('meta', 'spendcap', 'warning', 'Limite de gastos quase no fim', `Restam ${brl(left)} até o limite de gastos da conta (${brl(cap)}) — cerca de ${Math.max(1, Math.floor(left / avg))} dia(s) no ritmo atual.`));
  }

  // Anúncios reprovados / com problema em campanhas ativas
  const live = badAds.filter((a) => (a.campaign?.effective_status || 'ACTIVE') === 'ACTIVE' && !['PAUSED', 'CAMPAIGN_PAUSED'].includes(a.adset?.effective_status));
  if (live.length) {
    const reasons = live.map((a) => {
      const fb = a.ad_review_feedback || {};
      const g = fb.global || fb.placement_specific || {};
      return Object.keys(g)[0] || null;
    }).filter(Boolean);
    const names = live.slice(0, 3).map((a) => `"${a.name}"`).join(', ');
    const disapproved = live.filter((a) => a.effective_status === 'DISAPPROVED').length;
    out.alerts.push(alert('meta', 'rejected', streak.days >= 1 || disapproved === live.length ? 'critical' : 'warning',
      disapproved ? `${disapproved} ${disapproved === 1 ? 'anúncio reprovado' : 'anúncios reprovados'}` : `${live.length} ${live.length === 1 ? 'anúncio com problema' : 'anúncios com problema'}`,
      `Em campanhas ativas: ${names}${live.length > 3 ? ` e mais ${live.length - 3}` : ''}.${reasons.length ? ` Motivo apontado pela Meta: ${reasons[0].replace(/_/g, ' ').toLowerCase()}.` : ''} Revise e edite/solicite nova análise no Gerenciador.`,
      { count: live.length, ads: live.slice(0, 10).map((a) => ({ name: a.name, status: a.effective_status })) }));
  }

  // Sem veicular
  out.alerts.push(...deliveryAlerts('meta', account, streak, campaigns ? campaigns.length : null, out.alerts));
  return out;
}

function deliveryAlerts(platform, account, streak, activeCampaigns, others) {
  if (account.status === 'pausado' || account.status === 'inativo') return [];
  const why = others.some((a) => a.type === 'rejected') ? ' Provável causa: anúncios reprovados.'
    : others.some((a) => a.type === 'status' || a.type === 'billing') ? ' Provável causa: pagamento/status da conta.'
    : others.some((a) => a.type === 'balance' && a.severity === 'critical') ? ' Provável causa: saldo.'
    : others.some((a) => a.type === 'spendcap') ? ' Provável causa: limite de gastos.' : '';
  if (activeCampaigns === 0) {
    return [alert(platform, 'nocampaign', 'warning', 'Nenhuma campanha ativa', `O cliente está como ativo, mas não há campanha ativa nesta conta${streak.lastSpend ? ` (último gasto em ${streak.lastSpend.split('-').reverse().join('/')})` : ''}.`)];
  }
  if (streak.days >= 1) {
    const d = streak.days >= 14 ? 'mais de 14 dias' : `${streak.days} ${streak.days === 1 ? 'dia' : 'dias'}`;
    return [alert(platform, 'nodelivery', streak.days >= 2 ? 'critical' : 'warning', `Sem veicular há ${d}`,
      `Nenhum gasto ${streak.days === 1 ? 'ontem nem hoje' : `desde ${streak.lastSpend ? streak.lastSpend.split('-').reverse().join('/') : 'há mais de 14 dias'}`}, mesmo com campanhas ativas.${why || ' Confira entrega, orçamento e pagamento.'}`,
      { days: streak.days })];
  }
  return [];
}

/* ---------- Google ---------- */
async function checkGoogle(account) {
  const cid = String(account.google.customerId || '').replace(/-/g, '');
  if (!cid) return { alerts: [] };
  const token = await googleService.getAccessToken();
  const q = (query, label) => googleService.runGAQL(cid, query, token, label);
  const [cust, days, camps, bad] = await Promise.all([
    q('SELECT customer.status, customer.descriptive_name FROM customer', 'status').catch(() => []),
    q('SELECT segments.date, metrics.cost_micros FROM customer WHERE segments.date DURING LAST_14_DAYS', 'gasto diário').catch(() => []),
    q("SELECT campaign.id FROM campaign WHERE campaign.status = 'ENABLED' AND campaign.serving_status != 'ENDED'", 'campanhas').catch(() => null),
    q(`SELECT ad_group_ad.ad.id, ad_group_ad.ad.name, campaign.name, ad_group_ad.policy_summary.approval_status
       FROM ad_group_ad
       WHERE ad_group_ad.policy_summary.approval_status = 'DISAPPROVED'
         AND ad_group_ad.status = 'ENABLED' AND ad_group.status = 'ENABLED' AND campaign.status = 'ENABLED'
       LIMIT 50`, 'reprovados').catch(() => []),
  ]);
  const out = { alerts: [], info: {} };
  const status = cust[0]?.customer?.status;
  if (status && status !== 'ENABLED') {
    out.alerts.push(alert('google', 'status', 'critical', status === 'SUSPENDED' ? 'Conta Google Ads suspensa' : 'Conta Google Ads inativa',
      status === 'SUSPENDED' ? 'O Google suspendeu a conta (política ou pagamento). Veja o aviso no topo do Google Ads.' : `Status da conta: ${status}.`));
  }
  const byDate = {};
  days.forEach((r) => { byDate[r.segments.date] = num(r.metrics.costMicros) / 1e6; });
  const avg = avgDaily(byDate, null);
  const streak = zeroStreak(byDate);
  out.info = { daily: avg, lastSpend: streak.lastSpend, activeCampaigns: camps ? camps.length : null };
  if (bad.length) {
    const names = bad.slice(0, 3).map((r) => `"${r.adGroupAd?.ad?.name || r.campaign?.name}"`).join(', ');
    out.alerts.push(alert('google', 'rejected', streak.days >= 1 ? 'critical' : 'warning',
      `${bad.length} ${bad.length === 1 ? 'anúncio reprovado' : 'anúncios reprovados'}`,
      `Em campanhas ativas: ${names}${bad.length > 3 ? ` e mais ${bad.length - 3}` : ''}. Veja o motivo em Anúncios → Status e corrija ou recorra.`, { count: bad.length }));
  }
  const dl = deliveryAlerts('google', account, streak, camps ? camps.length : null, out.alerts);
  dl.forEach((a) => { if (a.type === 'nodelivery' && !a.detail.includes('Provável')) a.detail = a.detail.replace('Confira entrega, orçamento e pagamento.', 'Confira o faturamento (cartão recusado costuma ser o motivo) e o status das campanhas.'); });
  out.alerts.push(...dl);
  return out;
}

/* ---------- Dados de exemplo (sem credenciais) ---------- */
function mockCheck(account, idx) {
  const out = { alerts: [], info: {} };
  if (account.meta?.status === 'connected') {
    if (idx % 3 === 0) {
      out.alerts.push(alert('meta', 'rejected', 'critical', '2 anúncios reprovados', 'Em campanhas ativas: "video_depoimento_cliente", "carrossel_servicos". Motivo apontado pela Meta: personal attributes. Revise e edite/solicite nova análise no Gerenciador.', { count: 2 }));
      out.alerts.push(alert('meta', 'nodelivery', 'critical', 'Sem veicular há 7 dias', `Nenhum gasto desde ${spDate(8).split('-').reverse().join('/')}, mesmo com campanhas ativas. Provável causa: anúncios reprovados.`, { days: 7 }));
    } else if (idx % 3 === 1) {
      out.alerts.push(...balanceAlerts('meta', 60, 80, false));
    }
  }
  if (account.google?.status === 'connected' && idx % 3 === 2) {
    out.alerts.push(alert('google', 'nodelivery', 'critical', 'Sem veicular há 3 dias', `Nenhum gasto desde ${spDate(4).split('-').reverse().join('/')}, mesmo com campanhas ativas. Confira o faturamento (cartão recusado costuma ser o motivo) e o status das campanhas.`, { days: 3 }));
  }
  if (account.meta?.status === 'connected' && idx % 3 === 1) {
    out.alerts.push(alert('meta', 'status', 'critical', 'Pagamento recusado — conta parada', META_STATUS[3][2]));
  }
  return out;
}

/* ---------- Execução ---------- */
const SEV_ORDER = { critical: 0, warning: 1, info: 2 };

async function checkAccount(account, idx = 0, previous = null) {
  const now = new Date().toISOString();
  const record = { clientId: account.id, name: account.name, checkedAt: now, alerts: [], errors: [], meta: null, google: null, snoozed: previous?.snoozed || {} };
  const realMeta = metaService.hasRealCredentials(), realGoogle = googleService.hasRealCredentials();
  if (!realMeta && !realGoogle) {
    const m = mockCheck(account, idx);
    record.alerts = m.alerts; record.mock = true;
  } else {
    if (account.meta?.status === 'connected' && account.meta.adAccountId && realMeta) {
      try { const r = await checkMeta(account); record.alerts.push(...r.alerts); record.meta = r.info; }
      catch (e) { record.errors.push({ platform: 'meta', message: e.message }); }
    }
    if (account.google?.status === 'connected' && account.google.customerId && realGoogle) {
      try { const r = await checkGoogle(account); record.alerts.push(...r.alerts); record.google = r.info; }
      catch (e) { record.errors.push({ platform: 'google', message: e.message }); }
    }
  }
  // "desde quando" cada alerta está aberto
  const prevById = {};
  (previous?.alerts || []).forEach((a) => { prevById[a.id] = a; });
  record.alerts.forEach((a) => { a.since = prevById[a.id]?.since || now; a.isNew = !prevById[a.id]; });
  record.alerts.sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity]);
  // limpa silenciamentos vencidos ou de alertas que já sumiram
  Object.keys(record.snoozed).forEach((k) => {
    if (new Date(record.snoozed[k]) < new Date() || !record.alerts.some((a) => a.id === k)) delete record.snoozed[k];
  });
  return record;
}

function shouldCheck(account) {
  if (account.status === 'inativo') return false;
  return account.meta?.status === 'connected' || account.google?.status === 'connected';
}

let running = null;
async function runAll({ clientId } = {}) {
  if (running && !clientId) return running;
  const job = (async () => {
    const accounts = (await accountsStore.getAll()).filter((a) => (clientId ? a.id === clientId : true));
    const prev = {};
    (await healthStore.getAll()).forEach((r) => { prev[r.clientId] = r; });
    const results = [];
    let i = 0;
    for (const account of accounts) {
      if (!shouldCheck(account)) { if (prev[account.id]) await healthStore.remove(account.id); continue; }
      const rec = await checkAccount(account, i++, prev[account.id]);
      await healthStore.save(rec);
      results.push(rec);
    }
    const fresh = results.flatMap((r) => r.alerts.filter((a) => a.isNew && a.severity === 'critical').map((a) => ({ client: r.name, ...a })));
    if (fresh.length) {
      console.log(`Alertas novos: ${fresh.map((a) => `${a.client} — ${a.title}`).join(' | ')}`);
      notifyEmail(fresh).catch(() => {});
    }
    return results;
  })();
  if (!clientId) running = job.finally(() => { running = null; });
  return job;
}

async function list() {
  const accounts = await accountsStore.getAll();
  const alive = new Set(accounts.filter(shouldCheck).map((a) => a.id));
  return (await healthStore.getAll()).filter((r) => alive.has(r.clientId));
}

async function snooze(clientId, alertId, hours) {
  const rec = await healthStore.get(clientId);
  if (!rec) return null;
  rec.snoozed = rec.snoozed || {};
  if (hours > 0) rec.snoozed[alertId] = new Date(Date.now() + hours * 3600e3).toISOString();
  else delete rec.snoozed[alertId];
  return healthStore.save(rec);
}

/* ---------- Aviso por e-mail (só se o SMTP estiver configurado) ---------- */
async function notifyEmail(fresh) {
  const to = process.env.ALERT_EMAIL;
  if (!to || !process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) return;
  const nodemailer = require('nodemailer');
  const port = Number(process.env.SMTP_PORT) || 465;
  const t = nodemailer.createTransport({ host: process.env.SMTP_HOST, port, secure: port === 465, auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } });
  const text = fresh.map((a) => `• ${a.client} (${a.platform === 'meta' ? 'Meta' : 'Google'}): ${a.title}\n  ${a.detail}`).join('\n\n');
  await t.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to, subject: `⚠ ${fresh.length} alerta(s) nas contas · Sistema Instinto Digital`, text: `${text}\n\nVer tudo: https://dash.instintodigital.com.br/` });
}

module.exports = { runAll, list, snooze, checkAccount, parseMoney, balanceAlerts };
