// node --test test/
// Formato de vários conjuntos/anúncios e a publicação sempre PAUSADA.
process.env.USE_MOCK_DATA = 'true';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const spec = require('../src/lib/campaignSpec');
const publisher = require('../src/services/campaignPublisher');

const account = { meta: { adAccountId: 'act_123', pageId: '999', igBusinessId: '888' } };

// Forma de aceite (campanha de leads com 2 conjuntos e 4 anúncios). Os textos
// e ids ilustram o rascunho; o produto não tem esses valores fixos.
function leadsSpec() {
  const ad = (name, assetId, headline) => ({
    name,
    creative: {
      assetId,
      primaryText: `Texto de ${name}. Toque em Saiba mais.`,
      headline,
      description: 'Marketing de performance para delivery',
    },
  });
  return {
    objective: 'cadastros',
    pixelId: '1093864316811167',
    specialAdCategory: 'NONE',
    budgetType: 'daily',
    budget: 50,
    startDate: spec.todaySP(),
    endDate: '',
    creativeEnhancements: 'opt_out',
    audience: {
      countries: ['BR'],
      cities: [
        'São Paulo', 'Rio de Janeiro', 'Belo Horizonte', 'Curitiba', 'Porto Alegre',
        'Brasília', 'Goiânia', 'Campinas', 'Guarulhos', 'Santo André',
        'São Bernardo do Campo', 'Santos', 'Florianópolis', 'Recife', 'Fortaleza',
      ],
      ageMin: 25,
      ageMax: 50,
      gender: 'all',
      interests: [],
      advantage: false,
    },
    placements: {
      mode: 'manual',
      positions: ['instagram_feed', 'instagram_stories', 'instagram_reels', 'instagram_explore'],
    },
    creative: { cta: 'LEARN_MORE', link: 'https://rotadeliveryads.com.br' },
    adSets: [
      {
        name: '00 [Insta] [H/M] [25-50] [Donos de Restaurante] [Cidades]',
        audience: { interests: ['Restaurant management', 'Foodservice', 'Entrepreneurship', 'Small business'] },
        ads: [
          ad('04.11.2026 AD01', '910b46ae-b541-4c24-8a9f-521e9b11f2d4', 'Faça o Raio-X do seu delivery'),
          ad('04.11.2026 AD02', '07aff6af-de04-46ad-a7ac-f2b7a915db46', 'Venda direto e pague menos comissão'),
        ],
      },
      {
        name: '01 [Insta] [H/M] [25-50] [Delivery e iFood] [Cidades]',
        audience: { interests: ['iFood', 'Food delivery', 'Online food ordering'] },
        ads: [
          ad('04.11.2026 AD03', '298bcb7b-5725-4b2b-a80d-0aa41965e248', 'Anúncio que vira pedido, não curtida'),
          ad('04.11.2026 AD04', '49a16121-742b-4b79-ab61-bbab43e8ffec', 'Agende o Raio-X do seu delivery'),
        ],
      },
    ],
  };
}

function imagesFor(ids) {
  return Object.fromEntries(ids.map((id) => [id, { data: Buffer.from(`img-${id}`), size: 2048 }]));
}

