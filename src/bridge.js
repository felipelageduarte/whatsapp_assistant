// Ponte com o BotImóvel (backend/api/lib/agent/whatsapp.mjs + routes/whatsapp.mjs).
//
// Quando config.botimovelApiUrl está setado, este módulo substitui a
// sugestão local (store/llm/actions) por completo: mensagem recebida vira
// POST /whatsapp/inbound lá (que gera o rascunho via agente do BotImóvel,
// com acesso a fornecedores/clientes/projetos cadastrados — contexto que o
// llm.js local, puramente de estilo, não tem), e um polling em
// GET /whatsapp/outbox entrega o que foi aprovado pelo admin no Telegram do
// BotImóvel. Aprovação acontece LÁ, não aqui — este processo não decide
// nada, só conecta/envia/encaminha.
import { config } from './config.js';

const enabled = () => Boolean(config.botimovelApiUrl && config.botimovelBridgeSecret);

async function botimovelFetch(path, opts = {}) {
  const res = await fetch(`${config.botimovelApiUrl}${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'X-Whatsapp-Bridge-Secret': config.botimovelBridgeSecret,
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`BotImóvel ${path} -> HTTP ${res.status}`);
  return res.json();
}

// Chamado por whatsapp.js a cada mensagem inbound (não-fromMe, não-grupo).
// mediaType/waId (opcionais) deixam o classificador do BotImóvel BUSCAR a
// mídia (GET /bridge/accounts/:id/media/:waId, já existe pro chat ao vivo) e
// analisá-la com visão — antes disso um comprovante em imagem virava só o
// rótulo "📷 Foto" no texto, invisível pro motor de pagamento.
export async function notifyInbound({ accountId, jid, phone, pushName, text, providerMessageId, mediaType, waId }) {
  if (!enabled()) return;
  try {
    await botimovelFetch('/whatsapp/inbound', {
      method: 'POST',
      body: JSON.stringify({ accountId, jid, phone, pushName, text, providerMessageId, mediaType, waId }),
    });
  } catch (err) {
    console.error('[bridge] falha ao notificar inbound:', err.message);
  }
}

// Loop de polling — inicia do index.js no boot, se a ponte estiver configurada.
// sendFn: (accountId, jid, text) => Promise<{id}> — injeção evita import
// circular com whatsapp.js (que importa este módulo pro notifyInbound).
export function startOutboxPolling(sendFn) {
  if (!enabled()) return;
  console.log(`[bridge] polling BotImóvel outbox a cada ${config.botimovelPollMs}ms`);
  const tick = async () => {
    try {
      const { outbox } = await botimovelFetch('/whatsapp/outbox');
      for (const item of outbox || []) {
        try {
          const sent = await sendFn(item.account_id, item.jid, item.text);
          await botimovelFetch(`/whatsapp/outbox/${item.id}/delivered`, {
            method: 'POST',
            body: JSON.stringify({ providerMessageId: sent?.key?.id || null }),
          });
        } catch (err) {
          console.error(`[bridge] falha ao entregar outbox #${item.id}:`, err.message);
          await botimovelFetch(`/whatsapp/outbox/${item.id}/failed`, {
            method: 'POST',
            body: JSON.stringify({ error: err.message }),
          }).catch(() => {});
        }
      }
    } catch (err) {
      console.error('[bridge] falha ao consultar outbox:', err.message);
    }
    setTimeout(tick, config.botimovelPollMs);
  };
  tick();
}

export const bridgeEnabled = enabled;
