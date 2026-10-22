const crypto = require('crypto');
const config = require('../config');
const accountsStore = require('../data/accountsStore');
const reportsStore = require('../data/reportsStore');
const metaService = require('./metaService');
const googleService = require('./googleService');
const { visibilityOf } = require('../lib/clientAccess');
const goalsLib = require('../lib/goals');
const adStatusLogStore = require('../data/adStatusLogStore');

/**
 * Relatórios automáticos: no dia agendado de cada cliente, monta a mensagem
 * pronta (no formato que a agência já usa no WhatsApp) com os números do
 * período, guarda na Central de Relatórios e — se houver e-mail configurado —
 * já envia por e-mail. O envio pelo WhatsApp é com 1 clique no painel.
 */

const TZ = 'America/Sao_Paulo';
const DASH_URL = process.env.DASH_URL || 'https://dash.instintodigital.com.br';
const MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

/* ---------- Datas no fuso de São Paulo ---------- */
function nowParts(date = new Date()) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23', weekday: 'short' });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  const wd = { Sun: 7, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[p.weekday];
  return { ymd: `${p.year}-${p.month}-${p.day}`, year: Number(p.year), month: Number(p.month), day: Number(p.day), hour: Number(p.hour), weekday: wd };
}
function addDays(ymd, n) {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const br = (ymd) => ymd.split('-').reverse().slice(0, 2).join('/');
const brFull = (ymd) => ymd.split('-').reverse().join('/');

const FREQS = new Set(['weekly', 'biweekly', 'monthly']);

function normalizeSchedule(input = {}) {
  const s = input || {};
  return {
    enabled: s.enabled === true,
    frequency: FREQS.has(s.frequency) ? s.frequency : 'weekly',
    weekday: Math.min(7, Math.max(1, Number(s.weekday) || 1)),          // 1 = segunda
    monthDay: Math.min(28, Math.max(1, Number(s.monthDay) || 1)),
    greetingName: String(s.greetingName || 'pessoal').trim().slice(0, 40) || 'pessoal',
    wish: ['todos', 'individual', 'esperamos'].includes(s.wish) ? s.wish : 'todos',
    whatsapp: String(s.whatsapp || '').replace(/\D/g, '').slice(0, 15),
    email: String(s.email || '').trim().slice(0, 160),
    includeLink: s.includeLink !== false,
  };
}

/**
 * Período do relatório que vence hoje (ou null se hoje não é dia).
 * Semanal/quinzenal: os 7/14 dias completos até ontem. Mensal: o mês anterior.
 */
function dueRange(schedule, today = nowParts()) {
  if (schedule.frequency === 'monthly') {
    if (today.day !== schedule.monthDay) return null;
    return previousMonthRange(today);
  }
  if (today.weekday !== schedule.weekday) return null;
  if (schedule.frequency === 'biweekly') {
    // Semanas pares do ano (conta a partir de uma segunda fixa).
    const weeks = Math.floor((Date.parse(`${today.ymd}T12:00:00Z`) - Date.parse('2024-01-01T12:00:00Z')) / (7 * 86400000));
    if (weeks % 2 !== 0) return null;
  }
  return lastDaysRange(schedule.frequency === 'biweekly' ? 14 : 7, today);
}
function lastDaysRange(days, today = nowParts()) {
  const to = addDays(today.ymd, -1);
  const from = addDays(to, -(days - 1));
  return { from, to, label: `dos últimos ${days} dias`, key: `${days}d:${from}:${to}` };
}
function previousMonthRange(today = nowParts()) {
  const y = today.month === 1 ? today.year - 1 : today.year;
  const m = today.month === 1 ? 12 : today.month - 1;
  const from = `${y}-${String(m).padStart(2, '0')}-01`;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const to = `${y}-${String(m).padStart(2, '0')}-${String(last).padStart(2, '0')}`;
  return { from, to, label: `do mês de ${MONTHS[m - 1]}`, key: `m:${from}:${to}` };
}

/* ---------- Mensagem ---------- */
const brl = (v) => (v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const int = (v) => Math.round(v || 0).toLocaleString('pt-BR');
const dec = (v) => (Math.round((v || 0) * 10) / 10).toLocaleString('pt-BR');
const pctOf = (c, p) => (p > 0 ? ((c - p) / p) * 100 : null);
const f1 = (v) => `${Math.abs(v).toFixed(1).replace('.', ',')}%`;

function resultKind(label) {
  const l = String(label || '').toLowerCase();
  if (l.includes('conversa')) return { kind: 'messages', plural: 'conversas iniciadas', one: 'conversa' };
  if (l.includes('lead') || l.includes('cadastro')) return { kind: 'leads', plural: 'leads', one: 'lead' };
  if (l.includes('compra')) return { kind: 'sales', plural: 'compras', one: 'compra' };
  return { kind: 'other', plural: 'resultados', one: 'resultado' };
}

function observation(meta, google) {
  const parts = [];
  let leadQuestion = false;
  if (meta && meta.totals.spend > 0) {
    const t = meta.totals, p = meta.previousTotals || {};
    const k = resultKind(meta.resultLabel);
    leadQuestion = k.kind === 'leads';
    const dRes = pctOf(t.results, p.results), dCost = pctOf(t.costPerResult, p.costPerResult);
    if (!t.results) {
      parts.push(`Nesse período não houve ${k.plural}, apesar do investimento. Vamos revisar o rastreamento (pixel e eventos) e os públicos para entender o motivo e corrigir o quanto antes.`);
    } else if (dCost !== null && dCost <= -5 && (dRes === null || dRes >= 0)) {
      parts.push(`Ótimo período: ${dRes !== null && dRes > 0 ? `${f1(dRes)} mais ${k.plural}` : `mais ${k.plural}`} e com custo por ${k.one} ${f1(dCost)} menor que no período anterior. Recomendamos manter o investimento atual e avaliar um aumento gradual nos conjuntos de melhor desempenho.`);
    } else if (dCost !== null && dCost >= 10) {
      parts.push(`O custo por ${k.one} subiu ${f1(dCost)} em relação ao período anterior. Vamos revisar públicos e criativos, renovar os anúncios com sinais de desgaste e concentrar o orçamento nos conjuntos mais eficientes.`);
    } else {
      parts.push(`Os resultados seguiram estáveis em relação ao período anterior. Seguimos acompanhando de perto e testando novos criativos para buscar um custo ainda melhor.`);
    }
    const best = (meta.ads || []).filter((a) => a.results > 0).sort((a, b) => b.results - a.results)[0];
    if (best && t.results > 3) parts.push(`O destaque foi o anúncio "${best.name}", com ${int(best.results)} ${k.plural} a ${brl(best.costPerResult)} cada.`);
    if (t.frequency > 3) parts.push('A frequência está alta, então o público já viu bastante os mesmos anúncios: vamos subir criativos novos para manter o desempenho.');
  }
  if (google && google.totals.spend > 0) {
    const t = google.totals, p = google.previousTotals || {};
    const dCost = pctOf(t.costPerConv, p.costPerConv);
    if (!t.conversions) parts.push('No Google, não houve conversões registradas no período; vamos conferir as palavras-chave e o acompanhamento de conversões.');
    else if (dCost !== null && dCost <= -5) parts.push(`No Google, o custo por conversão caiu ${f1(dCost)}, um ótimo sinal de eficiência.`);
    else if (dCost !== null && dCost >= 10) parts.push(`No Google, o custo por conversão subiu ${f1(dCost)}; vamos revisar as palavras-chave com custo alto e negativar buscas que não convertem.`);
  }
  if (leadQuestion) parts.push('Como está a qualidade dos leads que chegaram? Esse retorno nos ajuda a ajustar ainda mais a segmentação.');
  return parts.join(' ');
}

/* ---------- Otimizações do período (histórico de pausar/ativar do sistema) ---------- */
const LEVEL_TXT = { campaign: 'a campanha', adset: 'o conjunto', ad: 'o anúncio' };
const LEVEL_ANY = { campaign: 'uma campanha', adset: 'um conjunto', ad: 'um anúncio' };
const OPT_PLACEHOLDER = '[Otimizações: descreva aqui os ajustes feitos no período, ou apague esta parte]';

async function optimizationsFor(account, range) {
  let log = [];
  try { log = await adStatusLogStore.list(account.id, 200); } catch (e) { return null; }
  return log
    .filter((e) => e.result === 'ok' && ['PAUSED', 'ACTIVE'].includes(e.requested))
    .map((e) => ({ ...e, day: nowParts(new Date(e.at)).ymd }))
    .filter((e) => e.day >= range.from && e.day <= range.to)
    .sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

function optimizationLines(entries) {
  if (!entries || !entries.length) return [OPT_PLACEHOLDER];
  const MAX = 8;
  const lines = entries.slice(0, MAX).map((e) => {
    const verb = e.requested === 'PAUSED' ? 'pausamos' : 'ativamos';
    const what = e.name ? `${LEVEL_TXT[e.level] || 'o item'} "${e.name}"` : (LEVEL_ANY[e.level] || 'um item');
    return `• ${br(e.day)}: ${verb} ${what}`;
  });
  if (entries.length > MAX) lines.push(`• e mais ${entries.length - MAX} ${entries.length - MAX === 1 ? 'ajuste' : 'ajustes'} no período`);
  return lines;
}

// Linhas de metas (só se o cliente puder ver as metas no painel).
function goalLines(lines, account, platform, actual, range, one) {
  if (!visibilityOf(account).ads_goals) return;
  const ev = goalsLib.evaluate((account.goals || {})[platform], actual, range);
  if (!ev) return;
  const icon = (st) => (st === 'good' ? '✅' : st === 'warn' ? '🟡' : '🔴');
  ev.items.forEach((g) => {
    if (g.key === 'budget') lines.push(`${icon(g.status)} Meta de investimento: ${brl(g.actual)} de ${brl(g.target)} (${Math.round(g.pct)}%)`);
    if (g.key === 'cpr') lines.push(`${icon(g.status)} Custo por ${one}: ${brl(g.actual)} (meta até ${brl(g.target)})`);
    if (g.key === 'results') lines.push(`${icon(g.status)} Meta de resultados: ${int(g.actual)} de ${int(g.target)} (${Math.round(g.pct)}%)`);
    if (g.key === 'roas') lines.push(`${icon(g.status)} ROAS: ${g.actual.toFixed(2).replace('.', ',')}x (meta ${g.target.toFixed(1).replace('.', ',')}x)`);
  });
}

function buildMessage({ account, schedule, range, meta, google, optimizations, weekly = false }) {
  const wish = { todos: 'Espero que estejam todos bem!', individual: 'Espero que esteja tudo certo por aí!', esperamos: 'Esperamos que estejam todos bem!' }[schedule.wish];
  const lines = [
    `Bom dia, ${schedule.greetingName}! Tudo bem?`,
    wish,
    weekly
      ? `Segue o feedback ${range.label} das campanhas, de ${brFull(range.from)} a ${brFull(range.to)}.`
      : `Segue o feedback ${range.label} das campanhas (${br(range.from)} a ${br(range.to)}).`,
  ];
  if (meta && meta.totals.spend > 0) {
    const t = meta.totals;
    const k = resultKind(meta.resultLabel);
    const label = k.plural.charAt(0).toUpperCase() + k.plural.slice(1);
    lines.push('', google && google.totals.spend > 0 ? '📊 *Meta Ads*' : '📊 *Resultados*');
    lines.push(`• Investimento: ${brl(t.spend)}`);
    lines.push(`• Alcance: ${int(t.reach)}`);
    lines.push(`• ${label}: ${int(t.results)}`);
    if (t.results) lines.push(`• Custo por ${k.one}: ${brl(t.costPerResult)}`);
    if (t.purchases > 0) {
      lines.push(`• Compras: ${int(t.purchases)} · Faturamento: ${brl(t.purchaseValue)}`);
      if (t.roas) lines.push(`• ROAS: ${t.roas.toFixed(2).replace('.', ',')}x · Ticket médio: ${brl(t.avgTicket)}`);
    }
    goalLines(lines, account, 'meta', { spend: t.spend, results: t.results, costPerResult: t.costPerResult, roas: t.roas }, range, k.one);
  }
  if (google && google.totals.spend > 0) {
    const t = google.totals;
    lines.push('', meta && meta.totals.spend > 0 ? '📊 *Google Ads*' : '📊 *Resultados*');
    lines.push(`• Investimento: ${brl(t.spend)}`);
    lines.push(`• Cliques: ${int(t.clicks)}`);
    lines.push(`• Conversões: ${dec(t.conversions)}`);
    if (t.conversions) lines.push(`• Custo por conversão: ${brl(t.costPerConv)}`);
    goalLines(lines, account, 'google', { spend: t.spend, results: t.conversions, costPerResult: t.costPerConv, roas: t.roas || 0 }, range, 'conversão');
  }
  if (!(meta && meta.totals.spend > 0) && !(google && google.totals.spend > 0)) {
    lines.push('', 'Neste período as campanhas não tiveram investimento.');
  } else {
    lines.push('', observation(meta, google));
  }
  if (weekly) {
    lines.push('', `🔧 *Otimizações ${range.label.startsWith('dos últimos 7') ? 'da semana' : 'do período'}*`, ...optimizationLines(optimizations));
  }
  if ((schedule.includeLink || weekly) && account.shareToken) {
    lines.push('', `📈 Painel completo (com PDF): ${DASH_URL}/?share=${account.shareToken}`);
  }
  const text = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  // Sem travessão (—) no texto que vai pro cliente.
  return weekly ? text.replace(/\s*—\s*/g, ' - ') : text;
}

/* ---------- E-mail (opcional, via SMTP) ---------- */
function smtpConfigured() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}
async function sendEmail(to, subject, text, account) {
  if (!smtpConfigured() || !to) return { sent: false };
  let nodemailer;
  try { nodemailer = require('nodemailer'); } catch (e) { return { sent: false, error: 'nodemailer não instalado' }; }
  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 465,
    secure: (Number(process.env.SMTP_PORT) || 465) === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
  const html = `<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;color:#151B2E">
    <div style="background:#1A0C06;color:#fff;padding:22px 24px;border-radius:14px 14px 0 0">
      <div style="font-size:12px;letter-spacing:3px;color:#FFB020;font-weight:bold">INSTINTO DIGITAL</div>
      <div style="font-size:22px;font-weight:bold;margin-top:6px">Relatório de resultados · ${esc(account.name)}</div>
    </div>
    <div style="border:1px solid #E6E9F2;border-top:none;padding:22px 24px;border-radius:0 0 14px 14px;line-height:1.6;font-size:14px">
      ${esc(text).replace(/\*([^*]+)\*/g, '<b>$1</b>').replace(/\n/g, '<br>').replace(/(https?:\/\/\S+)/g, '<a href="$1" style="color:#FF5A1E">$1</a>')}
    </div>
    <div style="font-size:11px;color:#8A93A6;text-align:center;margin-top:12px">Enviado automaticamente pelo Sistema Instinto Digital</div>
  </div>`;
  try {
    await transport.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to, subject, text: text.replace(/\*/g, ''), html });
    return { sent: true };
  } catch (e) {
    console.warn('E-mail do relatório falhou:', e.message);
    return { sent: false, error: e.message };
  }
}

