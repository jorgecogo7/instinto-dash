// Relatório de exemplo do Instagram orgânico (mesmo formato do
// instagramService real) — usado só sem token da Meta, com
// USE_MOCK_DATA=true ou quando o cliente ainda não tem o Instagram
// Business cadastrado. Determinístico a partir do período.
const period = require('../lib/period');

function rng(seed) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

const CAPTIONS = [
  'Bastidores de um dia de trabalho com a equipe — é assim que cuidamos de cada detalhe.',
  'Antes e depois de um projeto entregue esta semana. Arrasta pro lado pra ver o resultado!',
  'Três dúvidas que a gente mais escuta dos clientes, respondidas de uma vez.',
  'Depoimento de quem já passou por aqui. Obrigado pela confiança!',
  'Novidade chegando: agenda aberta para o próximo mês. Chama no direct.',
  'Dica rápida pra você aproveitar melhor o nosso serviço.',
  'Conheça quem faz acontecer por trás das câmeras.',
  'Promoção da semana: condições especiais até sexta-feira.',
];

function build(range) {
  const seed = Number(range.from.replace(/-/g, '')) % 100000;
  const rand = rng(seed);
  const days = period.eachDay(range);

  let followers = 4820;
  const daily = days.map((date, i) => {
    const newFollowers = Math.max(0, Math.round(Math.sin(i / 3) * 3 + 5 + rand() * 6));
    followers += newFollowers;
    const reach = Math.round(1800 + rand() * 2600 + (i % 7 === 0 ? 2400 : 0));
    return { date, newFollowers, reach };
  });
  const newFollowers = daily.reduce((s, d) => s + d.newFollowers, 0);
  const reach = daily.reduce((s, d) => s + d.reach, 0);

  const types = ['REEL', 'IMAGEM', 'CARROSSEL', 'REEL', 'IMAGEM', 'REEL', 'CARROSSEL', 'IMAGEM'];
  const postCount = Math.min(12, Math.max(3, Math.round(days.length / 3)));
  const posts = Array.from({ length: postCount }, (_, i) => {
    const type = types[i % types.length];
    const r = Math.round((type === 'REEL' ? 1600 : 700) * (0.4 + rand() * 1.4));
    const dayIdx = Math.min(days.length - 1, Math.floor((i / postCount) * days.length));
    return {
      id: `mock_post_${i + 1}`,
      caption: CAPTIONS[i % CAPTIONS.length],
      type,
      thumbnailUrl: null,
      permalink: null,
      timestamp: `${days[days.length - 1 - dayIdx]}T18:00:00+0000`,
      likes: Math.round(r * (0.03 + rand() * 0.05)),
      comments: Math.round(rand() * 9),
      reach: r,
      saved: Math.round(rand() * 14),
      shares: Math.round(rand() * 10),
      views: type === 'REEL' ? Math.round(r * 1.35) : null,
      interactions: null,
    };
  });

  return {
    mock: true,
    range,
    previousRange: period.previousRange(range),
    updatedAt: new Date().toISOString(),
    profile: {
      username: 'seucliente.oficial',
      displayName: 'Seu Cliente | Nicho do negócio',
      bio: 'Descrição curta do perfil, igual aparece na bio do Instagram.\nChame a atenção pro diferencial do negócio aqui.',
      link: 'https://wa.me/5500000000000',
      pictureUrl: null,
      avatarInitials: 'SC',
      postsCount: 186,
      followersCount: followers,
      followingCount: 412,
    },
    metrics: {
      followers,
      posts: 186,
      postsInPeriod: posts.length,
      newFollowers,
      newFollowersDeltaPct: -12.4,
      engagedAccounts: Math.round(reach * 0.011),
      engagedAccountsDeltaPct: 8.6,
      reach,
      reachDeltaPct: 21.2,
      profileVisits: Math.round(reach * 0.014),
      profileVisitsDeltaPct: -6.9,
      linkClicks: Math.round(reach * 0.0012) + 3,
      linkClicksDeltaPct: 14.0,
      reachUnique: Math.round(reach * 0.42), reachUniqueDeltaPct: 17.5,
      views: Math.round(reach * 2.6), viewsDeltaPct: 24.1,
      interactions: Math.round(reach * 0.05), interactionsDeltaPct: 9.8,
      likes: Math.round(reach * 0.038), likesDeltaPct: 7.2,
      comments: Math.round(reach * 0.004), commentsDeltaPct: -3.1,
      shares: Math.round(reach * 0.005), sharesDeltaPct: 31.0,
      saves: Math.round(reach * 0.003), savesDeltaPct: 12.4,
      engagementRate: (0.05 / 0.42) * 100,
    },
    reachByFollow: { FOLLOWER: Math.round(reach * 0.12), NON_FOLLOWER: Math.round(reach * 0.30) },
    reachByType: { REEL: Math.round(reach * 0.26), POST: Math.round(reach * 0.11), STORY: Math.round(reach * 0.05) },
    onlineByHour: [120, 80, 50, 30, 25, 40, 110, 260, 420, 510, 560, 590, 640, 610, 580, 600, 650, 720, 860, 980, 1050, 990, 720, 330],
    daily,
    demographics: {
      source: 'followers',
      age: [
        { label: '13-17', value: 12 }, { label: '18-24', value: 380 }, { label: '25-34', value: 1450 },
        { label: '35-44', value: 1720 }, { label: '45-54', value: 980 }, { label: '55-64', value: 420 }, { label: '65+', value: 160 },
      ],
      gender: [
        { label: 'Feminino', value: 2950 }, { label: 'Masculino', value: 1820 }, { label: 'Desconhecido', value: 360 },
      ],
      cities: [
        { label: 'São Paulo, São Paulo (state)', value: 2210 }, { label: 'Osasco, São Paulo (state)', value: 420 },
        { label: 'Guarulhos, São Paulo (state)', value: 260 }, { label: 'Santo André, São Paulo (state)', value: 190 },
        { label: 'Campinas, São Paulo (state)', value: 150 }, { label: 'Rio de Janeiro, Rio de Janeiro (state)', value: 120 },
      ],
      countries: [
        { label: 'BR', value: 5010 }, { label: 'US', value: 34 }, { label: 'PT', value: 21 }, { label: 'AR', value: 8 },
      ],
    },
    posts,
  };
}

module.exports = { build };
