const config = require('../config');

/**
 * Gera sugestões de melhoria profissionais a partir dos dados reais de
 * uma conta (campanhas, conjuntos, anúncios, palavras-chave, leilão).
 *
 * Precisa de uma chave de API da Anthropic (console.anthropic.com) em
 * ANTHROPIC_API_KEY no .env. Sem a chave, devolve um erro claro em vez
 * de mockar — análise de campanha não faz sentido mockar como os outros
 * dados, já que o valor todo está em ser sobre os números reais.
 */
async function generateInsights(platform, accountData) {
  if (!config.anthropic?.apiKey) {
    throw new Error(
      'ANTHROPIC_API_KEY não configurada. Crie uma chave em console.anthropic.com ' +
      'e adicione no .env para ativar as sugestões de melhoria por IA.'
    );
  }

  const systemPrompt = `Você é um analista sênior de mídia paga (Meta Ads e Google Ads).
Receberá dados reais de uma conta e deve devolver SOMENTE um JSON (sem markdown,
sem texto fora do JSON) no formato:

[
  {
    "campaign": "nome da campanha",
    "priority": "alta" | "media" | "baixa",
    "targeting": "análise de segmentação: públicos, idade, sexo, plataforma, localização",
    "adLevel": "análise de métricas por anúncio: CTR, cliques, visualizações, frequência",
    "copy": "sugestão concreta de melhoria de copy, ou '—' se não aplicável"
  }
]

Seja específico e cite os números reais recebidos. Priorize campanhas com maior
gasto ou pior performance. Máximo 4 campanhas por resposta.`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': config.anthropic.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: 2000,
      system: systemPrompt,
      messages: [
        { role: 'user', content: `Plataforma: ${platform}\n\nDados da conta:\n${JSON.stringify(accountData, null, 2)}` },
      ],
    }),
  });

  const json = await res.json();
  const text = json.content?.find((b) => b.type === 'text')?.text || '[]';

  try {
    return JSON.parse(text.replace(/```json|```/g, '').trim());
  } catch {
    throw new Error('A IA devolveu um formato inesperado — tente novamente.');
  }
}

module.exports = { generateInsights };
