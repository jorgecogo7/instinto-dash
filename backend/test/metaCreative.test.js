// node --test test/metaCreative.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const {
  pickCreativeMedia, pendingLookups, extraIgIds, parseStory, parseIgMedia, absPermalink, clientCreative,
} = require('../src/lib/metaCreative');
const { mockEnrichMeta } = require('../src/services/adStatusMetrics');

const img = (name) => `https://cdn.example/${name}.jpg`;
const mp4 = (id) => `https://video.xx.fbcdn.net/v/${id}.mp4?oe=FFFFFFFF`;

test('anúncio de imagem continua só com a miniatura, sem vídeo nem cards', () => {
  const c = {
    object_type: 'SHARE',
    image_url: img('oferta'),
    thumbnail_url: img('thumb'),
    object_story_spec: { link_data: { picture: img('oferta'), name: 'Oferta', message: 'Texto da oferta' } },
  };
  const media = pickCreativeMedia(c);
  assert.strictEqual(media.format, 'image');
  assert.strictEqual(media.imageUrl, img('oferta'));
  assert.strictEqual(media.title, 'Oferta');
  assert.strictEqual(media.body, 'Texto da oferta');
  assert.strictEqual(media.videoUrl, null);
  assert.strictEqual(media.videoId, null);
  assert.strictEqual(media.slides, null);
  assert.strictEqual(media.cards, null);
  assert.deepStrictEqual(pendingLookups(c), { hashes: [], videos: [], posts: [], ig: [] });
});

test('vídeo pede o arquivo mesmo quando a capa já veio', () => {
  const c = {
    object_type: 'VIDEO',
    thumbnail_url: img('mini'),
    video_id: 'v1',
    object_story_spec: { video_data: { video_id: 'v1', image_url: img('capa'), title: 'Depoimento', message: 'Assista' } },
  };
  assert.deepStrictEqual(pendingLookups(c).videos, ['v1']);
  const plain = pickCreativeMedia(c);
  assert.strictEqual(plain.format, 'video');
  assert.strictEqual(plain.imageUrl, img('capa'));
  assert.strictEqual(plain.videoUrl, null);
  const media = pickCreativeMedia(c, {
    sources: { v1: mp4('v1') },
    permalinks: { v1: '/reel/v1/' },
  });
  assert.strictEqual(media.format, 'video');
  assert.strictEqual(media.videoId, 'v1');
  assert.strictEqual(media.videoUrl, mp4('v1'));
  assert.strictEqual(media.imageUrl, img('capa'));
  assert.strictEqual(media.videoPermalink, 'https://www.facebook.com/reel/v1/');
  assert.strictEqual(media.slides, null);
});

test('source que não é https é ignorado', () => {
  const c = { object_type: 'VIDEO', video_id: 'v9', object_story_spec: { video_data: { video_id: 'v9', image_url: img('capa') } } };
  const media = pickCreativeMedia(c, { sources: { v9: 'http://inseguro/v.mp4' } });
  assert.strictEqual(media.videoUrl, null);
  assert.strictEqual(media.imageUrl, img('capa'));
});

test('carrossel devolve cada card, inclusive o card de vídeo', () => {
  const c = {
    object_story_spec: {
      link_data: {
        message: 'Veja os serviços',
        child_attachments: [
          { name: 'Card A', description: 'Primeiro', picture: img('a') },
          { name: 'Card B', description: 'Vídeo', image_hash: 'h2', video_id: 'v2' },
          { name: 'Card C', picture: img('c') },
        ],
      },
    },
  };
  const need = pendingLookups(c);
  assert.deepStrictEqual(need.videos, ['v2']);
  assert.deepStrictEqual(need.hashes, ['h2']);
  const media = pickCreativeMedia(c, {
    hashes: { h2: img('b') },
    videos: { v2: img('capa-b') },
    sources: { v2: mp4('v2') },
  });
  assert.strictEqual(media.format, 'carousel');
  assert.strictEqual(media.cards, 3);
  assert.strictEqual(media.imageUrl, img('a'));
  assert.strictEqual(media.videoUrl, null);
  assert.strictEqual(media.slides.length, 3);
  assert.strictEqual(media.slides[0].kind, 'image');
  assert.strictEqual(media.slides[0].title, 'Card A');
  assert.strictEqual(media.slides[1].kind, 'video');
  assert.strictEqual(media.slides[1].imageUrl, img('b'));
  assert.strictEqual(media.slides[1].videoUrl, mp4('v2'));
  assert.strictEqual(media.slides[2].imageUrl, img('c'));
});