/* ---------- Geração ---------- */
async function generateFor(account, range, { sendMail = true, weekly = false } = {}) {
  const schedule = normalizeSchedule(account.reportSchedule);
  const vis = visibilityOf(account);
  const mOn = account.meta?.status === 'connected' && vis.ads && vis.ads_meta;
  const gOn = account.google?.status === 'connected' && vis.ads && vis.ads_google;
  const model = account.dashboardModel || 'auto';
  const wantMeta = mOn && model !== 'google';
  const wantGoogle = gOn && model !== 'meta';
  const r = { from: range.from, to: range.to };
  const [meta, google] = await Promise.all([
    wantMeta ? metaService.getAccountReport(account.meta.adAccountId, r).catch((e) => ({ error: e.message })) : null,
    wantGoogle ? googleService.getAccountReport(account.google.customerId, r).catch((e) => ({ error: e.message })) : null,
  ]);
  const errors = [meta?.error && `Meta: ${meta.error}`, google?.error && `Google: ${google.error}`].filter(Boolean);
  const m = meta && !meta.error ? meta : null;
  const g = google && !google.error ? google : null;
  const optimizations = weekly ? await optimizationsFor(account, range) : null;
  const message = buildMessage({ account, schedule, range, meta: m, google: g, optimizations, weekly });
  const summary = {
    meta: m ? { spend: m.totals.spend, results: m.totals.results, costPerResult: m.totals.costPerResult, resultLabel: m.resultLabel,
      prevResults: m.previousTotals?.results, prevCost: m.previousTotals?.costPerResult } : null,
    google: g ? { spend: g.totals.spend, conversions: g.totals.conversions, costPerConv: g.totals.costPerConv,
      prevConversions: g.previousTotals?.conversions, prevCost: g.previousTotals?.costPerConv } : null,
  };
  const report = {
    id: crypto.randomBytes(8).toString('hex'),
    clientId: account.id,
    clientName: account.name,
    periodKey: range.key,
    range: { from: range.from, to: range.to, label: range.label },
    createdAt: new Date().toISOString(),
    message,
    summary,
    errors,
    whatsapp: schedule.whatsapp,
    email: schedule.email,
    status: 'pending',
    emailStatus: null,
    ...(weekly ? { kind: 'weekly', optimizationsCount: optimizations ? optimizations.length : 0 } : {}),
  };
  if (sendMail && schedule.email) {
    const res = await sendEmail(schedule.email, `Relatório ${range.label} · ${account.name}`, message, account);
    report.emailStatus = res.sent ? 'sent' : (smtpConfigured() ? `erro: ${res.error || 'falha'}` : 'smtp-nao-configurado');
    if (res.sent) report.emailSentAt = new Date().toISOString();
  }
  await reportsStore.upsert(report);
  return report;
}

