// Gera sugestao de resposta com Claude via Amazon Bedrock (sem API key —
// autentica pela credencial AWS: IAM role na EC2, ou profile local).
import { AnthropicBedrock } from '@anthropic-ai/bedrock-sdk';
import { config } from './config.js';

const client = new AnthropicBedrock({ awsRegion: config.awsRegion });

function buildTranscript(messages, myMarker = 'EU', otherMarker = 'CONTATO') {
  return messages
    .map((m) => `${m.from_me ? myMarker : (m.sender_name || otherMarker)}: ${m.body}`)
    .join('\n');
}

// Seleciona exemplos variados do estilo do dono (curtos e medios), limitando tamanho.
function styleBlock(samples = [], max = 40) {
  const seen = new Set();
  const picked = [];
  for (const raw of samples) {
    const s = String(raw).replace(/\s+/g, ' ').trim();
    if (s.length < 2 || s.length > 220) continue;
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k); picked.push(s);
    if (picked.length >= max) break;
  }
  return picked.map((s) => `- ${s}`).join('\n');
}

export async function suggestReply({ chatName, messages, chatStyleSamples = [], globalStyleSamples = [] }) {
  const transcript = buildTranscript(messages);
  // Estilo: prioriza como EU falo NESTE chat; complementa com estilo geral.
  const chatStyle = styleBlock(chatStyleSamples, 25);
  const globalStyle = styleBlock(globalStyleSamples, 15);

  const system =
    `Voce escreve a PROXIMA mensagem que ESTA pessoa enviaria no WhatsApp, imitando fielmente o jeito dela. ${config.persona}\n` +
    `COMO ENTENDER A CONVERSA:\n` +
    `- O interlocutor pode ter dividido um assunto ou pergunta em VARIAS mensagens seguidas. Leia TODAS as ultimas mensagens dele e junte o sentido.\n` +
    `- Identifique o que ficou EM ABERTO (pergunta nao respondida, pedido, decisao pendente, ultima coisa que ele disse) e responda exatamente isso.\n` +
    `- Se houver varias coisas em aberto, enderece a mais recente/relevante. Nao repita o que ja foi respondido.\n` +
    `- ATENCAO aos PAPEIS: entenda QUEM faz cada acao (quem vai ligar, quem vai avisar, quem espera, quem traz o que). NAO inverta os papeis nem assuma que EU farei o que o outro disse que faria. Se o outro disse que vai providenciar algo, minha resposta tipica e confirmar/agradecer/aguardar — nao me oferecer para fazer aquilo.\n` +
    `TOM E ESTILO (especifico DESTA conversa):\n` +
    `- Use o tom das ULTIMAS mensagens DESTA conversa e dos exemplos "como eu falo com esta pessoa". A forma de falar muda conforme o contato (intimo, formal, trabalho, familia).\n` +
    `- Copie vocabulario, girias, emojis, abreviacoes, pontuacao, maiusculas/minusculas e o COMPRIMENTO tipico. Se mando msgs curtas com essa pessoa, mande curta.\n` +
    `- Responda no idioma da conversa. NAO seja mais formal/longo/educado do que costumo ser com ela.\n` +
    `Saida: APENAS o texto da mensagem, sem aspas, sem rotulos, sem explicacao. ` +
    `Se faltar info para responder com seguranca, escreva uma resposta curta pedindo o esclarecimento.`;

  const user =
    (chatStyle ? `== COMO EU FALO COM ${chatName || 'esta pessoa'} (minhas msgs neste chat) ==\n${chatStyle}\n\n` : '') +
    (globalStyle ? `== MEU ESTILO GERAL (outras conversas) ==\n${globalStyle}\n\n` : '') +
    `== CONVERSA COM ${chatName || 'contato'} (mais antigo -> mais recente) ==\n${transcript}\n\n` +
    `Leia as ultimas mensagens, descubra o que ficou em aberto e escreva minha proxima resposta para ${chatName || 'o contato'}, no tom que uso com ela.`;

  const res = await client.messages.create({
    model: config.bedrockModel,
    max_tokens: 500,
    system,
    messages: [{ role: 'user', content: user }],
  });

  const text = res.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();

  return text || '(sem sugestao)';
}

// Reescreve uma mensagem do usuario ajustando o tom (sem mudar o sentido).
export async function rewriteMessage({ text, tone }) {
  const t = (text || '').trim();
  if (!t) return '';
  const system =
    `Voce reescreve mensagens de WhatsApp. Ajuste APENAS o tom/estilo conforme pedido, ` +
    `mantendo o sentido e o idioma original. Responda SOMENTE com a mensagem reescrita — ` +
    `sem aspas, sem rotulos, sem explicacao.`;
  const user = `Tom desejado: ${tone || 'mais ameno e gentil'}\n\nMensagem original:\n${t}\n\nReescreva.`;

  const res = await client.messages.create({
    model: config.bedrockModel,
    max_tokens: 600,
    system,
    messages: [{ role: 'user', content: user }],
  });
  const out = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  return out || t;
}