test('carrossel de publicação (sem child_attachments) usa os subattachments', () => {
  const c = { object_type: 'SHARE', effective_object_story_id: '10_20', thumbnail_url: img('mini') };
  assert.ok(pendingLookups(c).posts.includes('10_20'));
  const story = parseStory({
    full_picture: img('full'),
    attachments: { data: [{ media_type: 'album', subattachments: { data: [
      { media_type: 'photo', title: 'Um', media: { image: { src: img('1') } } },
      { media_type: 'video', title: 'Dois', target: { id: '77' }, media: { image: { src: img('2') }, source: mp4('77') } },
    ] } }] },
  });
  const media = pickCreativeMedia(c, { stories: { '10_20': story }, sources: { 77: mp4('melhor') } });
  assert.strictEqual(media.format, 'carousel');
  assert.strictEqual(media.slides.length, 2);
  assert.strictEqual(media.slides[1].videoId, '77');
  assert.strictEqual(media.slides[1].videoUrl, mp4('melhor'));
  assert.strictEqual(media.slides[1].imageUrl, img('2'));
});

test('vídeo da publicação entra quando o criativo não traz video_id', () => {
  const story = parseStory({
    attachments: { data: [{ media_type: 'video', target: { id: '55' }, media: { image: { src: img('capa') }, source: mp4('55') } }] },
  });
  assert.strictEqual(story.videoId, '55');
  assert.strictEqual(story.slides, null);
  const c = { object_type: 'VIDEO', effective_object_story_id: '1_2', thumbnail_url: img('mini') };
  const media = pickCreativeMedia(c, { stories: { '1_2': story } });
  assert.strictEqual(media.format, 'video');
  assert.strictEqual(media.videoId, '55');
  assert.strictEqual(media.videoUrl, mp4('55'));
  assert.strictEqual(media.imageUrl, img('capa'));
});

test('carrossel do Instagram e vídeo do Instagram', () => {
  const carousel = parseIgMedia({
    media_type: 'CAROUSEL_ALBUM',
    children: { data: [
      { media_type: 'IMAGE', media_url: img('ig1') },
      { media_type: 'VIDEO', media_url: mp4('ig'), thumbnail_url: img('ig-capa') },
    ] },
  });
  const c = { effective_instagram_media_id: 'ig9', thumbnail_url: img('mini') };
  const media = pickCreativeMedia(c, { ig: { ig9: carousel } });
  assert.strictEqual(media.format, 'carousel');
  assert.strictEqual(media.slides[1].kind, 'video');
  assert.strictEqual(media.slides[1].videoUrl, mp4('ig'));
  assert.strictEqual(media.slides[1].imageUrl, img('ig-capa'));

  const video = parseIgMedia({ media_type: 'VIDEO', media_url: mp4('reel'), thumbnail_url: img('reel') });
  const one = pickCreativeMedia({ effective_instagram_media_id: 'ig1', object_type: 'VIDEO' }, { ig: { ig1: video } });
  assert.strictEqual(one.format, 'video');
  assert.strictEqual(one.videoUrl, mp4('reel'));
  assert.strictEqual(one.imageUrl, img('reel'));
});

test('se o source do vídeo falta, pede a mídia do Instagram', () => {
  const c = {
    object_type: 'VIDEO',
    video_id: 'v1',
    effective_instagram_media_id: 'ig1',
    object_story_spec: { video_data: { video_id: 'v1', image_url: img('capa') } },
  };
  assert.deepStrictEqual(extraIgIds(c, { sources: {} }), ['ig1']);
  assert.deepStrictEqual(extraIgIds(c, { sources: { v1: mp4('v1') } }), []);
  assert.deepStrictEqual(extraIgIds(c, { sources: {}, ig: { ig1: { videoUrl: mp4('ig') } } }), []);
});

