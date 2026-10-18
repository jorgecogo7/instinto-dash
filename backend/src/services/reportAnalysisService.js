const config = require('../config');
const cache = require('../lib/cache');

/**
 * Análise curta das campanhas pro relatório em PDF: texto simples e
 * profissional, escrito pro CLIENTE ler (não pro gestor). Usa a API da
 * Anthropic (ANTHROPIC_API_KEY). Recebe os relatórios já prontos e manda
 * só um resumo enxuto dos números (economiza e evita mandar dado à toa).
 */

const r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
const pct = (c, p) => (p > 0 ? r2(((c - p) / p) * 100) : null);

function summarizeMeta(m) {
  if (!m) return null;
  const t = m.totals || {}, p = m.previousTotals || {}, bd = m.breakdowns || {};
  const pick = (o) => ({
    investimento: r2(o.spend), resultados: o.results, custo_por_resultado: r2(o.costPerResult), alcance: Math.round(o.reach || 0),
    impressoes: Math.round(o.impressions || 0), cliques: Math.round(o.clicks || 0), ctr: r2(o.ctr), cpc: r2(o.cpc), cpm: r2(o.cpm), frequencia: r2(o.frequency),
  });
  return {
    tipo_de_resultado: m.resultLabel,
    periodo_atual: pick(t),
    periodo_anterior: pick(p),
    variacao_pct: { investimento: pct(t.spend, p.spend), resultados: pct(t.results, p.results), custo_por_resultado: pct(t.costPerResult, p.costPerResult), ctr: pct(t.ctr, p.ctr) },
    melhores_anuncios: (m.ads || []).filter((a) => a.spend > 0).sort((a, b) => (b.results - a.results) || (b.spend - a.spend)).slice(0, 5)
      .map((a) => ({ nome: a.name, resultados: a.results, custo_por_resultado: r2(a.costPerResult), ctr: r2(a.ctr), investimento: r2(a.spend), frequencia: r2(a.frequency) })),
    campanhas: (m.campaigns || []).slice(0, 5).map((c) => ({ nome: c.name, investimento: r2(c.spend), resultados: c.results, custo_por_resultado: r2(c.costPerResult) })),
    idade_com_mais_resultado: (bd.age || []).slice().sort((a, b) => b.results - a.results).slice(0, 2).map((x) => x.label),
    posicionamentos: (bd.placements || []).slice(0, 4).map((x) => ({ nome: x.label, investimento: r2(x.spend), resultados: x.results, custo_por_resultado: r2(x.costPerResult) })),
  };
}

function summarizeGoogle(g) {
  if (!g) return null;
  const t = g.totals || {}, p = g.previousTotals || {};
  const pick = (o) => ({
    investimento: r2(o.spend), conversoes: r2(o.conversions), custo_por_conversao: r2(o.costPerConv), cliques: Math.round(o.clicks || 0),
    impressoes: Math.round(o.impressions || 0), ctr: r2(o.ctr), cpc: r2(o.cpc), taxa_conversao: r2(o.convRate), primeira_posicao_pct: r2(o.topImpressionShare),
  });
  return {
    periodo_atual: pick(t),
    periodo_anterior: pick(p),
    variacao_pct: { investimento: pct(t.spend, p.spend), conversoes: pct(t.conversions, p.conversions), custo_por_conversao: pct(t.costPerConv, p.costPerConv), ctr: pct(t.ctr, p.ctr) },
    campanhas: (g.campaigns || []).slice().sort((a, b) => b.spend - a.spend).slice(0, 5)
      .map((c) => ({ nome: c.name, tipo: c.type, investimento: r2(c.spend), conversoes: r2(c.conv ?? c.conversions), cliques: c.clicks, ctr: r2(c.ctr) })),
    palavras_chave: (g.keywords || []).slice().sort((a, b) => b.clicks - a.clicks).slice(0, 5)
      .map((k) => ({ termo: k.keyword, cliques: k.clicks, conversoes: r2(k.conversions), custo_por_conversao: r2(k.costPerConv) })),
    dispositivos: (g.deviceBreakdown || []).map((d) => ({ nome: d.label, investimento: r2(d.spend), conversoes: r2(d.conversions) })),
  };
}

async function generateReportAnalysis({ clientName, niche, range, meta, google }) {
  if (!config.anthropic.apiKey) {
    throw new Error('A análise por IA ainda não está ativada: falta a ANTHROPIC_API_KEY nas variáveis de ambiente da API (hPanel).');
  }
  const data = { cliente: clientName, segmento: niche || null, periodo: range, meta_ads: summarizeMeta(meta), google_ads: summarizeGoogle(google) };
  const key = `ai:report:${clientName}:${range.from}:${range.to}:${JSON.stringify(data).length}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const system = `Você é analista de tráfego pago da agência Instinto Digital e escreve a seção
"Análise das campanhas" de um relatório em PDF que vai para o CLIENTE.

Regras:
- Português do Brasil, tom profissional, simples e próximo. O cliente é dono de negócio, não especialista.
- Frases curtas. Nada de jargão sem explicar (se usar CTR, diga "taxa de cliques").
- Cite os números reais recebidos (com R$ e % no padrão brasileiro: R$ 1.234,56 e 12,3%).
- Compare com o período anterior quando houver dado.
- Seja honesto: se algo piorou, diga com calma e explique o provável motivo e o que será feito.
- Não prometa resultado, não invente dado, não culpe o cliente.
- Responda SOMENTE com um JSON válido (sem markdown), no formato:
{"visao_geral": "2 a 3 frases", "meta": "2 a 4 frases ou null se não houver Meta", "google": "2 a 4 frases ou null se não houver Google", "proximos_passos": ["ação curta 1", "ação curta 2", "ação curta 3"]}`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': config.anthropic.apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: config.anthropic.model,
      max_tokens: 900,
      system,
      messages: [{ role: 'user', content: `Dados do período:\n${JSON.stringify(data)}` }],
    }),
    signal: AbortSignal.timeout(60000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`A IA recusou o pedido: ${json.error?.message || `HTTP ${res.status}`}`);
  const text = json.content?.find((b) => b.type === 'text')?.text || '';
  let out;
  try {
    out = JSON.parse(text.replace(/```json|```/g, '').trim());
  } catch (e) {
    throw new Error('A IA devolveu um formato inesperado — tente de novo.');
  }
  const clean = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 1200) : null);
  const result = {
    visaoGeral: clean(out.visao_geral),
    meta: clean(out.meta),
    google: clean(out.google),
    proximosPassos: (Array.isArray(out.proximos_passos) ? out.proximos_passos : []).map(clean).filter(Boolean).slice(0, 5),
  };
  cache.set(key, result, 60 * 60 * 6);
  return result;
}

module.exports = { generateReportAnalysis };
