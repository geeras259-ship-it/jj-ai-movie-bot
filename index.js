const { Telegraf, Markup } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const express = require('express');

// 1. Setup Clients
const bot = new Telegraf((process.env.BOT_TOKEN || '').trim());
const supabase = createClient(
  (process.env.SUPABASE_URL || 'https://nrooqfmsbwirwlzeqcca.supabase.co').trim(),
  (process.env.SUPABASE_ANON_KEY || '').trim()
);
const genAI = new GoogleGenerativeAI((process.env.GEMINI_API_KEY || '').trim());
const aiModel = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

const DB_CHANNEL_ID = (process.env.DB_CHANNEL_ID || '-1004324049481').trim();
const GROUP_LINK = (process.env.GROUP_LINK || 'https://t.me/+QHmHTKoJButkMzNl').trim();
const ADMIN_ID = String(process.env.ADMIN_ID || '1293174588').trim();
const TARGET_GROUP_ID = String(process.env.GROUP_ID || '').trim(); // Optional: '-100xxxxxxxxxx'

const SUCCESS_REACTIONS = ['🔥', '🎬', '⚡', '🤩', '🍿'];
const VIBES = [
  'mass Telugu movie dialogue style (like Pushpa/RRR hype)',
  'funny best friend teasing style',
  'super chill popcorn night vibe',
  'energetic party hype style',
  'sweet & friendly request style'
];
const FALLBACK_SHARES = [
  '🍿 Movie super untadi mawa! Enjoy chey, mana group ni mee friends ki kuda share chey! 🔥',
  '🎬 Popcorn ready chesko mawa! Nachithe mana group link ni mee gang ki forward chey! 🚀',
  '🔥 Mass print ichanu mawa! Full enjoy chesi, mana group ni friends ki share cheyadam marchipoku! ✌️'
];

// Helpers
function formatSize(bytes) {
  if (!bytes) return 'Unknown';
  const gb = bytes / (1024 ** 3);
  return gb >= 1 ? `${gb.toFixed(2)} GB` : `${(bytes / (1024 ** 2)).toFixed(0)} MB`;
}