test('asset_feed de carrossel vira cards; criativo dinâmico de um vídeo não', () => {
  const carousel = {
    asset_feed_spec: {
      ad_formats: ['CAROUSEL'],
      images: [{ hash: 'ha' }, { url: img('b') }],
      titles: [{ text: 'T1' }, { text: 'T2' }],
    },
  };
  assert.deepStrictEqual(pendingLookups(carousel).hashes, ['ha']);
  const media = pickCreativeMedia(carousel, { hashes: { ha: img('a') } });
  assert.strictEqual(media.format, 'carousel');
  assert.strictEqual(media.slides[0].imageUrl, img('a'));
  assert.strictEqual(media.slides[0].title, 'T1');
  assert.strictEqual(media.slides[1].imageUrl, img('b'));

  const dynamic = {
    video_id: 'v1',
    asset_feed_spec: { videos: [{ video_id: 'v1', thumbnail_url: img('capa') }, { video_id: 'v2' }], bodies: [{ text: 'A' }, { text: 'B' }] },
  };
  const dyn = pickCreativeMedia(dynamic, { sources: { v1: mp4('v1') } });
  assert.strictEqual(dyn.format, 'video');
  assert.strictEqual(dyn.dynamic, true);
  assert.strictEqual(dyn.slides, null);
  assert.strictEqual(dyn.videoUrl, mp4('v1'));
  assert.deepStrictEqual(pendingLookups(dynamic).videos, ['v1']);
});

test('template_data de catálogo sem imagem fixa continua carrossel, mas sem mídia', () => {
  const c = {
    object_story_spec: { template_data: { child_attachments: [{ name: '{{product.name}}' }, { name: '{{product.name}}' }, { name: '{{product.name}}' }] } },
  };
  const media = pickCreativeMedia(c);
  assert.strictEqual(media.format, 'carousel');
  assert.strictEqual(media.cards, 3);
  assert.strictEqual(media.slides.every((s) => !s.imageUrl && !s.videoUrl), true);
});

test('permalink relativo vira link da Meta e lixo é descartado', () => {
  assert.strictEqual(absPermalink('/watch/?v=1'), 'https://www.facebook.com/watch/?v=1');
  assert.strictEqual(absPermalink('javascript:alert(1)'), null);
  assert.strictEqual(absPermalink('https://www.facebook.com/reel/1/'), 'https://www.facebook.com/reel/1/');
});

test('modo de teste: vídeo tem arquivo e carrossel tem um card de vídeo', () => {
  const tree = [{
    id: 'c', objective: 'OUTCOME_ENGAGEMENT', status: 'ACTIVE', children: [{
      id: 's', status: 'ACTIVE', optimizationGoal: 'CONVERSATIONS', destinationType: 'WHATSAPP', children: [
        { id: 'a-video', status: 'ACTIVE', mockCreative: { format: 'video', title: 'V', body: 'B' } },
        { id: 'a-car', status: 'ACTIVE', mockCreative: { format: 'carousel', title: 'C', body: 'B', cards: 4 } },
        { id: 'a-img', status: 'ACTIVE', mockCreative: { format: 'image', title: 'I', body: 'B' } },
      ],
    }],
  }];
  mockEnrichMeta(tree, { days: 7 });
  const ads = tree[0].children[0].children;
  const video = ads[0].creative;
  const carousel = ads[1].creative;
  const image = ads[2].creative;
  assert.strictEqual(video.format, 'video');
  assert.match(video.videoUrl, /^data:video\/mp4;base64,/);
  assert.strictEqual(video.slides, null);
  assert.strictEqual(carousel.format, 'carousel');
  assert.strictEqual(carousel.slides.length, 4);
  assert.strictEqual(carousel.cards, 4);
  assert.match(carousel.slides[1].videoUrl, /^data:video\/mp4;base64,/);
  assert.strictEqual(carousel.videoUrl, null);
  assert.strictEqual(image.format, 'image');
  assert.strictEqual(image.videoUrl, null);
  assert.strictEqual(image.slides, null);
  assert.match(image.imageUrl, /^data:image\//);
});

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `função ${name} não encontrada no painel`);
  let i = source.indexOf('{', start);
  let depth = 0;
  for (; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`função ${name} sem fechamento`);
}

