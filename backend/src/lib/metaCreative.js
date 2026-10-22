/**
 * Escolhe a melhor imagem e o texto de um criativo da Meta.
 *
 * Por que isso existe: o campo thumbnail_url do criativo é uma miniatura
 * gerada pela Meta. Em vídeo, em criativo dinâmico (Advantage+, asset_feed_spec)
 * e em anúncio feito a partir de publicação, ela costuma vir minúscula, borrada
 * ou como um quadro preto. A imagem "de verdade" fica em outros lugares:
 * object_story_spec (imagem, vídeo ou 1º card do carrossel), image_url,
 * asset_feed_spec ou a publicação (full_picture). thumbnail_url fica por último.
 */

// Campos pedidos para cada criativo (servem para /ads?fields=creative{...}).
const CREATIVE_FIELDS = 'id,object_type,thumbnail_url,image_url,image_hash,title,body,video_id,effective_object_story_id,object_story_spec,asset_feed_spec';

const first = (list) => (Array.isArray(list) && list.length ? list[0] : null);
const clean = (s) => (typeof s === 'string' && s.trim() ? s.trim() : null);

// Hashes de imagem e vídeos que precisam de uma consulta extra para virar URL.
// Só pede consulta extra quando o criativo não trouxe nenhuma imagem direta.
function pendingLookups(c) {
  const direct = pickCreativeMedia(c);
  if (!c || (direct && direct.source && direct.source !== 'miniatura da Meta')) return { hashes: [], videos: [], posts: [] };
  const oss = (c && c.object_story_spec) || {};
  const ld = oss.link_data || {};
  const vd = oss.video_data || {};
  const pd = oss.photo_data || {};
  const afs = (c && c.asset_feed_spec) || {};
  const card = first(ld.child_attachments) || {};
  const hashes = [
    !card.picture && card.image_hash, !ld.picture && ld.image_hash, !vd.image_url && vd.image_hash,
    !pd.url && pd.image_hash, c && c.image_hash, !(first(afs.images) || {}).url && (first(afs.images) || {}).hash,
  ].filter(Boolean);
  const videos = [!vd.image_url && vd.video_id, c && c.video_id, !(first(afs.videos) || {}).thumbnail_url && (first(afs.videos) || {}).video_id].filter(Boolean);
  const posts = [c && c.effective_object_story_id].filter(Boolean);
  return { hashes, videos, posts };
}

/**
 * lookups: { hashes: {hash: url}, videos: {videoId: url}, posts: {postId: url} }
 * Devolve { format, imageUrl, thumbUrl, title, body, cards, dynamic, source } ou null.
 */
function pickCreativeMedia(c, lookups = {}) {
  if (!c) return null;
  const H = lookups.hashes || {};
  const V = lookups.videos || {};
  const P = lookups.posts || {};
  const oss = c.object_story_spec || {};
  const ld = oss.link_data || {};
  const vd = oss.video_data || {};
  const pd = oss.photo_data || {};
  const afs = c.asset_feed_spec || {};
  const cards = Array.isArray(ld.child_attachments) ? ld.child_attachments : [];
  const card = cards[0] || {};
  const afsImg = first(afs.images) || {};
  const afsVid = first(afs.videos) || {};
  const videoId = vd.video_id || c.video_id || afsVid.video_id || null;
  const dynamic = ['images', 'videos', 'bodies', 'titles'].some((k) => Array.isArray(afs[k]) && afs[k].length > 1);

  let format = 'image';
  if (cards.length > 1) format = 'carousel';
  else if (videoId || String(c.object_type || '').toUpperCase() === 'VIDEO') format = 'video';

  const candidates = [];
  const add = (url, source) => { if (clean(url)) candidates.push({ url: url.trim(), source }); };
  if (format === 'carousel') {
    add(card.picture, 'carrossel (1º card)');
    add(H[card.image_hash], 'carrossel (1º card)');
  }
  if (format === 'video') {
    add(vd.image_url, 'capa do vídeo');
    add(H[vd.image_hash], 'capa do vídeo');
    add(afsVid.thumbnail_url, 'capa do vídeo');
    add(V[videoId], 'capa do vídeo');
  }
  add(ld.picture, 'imagem do anúncio');
  add(H[ld.image_hash], 'imagem do anúncio');
  add(pd.url, 'imagem do anúncio');
  add(H[pd.image_hash], 'imagem do anúncio');
  add(c.image_url, 'imagem do anúncio');
  add(H[c.image_hash], 'imagem do anúncio');
  add(afsImg.url, 'imagem do criativo dinâmico');
  add(H[afsImg.hash], 'imagem do criativo dinâmico');
  add(P[c.effective_object_story_id], 'imagem da publicação');
  add(c.thumbnail_url, 'miniatura da Meta');

  const body = clean(ld.message) || clean(vd.message) || clean(pd.caption) || clean(c.body) || clean((first(afs.bodies) || {}).text);
  const title = clean(ld.name) || clean(vd.title) || clean(card.name) || clean(c.title) || clean((first(afs.titles) || {}).text);
  const best = candidates[0] || null;
  return {
    format,
    imageUrl: best ? best.url : null,
    thumbUrl: clean(c.thumbnail_url) || (best ? best.url : null),
    source: best ? best.source : null,
    title: title ? title.slice(0, 160) : null,
    body: body ? body.slice(0, 400) : null,
    cards: cards.length > 1 ? cards.length : null,
    dynamic,
  };
}

module.exports = { CREATIVE_FIELDS, pickCreativeMedia, pendingLookups };
