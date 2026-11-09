/**
 * Preferência do resultado principal da Meta, por cliente.
 *
 * auto  — primeira ação que existir, na ordem do relatório (compras, leads, conversas, cadastros).
 * leads — só leads/cadastros de formulário (Instant Form). Conversas de WhatsApp
 *         não entram no número principal nem nos destaques do painel.
 *
 * O campo salvo na conta (`kpiPreference`) manda. Enquanto ele não existir,
 * Ara Faria Lima, Seiza e Síntese Moema já usam `leads`: o produto atual é
 * formulário nativo, e campanha antiga de WhatsApp não pode voltar a ser o KPI.
 * Gravar "auto" desliga esse padrão.
 */
const activeCreatives = require('./activeCreatives');

const VALUES = new Set(['auto', 'leads']);

const INSTANT_FORM_CLIENT_IDS = new Set(['ara-faria-lima', 'seiza', 's-ntese-moema']);

function normalize(value) {
  const v = String(value == null ? '' : value).trim().toLowerCase();
  return VALUES.has(v) ? v : null;
}

function effective(account) {
  const explicit = normalize(account && account.kpiPreference);
  if (explicit) return explicit;
  if (account && INSTANT_FORM_CLIENT_IDS.has(String(account.id || ''))) return 'leads';
  return 'auto';
}

// Junta a preferência nas opções do relatório sem apagar from/to/fresh.
// activeCreativesOnly viaja junto: quem já pede o relatório do cliente
// (painel, link, PDF) não precisa lembrar de um segundo helper.
function reportOptions(account, extra = {}) {
  return { ...extra, kpiPreference: effective(account), activeCreativesOnly: activeCreatives.effective(account) };
}

module.exports = { normalize, effective, reportOptions, INSTANT_FORM_CLIENT_IDS };