function loadPanel(names) {
  const html = fs.readFileSync(path.join(__dirname, '../../index.html'), 'utf8');
  const script = names.map((name) => extractFunction(html, name)).join('\n');
  const ctx = { URL, Date, parseInt, Number, String, Array, Math };
  vm.createContext(ctx);
  vm.runInContext(script, ctx);
  names.forEach((name) => assert.strictEqual(typeof ctx[name], 'function', name));
  return ctx;
}

test('a aba Anúncios só recebe vídeo e carrossel, sem link inseguro', () => {
  assert.strictEqual(clientCreative({ format: 'image', imageUrl: img('a') }), null);
  const video = clientCreative({ format: 'video', imageUrl: img('capa'), videoUrl: mp4('ok'), videoPermalink: '/reel/2/', title: 'T', body: 'B' });
  assert.strictEqual(video.format, 'video');
  assert.strictEqual(video.videoUrl, mp4('ok'));
  assert.strictEqual(video.videoPermalink, 'https://www.facebook.com/reel/2/');
  assert.strictEqual(video.slides, null);
  const bad = clientCreative({ format: 'video', videoUrl: 'javascript:alert(1)', imageUrl: 'http://insecure/a.jpg' });
  assert.strictEqual(bad.videoUrl, null);
  assert.strictEqual(bad.imageUrl, null);
  const car = clientCreative({
    format: 'carousel',
    slides: [{ imageUrl: img('a'), kind: 'image' }, { imageUrl: img('b'), videoUrl: mp4('c'), kind: 'video' }],
  });
  assert.strictEqual(car.cards, 2);
  assert.strictEqual(car.videoUrl, null);
  assert.strictEqual(car.slides[1].kind, 'video');
  assert.strictEqual(car.slides[1].videoUrl, mp4('c'));
});

