const { Telegraf, Markup } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const express = require('express');

// 1. Setup Clients
const bot = new Telegraf(process.env.BOT_TOKEN);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

const DB_CHANNEL_ID = process.env.DB_CHANNEL_ID; // -1004324049481

// Helper: Format Bytes to MB/GB
function formatSize(bytes) {
  if (!bytes) return 'Unknown';
  const gb = bytes / (1024 ** 3);
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  return `${(bytes / (1024 ** 2)).toFixed(0)} MB`;
}

// Helper: Escape HTML characters
function escapeHTML(str) {
  return str.replace(/[&<>'"]/g, tag => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[tag]));
}

// Helper: Detect Quality & Language
function detectMeta(name) {
  const qMatch = name.match(/(2160p|4K|1080p|720p|480p|360p)/i);
  const lMatch = name.match(/(Telugu|Hindi|Tamil|English|Malayalam|Kannada|Dual Audio)/i);
  return {
    quality: qMatch ? qMatch[0].toUpperCase() : 'HD',
    language: lMatch ? lMatch[0] : 'Multi'
  };
}

// 2. AUTO-INDEXING: DB Channel lo file upload avvagane Supabase lo save chesthundi
bot.on('channel_post', async (ctx) => {
  const post = ctx.channelPost;
  if (String(post.chat.id) !== String(DB_CHANNEL_ID)) return;

  const file = post.document || post.video;
  if (!file) return;

  const rawName = post.caption || file.file_name || 'Unknown Movie';
  const cleanName = rawName.replace(/\n/g, ' ').trim();
  const fileSize = formatSize(file.file_size);
  const { quality, language } = detectMeta(cleanName);

  const { error } = await supabase.from('movies_index').upsert({
    message_id: post.message_id,
    file_name: cleanName,
    file_size: fileSize,
    quality,
    language
  }, { onConflict: 'message_id' });

  if (error) console.error('Supabase Insert Error:', error.message);
  else console.log(`Indexed: ${cleanName} (${fileSize})`);
});

// 3. DEEP LINK DELIVERY: User link tap cheyagane DM lo file + 5-min Auto-Delete
bot.start(async (ctx) => {
  const payload = ctx.startPayload;
  if (!payload || !payload.startsWith('file_')) {
    return ctx.reply('🎬 Welcome! Group lo movie name type cheyandi, nenu ventane files isthanu.');
  }

  const msgId = parseInt(payload.replace('file_', ''), 10);
  if (isNaN(msgId)) return;

  try {
    const sentFile = await ctx.telegram.copyMessage(ctx.chat.id, DB_CHANNEL_ID, msgId);
    const warnMsg = await ctx.reply(
      '⚠️ <b>THIS MOVIE FILE WILL BE DELETED IN 5 MINUTES!</b>\n\nForward it to your Saved Messages immediately.',
      { parse_mode: 'HTML', reply_to_message_id: sentFile.message_id }
    );

    // 5 Minutes Auto-Delete
    setTimeout(async () => {
      try {
        await ctx.telegram.deleteMessage(ctx.chat.id, sentFile.message_id);
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          warnMsg.message_id,
          null,
          '✅ <b>YOUR FILE HAS BEEN DELETED!</b>\nKindly search again in the group.',
          { parse_mode: 'HTML' }
        );
      } catch (e) {
        console.log('Auto-delete skipped:', e.message);
      }
    }, 5 * 60 * 1000);
  } catch (err) {
    ctx.reply('❌ File not found or deleted from storage.');
  }
});

// Helper: Render Hyperlink Results
async function buildSearchMessage(query, page = 0, qualityFilter = null, botUsername, requester) {
  const limit = 10;
  let dbQuery = supabase
    .from('movies_index')
    .select('*', { count: 'exact' })
    .ilike('file_name', `%${query}%`);

  if (qualityFilter) {
    dbQuery = dbQuery.ilike('quality', `%${qualityFilter}%`);
  }

  const { data, count, error } = await dbQuery
    .order('created_at', { ascending: false })
    .range(page * limit, (page + 1) * limit - 1);

  if (error || !data || data.length === 0) return null;

  const totalPages = Math.ceil(count / limit);
  let text = `🎬 <b>RESULTS FOR:</b> <code>${escapeHTML(query)}</code>\n`;
  text += `👤 <b>REQUESTED BY:</b> ${escapeHTML(requester)}\n\n`;

  data.forEach((item, idx) => {
    const num = page * limit + idx + 1;
    const link = `https://t.me/${botUsername}?start=file_${item.message_id}`;
    text += `<b>${num}.</b> <a href="${link}">[${item.file_size}] ${escapeHTML(item.file_name)}</a>\n\n`;
  });

  // Filter & Pagination Buttons
  const buttons = [
    [
      Markup.button.callback('480p', `flt|${query}|0|480p`),
      Markup.button.callback('720p', `flt|${query}|0|720p`),
      Markup.button.callback('1080p', `flt|${query}|0|1080p`),
      Markup.button.callback('ALL', `flt|${query}|0|ALL`)
    ]
  ];

  const navRow = [];
  if (page > 0) navRow.push(Markup.button.callback('⬅️ PREV', `flt|${query}|${page - 1}|${qualityFilter || 'ALL'}`));
  navRow.push(Markup.button.callback(`PAGE ${page + 1}/${totalPages}`, 'noop'));
  if (page + 1 < totalPages) navRow.push(Markup.button.callback('NEXT ➡️', `flt|${query}|${page + 1}|${qualityFilter || 'ALL'}`));
  buttons.push(navRow);

  return { text, keyboard: Markup.inlineKeyboard(buttons) };
}

// 4. AI GROUP SEARCH: Natural language & typo-proof search
bot.on('text', async (ctx) => {
  if (ctx.chat.type === 'private') return; // Only work in groups
  const userText = ctx.message.text.trim();
  if (userText.startsWith('/') || userText.length < 2) return;

  // Give 👍 reaction
  ctx.react('👍').catch(() => {});
  const loadingMsg = await ctx.reply('🔍 <i>Searching...</i>', { parse_mode: 'HTML', reply_to_message_id: ctx.message.message_id });

  // Gemini AI extracts exact movie name from natural sentences/typos
  let searchKeyword = userText;
  try {
    const prompt = `Extract ONLY the movie or series title from this user message. Fix spelling mistakes if any. Return ONLY the title, nothing else. Message: "${userText}"`;
    const result = await model.generateContent(prompt);
    const aiTitle = result.response.text().trim().replace(/['"]/g, '');
    if (aiTitle && aiTitle.length < 50) searchKeyword = aiTitle;
  } catch (e) {
    console.log('Gemini fallback to raw text:', e.message);
  }

  const botUsername = ctx.botInfo.username;
  const requester = ctx.from.first_name || 'User';
  const res = await buildSearchMessage(searchKeyword, 0, null, botUsername, requester);

  if (!res) {
    return ctx.telegram.editMessageText(
      ctx.chat.id, loadingMsg.message_id, null,
      `❌ <b>"${escapeHTML(searchKeyword)}"</b> movie inka upload avvaledu. Admin ki request pampanu!`,
      { parse_mode: 'HTML' }
    );
  }

  await ctx.telegram.editMessageText(ctx.chat.id, loadingMsg.message_id, null, res.text, {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...res.keyboard
  });

  // Group message 2 minutes lo auto-delete
  setTimeout(() => {
    ctx.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id).catch(() => {});
  }, 2 * 60 * 1000);
});

// 5. BUTTON CALLBACKS (Quality Filter & Next/Prev Page)
bot.action(/^flt\|(.+)\|(\d+)\|(.+)$/, async (ctx) => {
  const [, query, pageStr, qual] = ctx.match;
  const page = parseInt(pageStr, 10);
  const qualityFilter = qual === 'ALL' ? null : qual;

  const res = await buildSearchMessage(query, page, qualityFilter, ctx.botInfo.username, ctx.from.first_name);
  if (!res) return ctx.answerCbQuery('No files found for this filter!', { show_alert: true });

  await ctx.editMessageText(res.text, {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...res.keyboard
  }).catch(() => {});
  ctx.answerCbQuery();
});

bot.action('noop', (ctx) => ctx.answerCbQuery());

// 6. Keep-Alive Web Server for Render
const app = express();
app.get('/', (req, res) => res.send('AI Movie Bot is Running!'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

bot.launch().then(() => console.log('Bot Started!'));
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