// Roda de hora em hora: gera o que venceu hoje e ainda não foi gerado.
async function runDue() {
  const today = nowParts();
  if (today.hour < 7) return [];
  const accounts = await accountsStore.getAll();
  const out = [];
  for (const account of accounts) {
    if (account.status === 'inativo') continue;
    const schedule = normalizeSchedule(account.reportSchedule);
    if (!schedule.enabled) continue;
    const range = dueRange(schedule, today);
    if (!range) continue;
    if (await reportsStore.exists(account.id, range.key)) continue;
    try {
      out.push(await generateFor(account, range));
    } catch (e) {
      console.error(`Relatório automático de ${account.name} falhou:`, e.message);
    }
  }
  return out;
}

function nextRunDate(schedule, from = nowParts()) {
  const s = normalizeSchedule(schedule);
  if (!s.enabled) return null;
  for (let i = 0; i < 70; i++) {
    const ymd = addDays(from.ymd, i);
    const d = new Date(`${ymd}T12:00:00Z`);
    const parts = { ymd, year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), weekday: ((d.getUTCDay() + 6) % 7) + 1, hour: 12 };
    if (dueRange(s, parts)) return ymd;
  }
  return null;
}

module.exports = {
  normalizeSchedule, dueRange, lastDaysRange, previousMonthRange, generateFor, runDue, nextRunDate, smtpConfigured, nowParts, buildMessage,
};