test('rascunho antigo, sem adSets, continua um conjunto e um anúncio pausados', async () => {
  const raw = {
    objective: 'mensagens',
    budget: '40',
    startDate: spec.todaySP(),
    audience: { countries: ['br'], ageMin: 21, ageMax: 45, advantage: false, interests: ['Odontologia'] },
    creative: { assetId: 'asset-legado', primaryText: 'Oi', headline: 'Título' },
  };
  const cleaned = spec.sanitizeMeta(raw);
  assert.strictEqual(cleaned.adSets, undefined);
  assert.strictEqual(cleaned.creativeEnhancements, undefined);
  assert.strictEqual(cleaned.audience.countries[0], 'BR');
  assert.deepStrictEqual(spec.validateMeta(cleaned, { account }), []);

  const draft = { id: 'd1', platform: 'meta', name: 'Avaliação outubro', spec: cleaned, currency: 'BRL' };
  const result = await publisher.publish(draft, account, { images: imagesFor(['asset-legado']) });
  assert.strictEqual(result.mock, true);
  const labels = result.requests.map((r) => r.label);
  assert.deepStrictEqual(labels, ['Imagem do anúncio', 'Campanha', 'Conjunto de anúncios', 'Criativo', 'Anúncio']);
  const campaign = result.requests[1].params;
  const adset = result.requests[2].params;
  const creative = result.requests[3].params;
  const ad = result.requests[4].params;
  assert.strictEqual(campaign.name, 'Avaliação outubro');
  assert.strictEqual(campaign.status, 'PAUSED');
  assert.strictEqual(adset.name, 'Avaliação outubro | Conjunto');
  assert.strictEqual(adset.status, 'PAUSED');
  assert.strictEqual(ad.name, 'Avaliação outubro | Anúncio');
  assert.strictEqual(ad.status, 'PAUSED');
  assert.strictEqual(creative.name, 'Avaliação outubro | Criativo');
  assert.strictEqual(creative.degrees_of_freedom_spec, undefined);
  assert.strictEqual(adset.targeting.targeting_automation.advantage_audience, 0);
  assert.deepStrictEqual(Object.keys(result.ids).sort(), ['ad', 'adset', 'campaign', 'creative']);
  for (const r of result.requests) {
    if (r.params && Object.prototype.hasOwnProperty.call(r.params, 'status')) assert.strictEqual(r.params.status, 'PAUSED');
    assert.notStrictEqual(r.params && r.params.status, 'ACTIVE');
  }
});

