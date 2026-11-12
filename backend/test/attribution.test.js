const test = require('node:test');
const assert = require('node:assert');
const attribution = require('../src/lib/attribution');
const adCatalog = require('../src/services/adCatalog');
const { inboundFromMessage } = require('../src/services/whatsappService');
const { leadFromWebhook } = require('../src/services/instantLeadService');

const at = '2026-11-02T15:00:00.000Z';

test('webhook do WhatsApp: referral vira anúncio, conjunto e miniatura', () => {
  const message = {
    from: '5511987654321',
    id: 'wamid.ABC',
    timestamp: '1762095600',
    type: 'text',
    text: { body: 'Oi, vi o anúncio' },
    referral: {
      source_url: 'https://fb.me/abc',
      source_id: '120000000000001',
      source_type: 'ad',
      headline: 'Promoção de verão',
      body: 'Até 20% off',
      media_type: 'image',
      image_url: 'https://cdn.example/criativo.jpg',
      thumbnail_url: 'http://inseguro/nao-entra.jpg',
      ctwa_clid: 'ARAk-clid',
    },
  };
  const item = inboundFromMessage(message, 'Maria');
  assert.equal(item.text, 'Oi, vi o anúncio');
  assert.equal(item.profileName, 'Maria');
  assert.equal(item.referral.source_id, '120000000000001');
  const touch = attribution.parseWhatsappReferral(item.referral, item.at);
  assert.equal(touch.platform, 'meta');
  assert.equal(touch.channel, 'whatsapp');
  assert.equal(touch.adId, '120000000000001');
  assert.equal(touch.adName, 'Promoção de verão');
  assert.equal(touch.headline, 'Promoção de verão');
  assert.equal(touch.body, 'Até 20% off');
  assert.equal(touch.thumbnailUrl, 'https://cdn.example/criativo.jpg');
  assert.equal(touch.ctwaClid, 'ARAk-clid');
  assert.equal(touch.sourceType, 'ad');
  assert.ok(touch.at);
});

test('referral de publicação não vira id de anúncio, e referral vazio é ignorado', () => {
  const post = attribution.parseWhatsappReferral({ source_id: 'post-1', source_type: 'post', headline: 'Post' }, at);
  assert.equal(post.adId, null);
  assert.equal(post.sourceId, 'post-1');
  assert.equal(post.platform, 'meta');
  assert.equal(attribution.parseWhatsappReferral(null), null);
  assert.equal(attribution.parseWhatsappReferral({}), null);
  assert.equal(attribution.parseWhatsappReferral('ad'), null);
  assert.equal(inboundFromMessage({ type: 'reaction', reaction: { emoji: '👍' } }), null);
});

test('UTM do formulário resolve Meta, Google ou orgânico', () => {
  const meta = attribution.touchFromUtm({
    utm_source: 'facebook', utm_medium: 'cpc', utm_campaign: 'Mensagens · Remarketing', utm_content: 'video_depoimento_cliente', fbclid: 'fb.1',
  }, { channel: 'form', at });
  assert.equal(meta.platform, 'meta');
  assert.equal(meta.campaignName, 'Mensagens · Remarketing');
  assert.equal(meta.adName, 'video_depoimento_cliente');
  assert.equal(meta.fbclid, 'fb.1');
  assert.deepEqual(meta.utm, {
    source: 'facebook', medium: 'cpc', campaign: 'Mensagens · Remarketing', content: 'video_depoimento_cliente', term: null,
  });

  const google = attribution.touchFromUtm({ utm_source: 'google', utm_medium: 'cpc', utm_campaign: 'Pesquisa · Marca', gclid: 'Cjw' }, { at });
  assert.equal(google.platform, 'google');
  assert.equal(google.campaignName, 'Pesquisa · Marca');
  assert.equal(google.gclid, 'Cjw');

  const onlyClick = attribution.touchFromUtm({ fbclid: 'fb.2' }, { at });
  assert.equal(onlyClick.platform, 'meta');

  const organic = attribution.touchFromUtm({}, { at });
  assert.equal(organic.platform, 'organic');
  assert.equal(attribution.isPaid(organic), false);
  assert.equal(attribution.present(null).label, 'Origem desconhecida');
  assert.equal(attribution.present({ first: organic }).label, 'Orgânico');
});

