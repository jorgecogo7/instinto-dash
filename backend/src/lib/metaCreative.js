/**
 * Escolhe a imagem, o vídeo e os cards de um criativo da Meta.
 *
 * A miniatura (thumbnail_url) fica por último: em vídeo, carrossel e
 * criativo dinâmico ela costuma vir pequena ou preta. A mídia de verdade
 * está no object_story_spec (imagem, vídeo ou cards), no asset_feed_spec,
 * no vídeo (source) ou na publicação.
 *
 * O campo source do vídeo é um link temporário da Meta. Quem exibe precisa
 * tratar quando ele expirar.
 */

// Campos pedidos para cada criativo (servem para /ads?fields=creative{...}).
const CREATIVE_FIELDS = 'id,object_type,thumbnail_url,image_url,image_hash,title,body,video_id,effective_object_story_id,object_story_spec,asset_feed_spec';

// Prévia de vídeo e carrossel (Gerenciar e Anúncios). Se a Meta recusar algum, a leitura cai no conjunto acima.
const CREATIVE_PLAYBACK_FIELDS = `${CREATIVE_FIELDS},object_story_id,effective_instagram_media_id,source_instagram_media_id`;

const STORY_FIELDS = 'full_picture,attachments{media_type,type,title,description,target{id},media{image,source},subattachments{media_type,type,title,description,target{id},media{image,source}}}';
const IG_FIELDS = 'media_type,media_url,thumbnail_url,children{media_type,media_url,thumbnail_url}';
const VIDEO_FIELDS = 'source,picture,permalink_url,thumbnails{uri,is_preferred,width}';
const VIDEO_FIELDS_SAFE = 'picture,permalink_url,thumbnails{uri,is_preferred,width}';