test('um rascunho com 2 conjuntos e 4 anúncios publica os nomes e fica pausado', async () => {
  const cleaned = spec.sanitizeMeta(leadsSpec());
  assert.strictEqual(cleaned.adSets.length, 2);
  assert.strictEqual(cleaned.adSets[0].ads.length, 2);
  assert.strictEqual(cleaned.adSets[1].ads.length, 2);
  assert.strictEqual(cleaned.creativeEnhancements, 'opt_out');
  assert.strictEqual(cleaned.audience.advantage, false);
  assert.strictEqual(cleaned.audience.ageMin, 25);
  assert.strictEqual(cleaned.audience.cities.length, 15);
  assert.deepStrictEqual(spec.validateMeta(cleaned, { account }), []);

  const draft = { id: 'd2', platform: 'meta', name: '[Rota] [Leads] [Landing Page]', spec: cleaned, currency: 'BRL' };
  const result = await publisher.publish(draft, account, { images: imagesFor(spec.collectAssetIds(cleaned, draft.name)) });
  const campaign = result.requests.find((r) => r.label === 'Campanha').params;
  assert.strictEqual(campaign.name, '[Rota] [Leads] [Landing Page]');
  assert.strictEqual(campaign.objective, 'OUTCOME_LEADS');
  assert.strictEqual(campaign.status, 'PAUSED');
  assert.strictEqual(campaign.daily_budget, 5000);

  const adsets = result.requests.filter((r) => r.url.endsWith('/adsets'));
  assert.strictEqual(adsets.length, 2);
  assert.deepStrictEqual(adsets.map((r) => r.params.name), [
    '00 [Insta] [H/M] [25-50] [Donos de Restaurante] [Cidades]',
    '01 [Insta] [H/M] [25-50] [Delivery e iFood] [Cidades]',
  ]);
  for (const r of adsets) {
    const t = r.params.targeting;
    assert.strictEqual(r.params.status, 'PAUSED');
    assert.strictEqual(r.params.optimization_goal, 'OFFSITE_CONVERSIONS');
    assert.strictEqual(r.params.destination_type, 'WEBSITE');
    assert.strictEqual(r.params.promoted_object.pixel_id, '1093864316811167');
    assert.strictEqual(r.params.promoted_object.custom_event_type, 'LEAD');
    assert.strictEqual(t.age_min, 25);
    assert.strictEqual(t.age_max, 50);
    assert.strictEqual(t.targeting_automation.advantage_audience, 0);
    assert.deepStrictEqual(t.publisher_platforms, ['instagram']);
    assert.deepStrictEqual(t.instagram_positions, ['stream', 'story', 'reels', 'explore']);
    assert.strictEqual(t.facebook_positions, undefined);
    assert.strictEqual(t.geo_locations.cities.length, 15);
    assert.ok(t.geo_locations.cities.every((c) => typeof c.key === 'string' && c.key.includes('chave da cidade')));
  }
  assert.deepStrictEqual(adsets[0].params.targeting.flexible_spec[0].interests.map((i) => i.name), [
    'Restaurant management', 'Foodservice', 'Entrepreneurship', 'Small business',
  ]);
  assert.deepStrictEqual(adsets[1].params.targeting.flexible_spec[0].interests.map((i) => i.name), [
    'iFood', 'Food delivery', 'Online food ordering',
  ]);

  const ads = result.requests.filter((r) => r.url.endsWith('/ads'));
  assert.deepStrictEqual(ads.map((r) => r.params.name), [
    '04.11.2026 AD01', '04.11.2026 AD02', '04.11.2026 AD03', '04.11.2026 AD04',
  ]);
  const creatives = result.requests.filter((r) => r.url.endsWith('/adcreatives'));
  assert.strictEqual(creatives.length, 4);
  assert.strictEqual(result.requests.filter((r) => r.url.endsWith('/adimages')).length, 4);
  for (const r of creatives) {
    const features = r.params.degrees_of_freedom_spec.creative_features_spec;
    assert.strictEqual(features.standard_enhancements, undefined);
    for (const name of ['adapt_to_placement', 'image_touchups', 'image_brightness_and_contrast', 'text_optimizations', 'enhance_cta', 'inline_comment', 'site_extensions']) {
      assert.strictEqual(features[name].enroll_status, 'OPT_OUT', name);
    }
    assert.strictEqual(r.params.object_story_spec.link_data.link, 'https://rotadeliveryads.com.br');
    assert.strictEqual(r.params.object_story_spec.link_data.call_to_action.type, 'LEARN_MORE');
  }
  for (const r of result.requests) {
    if (r.params && Object.prototype.hasOwnProperty.call(r.params, 'status')) {
      assert.strictEqual(r.params.status, 'PAUSED');
    }
  }
  const createdAds = result.created.filter((c) => c.type === 'ad').map((c) => c.name);
  assert.deepStrictEqual(createdAds, ads.map((r) => r.params.name));
  assert.ok(!JSON.stringify(result.requests).includes('"status": "ACTIVE"') && !JSON.stringify(result.requests).includes('"status":"ACTIVE"'));
});

test('sem o pedido de opt-out, o criativo não manda degrees_of_freedom_spec', async () => {
  const input = leadsSpec();
  delete input.creativeEnhancements;
  const cleaned = spec.sanitizeMeta(input);
  assert.strictEqual(cleaned.creativeEnhancements, undefined);
  const draft = { platform: 'meta', name: 'Sem opt-out', spec: cleaned, currency: 'BRL' };
  const result = await publisher.publish(draft, account, { images: imagesFor(spec.collectAssetIds(cleaned)) });
  for (const r of result.requests.filter((x) => x.url.endsWith('/adcreatives'))) {
    assert.strictEqual(r.params.degrees_of_freedom_spec, undefined);
  }
});