test('catálogo preenche nome, conjunto e miniatura sem trocar o primeiro toque', () => {
  const catalog = adCatalog.catalogFor(null);
  const touch = attribution.parseWhatsappReferral(attribution.MOCK_CTWA_REFERRAL, at);
  const enriched = attribution.enrichWithCatalog(touch, catalog);
  assert.equal(enriched.adId, 'ad_mock_1');
  assert.equal(enriched.adName, 'video_depoimento_cliente');
  assert.equal(enriched.adsetName, 'mensagem_quente');
  assert.equal(enriched.campaignName, 'Mensagens · Remarketing');
  assert.ok(enriched.thumbnailUrl);
  assert.equal(enriched.headline, 'Depoimento de cliente');

  const byName = attribution.enrichWithCatalog(attribution.touchFromUtm({
    utm_source: 'facebook', utm_campaign: 'Mensagens · Remarketing', utm_content: 'video_depoimento_cliente',
  }, { at }), catalog);
  assert.equal(byName.adId, 'ad_mock_1');
  assert.equal(byName.campaignId, 'cmp_Mensagens · Remarketing');

  const google = attribution.enrichWithCatalog(attribution.touchFromUtm({
    utm_source: 'google', utm_campaign: 'Pesquisa · Marca', gclid: 'x',
  }, { at }), catalog);
  assert.equal(google.platform, 'google');
  assert.equal(google.campaignId, '111');

  const contact = { attribution: null };
  assert.equal(attribution.applyTouch(contact, enriched), true);
  assert.equal(contact.attribution.first.adId, 'ad_mock_1');
  assert.equal(attribution.applyTouch(contact, { ...enriched, adId: 'ad_outro', adName: 'Outro', platform: 'meta' }), true);
  assert.equal(contact.attribution.first.adId, 'ad_mock_1');
  assert.equal(contact.attribution.last.adId, 'ad_outro');
  assert.equal(attribution.applyTouch(contact, attribution.organicTouch('form', at)), false);
  assert.equal(contact.attribution.first.adId, 'ad_mock_1');
  const shown = attribution.present(contact.attribution, null);
  assert.equal(shown.adId, 'ad_mock_1');
  assert.equal(shown.last.adName, 'Outro');
});

test('Instant Form lê ad, conjunto, campanha e os campos do lead', () => {
  const lead = leadFromWebhook({
    leadgen_id: 'lead-9', page_id: '111', ad_id: 'ad_mock_1', adgroup_id: 'set-1', created_time: 1762095600,
  }, {
    id: 'lead-9', field_data: [
      { name: 'full_name', values: ['Ana Souza'] },
      { name: 'phone_number', values: ['+5511988880101'] },
      { name: 'email', values: ['ana@example.com'] },
    ],
  });
  assert.equal(lead.ad_id, 'ad_mock_1');
  assert.equal(lead.adset_id, 'set-1');
  const person = attribution.contactFromInstantLead(lead);
  assert.equal(person.name, 'Ana Souza');
  assert.equal(person.phone, '+5511988880101');
  assert.equal(person.email, 'ana@example.com');
  const touch = attribution.touchFromInstantLead({ ...lead, campaign_id: 'cmp_1', campaign_name: 'Captação', adset_name: 'Quente', ad_name: 'Vídeo' });
  assert.equal(touch.platform, 'meta');
  assert.equal(touch.channel, 'instant_form');
  assert.equal(touch.adId, 'ad_mock_1');
  assert.equal(touch.adsetId, 'set-1');
  assert.equal(touch.campaignId, 'cmp_1');
  assert.equal(touch.campaignName, 'Captação');
  assert.ok(touch.at);
});

