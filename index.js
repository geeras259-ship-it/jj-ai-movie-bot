const { Telegraf, Markup } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const express = require('express');

// 1. Setup Clients
const bot = new Telegraf(process.env.BOT_TOKEN);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const searchModel = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

const DB_CHANNEL_ID = process.env.DB_CHANNEL_ID; // -1004324049481
const GROUP_LINK = process.env.GROUP_LINK || 'https://t.me/YourMovieGroup';

// Random Vibes for Unique Gemini Messages
const VIBES = [
  'mass Telugu movie dialogue style (like Pushpa/RRR hype)',
  'funny best friend teasing style',
  'super chill popcorn night vibe',
  'energetic DJ/party hype style',
  'sweet & emotional friendly request style'
];

const FALLBACK_SHARES = [
  '🍿 Movie super untadi mawa! Enjoy chey, mana group ni mee friends ki kuda share chey! 🔥',
  '🎬 Popcorn ready chesko mawa! Nachithe mana group link ni mee gang ki forward chey! 🚀',
  '🔥 Mass print ichanu mawa! Full enjoy chesi, mana group ni friends ki share cheyadam marchipoku! ✌️',
  '😎 Free HD movies kosam mana group best mawa! Mee friends ni kuda join cheyinchu! 🍿'
];

// Helpers
function formatSize(bytes) {
  if (!bytes) return 'Unknown';
  const gb = bytes / (1024 ** 3);
  return gb >= 1 ? `${gb.toFixed(2)} GB` : `${(bytes / (1024 ** 2)).toFixed(0)} MB`;
}

