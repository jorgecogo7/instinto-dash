/**
 * Avaliação das metas do cliente num período. As metas são mensais, então o
 * orçamento e os resultados esperados são proporcionais aos dias do período.
 */
const period = require('./period');

function daysInMonthOf(dateStr) {
  const [y, m] = dateStr.split('-').map(Number);
  return new Date(y, m, 0).getDate();
}

// actual: { spend, results, costPerResult, roas }
function evaluate(goal, actual, range) {
  if (!goal || !actual) return null;
  const days = period.daysInRange(range);
  const factor = Math.min(1, days / daysInMonthOf(range.from)) || 1;
  const out = { factor, items: [] };
  if (goal.monthlyBudget) {
    const target = goal.monthlyBudget * factor;
    const pct = target ? (actual.spend / target) * 100 : 0;
    out.items.push({ key: 'budget', target, actual: actual.spend, pct, status: pct > 110 ? 'bad' : pct >= 85 ? 'good' : 'warn' });
  }
  if (goal.costPerResultTarget && actual.results > 0) {
    const pct = (actual.costPerResult / goal.costPerResultTarget) * 100;
    out.items.push({ key: 'cpr', target: goal.costPerResultTarget, actual: actual.costPerResult, pct, status: pct <= 100 ? 'good' : pct <= 120 ? 'warn' : 'bad' });
  }
  if (goal.resultsTarget) {
    const target = goal.resultsTarget * factor;
    const pct = target ? (actual.results / target) * 100 : 0;
    out.items.push({ key: 'results', target, actual: actual.results, pct, status: pct >= 100 ? 'good' : pct >= 80 ? 'warn' : 'bad' });
  }
  if (goal.roasTarget && actual.roas > 0) {
    const pct = (actual.roas / goal.roasTarget) * 100;
    out.items.push({ key: 'roas', target: goal.roasTarget, actual: actual.roas, pct, status: pct >= 100 ? 'good' : pct >= 80 ? 'warn' : 'bad' });
  }
  return out.items.length ? out : null;
}

module.exports = { evaluate };
