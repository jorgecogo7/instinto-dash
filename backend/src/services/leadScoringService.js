const config = require('../config');

/**
 * Gera um score (0-100) e uma leitura curta pra cada lead que entra pelo
 * funil de Captação & CRM — mesma ideia do "Lead scoring com IA" do
 * Chronos Dock. Usa os dados que o próprio lead informou (nome, empresa,
 * mensagem, orçamento, nicho) pra estimar o quão pronto ele está pra
 * fechar com a agência.
 *
 * Mesma regra do insightsService: precisa de ANTHROPIC_API_KEY no .env.
 * Sem a chave, devolve um erro claro em vez de inventar um score — um
 * número fake aqui pode literalmente fazer alguém ligar pra pessoa
 * errada primeiro.
 */
async function scoreLead(lead) {
  if (!config.anthropic?.apiKey) {
    throw new Error(
      'ANTHROPIC_API_KEY não configurada. Crie uma chave em console.anthropic.com ' +
      'e adicione no .env para ativar o lead scoring por IA.'
    );
  }

  const systemPrompt = `Você é um SDR (pré-vendas) sênior de uma agência de tráfego pago
(Meta Ads e Google Ads) avaliando um lead que chegou pelo formulário de captação.

Devolva SOMENTE um JSON (sem markdown, sem texto fora do JSON) no formato:

{
  "score": 0 a 100 (inteiro — quão pronto/qualificado esse lead parece pra fechar contrato),
  "temperature": "quente" | "morno" | "frio",
  "reasoning": "1-2 frases explicando o score, citando o que o lead informou",
  "nextAction": "próxima ação concreta e específica pro time comercial tomar"
}

Critérios pra pontuar mais alto: orçamento declarado compatível com serviço de agência,
mensagem com urgência ou objetivo claro (ex: "preciso de resultado esse mês", "já invisto
em anúncios hoje"), empresa/nicho identificável, dados de contato completos.
Critérios pra pontuar mais baixo: mensagem vaga ou genérica, sem orçamento informado,
parece só curiosidade ou pesquisa de preço sem intenção real.`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': config.anthropic.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: 500,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: `Dados do lead:\n${JSON.stringify(
            {
              nome: lead.name,
              empresa: lead.company,
              nicho: lead.niche,
              telefone: lead.phone,
              email: lead.email,
              orcamento: lead.budget,
              mensagem: lead.message,
              origem: lead.source,
            },
            null,
            2
          )}`,
        },
      ],
    }),
  });

  const json = await res.json();
  const text = json.content?.find((b) => b.type === 'text')?.text || '{}';

  let parsed;
  try {
    parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
  } catch {
    throw new Error('A IA devolveu um formato inesperado — tente novamente.');
  }

  const score = Number(parsed.score);
  return {
    score: Number.isFinite(score) ? Math.max(0, Math.min(100, Math.round(score))) : null,
    temperature: ['quente', 'morno', 'frio'].includes(parsed.temperature) ? parsed.temperature : null,
    reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : '',
    nextAction: typeof parsed.nextAction === 'string' ? parsed.nextAction : '',
    scoredAt: new Date().toISOString(),
  };
}

module.exports = { scoreLead };