function escapeHTML(str) {
  return String(str).replace(/[&<>'"]/g, tag => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[tag]));
}

function detectMeta(name) {
  const qMatch = name.match(/(2160p|4K|1080p|720p|480p|360p)/i);
  const lMatch = name.match(/(Telugu|Hindi|Tamil|English|Malayalam|Kannada|Dual Audio)/i);
  return {
    quality: qMatch ? qMatch[0].toUpperCase() : 'HD',
    language: lMatch ? lMatch[0] : 'Multi'
  };
}

async function isAdmin(ctx) {
  try {
    const member = await ctx.telegram.getChatMember(ctx.chat.id, ctx.from.id);
    return ['creator', 'administrator'].includes(member.status);
  } catch {
    return false;
  }
}

async function getUniqueShareMsg(userName, movieName) {
  const randomVibe = VIBES[Math.floor(Math.random() * VIBES.length)];
  const randomSeed = Math.floor(Math.random() * 10000);

  try {
    const creativeModel = genAI.getGenerativeModel({
      model: 'gemini-2.0-flash',
      generationConfig: { temperature: 1.2, maxOutputTokens: 100 }
    });

    const prompt = `Write a unique, short (max 2 lines) Tenglish (Telugu + English) message for "${userName}" who just downloaded "${movieName}".
Style: ${randomVibe}.
Rules:
- Use "mawa" naturally.
- Tell them to enjoy the movie and share our movies group with their friends.
- Add 2-3 emojis. No links.
- Be completely original (Seed: ${randomSeed}).`;

    const res = await creativeModel.generateContent(prompt);
    const text = res.response.text().trim();
    if (text) return escapeHTML(text);
  } catch (e) {
    console.log('Gemini share fallback:', e.message);
  }

  return FALLBACK_SHARES[Math.floor(Math.random() * FALLBACK_SHARES.length)];
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

// 3. AUTO-WELCOME + DELETE JOIN SERVICE MESSAGE
bot.on('new_chat_members', async (ctx) => {
  ctx.deleteMessage().catch(() => {});

  const newMembers = ctx.message.new_chat_members;
  for (const member of newMembers) {
    if (member.is_bot) continue;

    const name = escapeHTML(member.first_name || 'Mawa');
    const welcomeMsg = await ctx.reply(
      `👋 <b>Welcome ${name}!</b>\n\n🎬 Meeku kavalsina movie name ikkada type cheyandi (e.g., <code>Kalki</code> or <code>Devara</code>), nenu ventane HD files isthanu!\n\n⚠️ <i>Note: External links & promotions are strictly not allowed.</i>`,
      { parse_mode: 'HTML' }
    );

    setTimeout(() => {
      ctx.telegram.deleteMessage(ctx.chat.id, welcomeMsg.message_id).catch(() => {});
    }, 60 * 1000);
  }
});

// 4. ANTI-LINK BLOCKER (External join links auto-delete for non-admins)
bot.use(async (ctx, next) => {
  if (!ctx.message || ctx.chat?.type === 'private') return next();

  const text = ctx.message.text || ctx.message.caption || '';
  const entities = ctx.message.entities || ctx.message.caption_entities || [];

  const hasLinkEntity = entities.some(e => ['url', 'text_link', 'mention'].includes(e.type));
  const hasLinkRegex = /(https?:\/\/|www\.|t\.me\/|telegram\.me\/|@[\w]+)/i.test(text);

  if (hasLinkEntity || hasLinkRegex) {
    const admin = await isAdmin(ctx);
    if (!admin) {
      await ctx.deleteMessage().catch(() => {});
      const name = escapeHTML(ctx.from?.first_name || 'User');
      const warn = await ctx.reply(
        `🚫 <b>${name}</b>, external links & join links ee group lo allow levu!`,
        { parse_mode: 'HTML' }
      );
      setTimeout(() => {
        ctx.telegram.deleteMessage(ctx.chat.id, warn.message_id).catch(() => {});
      }, 10 * 1000);
      return;
    }
  }
  return next();
});

// 5. DEEP LINK DELIVERY + UNIQUE GEMINI START & SHARE MESSAGES
bot.start(async (ctx) => {
  const payload = ctx.startPayload;
  const userName = ctx.from.first_name || 'Mawa';

  // Normal /start -> Unique Gemini AI Welcome Message
  if (!payload || !payload.startsWith('file_')) {
    await ctx.sendChatAction('typing').catch(() => {});
    const randomVibe = VIBES[Math.floor(Math.random() * VIBES.length)];

    try {
      const creativeModel = genAI.getGenerativeModel({
        model: 'gemini-2.0-flash',
        generationConfig: { temperature: 1.2, maxOutputTokens: 100 }
      });
      const prompt = `You are a cool AI Movie Assistant Telegram bot. Write a short, unique welcome message (max 3 lines) in Tenglish using "mawa" style for "${userName}". Vibe: ${randomVibe}. Tell them to type any movie name in our group for instant HD files. Add movie emojis.`;
      const result = await creativeModel.generateContent(prompt);
      return ctx.reply(result.response.text().trim(), {
        ...Markup.inlineKeyboard([[Markup.button.url('🎬 Join Movies Group', GROUP_LINK)]])
      });
    } catch (e) {
      return ctx.reply(
        `🎬 Hey ${userName} mawa! Welcome to AI Movie Bot.\n\nGroup lo meeku kavalsina movie name type cheyandi, ventane HD files isthanu! 🍿`,
        Markup.inlineKeyboard([[Markup.button.url('🎬 Join Movies Group', GROUP_LINK)]])
      );
    }
  }

  // Deep Link (/start file_123) -> Send Movie File + Unique Share Msg + 5-Min Auto-Delete
  const msgId = parseInt(payload.replace('file_', ''), 10);
  if (isNaN(msgId)) return;

  try {
    const { data: movie } = await supabase
      .from('movies_index')
      .select('file_name, file_size')
      .eq('message_id', msgId)
      .single();

    const rawTitle = movie ? movie.file_name : 'Watch Movie';
    const title = escapeHTML(rawTitle);
    const size = movie ? movie.file_size : '';

    // Clickable Group Link Caption
    const customCaption =
      `🎬 <a href="${GROUP_LINK}"><b>${title}</b></a>\n` +
      (size ? `📦 <b>Size:</b> ${size}\n\n` : '\n') +
      `📢 <a href="${GROUP_LINK}"><b>Join Our Movies Group for More HD Movies!</b></a>`;

    const sentFile = await ctx.telegram.copyMessage(ctx.chat.id, DB_CHANNEL_ID, msgId, {
      caption: customCaption,
      parse_mode: 'HTML'
    });

    const shareText = await getUniqueShareMsg(userName, rawTitle);
    const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(GROUP_LINK)}&text=${encodeURIComponent('🎬 Free HD Movies Group mawa! Join avvu:')}`;

    const warnMsg = await ctx.reply(
      `${shareText}\n\n⚠️ <b>Note:</b> Ee file <b>5 minutes</b> lo auto-delete avuthundi. Ventane Saved Messages ki forward chesko!`,
      {
        parse_mode: 'HTML',
        reply_to_message_id: sentFile.message_id,
        ...Markup.inlineKeyboard([
          [Markup.button.url('📤 Share Group with Friends', shareUrl)]
        ])
      }
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
          {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
              [Markup.button.url('📤 Share Group with Friends', shareUrl)]
            ])
          }
        );
      } catch (e) {
        console.log('Auto-delete skipped:', e.message);
      }
    }, 5 * 60 * 1000);
  } catch (err) {
    ctx.reply('❌ File not found or deleted from storage.');
  }
});

// Helper: Render Hyperlink Search Results
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

// 6. AI GROUP SEARCH
bot.on('text', async (ctx) => {
  if (ctx.chat.type === 'private') return;
  const userText = ctx.message.text.trim();
  if (userText.startsWith('/') || userText.length < 2) return;

  ctx.react('👍').catch(() => {});
  const loadingMsg = await ctx.reply('🔍 <i>Searching...</i>', {
    parse_mode: 'HTML',
    reply_to_message_id: ctx.message.message_id
  });

  let searchKeyword = userText;
  try {
    const prompt = `Extract ONLY the movie or series title from this user message. Fix spelling mistakes if any. Return ONLY the title, nothing else. Message: "${userText}"`;
    const result = await searchModel.generateContent(prompt);
    const aiTitle = result.response.text().trim().replace(/['"]/g, '');
    if (aiTitle && aiTitle.length < 50) searchKeyword = aiTitle;
  } catch (e) {
    console.log('Gemini search fallback:', e.message);
  }

  const res = await buildSearchMessage(searchKeyword, 0, null, ctx.botInfo.username, ctx.from.first_name || 'User');

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

  setTimeout(() => {
    ctx.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id).catch(() => {});
  }, 2 * 60 * 1000);
});

// 7. BUTTON CALLBACKS (Quality Filter & Pagination)
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

// 8. Keep-Alive Web Server for Render
const app = express();
app.get('/', (req, res) => res.send('AI Movie Bot is Running!'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

bot.launch().then(() => console.log('Bot Started!'));
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
