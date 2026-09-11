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

/**
 * Gera a mensagem de feedback semanal pronta pra copiar e mandar no
 * WhatsApp do cliente — no mesmo formato/tom que Jorge já usa no
 * workflow manual dele (saudação, resumo em linguagem simples,
 * diagnóstico do "porquê", recomendação, e uma pergunta de fechamento
 * pra contas de geração de lead).
 */
async function generateFeedbackMessage(platform, accountData) {
  if (!config.anthropic?.apiKey) {
    throw new Error(
      'ANTHROPIC_API_KEY não configurada. Crie uma chave em console.anthropic.com ' +
      'e adicione no .env para ativar a geração de mensagens de feedback.'
    );
  }

  const systemPrompt = `Você escreve mensagens de feedback semanal de performance de
anúncios (${platform === 'google' ? 'Google Ads' : 'Meta Ads'}) para clientes de uma
agência de marketing digital, prontas para envio direto por WhatsApp.

Formato obrigatório, sempre nessa ordem:
1. Saudação breve e calorosa ("Bom dia!" ou "Boa tarde!", seguida de uma abertura simpática)
2. Resumo de performance: principais movimentos das métricas vs. o período anterior, em linguagem simples
3. Diagnóstico: motivos prováveis pelos resultados (fadiga de criativo, mudança de orçamento,
   desgaste de anúncio, fatores externos, sazonalidade)
4. Recomendação voltada pro futuro
5. Se a conta parecer ser de geração de leads, termine com uma pergunta sobre a qualidade
   dos leads e a segmentação

Regras de tom e linguagem:
- Português do Brasil, profissional mas caloroso e acessível — nunca frio ou técnico demais
- Evite jargão técnico (CTR, CPM, ROAS) — prefira fale de resultados que o cliente entende
  (conversas iniciadas, conversões, custo por resultado)
- Não inclua nome de cliente nem nome de contato — isso é adicionado manualmente depois
- Sem divisórias horizontais nem títulos de seção — é uma mensagem corrida, não um relatório
- Seja breve: 4 a 5 parágrafos curtos, cobrindo o que melhorou, o que piorou, e a
  recomendação principal — mensagens longas não funcionam bem no WhatsApp
- Devolva SOMENTE o texto da mensagem, pronto pra copiar e colar. Nada de markdown,
  nada de comentário antes ou depois.`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': config.anthropic.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: 800,
      system: systemPrompt,
      messages: [
        { role: 'user', content: `Dados reais da conta (últimos 30 dias):\n${JSON.stringify(accountData, null, 2)}` },
      ],
    }),
  });

  const json = await res.json();
  const text = json.content?.find((b) => b.type === 'text')?.text;
  if (!text) throw new Error('A IA não devolveu texto — tente novamente.');
  return text.trim();
}

module.exports = { generateInsights, generateFeedbackMessage };
