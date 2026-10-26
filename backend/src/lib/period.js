// Datas de relatório compartilhadas pelo Meta Ads e pelo Instagram:
// período pedido (from/to em AAAA-MM-DD), período anterior equivalente
// e variação percentual. O padrão "últimos N dias" é o mesmo do painel
// e do googleService: N dias calendário completos, terminando ontem.

const TZ = 'America/Sao_Paulo';

function toISODate(d) {
  return d.toISOString().slice(0, 10);
}

// Dia calendário em America/Sao_Paulo (AAAA-MM-DD), independente do fuso do servidor.
function todaySP(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(date);
}

function addCalendarDays(iso, n) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Últimos N dias calendário completos: de (hoje - N) até ontem, inclusive.
// Hoje fica de fora — o dia ainda não fechou. Ex.: hoje 2026-10-26 e N=7
// → 2026-10-19 a 2026-10-25. `now` só existe para teste.
function defaultRange(days = 30, now = new Date()) {
  const n = Number(days);
  const span = Number.isFinite(n) && n > 0 ? Math.floor(n) : 30;
  const today = todaySP(now);
  return { from: addCalendarDays(today, -span), to: addCalendarDays(today, -1) };
}

function normalizeRange(from, to) {
  const ok = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || '') && !Number.isNaN(Date.parse(d));
  if (!ok(from) || !ok(to) || from > to) return defaultRange();
  return { from, to };
}

function daysInRange({ from, to }) {
  return Math.round((new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / 86400000) + 1;
}

function previousRange(range) {
  const days = daysInRange(range);
  const prevTo = new Date(`${range.from}T00:00:00Z`);
  prevTo.setUTCDate(prevTo.getUTCDate() - 1);
  const prevFrom = new Date(prevTo);
  prevFrom.setUTCDate(prevFrom.getUTCDate() - (days - 1));
  return { from: toISODate(prevFrom), to: toISODate(prevTo) };
}

// Lista de dias (AAAA-MM-DD) do período, em ordem.
function eachDay({ from, to }) {
  const out = [];
  const d = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (d <= end) {
    out.push(toISODate(d));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

// Quebra um período em janelas de no máximo `maxDays` dias (algumas
// métricas do Instagram só aceitam até 30 dias por consulta).
function chunkRange(range, maxDays = 30) {
  const days = eachDay(range);
  const out = [];
  for (let i = 0; i < days.length; i += maxDays) {
    const slice = days.slice(i, i + maxDays);
    out.push({ from: slice[0], to: slice[slice.length - 1] });
  }
  return out;
}

function pctDelta(curr, prev) {
  if (!prev) return curr > 0 ? 100 : null;
  return ((curr - prev) / prev) * 100;
}

module.exports = { toISODate, todaySP, addCalendarDays, defaultRange, normalizeRange, daysInRange, previousRange, eachDay, chunkRange, pctDelta };
