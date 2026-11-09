/**
 * Mostrar só criativos que podem veicular agora, por cliente.
 *
 * O campo salvo na conta (`activeCreativesOnly`) manda. Enquanto ele não
 * existir, Seiza, Ara Faria Lima, Síntese Moema e Arvis já ficam ligados:
 * anúncio pausado (ou de campanha/conjunto pausado, arquivado, excluído ou
 * reprovado) sai da lista de criativos. Gravar false desliga esse padrão.
 *
 * Não mexe em investimento, resultados, série diária nem campanhas do
 * período. Só na lista de anúncios/criativos.
 *
 * Meta — entra na lista quando o effective_status do anúncio é um destes
 * (a Meta já embute campanha e conjunto pausados/arquivados/excluídos em
 * CAMPAIGN_PAUSED, ADSET_PAUSED, ARCHIVED e DELETED):
 *   ACTIVE, IN_PROCESS, PENDING_REVIEW, PREAPPROVED, WITH_ISSUES
 * IN_PROCESS, PENDING_REVIEW e PREAPPROVED contam como ativos (ainda vão
 * veicular ou estão em análise). WITH_ISSUES continua veiculando.
 * Ficam de fora: PAUSED, CAMPAIGN_PAUSED, ADSET_PAUSED, ARCHIVED, DELETED,
 * DISAPPROVED, PENDING_BILLING_INFO.
 * Se a consulta de status vier vazia, a lista inteira permanece (não zera
 * o painel por falha da Meta). Se outros anúncios têm status e este não,
 * ele fica de fora: não está entre os que podem veicular.
 * Se o status da campanha ou do conjunto vier junto e não estiver ativo,
 * o anúncio também fica de fora, mesmo com status próprio ACTIVE.
 *
 * Google — anúncio, grupo e campanha ENABLED. DISAPPROVED fica de fora
 * (o status do anúncio continua ENABLED, mas ele não veicula). UNKNOWN e
 * em análise continuam na lista. A consulta de força do anúncio já exigia
 * ENABLED nos três níveis; com a opção ligada ela também tira reprovado.
 */
const DEFAULT_ON_CLIENT_IDS = new Set(['ara-faria-lima', 'seiza', 's-ntese-moema', 'arvis']);

const META_AD_OK = new Set(['ACTIVE', 'IN_PROCESS', 'PENDING_REVIEW', 'PREAPPROVED', 'WITH_ISSUES']);
const META_PARENT_OK = new Set(['ACTIVE', 'IN_PROCESS', 'WITH_ISSUES', 'PENDING_REVIEW', 'PREAPPROVED']);

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
  const explicit = normalize(account && account.activeCreativesOnly);
  if (explicit !== null) return explicit;
  return !!(account && DEFAULT_ON_CLIENT_IDS.has(String(account.id || '')));
}

function metaListed(ad) {
  const status = upper(ad && (ad.status || ad.effectiveStatus || ad.effective_status));
  const campaign = upper(ad && (ad.campaignStatus || ad.campaignEffectiveStatus));
  const adset = upper(ad && (ad.adsetStatus || ad.adsetEffectiveStatus));
  if (!status && !campaign && !adset) return true;
  if (campaign && !META_PARENT_OK.has(campaign)) return false;
  if (adset && !META_PARENT_OK.has(adset)) return false;
  if (!status) return true;
  return META_AD_OK.has(status);
}

// Tira da lista o que não pode veicular. Sem nenhum status conhecido,
// devolve a mesma lista (falha da Meta não pode esvaziar o painel).
function filterMetaAds(ads) {
  const list = Array.isArray(ads) ? ads : [];
  const known = list.some((a) => upper(a && (a.status || a.effectiveStatus || a.effective_status)));
  if (!known) return list;
  return list.filter((a) => {
    const status = upper(a && (a.status || a.effectiveStatus || a.effective_status));
    if (!status) return false;
    return metaListed(a);
  });
}

// Cópia rasa: o relatório em cache continua com todos os anúncios.
function presentMetaReport(report, onlyActive) {
  if (!onlyActive || !report) return report;
  return { ...report, ads: filterMetaAds(report.ads), activeCreativesOnly: true };
}

function googleListed(row) {
  const ad = row || {};
  if (upper(ad.adStatus || ad.status) !== 'ENABLED') return false;
  if (upper(ad.adGroupStatus || ad.groupStatus) !== 'ENABLED') return false;
  if (upper(ad.campaignStatus) !== 'ENABLED') return false;
  if (upper(ad.approvalStatus || ad.approval) === 'DISAPPROVED') return false;
  return true;
}

function filterGoogleAds(ads) {
  const list = Array.isArray(ads) ? ads : [];
  return list.filter((a) => googleListed(a));
}

// A cláusula base é a que o relatório já usava. Com a opção ligada, o
// anúncio reprovado (status ENABLED, mas sem veicular) sai da força.
function googleAdStrengthWhere(onlyActive) {
  const base = "campaign.status = 'ENABLED' AND ad_group.status = 'ENABLED' AND ad_group_ad.status = 'ENABLED' AND ad_group_ad.ad.type = 'RESPONSIVE_SEARCH_AD'";
  if (!onlyActive) return base;
  return `${base} AND ad_group_ad.policy_summary.approval_status != 'DISAPPROVED'`;
}

module.exports = {
  normalize,
  effective,
  metaListed,
  filterMetaAds,
  presentMetaReport,
  googleListed,
  filterGoogleAds,
  googleAdStrengthWhere,
  DEFAULT_ON_CLIENT_IDS,
  META_AD_OK,
  META_PARENT_OK,
};