test('relatório de exemplo da aba Anúncios traz vídeo e carrossel', () => {
  const report = require('../src/data/mockMetaReport').build({ from: '2026-10-01', to: '2026-10-07' });
  const video = report.ads.find((a) => a.name.startsWith('video_'));
  const carousel = report.ads.find((a) => a.name.startsWith('carrossel_'));
  const image = report.ads.find((a) => a.name.startsWith('estatico_'));
  assert.strictEqual(video.creative.format, 'video');
  assert.match(video.creative.videoUrl, /^data:video\/mp4;base64,/);
  assert.strictEqual(video.creative.slides, null);
  assert.match(video.thumbnailUrl, /^data:image\//);
  assert.strictEqual(carousel.creative.format, 'carousel');
  assert.strictEqual(carousel.creative.slides.length, 4);
  assert.match(carousel.creative.slides[1].videoUrl, /^data:video\/mp4;base64,/);
  assert.strictEqual(image.creative, undefined);
  assert.strictEqual(image.thumbnailUrl, null);
});

test('a prévia monta player, carrossel e trata link expirado', () => {
  const ui = loadPanel(['escapeHtml', 'escapeAttr', 'mgIdAttr', 'mgSafeMediaUrl', 'mgLinkExpired', 'mgRetryBtn', 'mgVideoHtml', 'mgCarouselHtml', 'mgStageHtml']);
  const future = 'FFFFFFFF';
  const past = '1';
  assert.strictEqual(ui.mgLinkExpired(`https://video.xx.fbcdn.net/v/a.mp4?oe=${future}`), false);
  assert.strictEqual(ui.mgLinkExpired(`https://video.xx.fbcdn.net/v/a.mp4?oe=${past}`), true);
  assert.strictEqual(ui.mgLinkExpired('https://cdn.example/a.jpg'), false);

  const image = ui.mgStageHtml({ format: 'image', imageUrl: img('a'), videoUrl: mp4('nao'), slides: [{ imageUrl: img('a') }, { imageUrl: img('b') }] }, '10', false);
  assert.match(image, /<img /);
  assert.doesNotMatch(image, /<video/);
  assert.doesNotMatch(image, /mg-slide/);

  const video = ui.mgStageHtml({ format: 'video', imageUrl: img('capa'), videoUrl: mp4('ok'), videoPermalink: 'https://www.facebook.com/reel/1/' }, '11', false);
  assert.match(video, /<video[^>]*playsinline/);
  assert.match(video, /controls/);
  assert.match(video, new RegExp(img('capa').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(video, /Abrir o vídeo na Meta/);

  const expired = ui.mgStageHtml({ format: 'video', imageUrl: img('capa'), videoUrl: `https://video.xx.fbcdn.net/v/a.mp4?oe=${past}` }, '12', false);
  assert.doesNotMatch(expired, /<video/);
  assert.match(expired, /expirou/);
  assert.match(expired, /Buscar de novo/);
  assert.match(expired, /mgRefreshPreview\('12'\)/);

  const blocked = ui.mgStageHtml({ format: 'video', imageUrl: img('capa'), videoUrl: null, videoPermalink: 'https://www.facebook.com/reel/9/' }, '13', false);
  assert.match(blocked, /não liberou o arquivo/);
  assert.match(blocked, /Abrir o vídeo na Meta/);
  assert.match(blocked, /https:\/\/www\.facebook\.com\/reel\/9\//);

  const carousel = ui.mgStageHtml({
    format: 'carousel',
    imageUrl: img('a'),
    slides: [
      { kind: 'image', imageUrl: img('a'), title: 'Um', body: 'Texto 1' },
      { kind: 'video', imageUrl: img('b'), videoUrl: mp4('card'), title: 'Dois' },
      { kind: 'image', imageUrl: img('c'), title: 'Três' },
    ],
  }, '14', false);
  assert.strictEqual((carousel.match(/class="mg-slide"/g) || []).length, 3);
  assert.match(carousel, /mg-car-scroll/);
  assert.match(carousel, /Arraste para o lado/);
  assert.match(carousel, /1 de 3/);
  assert.match(carousel, /playsinline/);
  assert.match(carousel, /Card anterior/);
  assert.match(carousel, /Próximo card/);

  const catalog = ui.mgStageHtml({
    format: 'carousel',
    slides: [{ title: '{{product.name}}' }, { title: '{{product.name}}' }],
  }, '15', false);
  assert.match(catalog, /não tem imagens fixas/);
  assert.doesNotMatch(catalog, /<video/);

  const google = ui.mgStageHtml({ format: 'video', imageUrl: img('g'), videoUrl: mp4('g'), headlines: ['A'] }, '16', true);
  assert.match(google, /<img /);
  assert.doesNotMatch(google, /<video/);
});

test('na aba Anúncios, vídeo e carrossel abrem a prévia e imagem continua miniatura', () => {
  const ui = loadPanel(['escapeHtml', 'escapeAttr', 'mgIdAttr', 'mgSafeMediaUrl', 'mgLinkExpired', 'mgRetryBtn', 'mgVideoHtml', 'mgCarouselHtml', 'mgStageHtml', 'adPreviewable', 'adPlayThumbHtml', 'adThumbHtml2', 'adPreviewBodyHtml']);
  const imageAd = { id: '1', name: 'Foto', thumbnailUrl: img('foto') };
  const videoAd = { id: '2', name: 'Filme', thumbnailUrl: img('capa'), creative: { format: 'video', imageUrl: img('capa'), videoUrl: mp4('ok'), title: 'Olá', body: 'Texto' } };
  const carAd = { id: '3', name: 'Cards', thumbnailUrl: img('a'), creative: { format: 'carousel', slides: [{ kind: 'image', imageUrl: img('a'), title: 'Um' }, { kind: 'video', imageUrl: img('b'), videoUrl: mp4('card'), title: 'Dois' }] } };
  assert.strictEqual(ui.adPreviewable(imageAd), false);
  assert.strictEqual(ui.adPreviewable(videoAd), true);
  const still = ui.adThumbHtml2(imageAd);
  assert.match(still, /<img /);
  assert.doesNotMatch(still, /adOpenPreview/);
  assert.match(still, /ad-preview/);
  const play = ui.adThumbHtml2(videoAd);
  assert.match(play, /adOpenPreview\('2'\)/);
  assert.match(play, /Assistir vídeo/);
  assert.doesNotMatch(play, /ad-preview/);
  const body = ui.adPreviewBodyHtml(videoAd);
  assert.match(body, /<video[^>]*playsinline/);
  assert.match(body, /Buscar de novo/);
  const cards = ui.adPreviewBodyHtml(carAd);
  assert.strictEqual((cards.match(/class="mg-slide"/g) || []).length, 2);
  assert.match(ui.adPlayThumbHtml(carAd), /Ver cards do carrossel/);
});
