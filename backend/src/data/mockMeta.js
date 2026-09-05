// Formato pensado para espelhar o que a Graph Marketing API devolve
// (campaign -> adsets -> ads, com "insights" agregados por nível),
// para que trocar por dados reais mude só o serviço, não o formato.

module.exports = {
  campaigns: [
    {
      id: 'cmp_1001',
      name: 'Conversão · Remarketing 30 dias',
      objective: 'CONVERSIONS',
      status: 'ACTIVE',
      insights: { spend: 3240, ctr: 3.8, cpc: 1.42, conversions: 142, targetPerformancePct: 128 },
      adsets: [
        {
          id: 'adset_2001',
          name: 'Remarketing quente',
          ads: [
            { id: 'ad_3001', name: 'Carrossel · Coleção Verão', insights: { spend: 1180, ctr: 4.6, cpc: 1.20, conversions: 64, targetPerformancePct: 140 } },
            { id: 'ad_3002', name: 'Vídeo · Depoimento cliente', insights: { spend: 940, ctr: 3.9, cpc: 1.35, conversions: 41, targetPerformancePct: 118 } },
          ],
        },
        {
          id: 'adset_2002',
          name: 'Remarketing morno',
          ads: [
            { id: 'ad_3003', name: 'Estático · Frete grátis', insights: { spend: 1120, ctr: 2.7, cpc: 1.68, conversions: 37, targetPerformancePct: 96 } },
          ],
        },
      ],
    },
    {
      id: 'cmp_1002',
      name: 'Prospecção · Lookalike 1%',
      objective: 'CONVERSIONS',
      status: 'ACTIVE',
      insights: { spend: 2860, ctr: 2.1, cpc: 1.95, conversions: 67, targetPerformancePct: 92 },
      adsets: [
        {
          id: 'adset_2003',
          name: 'LAL 1% compradores',
          ads: [
            { id: 'ad_3004', name: 'Carrossel · Novidades', insights: { spend: 1540, ctr: 2.3, cpc: 1.80, conversions: 39, targetPerformancePct: 104 } },
            { id: 'ad_3005', name: 'Estático · Prova social', insights: { spend: 1320, ctr: 1.8, cpc: 2.12, conversions: 28, targetPerformancePct: 78 } },
          ],
        },
      ],
    },
  ],
};
