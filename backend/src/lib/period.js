// Datas de relatório compartilhadas pelo Meta Ads e pelo Instagram:
// período pedido (from/to em AAAA-MM-DD), período anterior equivalente
// e variação percentual. Mesmo comportamento do googleService.

function toISODate(d) {
  return d.toISOString().slice(0, 10);
}

function defaultRange(days = 30) {
  const to = new Date();
  const from = new Date();
  from.setUTCDate(from.getUTCDate() - (days - 1));
  return { from: toISODate(from), to: toISODate(to) };
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

module.exports = { toISODate, defaultRange, normalizeRange, daysInRange, previousRange, eachDay, chunkRange, pctDelta };