test('relatório por anúncio: etapas, ganhos, receita e custo', () => {
  const stages = [
    { id: 'novo', name: 'Novo lead', kind: 'open', color: 'blue' },
    { id: 'ganho', name: 'Ganho', kind: 'won', color: 'green' },
    { id: 'perdido', name: 'Perdido', kind: 'lost', color: 'red' },
  ];
  const ad = { platform: 'meta', adId: 'ad1', adName: 'Anúncio A', adsetName: 'Conjunto 1', campaignId: 'c1', campaignName: 'Campanha A' };
  const deals = [
    { createdAt: '2026-11-02T12:00:00.000Z', stageId: 'novo', value: null, history: [], attribution: { first: ad } },
    {
      createdAt: '2026-11-02T13:00:00.000Z', stageId: 'ganho', value: 150, stageChangedAt: '2026-11-04T12:00:00.000Z',
      history: [{ type: 'stage', to: 'ganho', at: '2026-11-04T12:00:00.000Z' }],
      attribution: { first: ad },
    },
    { createdAt: '2026-11-03T12:00:00.000Z', stageId: 'novo', value: null, history: [], attribution: { first: attribution.organicTouch('whatsapp', '2026-11-03T12:00:00.000Z') } },
    { createdAt: '2026-11-03T15:00:00.000Z', stageId: 'novo', value: null, history: [], attribution: null },
    {
      createdAt: '2026-11-05T12:00:00.000Z', stageId: 'novo', value: null, history: [],
      attribution: { first: { platform: 'google', campaignId: '111', campaignName: 'Pesquisa · Marca', adName: 'Anúncio da busca' } },
    },
    {
      createdAt: '2026-10-01T12:00:00.000Z', stageId: 'ganho', value: 999, stageChangedAt: '2026-10-02T12:00:00.000Z',
      history: [{ type: 'created', to: 'ganho', at: '2026-10-02T12:00:00.000Z' }],
      attribution: { first: ad },
    },
  ];
  const report = attribution.buildAdReport({
    deals, stages, from: '2026-11-01T00:00:00.000Z', to: '2026-11-10T00:00:00.000Z',
    spendRows: [
      { platform: 'meta', adId: 'ad1', adName: 'Anúncio A', adsetName: 'Conjunto 1', campaignId: 'c1', campaignName: 'Campanha A', spend: 100, thumbnailUrl: 'https://cdn.example/a.jpg' },
      { platform: 'meta', adId: 'ad-sem-lead', adName: 'Sem lead', campaignId: 'c9', campaignName: 'Outra', spend: 40 },
      { platform: 'google', campaignId: '111', campaignName: 'Pesquisa · Marca', spend: 80 },
    ],
  });
  const row = report.ads.find((r) => r.adId === 'ad1');
  assert.equal(row.leads, 2);
  assert.equal(row.won, 1);
  assert.equal(row.revenue, 150);
  assert.equal(row.spend, 100);
  assert.equal(row.costPerLead, 50);
  assert.equal(row.costPerSale, 100);
  assert.equal(row.thumbnailUrl, 'https://cdn.example/a.jpg');
  assert.equal(row.stages.find((s) => s.id === 'novo').count, 1);
  assert.equal(row.stages.find((s) => s.id === 'ganho').count, 1);
  assert.equal(report.ads.find((r) => r.kind === 'organic').leads, 1);
  assert.equal(report.ads.find((r) => r.kind === 'unknown').adName, 'Origem desconhecida');
  assert.equal(report.ads.find((r) => r.adId === 'ad-sem-lead').leads, 0);
  assert.equal(report.ads.find((r) => r.adId === 'ad-sem-lead').spend, 40);
  const googleAd = report.ads.find((r) => r.platform === 'google');
  assert.equal(googleAd.leads, 1);
  assert.equal(googleAd.spend, null);
  const camp = report.campaigns.find((r) => r.campaignId === 'c1');
  assert.equal(camp.leads, 2);
  assert.equal(camp.won, 1);
  assert.equal(camp.spend, 100);
  assert.equal(camp.costPerLead, 50);
  const gCamp = report.campaigns.find((r) => r.campaignId === '111');
  assert.equal(gCamp.leads, 1);
  assert.equal(gCamp.spend, 80);
  assert.equal(gCamp.costPerLead, 80);
  assert.equal(gCamp.costPerSale, null);
});
