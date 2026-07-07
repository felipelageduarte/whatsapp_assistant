// EventBus em processo. Conecta core -> frontends (Telegram, Web).
// Eventos:
//   'suggestion'  -> nova sugestao pendente (payload: suggestion row)
//   'updated'     -> sugestao mudou de status (payload: suggestion row)
//   'wa-status'   -> mudanca de conexao do WhatsApp (payload: { state, qr })
import { EventEmitter } from 'node:events';

export const bus = new EventEmitter();
bus.setMaxListeners(50);