test('imagem repetida sobe uma vez e o conjunto pode trocar idade e posicionamento', async () => {
  const cleaned = spec.sanitizeMeta({
    objective: 'trafego',
    budget: 20,
    startDate: spec.todaySP(),
    audience: { countries: ['BR'], ageMin: 18, ageMax: 65, advantage: true },
    placements: { mode: 'auto', positions: [] },
    creative: { link: 'https://exemplo.com', cta: 'LEARN_MORE' },
    adSets: [{
      name: 'Conjunto estreito',
      audience: { ageMin: 30, ageMax: 40, advantage: false, interests: ['Café'] },
      placements: { mode: 'manual', positions: ['instagram_stories', 'instagram_reels'] },
      ads: [
        { name: 'Um', creative: { assetId: 'mesmo', primaryText: 'A', headline: 'H' } },
        { name: 'Dois', creative: { assetId: 'mesmo', primaryText: 'B', headline: 'H2', link: 'https://outro.exemplo.com' } },
      ],
    }],
  });
  const draft = { platform: 'meta', name: 'Campanha', spec: cleaned, currency: 'BRL' };
  const result = await publisher.publish(draft, account, { images: imagesFor(['mesmo']) });
  assert.strictEqual(result.requests.filter((r) => r.url.endsWith('/adimages')).length, 1);
  const adset = result.requests.find((r) => r.url.endsWith('/adsets')).params;
  assert.strictEqual(adset.name, 'Conjunto estreito');
  assert.strictEqual(adset.targeting.age_min, 30);
  assert.strictEqual(adset.targeting.age_max, 40);
  assert.strictEqual(adset.targeting.targeting_automation.advantage_audience, 0);
  assert.deepStrictEqual(adset.targeting.publisher_platforms, ['instagram']);
  assert.deepStrictEqual(adset.targeting.instagram_positions, ['story', 'reels']);
  const ads = result.requests.filter((r) => r.url.endsWith('/ads'));
  assert.deepStrictEqual(ads.map((r) => r.params.name), ['Um', 'Dois']);
  assert.strictEqual(ads[0].params.adset_id, ads[1].params.adset_id);
  const links = result.requests.filter((r) => r.url.endsWith('/adcreatives')).map((r) => r.params.object_story_spec.link_data.link);
  assert.deepStrictEqual(links, ['https://exemplo.com', 'https://outro.exemplo.com']);
});

test('validador aponta nome, imagem e link que faltam, e aceita o alias de opt-out', () => {
  const cleaned = spec.sanitizeMeta({
    objective: 'cadastros',
    pixelId: '123',
    budget: 10,
    startDate: spec.todaySP(),
    optOutAdvantageCreative: true,
    creative: {},
    adSets: [
      { name: '', ads: [{ name: '', creative: {} }] },
      { name: 'Repetido', ads: [{ name: 'Igual', creative: { assetId: 'a', primaryText: 'p', headline: 'h' } }] },
      { name: 'Repetido', ads: [{ name: 'Igual', creative: { assetId: 'a', primaryText: 'p', headline: 'h' } }] },
    ],
  });
  assert.strictEqual(cleaned.creativeEnhancements, 'opt_out');
  const problems = spec.validateMeta(cleaned, { account });
  assert.ok(problems.some((p) => p.includes('Dê um nome para o conjunto')));
  assert.ok(problems.some((p) => p.includes('Dê um nome para o anúncio')));
  assert.ok(problems.some((p) => p.includes('está repetido')));
  assert.ok(problems.some((p) => p.includes('Envie a imagem')));
  assert.ok(problems.some((p) => p.includes('link de destino')));
});

test('interesses vazios do conjunto herdam os da campanha', () => {
  const cleaned = spec.sanitizeMeta({
    objective: 'mensagens',
    budget: 10,
    startDate: spec.todaySP(),
    audience: { interests: ['Odontologia'], advantage: false },
    creative: { assetId: 'a', primaryText: 'p', headline: 'h' },
    adSets: [{ name: 'Só o nome', audience: { interests: [] }, ads: [{ name: 'Anúncio A', creative: {} }] }],
  });
  const plan = spec.expandMetaPlan(cleaned, 'Campanha');
  assert.deepStrictEqual(plan.adSets[0].audience.interests, ['Odontologia']);
  assert.strictEqual(plan.adSets[0].ads[0].creative.assetId, 'a');
  assert.strictEqual(plan.legacy, false);
});

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `função ${name} não encontrada`);
  let i = source.indexOf('{', start);
  let depth = 0;
  for (; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`função ${name} sem fechamento`);
}

