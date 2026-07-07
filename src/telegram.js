// Frontend Telegram multi-usuario. Cada user vincula seu chat_id (em /me/telegram no web,
// ou via /start aqui). Sugestoes sao enviadas ao chat_id do DONO. Callbacks validam posse.
import { Bot, InlineKeyboard } from 'grammy';
import { config } from './config.js';
import { store } from './store.js';
import { bus } from './bus.js';
import { approveSuggestion, rejectSuggestion } from './actions.js';

const editing = new Map(); // chatId -> suggestionId

const escapeMd = (t = '') => String(t).replace(/([_*[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
const card = (s) =>
  `💬 *${escapeMd(s.chat_name || s.jid)}*\n_recebido:_ ${escapeMd(s.trigger_msg)}\n\n🤖 *sugestao:*\n${escapeMd(s.suggestion)}`;
const kb = (id) =>
  new InlineKeyboard().text('✅ Aprovar', `ok:${id}`).text('✏️ Editar', `edit:${id}`).text('❌ Rejeitar', `no:${id}`);

// resolve o owner (email) a partir do chat do Telegram
const ownerOf = (ctx) => store.getUserByTelegram(ctx.chat.id)?.email || null;

export function startTelegram() {
  if (!config.telegram.token) {
    console.log('[tg] TELEGRAM_BOT_TOKEN ausente — frontend Telegram desativado.');
    return null;
  }
  const bot = new Bot(config.telegram.token);

  bot.command('start', (ctx) =>
    ctx.reply(
      `Seu chat id é \`${ctx.chat.id}\`.\nNo web app, em Configurações, cole esse id para receber sugestões aqui.`,
      { parse_mode: 'Markdown' }
    )
  );

  bot.command('pending', async (ctx) => {
    const owner = ownerOf(ctx);
    if (!owner) return ctx.reply('Chat não vinculado. Veja /start.');
    const list = store.listSuggestions({ owner, status: 'pending', limit: 10 });
    if (!list.length) return ctx.reply('Nenhuma sugestão pendente.');
    for (const s of list) await ctx.reply(card(s), { parse_mode: 'MarkdownV2', reply_markup: kb(s.id) });
  });

  bot.callbackQuery(/^ok:(\d+)$/, async (ctx) => {
    const owner = ownerOf(ctx);
    try {
      const u = await approveSuggestion(Number(ctx.match[1]), { owner });
      await ctx.editMessageText(`✅ *Enviado:*\n${escapeMd(u.final_text)}`, { parse_mode: 'MarkdownV2' });
    } catch (err) {
      await ctx.answerCallbackQuery({ text: err.message, show_alert: true });
    }
  });

  bot.callbackQuery(/^no:(\d+)$/, async (ctx) => {
    const owner = ownerOf(ctx);
    try {
      rejectSuggestion(Number(ctx.match[1]), { owner });
      await ctx.editMessageText('❌ Rejeitado.');
    } catch (err) {
      await ctx.answerCallbackQuery({ text: err.message, show_alert: true });
    }
  });

  bot.callbackQuery(/^edit:(\d+)$/, async (ctx) => {
    editing.set(ctx.chat.id, Number(ctx.match[1]));
    await ctx.answerCallbackQuery();
    await ctx.reply(`✏️ Envie o texto corrigido (ou /cancel).`);
  });

  bot.command('cancel', (ctx) => {
    editing.delete(ctx.chat.id);
    return ctx.reply('Edição cancelada.');
  });

  bot.on('message:text', async (ctx) => {
    const id = editing.get(ctx.chat.id);
    if (!id) return;
    editing.delete(ctx.chat.id);
    try {
      const u = await approveSuggestion(id, { owner: ownerOf(ctx), editedText: ctx.message.text });
      await ctx.reply(`✅ Enviado (editado):\n${u.final_text}`);
    } catch (err) {
      await ctx.reply(`Erro: ${err.message}`);
    }
  });

  // push: nova sugestao -> chat_id do dono
  bus.on('suggestion', async (s) => {
    const owner = store.getUser(s.owner);
    if (!owner?.telegram_chat_id) return;
    try {
      await bot.api.sendMessage(owner.telegram_chat_id, card(s), { parse_mode: 'MarkdownV2', reply_markup: kb(s.id) });
    } catch (err) {
      console.error('[tg] falha push:', err.message);
    }
  });

  bot.catch((err) => console.error('[tg] erro:', err.message));
  bot.start({ onStart: () => console.log('[tg] bot Telegram ativo.') });
  return bot;
}
