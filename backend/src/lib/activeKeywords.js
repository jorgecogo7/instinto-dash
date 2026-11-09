/**
 * No Google, esconder termos de pesquisa e listar só palavra-chave ativa.
 *
 * O campo salvo na conta (`activeKeywordsOnly`) manda. Enquanto ele não
 * existir, Seiza, Ara Faria Lima, Síntese Moema e Arvis já ficam ligados.
 * Gravar false desliga esse padrão. Os outros clientes continuam como estão.
 *
 * Palavra-chave ativa: o critério está ENABLED, o grupo de anúncios está
 * ENABLED e a campanha está ENABLED. Pausada, removida e negativa ficam
 * de fora. Termos de pesquisa (o que a pessoa digitou) não entram na lista.
 *
 * Não mexe em investimento, cliques, conversões, campanhas nem na série
 * do período. keyword_view já não traz negativa; o filtro `negative = FALSE`
 * deixa isso explícito na consulta.
 *
 * Se nenhuma palavra da lista tiver status (dado de exemplo antigo), a
 * lista de palavras permanece. Os termos de pesquisa saem mesmo assim.
 */
const { DEFAULT_ON_CLIENT_IDS } = require('./activeCreatives');

function upper(value) {
  return String(value == null ? '' : value).trim().toUpperCase();
}

function normalize(value) {
  if (value === true || value === false) return value;
  if (value === 1 || value === '1') return true;
  if (value === 0 || value === '0') return false;
  const v = String(value == null ? '' : value).trim().toLowerCase();
  if (['true', 'on', 'sim', 'yes'].includes(v)) return true;
  if (['false', 'off', 'nao', 'não', 'no'].includes(v)) return false;
  return null;
}

function effective(account) {
  const explicit = normalize(account && account.activeKeywordsOnly);
  if (explicit !== null) return explicit;
  return !!(account && DEFAULT_ON_CLIENT_IDS.has(String(account.id || '')));
}

function keywordListed(row) {
  const k = row || {};
  if (k.negative === true || upper(k.negative) === 'TRUE') return false;
  if (upper(k.criterionStatus || k.status) !== 'ENABLED') return false;
  if (upper(k.adGroupStatus) !== 'ENABLED') return false;
  if (upper(k.campaignStatus) !== 'ENABLED') return false;
  return true;
}

function hasKeywordStatus(row) {
  if (!row) return false;
  if (row.criterionStatus || row.status || row.adGroupStatus || row.campaignStatus) return true;
  return row.negative === true || row.negative === false || upper(row.negative) === 'TRUE' || upper(row.negative) === 'FALSE';
}

function filterKeywords(keywords) {
  const list = Array.isArray(keywords) ? keywords : [];
  if (!list.some(hasKeywordStatus)) return list;
  return list.filter(keywordListed);
}

// Cópia rasa: o relatório em cache (e o mock compartilhado) continua inteiro.
function presentGoogleReport(report, onlyActive) {
  if (!onlyActive || !report) return report;
  return {
    ...report,
    keywords: filterKeywords(report.keywords),
    searchTerms: null,
    activeKeywordsOnly: true,
  };
}

// Acrescentada à consulta de keyword_view só quando a opção está ligada.
function keywordStatusWhere() {
  return "ad_group_criterion.status = 'ENABLED' AND ad_group_criterion.negative = FALSE AND ad_group.status = 'ENABLED' AND campaign.status = 'ENABLED'";
}

module.exports = {
  normalize,
  effective,
  keywordListed,
  filterKeywords,
  presentGoogleReport,
  keywordStatusWhere,
  DEFAULT_ON_CLIENT_IDS,
};