test('a tela de Campanhas lê vários conjuntos e anúncios de volta para o spec', () => {
  const html = fs.readFileSync(path.join(__dirname, '../../index.html'), 'utf8');
  assert.match(html, /function cpAddSet\(/);
  assert.match(html, /function cpAddAd\(/);
  assert.match(html, /Não aplicar melhorias automáticas do criativo/);
  const script = [
    'const cpSplit = (v) => String(v || "").split("\\n").map(x => x.trim()).filter(Boolean);',
    'const cpVal = (id) => { const el = document.getElementById(id); return el ? el.value : undefined; };',
    extractFunction(html, 'cpCollectSets'),
  ].join('\n');
  const input = (value) => ({ value });
  const values = {
    cpSetName_0: input('Conjunto A'),
    cpSetInterests_0: input('Café\nPadaria'),
    cpSetCustom_0: { checked: false },
    cpAdName_0_0: input('AD01'),
    cpAdPrimary_0_0: input('Texto 1'),
    cpAdHeadline_0_0: input('Título 1'),
    cpAdDesc_0_0: input(''),
    cpAdLink_0_0: input(''),
    cpAdCta_0_0: input(''),
    cpAdName_0_1: input('AD02'),
    cpAdPrimary_0_1: input('Texto 2'),
    cpAdHeadline_0_1: input('Título 2'),
    cpAdDesc_0_1: input('Desc'),
    cpAdLink_0_1: input('https://exemplo.com/b'),
    cpAdCta_0_1: input('SIGN_UP'),
    cpSetName_1: input('Conjunto B'),
    cpSetInterests_1: input(''),
    cpSetCustom_1: { checked: true },
    cpSetCountries_1: input('BR'),
    cpSetCities_1: input('Curitiba'),
    cpSetAgeMin_1: input('25'),
    cpSetAgeMax_1: input('50'),
    cpSetGender_1: input('all'),
    cpSetAdvantage_1: { checked: false },
    cpSetPlacementMode_1: input('manual'),
    cpAdName_1_0: input('AD03'),
    cpAdPrimary_1_0: input('Texto 3'),
    cpAdHeadline_1_0: input('Título 3'),
    cpAdDesc_1_0: input(''),
    cpAdLink_1_0: input(''),
    cpAdCta_1_0: input(''),
  };
  const checked = [{ value: 'instagram_feed', dataset: { set: '1' } }, { value: 'instagram_stories', dataset: { set: '1' } }];
  const document = {
    getElementById(id) { return Object.prototype.hasOwnProperty.call(values, id) ? values[id] : null; },
    querySelector(sel) { return sel.includes('cpSetPos') && sel.includes('"1"') ? checked[0] : null; },
    querySelectorAll(sel) { return sel.includes('cpSetPos') && sel.includes(':checked') ? checked : []; },
  };
  const ctx = {
    document,
    spec: {
      audience: { countries: ['BR'], cities: ['São Paulo'], ageMin: 18, ageMax: 65, gender: 'all', advantage: true },
      placements: { mode: 'auto', positions: [] },
      adSets: [
        { name: '', audience: { interests: [] }, ads: [{ name: '', creative: { assetId: 'img-1' } }, { name: '', creative: { assetId: 'img-2' } }] },
        { name: '', audience: { interests: [] }, ads: [{ name: '', creative: { assetId: 'img-3' } }] },
      ],
    },
  };
  vm.createContext(ctx);
  vm.runInContext(`${script}\ncpCollectSets(spec);`, ctx);
  const plain = (v) => JSON.parse(JSON.stringify(v));
  assert.strictEqual(ctx.spec.adSets[0].name, 'Conjunto A');
  assert.deepStrictEqual(plain(ctx.spec.adSets[0].audience.interests), ['Café', 'Padaria']);
  assert.strictEqual(ctx.spec.adSets[0].placements, undefined);
  assert.strictEqual(ctx.spec.adSets[0].ads[0].name, 'AD01');
  assert.strictEqual(ctx.spec.adSets[0].ads[0].creative.assetId, 'img-1');
  assert.strictEqual(ctx.spec.adSets[0].ads[0].creative.primaryText, 'Texto 1');
  assert.strictEqual(ctx.spec.adSets[0].ads[1].creative.link, 'https://exemplo.com/b');
  assert.strictEqual(ctx.spec.adSets[0].ads[1].creative.cta, 'SIGN_UP');
  assert.strictEqual(ctx.spec.adSets[1].name, 'Conjunto B');
  assert.strictEqual(ctx.spec.adSets[1].audience.ageMin, 25);
  assert.strictEqual(ctx.spec.adSets[1].audience.advantage, false);
  assert.deepStrictEqual(plain(ctx.spec.adSets[1].audience.cities), ['Curitiba']);
  assert.strictEqual(ctx.spec.adSets[1].placements.mode, 'manual');
  assert.deepStrictEqual(plain(ctx.spec.adSets[1].placements.positions), ['instagram_feed', 'instagram_stories']);
  assert.strictEqual(ctx.spec.adSets[1].ads[0].creative.assetId, 'img-3');
});

test('o formulário desenha dois conjuntos e quatro anúncios, e o rascunho antigo segue com um anúncio', () => {
  const html = fs.readFileSync(path.join(__dirname, '../../index.html'), 'utf8');
  const names = ['cpSetIsCustom', 'cpPosBoxes', 'cpMetaLegacyAdHtml', 'cpMetaAdHtml', 'cpMetaSetsHtml', 'cpMetaHtml', 'escapeHtml', 'escapeAttr'];
  const script = [
    'const cpLines = (arr) => (arr || []).join("\\n");',
    'const cpOpt = (map, cur) => Object.entries(map).map(([v, l]) => `<option value="${escapeAttr(v)}">${escapeHtml(l)}</option>`).join("");',
    'const cpIn = (id, v, extra = "") => `<input id="${id}" value="${escapeAttr(v ?? "")}" ${extra}>`;',
    'const cpRow = (label, inner, help) => `<div>${label}${inner || ""}${help || ""}</div>`;',
    ...names.map((name) => extractFunction(html, name)),
  ].join('\n');
  const ctx = {
    CP: { edit: { name: '[Rota] [Leads] [Landing Page]', currency: 'BRL' } },
    CP_EU: ['PT'],
    CP_OBJ: { cadastros: 'Cadastros no site (pixel)', mensagens: 'Mensagens no WhatsApp' },
    CP_CTA: { LEARN_MORE: 'Saiba mais' },
    CP_POS: { instagram_feed: 'Instagram: Feed', instagram_stories: 'Instagram: Stories', instagram_reels: 'Instagram: Reels', instagram_explore: 'Instagram: Explorar' },
  };
  vm.createContext(ctx);
  vm.runInContext(script, ctx);
  const multi = spec.sanitizeMeta(leadsSpec());
  const htmlMulti = vm.runInContext('cpMetaHtml(spec, "")', Object.assign(ctx, { spec: multi }));
  assert.match(htmlMulti, /Conjuntos e anúncios \(2 conjuntos, 4 anúncios\)/);
  assert.match(htmlMulti, /00 \[Insta\] \[H\/M\] \[25-50\] \[Donos de Restaurante\] \[Cidades\]/);
  assert.match(htmlMulti, /01 \[Insta\] \[H\/M\] \[25-50\] \[Delivery e iFood\] \[Cidades\]/);
  for (const name of ['04.11.2026 AD01', '04.11.2026 AD02', '04.11.2026 AD03', '04.11.2026 AD04']) {
    assert.ok(htmlMulti.includes(name), name);
  }
  assert.match(htmlMulti, /id="cpOptOutCreative" checked/);
  assert.match(htmlMulti, /instagram_feed/);
  assert.match(htmlMulti, /\+ Conjunto/);
  assert.match(htmlMulti, /\+ Anúncio neste conjunto/);
  const legacy = spec.sanitizeMeta({ objective: 'mensagens', budget: 10, startDate: spec.todaySP(), creative: { assetId: 'a', primaryText: 'Oi', headline: 'Título' } });
  const htmlLegacy = vm.runInContext('cpMetaHtml(spec, "")', Object.assign(ctx, { spec: legacy }));
  assert.match(htmlLegacy, /Usar vários conjuntos e anúncios/);
  assert.doesNotMatch(htmlLegacy, /id="cpSetName_0"/);
});