function escapeHTML(str) {
  return String(str || '').replace(/[&<>'"]/g, tag => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[tag]));
}

function getRequesterDisplay(ctx) {
  if (ctx.message?.sender_chat?.title) return ctx.message.sender_chat.title;
  if (ctx.callbackQuery?.message?.sender_chat?.title) return ctx.callbackQuery.message.sender_chat.title;
  return 'Member';
}

// Checks Owner ID, Anonymous Group Admin (sender_chat), or Telegram Group Admin
async function isAdmin(ctx, userId = ctx.from?.id) {
  // 1. Owner personal account check
  if (ADMIN_ID && userId && String(userId) === ADMIN_ID) {
    return true;
  }

  // 2. Anonymous Admin posting as Group/Channel (sender_chat)
  const senderChat = ctx.message?.sender_chat || ctx.callbackQuery?.message?.sender_chat;
  if (senderChat) {
    if (TARGET_GROUP_ID) {
      const cleanSender = String(senderChat.id).replace(/^-100/, '');
      const cleanTarget = TARGET_GROUP_ID.replace(/^-100/, '');
      if (cleanSender === cleanTarget) return true;
    } else if (['group', 'supergroup', 'channel'].includes(senderChat.type)) {
      return true;
    }
  }

  // 3. Normal Telegram group admin check
  if (!userId || !ctx.chat || ctx.chat.type === 'private') return false;
  try {
    const member = await ctx.telegram.getChatMember(ctx.chat.id, userId);
    return ['creator', 'administrator'].includes(member.status);
  } catch {
    return false;
  }
}

function containsLink(msg) {
  const text = msg?.text || msg?.caption || '';
  const entities = msg?.entities || msg?.caption_entities || [];
  const hasEntityLink = entities.some(e => ['url', 'text_link', 'mention'].includes(e.type));
  const hasRegexLink = /(https?:\/\/|www\.|t\.me\/|telegram\.me\/|@[\w]+)/i.test(text);
  return hasEntityLink || hasRegexLink;
}

function detectMeta(name) {
  const qMatch = name.match(/(2160p|4K|1080p|720p|480p|360p)/i);
  const lMatch = name.match(/(Telugu|Hindi|Tamil|English|Malayalam|Kannada|Dual Audio)/i);
  return {
    quality: qMatch ? qMatch[0].toUpperCase() : 'HD',
    language: lMatch ? lMatch[0] : 'Multi'
  };
}

function extractMovieTitle(rawCaption, fallbackFileName) {
  if (rawCaption && rawCaption.trim()) {
    const lines = rawCaption
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(l =>
        l.length > 0 &&
        !/^(💾|⏰|📦|🎬|📢)?\s*(size|duration)\s*:/i.test(l)
      );
    if (lines.length > 0) return lines[0];
  }
  return (fallbackFileName || 'Unknown Movie').replace(/\n/g, ' ').trim();
}

function scheduleUserMessageDelete(ctx, delayMs) {
  const msgId = ctx.message?.message_id;
  const chatId = ctx.chat?.id;
  if (!msgId || !chatId) return;

  setTimeout(async () => {
    try {
      await ctx.telegram.deleteMessage(chatId, msgId);
      console.log(`🗑️ Deleted message ${msgId}`);
    } catch (e) {
      console.log(`Could not delete message ${msgId}:`, e.message);
    }
  }, delayMs);
}

async function getUniqueShareMsg(userName, movieName) {
  const randomVibe = VIBES[Math.floor(Math.random() * VIBES.length)];
  const seed = Math.floor(Math.random() * 10000);
  try {
    const creativeModel = genAI.getGenerativeModel({
      model: 'gemini-2.0-flash',
      generationConfig: { temperature: 1.2, maxOutputTokens: 100 }
    });
    const prompt = `Write a unique, short (max 2 lines) Tenglish message for "${userName}" who just got "${movieName}". Style: ${randomVibe}. Use "mawa" naturally, tell them to enjoy & share our movies group with friends. Add 2-3 emojis. No links. Seed: ${seed}`;
    const res = await creativeModel.generateContent(prompt);
    const text = res.response.text().trim();
    if (text) return escapeHTML(text);
  } catch (e) {}
  return FALLBACK_SHARES[Math.floor(Math.random() * FALLBACK_SHARES.length)];
}

async function findSpellingOrSimilar(query) {
  let aiSuggestion = null;
  try {
    const prompt = `A user searched for "${query}" in a movie Telegram group. If it looks like a spelling mistake or typo of a real movie/series/anime title, return ONLY the corrected title. If it seems completely valid or unknown, return ONLY NONE.`;
    const res = await aiModel.generateContent(prompt);
    const out = res.response.text().trim().replace(/['"]/g, '');
    if (out && out.toUpperCase() !== 'NONE' && out.toLowerCase() !== query.toLowerCase() && out.length < 60) {
      aiSuggestion = out;
    }
  } catch (e) {}

  let similarRows = [];
  if (query.length >= 4) {
    const prefix = query.slice(0, 4);
    const { data } = await supabase
      .from('movies_index')
      .select('message_id, file_name, file_size')
      .ilike('file_name', `%${prefix}%`)
      .limit(3);
    if (data && data.length > 0) similarRows = data;
  }

  return { aiSuggestion, similarRows };
}

// 2. /stats COMMAND (Admin / Owner Only)
bot.command('stats', async (ctx) => {
  const allowed = await isAdmin(ctx);
  if (!allowed) return;

  const { data, count, error } = await supabase
    .from('movies_index')
    .select('*', { count: 'exact' });

  if (error) {
    return ctx.reply(`❌ DB Error: <code>${escapeHTML(error.message)}</code>`, { parse_mode: 'HTML' });
  }
  ctx.reply(
    `📊 <b>JJ AI BOT STATS</b>\n\n🎬 <b>Total Indexed Files:</b> <code>${count ?? data?.length ?? 0}</code>\n⚡ <b>Status:</b> Online & Ready`,
    { parse_mode: 'HTML' }
  );
});

// 3. AUTO-INDEXING (DB Channel -> Supabase with safe ID normalization)
bot.on('channel_post', async (ctx) => {
  const post = ctx.channelPost;
  const incomingId = String(post.chat.id).replace(/^-100/, '');
  const expectedId = String(DB_CHANNEL_ID).replace(/^-100/, '');
  if (incomingId !== expectedId) return;

  const file = post.document || post.video;
  if (!file) return;

  const cleanName = extractMovieTitle(post.caption, file.file_name);
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
  else console.log(`✅ Indexed: ${cleanName} (${fileSize})`);
});

// 4. AUTO-WELCOME + DELETE JOIN SERVICE MESSAGE
bot.on('new_chat_members', async (ctx) => {
  ctx.deleteMessage().catch(() => {});
  for (const member of ctx.message.new_chat_members) {
    if (member.is_bot) continue;
    const welcomeMsg = await ctx.reply(
      `👋 <b>Welcome!</b>\n\n🎬 Meeku kavalsina movie name ikkada type cheyandi (e.g., <code>Kalki</code> or <code>Devara</code>), nenu ventane HD files isthanu!\n\n⚠️ <i>External links & promotions are strictly not allowed.</i>`,
      { parse_mode: 'HTML' }
    );
    setTimeout(() => ctx.telegram.deleteMessage(ctx.chat.id, welcomeMsg.message_id).catch(() => {}), 60 * 1000);
  }
});

// 5. LINK GUARD: Allow Admins / Anonymous Group Links, Delete Non-Admin Links
bot.use(async (ctx, next) => {
  if (!ctx.message || ctx.chat?.type === 'private') return next();

  if (containsLink(ctx.message)) {
    const allowed = await isAdmin(ctx);
    if (!allowed) {
      await ctx.deleteMessage().catch(() => {});
      const warn = await ctx.reply(
        `🚫 <b>Links Not Allowed!</b>\nAdmins / Channel links matrame allow. Vere links delete avuthayi.`,
        { parse_mode: 'HTML' }
      );
      setTimeout(() => ctx.telegram.deleteMessage(ctx.chat.id, warn.message_id).catch(() => {}), 10 * 1000);
      return;
    }
  }

  return next();
});

// Helper: Send Single or Multiple Files with Blue Group Link Captions + 5-Min Auto-Delete
async function deliverFiles(ctx, msgIds, labelName) {
  const sentIds = [];
  let lastTitle = 'Movie';

  for (const msgId of msgIds) {
    try {
      const { data: movie } = await supabase
        .from('movies_index')
        .select('file_name, file_size')
        .eq('message_id', msgId)
        .single();

      const rawTitle = movie ? movie.file_name : 'Watch Movie';
      lastTitle = rawTitle;

      const customCaption =
        `<a href="${GROUP_LINK}"><b>${escapeHTML(rawTitle)}</b></a>\n\n` +
        (movie?.file_size ? `💾 <a href="${GROUP_LINK}"><b>Size: ${escapeHTML(movie.file_size)}</b></a>\n\n` : '') +
        `📢 <a href="${GROUP_LINK}"><b>Join Our Movies Group</b></a>`;

      const sent = await ctx.telegram.copyMessage(ctx.chat.id, DB_CHANNEL_ID, msgId, {
        caption: customCaption,
        parse_mode: 'HTML'
      });
      sentIds.push(sent.message_id);
    } catch (e) {
      console.log(`Failed to send msgId ${msgId}:`, e.message);
    }
  }

  if (sentIds.length === 0) return ctx.reply('❌ File not found or deleted from storage.');

  const shareText = await getUniqueShareMsg(labelName, lastTitle);
  const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(GROUP_LINK)}&text=${encodeURIComponent('🎬 Free HD Movies Group mawa! Join avvu:')}`;

  const warnMsg = await ctx.reply(
    `${shareText}\n\n⚠️ <b>Note:</b> Ee file(s) <b>5 minutes</b> lo auto-delete avuthayi. Ventane Saved Messages ki forward chesko!`,
    {
      parse_mode: 'HTML',
      reply_to_message_id: sentIds[sentIds.length - 1],
      ...Markup.inlineKeyboard([[Markup.button.url('📤 Share Group with Friends', shareUrl)]])
    }
  );

  setTimeout(async () => {
    for (const id of sentIds) {
      await ctx.telegram.deleteMessage(ctx.chat.id, id).catch(() => {});
    }
    await ctx.telegram.editMessageText(
      ctx.chat.id, warnMsg.message_id, null,
      '✅ <b>YOUR FILES HAVE BEEN DELETED!</b>\nKindly search again in the group.',
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([[Markup.button.url('📤 Share Group with Friends', shareUrl)]])
      }
    ).catch(() => {});

    // Auto-delete the status notice 30s after editing
    setTimeout(() => {
      ctx.telegram.deleteMessage(ctx.chat.id, warnMsg.message_id).catch(() => {});
    }, 30 * 1000);
  }, 5 * 60 * 1000);
}

// 6. DEEP LINK DELIVERY (Single + SEND ALL) & GEMINI /start
bot.start(async (ctx) => {
  const payload = ctx.startPayload;
  const labelName = getRequesterDisplay(ctx);

  if (!payload) {
    await ctx.sendChatAction('typing').catch(() => {});
    const vibe = VIBES[Math.floor(Math.random() * VIBES.length)];
    try {
      const creativeModel = genAI.getGenerativeModel({
        model: 'gemini-2.0-flash',
        generationConfig: { temperature: 1.2, maxOutputTokens: 100 }
      });
      const prompt = `You are a cool AI Movie Assistant Telegram bot. Write a short, unique welcome message (max 3 lines) in Tenglish using "mawa" style for "${labelName}". Vibe: ${vibe}. Tell them to type any movie name in our group for instant HD files. Add movie emojis.`;
      const res = await creativeModel.generateContent(prompt);
      return ctx.reply(res.response.text().trim(), Markup.inlineKeyboard([[Markup.button.url('🎬 Join Movies Group', GROUP_LINK)]]));
    } catch (e) {
      return ctx.reply(`🎬 Hey ${labelName} mawa! Welcome to AI Movie Bot.\n\nGroup lo movie name type cheyandi, ventane HD files isthanu! 🍿`, Markup.inlineKeyboard([[Markup.button.url('🎬 Join Movies Group', GROUP_LINK)]]));
    }
  }

  if (payload.startsWith('file_')) {
    const msgId = parseInt(payload.replace('file_', ''), 10);
    if (!isNaN(msgId)) return deliverFiles(ctx, [msgId], labelName);
  }

  if (payload.startsWith('all_')) {
    const ids = payload.replace('all_', '').split('_').map(Number).filter(n => !isNaN(n));
    if (ids.length > 0) return deliverFiles(ctx, ids, labelName);
  }
});

// Helper: Build Clean & Minimal Movie Results Message (No User IDs/Names)
async function buildSearchMessage(query, page = 0, qual = 'ALL', lang = 'ALL', botUsername, tagLabel = 'JJ Movies AI') {
  const limit = 6;
  let dbQuery = supabase
    .from('movies_index')
    .select('*', { count: 'exact' })
    .ilike('file_name', `%${query}%`);

  if (qual !== 'ALL') dbQuery = dbQuery.ilike('quality', `%${qual}%`);
  if (lang !== 'ALL') dbQuery = dbQuery.ilike('language', `%${lang}%`);

  const { data, count, error } = await dbQuery
    .order('created_at', { ascending: false })
    .range(page * limit, (page + 1) * limit - 1);

  if (error || !data || data.length === 0) return null;

  const totalPages = Math.ceil(count / limit);

  let text = `🎬 <b>${escapeHTML(query)}</b> • <code>${count} Files</code>\n`;
  text += `⚡ <a href="${GROUP_LINK}">${escapeHTML(tagLabel)}</a>\n`;
  text += `──────────────\n\n`;

  const batchIds = data.slice(0, 5).map(i => i.message_id).join('_');
  const sendAllUrl = `https://t.me/${botUsername}?start=all_${batchIds}`;

  data.forEach((item, idx) => {
    const num = page * limit + idx + 1;
    const link = `https://t.me/${botUsername}?start=file_${item.message_id}`;
    const meta = detectMeta(item.file_name);
    text += `<b>${num}.</b> <a href="${link}">${escapeHTML(item.file_name)}</a>\n`;
    text += `📦 <code>${escapeHTML(item.file_size)}</code> | <code>${escapeHTML(item.quality || meta.quality)}</code> | <code>${escapeHTML(item.language || meta.language)}</code>\n\n`;
  });

  text += `──────────────\n`;
  text += `👇 <i>Click a file to get it in DM</i>`;

  const qShort = query.slice(0, 18);
  const buttons = [
    [Markup.button.url(`⚡ SEND ALL (${Math.min(data.length, 5)} FILES)`, sendAllUrl)],
    [
      Markup.button.callback(qual === '480p' ? '✅ 480p' : '480p', `f|${qShort}|0|480p|${lang}`),
      Markup.button.callback(qual === '720p' ? '✅ 720p' : '720p', `f|${qShort}|0|720p|${lang}`),
      Markup.button.callback(qual === '1080p' ? '✅ 1080p' : '1080p', `f|${qShort}|0|1080p|${lang}`),
      Markup.button.callback(qual === 'ALL' ? '✅ ALL' : 'ALL', `f|${qShort}|0|ALL|${lang}`)
    ],
    [
      Markup.button.callback(lang === 'Telugu' ? '✅ Tel' : 'Telugu', `f|${qShort}|0|${qual}|Telugu`),
      Markup.button.callback(lang === 'Hindi' ? '✅ Hin' : 'Hindi', `f|${qShort}|0|${qual}|Hindi`),
      Markup.button.callback(lang === 'Tamil' ? '✅ Tam' : 'Tamil', `f|${qShort}|0|${qual}|Tamil`),
      Markup.button.callback(lang === 'ALL' ? '✅ All Lang' : 'All Lang', `f|${qShort}|0|${qual}|ALL`)
    ]
  ];

  const navRow = [];
  if (page > 0) navRow.push(Markup.button.callback('⬅️ PREV', `f|${qShort}|${page - 1}|${qual}|${lang}`));
  navRow.push(Markup.button.callback(`📄 ${page + 1}/${totalPages}`, 'noop'));
  if (page + 1 < totalPages) navRow.push(Markup.button.callback('NEXT ➡️', `f|${qShort}|${page + 1}|${qual}|${lang}`));
  buttons.push(navRow);

  return { text, keyboard: Markup.inlineKeyboard(buttons) };
}

// 7. SMART AI GROUP SEARCH + DELETE NON-MOVIE / UNWANTED MESSAGES
bot.on('text', async (ctx) => {
  if (ctx.chat.type === 'private') return;
  const userText = ctx.message.text.trim();
  if (userText.startsWith('/')) return;

  const adminUser = await isAdmin(ctx);

  // If Admin / Anonymous Group posts a link or announcement, keep it as-is
  if (adminUser && containsLink(ctx.message)) {
    return;
  }

  // Delete very short messages (except admins)
  if (userText.length < 2) {
    if (!adminUser) scheduleUserMessageDelete(ctx, 10 * 1000);
    return;
  }

  let searchKeyword = userText;
  try {
    const prompt = `Analyze this Telegram group message: "${userText}"
Is the user asking for a movie, web series, or anime?
- If YES: Return ONLY the clean movie/series title (fix obvious spelling mistakes).
- If NO (it's normal chat like "hi", "hello", "bro", "thanks", or a random person's name like "Harish", "Suresh"): Return ONLY the word NONE.`;
    const result = await aiModel.generateContent(prompt);
    const aiOut = result.response.text().trim().replace(/['"]/g, '');

    if (aiOut.toUpperCase() === 'NONE') {
      if (!adminUser) scheduleUserMessageDelete(ctx, 15 * 1000);
      return;
    }
    if (aiOut && aiOut.length < 50) searchKeyword = aiOut;
  } catch (e) {
    console.log('Gemini intent fallback:', e.message);
  }

  let res = await buildSearchMessage(searchKeyword, 0, 'ALL', 'ALL', ctx.botInfo.username, 'JJ Movies AI');

  if (!res && searchKeyword.toLowerCase() !== userText.toLowerCase()) {
    res = await buildSearchMessage(userText, 0, 'ALL', 'ALL', ctx.botInfo.username, 'JJ Movies AI');
  }

  if (!res) {
    ctx.react('👀').catch(() => {});
    const { aiSuggestion, similarRows } = await findSpellingOrSimilar(userText);

    let msgText = `🔎 <b>"${escapeHTML(userText)}"</b> mana database lo dorakaledu mawa.\n`;
    msgText += `✍️ <i>Spelling mistake emo oka sari check chey!</i>\n`;

    if (aiSuggestion) {
      msgText += `\n💡 <b>Did you mean:</b> <code>${escapeHTML(aiSuggestion)}</code>?`;
    }

    if (similarRows.length > 0) {
      msgText += `\n\n📂 <b>Close matches found:</b>\n`;
      similarRows.forEach((row, i) => {
        const link = `https://t.me/${ctx.botInfo.username}?start=file_${row.message_id}`;
        msgText += `<b>${i + 1}.</b> <a href="${link}">${escapeHTML(row.file_name)}</a>\n📦 <code>${escapeHTML(row.file_size)}</code>\n`;
      });
    }

    msgText += `\nLekapothe kindha button click chesi Admin ki request pampu!`;

    const notFoundMsg = await ctx.reply(msgText, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_to_message_id: ctx.message.message_id,
      ...Markup.inlineKeyboard([[Markup.button.callback('📩 Request Admin', `req|${userText.slice(0, 35)}`)]])
    });

    setTimeout(() => ctx.telegram.deleteMessage(ctx.chat.id, notFoundMsg.message_id).catch(() => {}), 20 * 1000);
    if (!adminUser) scheduleUserMessageDelete(ctx, 20 * 1000);
    return;
  }

  const randomEmoji = SUCCESS_REACTIONS[Math.floor(Math.random() * SUCCESS_REACTIONS.length)];
  ctx.react(randomEmoji).catch(() => {});

  const resultMsg = await ctx.reply(res.text, {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_to_message_id: ctx.message.message_id,
    ...res.keyboard
  });

  setTimeout(() => ctx.telegram.deleteMessage(ctx.chat.id, resultMsg.message_id).catch(() => {}), 60 * 1000);
  if (!adminUser) scheduleUserMessageDelete(ctx, 60 * 1000);
});

// 8. CALLBACK HANDLERS (Filters, Pagination & Admin Request)
bot.action(/^f\|(.+)\|(\d+)\|(.+)\|(.+)$/, async (ctx) => {
  const [, query, pageStr, qual, lang] = ctx.match;
  const res = await buildSearchMessage(query, parseInt(pageStr, 10), qual, lang, ctx.botInfo.username, 'JJ Movies AI');
  if (!res) return ctx.answerCbQuery('❌ Ee filter lo files levu!', { show_alert: true });

  await ctx.editMessageText(res.text, {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...res.keyboard
  }).catch(() => {});
  ctx.answerCbQuery();
});

bot.action(/^req\|(.+)$/, async (ctx) => {
  const movieName = ctx.match[1];

  if (ADMIN_ID) {
    await ctx.telegram.sendMessage(
      ADMIN_ID,
      `📩 <b>NEW MOVIE REQUEST!</b>\n\n🎬 <b>Movie:</b> <code>${escapeHTML(movieName)}</code>`,
      { parse_mode: 'HTML' }
    ).catch(() => {});
  }

  await ctx.answerCbQuery('✅ Request Admin ki pampanu! Twaralo upload avuthundi.', { show_alert: true });
  ctx.deleteMessage().catch(() => {});
});

bot.action('noop', (ctx) => ctx.answerCbQuery());

// 9. Keep-Alive Server for Render
const app = express();
app.get('/', (req, res) => res.send('JJ AI Movie Bot Pro is Running!'));
app.listen(process.env.PORT || 3000, () => console.log('Server running...'));

bot.launch().then(() => console.log('🚀 JJ AI Movie Bot Pro Started!'));
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