const first = (list) => (Array.isArray(list) && list.length ? list[0] : null);
const clean = (s) => (typeof s === 'string' && s.trim() ? s.trim() : null);
const clip = (s, n) => { const c = clean(s); return c ? c.slice(0, n) : null; };
const httpsUrl = (s) => { const c = clean(s); return c && /^https:\/\//i.test(c) ? c : null; };
const idOf = (v) => { const s = clean(v == null ? '' : String(v)); return s || null; };

function childAttachments(c) {
  const oss = (c && c.object_story_spec) || {};
  const lists = [
    oss.link_data && oss.link_data.child_attachments,
    oss.template_data && oss.template_data.child_attachments,
  ].filter((a) => Array.isArray(a) && a.length);
  lists.sort((a, b) => b.length - a.length);
  return lists[0] || [];
}

function storyIdOf(c) {
  return idOf(c && (c.effective_object_story_id || c.object_story_id));
}

function igIdOf(c) {
  return idOf(c && (c.effective_instagram_media_id || c.source_instagram_media_id));
}

function afsIsCarousel(afs) {
  return (Array.isArray(afs && afs.ad_formats) ? afs.ad_formats : []).some((f) => String(f).toUpperCase().includes('CAROUSEL'));
}

// A publicação precisa ser lida quando o criativo não traz os cards nem o vídeo.
function needsStory(c) {
  if (!storyIdOf(c)) return false;
  if (childAttachments(c).length > 1) return false;
  const oss = c.object_story_spec || {};
  const vd = oss.video_data || {};
  const ld = oss.link_data || {};
  const pd = oss.photo_data || {};
  const afs = c.asset_feed_spec || {};
  if (vd.video_id || c.video_id) return false;
  if (ld.picture || ld.image_hash || pd.url || pd.image_hash) return false;
  if ((Array.isArray(afs.images) && afs.images.length) || (Array.isArray(afs.videos) && afs.videos.length)) return false;
  const type = String(c.object_type || '').toUpperCase();
  if (type === 'PHOTO' && (c.image_url || c.image_hash || c.thumbnail_url)) return false;
  return true;
}

function slideFromCard(card, H, V) {
  const videoId = idOf(card && card.video_id);
  const imageUrl = httpsUrl(card && card.picture)
    || (card && card.image_hash && httpsUrl(H[card.image_hash]))
    || (videoId && httpsUrl(V[videoId]))
    || null;
  return {
    imageUrl,
    videoId,
    videoUrl: null,
    title: clip(card && card.name, 160),
    body: clip(card && (card.description || card.message), 220),
    kind: videoId ? 'video' : 'image',
  };
}

function applySource(slide, sources) {
  const videoUrl = (slide.videoId && httpsUrl(sources[slide.videoId])) || httpsUrl(slide.videoUrl) || null;
  return { ...slide, videoUrl, kind: slide.videoId || videoUrl ? 'video' : 'image' };
}

function mapAttachment(a) {
  const type = String((a && (a.media_type || a.type)) || '').toLowerCase();
  const video = type.includes('video');
  const media = (a && a.media) || {};
  const imageUrl = httpsUrl(media.image && media.image.src);
  const videoUrl = video ? httpsUrl(media.source) : null;
  const videoId = video ? idOf(a.target && a.target.id) : null;
  return {
    imageUrl: imageUrl || null,
    videoId,
    videoUrl,
    title: clip(a && a.title, 160),
    body: clip(a && a.description, 220),
    kind: videoId || videoUrl ? 'video' : 'image',
  };
}

// Publicação da página (anúncio que usa um post pronto): álbum vira cards.
function parseStory(post) {
  const att = first(post && post.attachments && post.attachments.data);
  if (!att) return null;
  const subs = (att.subattachments && att.subattachments.data) || [];
  if (subs.length > 1) {
    const slides = subs.slice(0, 10).map(mapAttachment);
    return { slides, imageUrl: (slides[0] && slides[0].imageUrl) || httpsUrl(post.full_picture), videoId: null, videoUrl: null };
  }
  const one = mapAttachment(att);
  return {
    slides: null,
    imageUrl: one.imageUrl || httpsUrl(post.full_picture),
    videoId: one.videoId,
    videoUrl: one.videoUrl,
  };
}

function mapIgItem(item) {
  const video = String(item && item.media_type || '').toUpperCase() === 'VIDEO';
  const mediaUrl = httpsUrl(item && item.media_url);
  const thumb = httpsUrl(item && item.thumbnail_url);
  return {
    imageUrl: video ? thumb : (mediaUrl || thumb),
    videoId: null,
    videoUrl: video ? mediaUrl : null,
    title: null,
    body: null,
    kind: video ? 'video' : 'image',
  };
}

function parseIgMedia(media) {
  if (!media || media.error || !media.media_type) return null;
  const kids = (media.children && media.children.data) || [];
  if (kids.length > 1 || String(media.media_type).toUpperCase() === 'CAROUSEL_ALBUM') {
    const slides = (kids.length ? kids : [media]).slice(0, 10).map(mapIgItem);
    if (kids.length > 1) return { slides, imageUrl: slides[0].imageUrl, videoId: null, videoUrl: null };
    return { slides: null, imageUrl: slides[0].imageUrl, videoId: null, videoUrl: null, incompleteCarousel: true };
  }
  const one = mapIgItem(media);
  return { slides: null, imageUrl: one.imageUrl, videoId: null, videoUrl: one.videoUrl };
}

function afsSlides(afs, H, V) {
  if (!afsIsCarousel(afs)) return null;
  const images = Array.isArray(afs.images) ? afs.images : [];
  const videos = Array.isArray(afs.videos) ? afs.videos : [];
  const titles = Array.isArray(afs.titles) ? afs.titles : [];
  const descs = Array.isArray(afs.descriptions) ? afs.descriptions : [];
  const slides = [];
  images.forEach((im, i) => {
    slides.push({
      imageUrl: httpsUrl(im && im.url) || (im && im.hash && httpsUrl(H[im.hash])) || null,
      videoId: null,
      videoUrl: null,
      title: clip(titles[i] && titles[i].text, 160),
      body: clip(descs[i] && descs[i].text, 220),
      kind: 'image',
    });
  });
  videos.forEach((v, i) => {
    const videoId = idOf(v && v.video_id);
    const idx = images.length + i;
    slides.push({
      imageUrl: httpsUrl(v && v.thumbnail_url) || (videoId && httpsUrl(V[videoId])) || null,
      videoId,
      videoUrl: null,
      title: clip((titles[idx] || titles[i] || {}).text, 160),
      body: clip((descs[idx] || descs[i] || {}).text, 220),
      kind: videoId ? 'video' : 'image',
    });
  });
  return slides.length > 1 ? slides : null;
}

function absPermalink(url) {
  const c = clean(url);
  if (!c) return null;
  if (/^https:\/\//i.test(c)) return c;
  if (c.startsWith('/')) return `https://www.facebook.com${c}`;
  return null;
}

// Hashes, vídeos e publicações que precisam de uma segunda consulta.
// Vídeo entra mesmo quando a capa já veio: a capa não é o arquivo.
function pendingLookups(c) {
  const empty = { hashes: [], videos: [], posts: [], ig: [] };
  if (!c) return empty;
  const direct = pickCreativeMedia(c);
  const weak = !direct || !direct.imageUrl || direct.source === 'miniatura da Meta';
  const oss = c.object_story_spec || {};
  const ld = oss.link_data || {};
  const vd = oss.video_data || {};
  const pd = oss.photo_data || {};
  const afs = c.asset_feed_spec || {};
  const cards = childAttachments(c);
  const hashes = new Set();
  const videos = new Set();
  const posts = new Set();
  const ig = new Set();
  const addVideo = (id) => { const s = idOf(id); if (s) videos.add(s); };

  addVideo(vd.video_id);
  addVideo(c.video_id);
  cards.forEach((card) => {
    addVideo(card.video_id);
    if (!httpsUrl(card.picture) && card.image_hash) hashes.add(card.image_hash);
  });
  if (afsIsCarousel(afs)) {
    (afs.images || []).forEach((im) => { if (im && !httpsUrl(im.url) && im.hash) hashes.add(im.hash); });
    (afs.videos || []).forEach((v) => addVideo(v && v.video_id));
  } else addVideo((first(afs.videos) || {}).video_id);

  if (weak) {
    if (!httpsUrl(ld.picture) && ld.image_hash) hashes.add(ld.image_hash);
    if (!httpsUrl(vd.image_url) && vd.image_hash) hashes.add(vd.image_hash);
    if (!httpsUrl(pd.url) && pd.image_hash) hashes.add(pd.image_hash);
    if (!httpsUrl(c.image_url) && c.image_hash) hashes.add(c.image_hash);
    const afsImg = first(afs.images) || {};
    if (!httpsUrl(afsImg.url) && afsImg.hash) hashes.add(afsImg.hash);
    if (!afsIsCarousel(afs) && !(first(afs.videos) || {}).thumbnail_url) addVideo((first(afs.videos) || {}).video_id);
    const sid = storyIdOf(c);
    if (sid) posts.add(sid);
  }
  if (needsStory(c)) posts.add(storyIdOf(c));
  const igId = igIdOf(c);
  const specImage = ld.picture || ld.image_hash || pd.url || pd.image_hash || c.image_url || c.image_hash;
  if (igId && cards.length < 2 && !vd.video_id && !c.video_id && !specImage && !(first(afs.videos) || {}).video_id) ig.add(igId);

  return { hashes: [...hashes], videos: [...videos], posts: [...posts], ig: [...ig] };
}

// Quando o vídeo da conta não devolve source, a mídia do Instagram ainda pode.
function extraIgIds(c, lookups) {
  const igId = igIdOf(c);
  if (!igId || (lookups.ig && lookups.ig[igId])) return [];
  const media = pickCreativeMedia(c, lookups);
  if (!media) return [];
  if (media.format === 'video' && !media.videoUrl) return [igId];
  if (media.format === 'carousel' && Array.isArray(media.slides) && media.slides.some((s) => s.kind === 'video' && !s.videoUrl)) return [igId];
  return [];
}

/**
 * lookups: {
 *   hashes: {hash: url}, videos: {videoId: capa}, sources: {videoId: mp4},
 *   permalinks: {videoId: url}, posts: {postId: full_picture},
 *   stories: {postId: parseStory}, ig: {igId: parseIgMedia}
 * }
 * Devolve a prévia pronta pra tela. Imagem continua com slides null.
 */
function pickCreativeMedia(c, lookups = {}) {
  if (!c) return null;
  const H = lookups.hashes || {};
  const V = lookups.videos || {};
  const S = lookups.sources || {};
  const P = lookups.posts || {};
  const stories = lookups.stories || {};
  const igMap = lookups.ig || {};
  const perms = lookups.permalinks || {};
  const oss = c.object_story_spec || {};
  const ld = oss.link_data || {};
  const vd = oss.video_data || {};
  const pd = oss.photo_data || {};
  const afs = c.asset_feed_spec || {};
  const cards = childAttachments(c);
  const afsImg = first(afs.images) || {};
  const afsVid = first(afs.videos) || {};
  const sid = storyIdOf(c);
  const story = sid ? stories[sid] : null;
  const ig = igMap[igIdOf(c)] || null;
  const dynamic = ['images', 'videos', 'bodies', 'titles'].some((k) => Array.isArray(afs[k]) && afs[k].length > 1);

  let videoId = idOf(vd.video_id) || idOf(c.video_id) || idOf(afsVid.video_id) || null;
  if (!videoId && cards.length === 1) videoId = idOf(cards[0].video_id);
  if (!videoId && story && !story.slides) videoId = idOf(story.videoId);

  let slides = null;
  if (cards.length > 1) slides = cards.slice(0, 10).map((card) => slideFromCard(card, H, V));
  else if (story && story.slides && story.slides.length > 1) slides = story.slides.slice(0, 10);
  else if (ig && ig.slides && ig.slides.length > 1) slides = ig.slides.slice(0, 10);
  else {
    const fromAfs = afsSlides(afs, H, V);
    if (fromAfs) slides = fromAfs;
  }
  if (slides) slides = slides.map((s) => applySource(s, S));
  if (slides && slides.length < 2) slides = null;

  const videoUrl = httpsUrl(videoId && S[videoId]) || httpsUrl(story && !story.slides && story.videoUrl) || httpsUrl(ig && ig.videoUrl) || null;
  let format = 'image';
  if (slides && slides.length > 1) format = 'carousel';
  else if (videoId || videoUrl || String(c.object_type || '').toUpperCase() === 'VIDEO') format = 'video';

  const candidates = [];
  const add = (url, source) => { const u = httpsUrl(url); if (u) candidates.push({ url: u, source }); };
  if (format === 'carousel' && slides && slides[0]) add(slides[0].imageUrl, 'carrossel (1º card)');
  if (format === 'video') {
    add(vd.image_url, 'capa do vídeo');
    add(H[vd.image_hash], 'capa do vídeo');
    add(afsVid.thumbnail_url, 'capa do vídeo');
    add(videoId && V[videoId], 'capa do vídeo');
    add(story && story.imageUrl, 'capa do vídeo');
    add(ig && ig.imageUrl, 'capa do vídeo');
  }
  add(ld.picture, 'imagem do anúncio');
  add(H[ld.image_hash], 'imagem do anúncio');
  add(pd.url, 'imagem do anúncio');
  add(H[pd.image_hash], 'imagem do anúncio');
  add(c.image_url, 'imagem do anúncio');
  add(H[c.image_hash], 'imagem do anúncio');
  add(afsImg.url, 'imagem do criativo dinâmico');
  add(H[afsImg.hash], 'imagem do criativo dinâmico');
  add(story && story.imageUrl, 'imagem da publicação');
  add(ig && ig.imageUrl, 'imagem do Instagram');
  add(P[sid], 'imagem da publicação');
  add(c.thumbnail_url, 'miniatura da Meta');

  const body = clip(ld.message, 400) || clip(vd.message, 400) || clip(pd.caption, 400) || clip(c.body, 400) || clip((first(afs.bodies) || {}).text, 400);
  const title = clip(ld.name, 160) || clip(vd.title, 160) || clip(cards[0] && cards[0].name, 160) || clip(c.title, 160) || clip((first(afs.titles) || {}).text, 160);
  const best = candidates[0] || null;
  const permalink = format === 'video' && videoId ? absPermalink(perms[videoId]) : null;

  return {
    format,
    imageUrl: best ? best.url : null,
    thumbUrl: httpsUrl(c.thumbnail_url) || (best ? best.url : null),
    source: best ? best.source : null,
    title,
    body,
    cards: format === 'carousel' && slides ? slides.length : null,
    dynamic,
    videoId: format === 'video' ? videoId : null,
    videoUrl: format === 'video' ? videoUrl : null,
    videoPermalink: format === 'video' ? permalink : null,
    slides: format === 'carousel' ? slides : null,
  };
}

// O que a aba Anúncios (e o link do cliente) pode receber. Imagem fica de fora:
// a miniatura que já existia continua igual. Só entra https ou o vídeo de exemplo.
function safeMediaUrl(s) {
  const c = clean(s);
  if (!c) return null;
  if (/^https:\/\//i.test(c)) return c;
  if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(c)) return c;
  if (/^data:video\/mp4;base64,/i.test(c)) return c;
  return null;
}

function clientCreative(media) {
  if (!media || (media.format !== 'video' && media.format !== 'carousel')) return null;
  const slide = (s) => ({
    imageUrl: safeMediaUrl(s && s.imageUrl),
    videoUrl: safeMediaUrl(s && s.videoUrl),
    title: clip(s && s.title, 160),
    body: clip(s && s.body, 400),
    kind: s && (s.kind === 'video' || safeMediaUrl(s.videoUrl)) ? 'video' : 'image',
  });
  const slides = media.format === 'carousel' && Array.isArray(media.slides) ? media.slides.slice(0, 10).map(slide) : null;
  return {
    format: media.format,
    imageUrl: safeMediaUrl(media.imageUrl),
    videoUrl: media.format === 'video' ? safeMediaUrl(media.videoUrl) : null,
    videoPermalink: media.format === 'video' ? absPermalink(media.videoPermalink) : null,
    title: clip(media.title, 160),
    body: clip(media.body, 400),
    cards: media.format === 'carousel' ? (slides ? slides.length : (Number(media.cards) || null)) : null,
    dynamic: !!media.dynamic,
    slides,
  };
}

module.exports = {
  CREATIVE_FIELDS,
  CREATIVE_PLAYBACK_FIELDS,
  STORY_FIELDS,
  IG_FIELDS,
  VIDEO_FIELDS,
  VIDEO_FIELDS_SAFE,
  pickCreativeMedia,
  pendingLookups,
  extraIgIds,
  parseStory,
  parseIgMedia,
  absPermalink,
  clientCreative,
};
