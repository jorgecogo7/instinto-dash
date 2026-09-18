// Formato pensado para espelhar o que a Instagram Graph API devolve pra
// uma conta Business/Creator vinculada a uma Página do Facebook: dados de
// perfil (biografia, seguidores, publicações) + métricas de insights
// (alcance, visitas ao perfil, cliques no link, contas com engajamento)
// agregadas por dia — usado só quando USE_MOCK_DATA=true ou antes das
// credenciais do Instagram Business estarem configuradas.

function buildDaily(days) {
  const out = [];
  let followers = 820;
  for (let i = 0; i < days; i++) {
    const newFollowers = Math.max(0, Math.round(Math.sin(i / 3) * 2 + 1 + Math.random() * 3));
    followers += newFollowers;
    const reach = Math.round(900 + Math.random() * 2600 + (i % 7 === 0 ? 1800 : 0));
    out.push({
      date: new Date(Date.now() - (days - 1 - i) * 86400000).toISOString().slice(0, 10),
      newFollowers,
      reach,
      followersTotal: followers,
    });
  }
  return out;
}

const daily = buildDaily(30);
const totalNewFollowers = daily.reduce((s, d) => s + d.newFollowers, 0);
const totalReach = daily.reduce((s, d) => s + d.reach, 0);

const profile = {
  username: 'seucliente.oficial',
  displayName: 'Seu Cliente | Nicho do negócio',
  bio: 'Descrição curta do perfil, igual aparece na bio do Instagram.\nChame a atenção pro diferencial do negócio aqui.',
  avatarInitials: 'SC',
  link: 'https://wa.me/5500000000000',
  postsCount: 18,
  followersCount: daily[daily.length - 1].followersTotal,
  followingCount: 412,
};

const metrics = {
  followers: profile.followersCount,
  posts: profile.postsCount,
  newFollowers: totalNewFollowers,
  newFollowersDeltaPct: 32.4,
  engagedAccounts: Math.round(totalReach * 0.09),
  engagedAccountsDeltaPct: 18.6,
  reach: totalReach,
  reachDeltaPct: 41.2,
  profileVisits: Math.round(totalReach * 0.05),
  profileVisitsDeltaPct: 22.9,
  linkClicks: Math.round(totalReach * 0.0015) + 3,
  linkClicksDeltaPct: 12.0,
};

module.exports = {
  range: { from: daily[0].date, to: daily[daily.length - 1].date },
  profile,
  metrics,
  daily,
};
