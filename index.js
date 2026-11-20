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
const TARGET_GROUP_ID = String(process.env.GROUP_ID || '').trim();
const TMDB_API_KEY = (process.env.TMDB_API_KEY || '').trim();

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

// Dynamic Multi-Supabase, Admins & Channels State
let extraDbs = [];     // [{ url, key, client }]
let extraAdmins = [];  // ['123456789', ...]
let channels = {
  db: [],      // Storage channels
  marvel: [],  // Marvel & DC
  series: [],  // Web Series
  dubbed: [],  // Hollywood Telugu Dubbed
  telugu: []   // Telugu & Remaining
};
const adminState = new Map();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Category Menu Helper
const channelMenuKeyboard = Markup.inlineKeyboard([
  [Markup.button.callback('🦸 Marvel & DC', 'addch_marvel'), Markup.button.callback('📺 Web Series', 'addch_series')],
  [Markup.button.callback('🗣️ Telugu Dubbed (Hollywood)', 'addch_dubbed')],
  [Markup.button.callback('🎬 Telugu & Remaining', 'addch_telugu')],
  [Markup.button.callback('🗄️ Storage (DB Channel)', 'addch_db')],
  [Markup.button.callback('❌ Cancel', 'addch_cancel')]
]);

// Load Dynamic DBs, Channels & Admins from Main Supabase
async function loadDynamicConfig() {
  try {
    const { data: dbs } = await supabase.from('bot_databases').select('*');
    extraDbs = (dbs || []).map((d) => ({
      url: d.url,
      key: d.anon_key,
      client: createClient(d.url, d.anon_key)
    }));

    const { data: chs } = await supabase.from('bot_channels').select('*');
    channels = { db: [], marvel: [], series: [], dubbed: [], telugu: [] };
    for (const c of chs || []) {
      if (channels[c.channel_type]) {
        channels[c.channel_type].push(String(c.channel_id));
      }
    }

    const { data: admins } = await supabase.from('bot_admins').select('user_id');
    extraAdmins = (admins || []).map((a) => String(a.user_id));

    console.log(`✅ Loaded ${extraDbs.length} extra DBs, ${(chs || []).length} channels, ${extraAdmins.length} extra admins.`);
  } catch (err) {
    console.error('Config Load Error:', err.message);
  }
}
loadDynamicConfig();

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

// Main Owner Only (Add/Remove Admins)
function isMainOwnerDM(ctx) {
  return ctx.chat?.type === 'private' && String(ctx.from?.id || '') === ADMIN_ID;
}

// Main Owner + Added Admins (DM Admin Panel & Commands)
function isOwnerDM(ctx) {
  const uid = String(ctx.from?.id || '');
  return ctx.chat?.type === 'private' && (uid === ADMIN_ID || extraAdmins.includes(uid));
}

// Checks Owner, Added Admins, Anonymous Group Admin, or Telegram Group Admin
async function isAdmin(ctx, userId = ctx.from?.id) {
  const uid = String(userId || '');
  if (uid && (uid === ADMIN_ID || extraAdmins.includes(uid))) return true;

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

function parseFileMeta(rawName) {
  const cleanStr = (rawName || '').replace(/\.(mkv|mp4|avi|mov)$/i, '').replace(/[\._]/g, ' ');
  const isSeries = /\b(S\d{1,2}|Season\s*\d{1,2}|E\d{1,2}|EP\s*\d{1,2})\b/i.test(cleanStr);
  const seasonMatch = cleanStr.match(/\b(?:S|Season\s*)0?(\d{1,2})\b/i);
  const seasonNum = seasonMatch ? parseInt(seasonMatch[1], 10) : null;

  const yearMatch = cleanStr.match(/\b(19\d{2}|20\d{2})\b/);
  const year = yearMatch ? yearMatch[1] : null;

  const langs = [];
  if (/telugu|tel\b/i.test(cleanStr)) langs.push('Telugu');
  if (/tamil|tam\b/i.test(cleanStr)) langs.push('Tamil');
  if (/hindi|hin\b/i.test(cleanStr)) langs.push('Hindi');
  if (/english|eng\b/i.test(cleanStr)) langs.push('English');
  if (/malayalam|mal\b/i.test(cleanStr)) langs.push('Malayalam');
  if (/kannada|kan\b/i.test(cleanStr)) langs.push('Kannada');

  const qualMatch = cleanStr.match(/\b(480p|720p|1080p|2160p|4K)\b/i);
  const quality = qualMatch ? qualMatch[1].toUpperCase() : 'HD';

  let title = cleanStr
    .replace(/\b(19\d{2}|20\d{2})\b.*/i, '')
    .replace(/\b(S\d{1,2}.*|Season\s*\d+.*|480p.*|720p.*|1080p.*|WEB-DL.*|HDRip.*|BluRay.*|HQ.*|PreDVD.*)/i, '')
    .replace(/[\(\)\[\]\-–—]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!title || title.length < 2) title = cleanStr.slice(0, 35).trim();

  const groupKey = `${title.toLowerCase().replace(/[^a-z0-9]/g, '')}_${year || 'na'}${isSeries && seasonNum ? `_s${seasonNum}` : ''}`;
  return { title, year, langs, quality, isSeries, seasonNum, groupKey };
}

async function fetchTmdbInfo(title, year, isSeries) {
  if (!TMDB_API_KEY) return null;
  try {
    const type = isSeries ? 'tv' : 'movie';
    const yearParam = year ? (isSeries ? `&first_air_date_year=${year}` : `&year=${year}`) : '';
    const searchUrl = `https://api.themoviedb.org/3/search/${type}?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(title)}${yearParam}`;
    const res = await fetch(searchUrl);
    const data = await res.json();
    const first = data.results?.[0];
    if (!first) return null;

    const detailUrl = `https://api.themoviedb.org/3/${type}/${first.id}?api_key=${TMDB_API_KEY}`;
    const detRes = await fetch(detailUrl);
    const det = await detRes.json();

    const companies = (det.production_companies || []).map((c) => c.name.toLowerCase());
    const networks = (det.networks || []).map((n) => n.name.toLowerCase());
    const combinedText = `${det.title || det.name || ''} ${det.overview || ''} ${companies.join(' ')} ${networks.join(' ')}`.toLowerCase();

    const isMarvelOrDc = /(marvel|dc films|dc entertainment|dc studios|avengers|spider-man|batman|superman|deadpool|wolverine|thunderbolts|loki|daredevil|peacemaker|joker|aquaman|flash|iron man|thor|captain america|x-men)/i.test(combinedText);

    return {
      title: det.title || det.name || title,
      year: (det.release_date || det.first_air_date || year || '').slice(0, 4),
      originalLang: det.original_language || '',
      posterUrl: det.poster_path ? `https://image.tmdb.org/t/p/w500${det.poster_path}` : null,
      isMarvelOrDc
    };
  } catch (err) {
    console.error('TMDB Error:', err.message);
    return null;
  }
}

function scheduleUserMessageDelete(ctx, delayMs) {
  const msgId = ctx.message?.message_id;
  const chatId = ctx.chat?.id;
  if (!msgId || !chatId) return;

  setTimeout(async () => {
    try {
      await ctx.telegram.deleteMessage(chatId, msgId);
    } catch (e) {}
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

function getAdminPanelText() {
  return (
    `👑 <b>JJ FILES ADMIN PANEL</b>\n\n` +
    `• /addchannel - Add Category Channel\n` +
    `• /channels - View Connected Channels\n` +
    `• /delchannel - Remove Channel\n` +
    `• /autopost - Start TMDB Auto-Post\n` +
    `• /adddb - Add Extra Supabase DB\n` +
    `• /listdb - View Active DBs\n` +
    `• /addadmin - Add Bot Admin (Owner)\n` +
    `• /deladmin - Remove Bot Admin (Owner)\n` +
    `• /admins - View Admins List\n` +
    `• /stats - Bot & File Stats`
  );
}

// ================= OWNER & ADMIN PRIVATE DM COMMANDS =================
bot.command('admin', (ctx) => {
  if (!isOwnerDM(ctx)) return;
  ctx.reply(getAdminPanelText(), {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([[Markup.button.callback('📢 Add Channel', 'addch_back')]])
  });
});

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
    `📊 <b>JJ AI BOT STATS</b>\n\n🎬 <b>Total Indexed Files:</b> <code>${count ?? data?.length ?? 0}</code>\n🗄️ <b>Extra DBs:</b> <code>${extraDbs.length}</code>\n👮 <b>Extra Admins:</b> <code>${extraAdmins.length}</code>\n⚡ <b>Status:</b> Online & Ready`,
    { parse_mode: 'HTML' }
  );
});

bot.command('addadmin', async (ctx) => {
  if (!isMainOwnerDM(ctx)) return;
  const uid = ctx.message.text.replace('/addadmin', '').trim();
  if (!/^\d+$/.test(uid)) {
    return ctx.reply('❌ Usage: <code>/addadmin 1234567890</code>', { parse_mode: 'HTML' });
  }
  await supabase.from('bot_admins').upsert({ user_id: uid }, { onConflict: 'user_id' });
  await loadDynamicConfig();
  ctx.reply(`✅ Admin <code>${uid}</code> added!`, { parse_mode: 'HTML' });
});

bot.command('deladmin', async (ctx) => {
  if (!isMainOwnerDM(ctx)) return;
  const uid = ctx.message.text.replace('/deladmin', '').trim();
  if (!/^\d+$/.test(uid)) {
    return ctx.reply('❌ Usage: <code>/deladmin 1234567890</code>', { parse_mode: 'HTML' });
  }
  await supabase.from('bot_admins').delete().eq('user_id', uid);
  await loadDynamicConfig();
  ctx.reply(`🗑️ Admin <code>${uid}</code> removed.`, { parse_mode: 'HTML' });
});

bot.command('admins', (ctx) => {
  if (!isOwnerDM(ctx)) return;
  const list = extraAdmins.length > 0 ? extraAdmins.map((id, i) => `${i + 1}. <code>${id}</code>`).join('\n') : 'None';
  ctx.reply(`👑 <b>Main Owner:</b> <code>${ADMIN_ID}</code>\n\n👮 <b>Added Admins:</b>\n${list}`, { parse_mode: 'HTML' });
});

bot.command('addchannel', (ctx) => {
  if (!isOwnerDM(ctx)) return;
  adminState.delete(ctx.chat.id);
  ctx.reply('📢 <b>Select Channel Category to Add:</b>', {
    parse_mode: 'HTML',
    ...channelMenuKeyboard
  });
});

bot.command('channels', (ctx) => {
  if (!isOwnerDM(ctx)) return;
  const text =
    `📢 <b>Connected Channels:</b>\n\n` +
    `🗄️ <b>Storage (DB):</b> ${channels.db.join(', ') || DB_CHANNEL_ID}\n` +
    `🦸 <b>Marvel & DC:</b> ${channels.marvel.join(', ') || 'None'}\n` +
    `📺 <b>Web Series:</b> ${channels.series.join(', ') || 'None'}\n` +
    `🗣️ <b>Telugu Dubbed:</b> ${channels.dubbed.join(', ') || 'None'}\n` +
    `🎬 <b>Telugu/Remaining:</b> ${channels.telugu.join(', ') || 'None'}\n\n` +
    `Remove cheyadaniki: <code>/delchannel -100xxxx</code>`;
  ctx.reply(text, { parse_mode: 'HTML' });
});

bot.command('delchannel', async (ctx) => {
  if (!isOwnerDM(ctx)) return;
  const chId = ctx.message.text.replace('/delchannel', '').trim();
  if (!/^-?\d+$/.test(chId)) return ctx.reply('❌ Usage: <code>/delchannel -1001234567890</code>', { parse_mode: 'HTML' });

  await supabase.from('bot_channels').delete().eq('channel_id', chId);
  await loadDynamicConfig();
  ctx.reply(`🗑️ Channel <code>${chId}</code> removed.`, { parse_mode: 'HTML' });
});

bot.command('adddb', (ctx) => {
  if (!isOwnerDM(ctx)) return;
  adminState.set(ctx.chat.id, { action: 'awaiting_db' });
  ctx.reply('🗄️ Kotha Supabase details ila pampandi:\n\n<code>SUPABASE_URL SUPABASE_ANON_KEY</code>', { parse_mode: 'HTML' });
});

bot.command('listdb', (ctx) => {
  if (!isOwnerDM(ctx)) return;
  const list = extraDbs.map((d, i) => `${i + 1}. ${d.url}`).join('\n') || 'No extra DBs added.';
  ctx.reply(`🗄️ <b>Active Databases:</b>\n\n<b>Main:</b> ${process.env.SUPABASE_URL || 'Default'}\n\n<b>Extra:</b>\n${escapeHTML(list)}`, { parse_mode: 'HTML' });
});

// ================= TMDB 4-CHANNEL AUTO-POSTER =================
bot.command('autopost', async (ctx) => {
  if (!isOwnerDM(ctx)) return;
  await ctx.reply('🔄 Scanning all Supabase DBs & grouping movies/series...');

  let allFiles = [];
  const dbsToRead = [supabase, ...extraDbs.map((d) => d.client)];
  for (const client of dbsToRead) {
    const { data } = await client.from('movies_index').select('file_name, message_id, channel_id').limit(5000);
    if (data) allFiles = allFiles.concat(data);
  }

  if (allFiles.length === 0) {
    return ctx.reply('❌ Supabase lo files em levu.');
  }

  const groups = new Map();
  for (const f of allFiles) {
    if (!f.message_id) continue;
    const chId = String(f.channel_id || DB_CHANNEL_ID);
    const meta = parseFileMeta(f.file_name);
    if (!groups.has(meta.groupKey)) {
      groups.set(meta.groupKey, {
        meta,
        langs: new Set(meta.langs),
        qualities: new Set([meta.quality]),
        items: []
      });
    }
    const g = groups.get(meta.groupKey);
    meta.langs.forEach((l) => g.langs.add(l));
    g.qualities.add(meta.quality);
    g.items.push({ channel_id: chId, message_id: f.message_id });
  }

  const { data: existing } = await supabase.from('movie_batches').select('movie_key').eq('posted', true);
  const postedKeys = new Set((existing || []).map((e) => e.movie_key));

  let postedCount = 0;

  for (const [movieKey, g] of groups.entries()) {
    if (postedKeys.has(movieKey)) continue;

    const tmdb = await fetchTmdbInfo(g.meta.title, g.meta.year, g.meta.isSeries);
    const finalTitle = tmdb?.title || g.meta.title;
    const finalYear = tmdb?.year || g.meta.year || 'N/A';
    const langsArr = Array.from(g.langs);
    const langsText = langsArr.length > 0 ? langsArr.join(', ') : 'Telugu';
    const qualsText = Array.from(g.qualities).join(', ');

    // Priority: 1. Marvel/DC -> 2. Web Series -> 3. Hollywood Telugu Dubbed -> 4. Telugu/Remaining
    let targetType = 'telugu';
    if (tmdb?.isMarvelOrDc) {
      targetType = 'marvel';
    } else if (g.meta.isSeries) {
      targetType = 'series';
    } else if (tmdb?.originalLang === 'en' && langsArr.includes('Telugu')) {
      targetType = 'dubbed';
    }

    const targetChannels = channels[targetType]?.length > 0 ? channels[targetType] : channels.telugu;
    if (!targetChannels || targetChannels.length === 0) continue;

    const batchCode = `b_${Date.now().toString(36)}${Math.floor(Math.random() * 90 + 10)}`;
    const deepLink = `https://t.me/${ctx.botInfo.username}?start=${batchCode}`;

    const { error: saveErr } = await supabase.from('movie_batches').upsert({
      batch_code: batchCode,
      movie_key: movieKey,
      movie_title: finalTitle,
      file_items: g.items,
      posted: true
    }, { onConflict: 'movie_key' });

    if (saveErr) {
      console.error('Batch Save Error:', saveErr.message);
      continue;
    }

    const seasonTag = g.meta.isSeries && g.meta.seasonNum ? ` - Season ${g.meta.seasonNum}` : '';
    const caption =
      `🎬 <b>${escapeHTML(finalTitle)}${seasonTag} (${escapeHTML(finalYear)})</b>\n\n` +
      `📅 <b>Year:</b> ${escapeHTML(finalYear)}\n` +
      `🔊 <b>Languages:</b> ${escapeHTML(langsText)}\n` +
      `🎞️ <b>Qualities:</b> ${escapeHTML(qualsText)}\n` +
      `📂 <b>Total Files:</b> ${g.items.length}`;

    const keyboard = Markup.inlineKeyboard([[Markup.button.url('⚡ Download All Files', deepLink)]]);

    for (const targetCh of targetChannels) {
      try {
        if (tmdb?.posterUrl) {
          await ctx.telegram.sendPhoto(targetCh, tmdb.posterUrl, { caption, parse_mode: 'HTML', ...keyboard });
        } else {
          await ctx.telegram.sendMessage(targetCh, caption, { parse_mode: 'HTML', ...keyboard });
        }
      } catch (err) {
        console.error(`Post failed for ${finalTitle} in ${targetCh}:`, err.message);
      }
      await sleep(5000); // Safe 5s delay
    }

    postedCount++;
  }

  ctx.reply(`✅ Auto-Post Complete! Total new posts: <b>${postedCount}</b>`, { parse_mode: 'HTML' });
});

// ================= AUTO-INDEXING (STORAGE CHANNELS -> SUPABASE) =================
bot.on('channel_post', async (ctx) => {
  const post = ctx.channelPost;
  const incomingClean = String(post.chat.id).replace(/^-100/, '');
  const allowedCleanIds = [DB_CHANNEL_ID, ...channels.db].map(id => String(id).replace(/^-100/, ''));

  if (!allowedCleanIds.includes(incomingClean)) return;

  const file = post.document || post.video;
  if (!file) return;

  const cleanName = extractMovieTitle(post.caption, file.file_name);
  const fileSize = formatSize(file.file_size);
  const { quality, language } = detectMeta(cleanName);

  const record = {
    message_id: post.message_id,
    channel_id: String(post.chat.id),
    file_name: cleanName,
    file_size: fileSize,
    quality,
    language
  };

  const { error } = await supabase.from('movies_index').upsert(record, { onConflict: 'message_id' });
  if (error && extraDbs.length > 0) {
    for (const db of extraDbs) {
      const res = await db.client.from('movies_index').upsert(record, { onConflict: 'message_id' });
      if (!res.error) break;
    }
  } else if (!error) {
    console.log(`✅ Indexed: ${cleanName} (${fileSize})`);
  }
});

// ================= AUTO-WELCOME + LINK GUARD =================
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

// ================= FILE DELIVERY (SINGLE, SEND ALL & BATCH) =================
async function deliverFiles(ctx, items, labelName) {
  const sentIds = [];
  let lastTitle = 'Movie';

  for (const item of items) {
    const msgId = typeof item === 'object' ? item.message_id : item;
    const chId = typeof item === 'object' && item.channel_id ? item.channel_id : DB_CHANNEL_ID;

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

      const sent = await ctx.telegram.copyMessage(ctx.chat.id, chId, msgId, {
        caption: customCaption,
        parse_mode: 'HTML'
      });
      sentIds.push(sent.message_id);
      await sleep(800);
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

    setTimeout(() => {
      ctx.telegram.deleteMessage(ctx.chat.id, warnMsg.message_id).catch(() => {});
    }, 30 * 1000);
  }, 5 * 60 * 1000);
}

// ================= DEEP LINK DELIVERY (/start) =================
bot.start(async (ctx) => {
  const payload = ctx.startPayload;
  const labelName = getRequesterDisplay(ctx);

  if (!payload) {
    if (isOwnerDM(ctx)) {
      return ctx.reply(getAdminPanelText(), {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([[Markup.button.callback('📢 Add Channel', 'addch_back')]])
      });
    }

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

  if (payload.startsWith('b_')) {
    const { data: batch } = await supabase
      .from('movie_batches')
      .select('*')
      .eq('batch_code', payload)
      .single();

    if (!batch || !batch.file_items?.length) {
      return ctx.reply('❌ Files not found or batch link expired.');
    }
    return deliverFiles(ctx, batch.file_items, labelName);
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

// ================= INTERACTIVE OWNER DM INPUT HANDLER =================
bot.on('message', async (ctx, next) => {
  if (!isOwnerDM(ctx)) return next();
  if (ctx.message.text && ctx.message.text.startsWith('/')) return next();

  const state = adminState.get(ctx.chat.id);
  if (!state) return next();

  if (state.action === 'awaiting_channel') {
    let chId = null;
    if (ctx.message.forward_from_chat && ctx.message.forward_from_chat.type === 'channel') {
      chId = String(ctx.message.forward_from_chat.id);
    } else if (ctx.message.text && /^-?\d+$/.test(ctx.message.text.trim())) {
      chId = ctx.message.text.trim();
    }

    if (!chId) {
      return ctx.reply('❌ Invalid Channel ID. Forward a message from the channel or send <code>-100...</code> ID.', { parse_mode: 'HTML' });
    }

    await supabase.from('bot_channels').upsert({ channel_id: chId, channel_type: state.category }, { onConflict: 'channel_id' });
    await loadDynamicConfig();
    adminState.delete(ctx.chat.id);
    return ctx.reply(`✅ Saved! Channel <code>${chId}</code> added to <b>${state.category.toUpperCase()}</b>.`, { parse_mode: 'HTML' });
  }

  if (state.action === 'awaiting_db') {
    const parts = (ctx.message.text || '').trim().split(/\s+/);
    if (parts.length < 2) {
      return ctx.reply('❌ Format: <code>SUPABASE_URL SUPABASE_ANON_KEY</code>', { parse_mode: 'HTML' });
    }
    const [url, anon_key] = parts;
    await supabase.from('bot_databases').upsert({ url, anon_key }, { onConflict: 'url' });
    await loadDynamicConfig();
    adminState.delete(ctx.chat.id);
    return ctx.reply('✅ Extra Supabase DB added and active!');
  }

  return next();
});

// ================= GROUP SEARCH & FILTERS =================
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

bot.on('text', async (ctx) => {
  if (ctx.chat.type === 'private') return;
  const userText = ctx.message.text.trim();
  if (userText.startsWith('/')) return;

  const adminUser = await isAdmin(ctx);
  if (adminUser && containsLink(ctx.message)) return;

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
  } catch (e) {}

  let res = await buildSearchMessage(searchKeyword, 0, 'ALL', 'ALL', ctx.botInfo.username, 'JJ Movies AI');
  if (!res && searchKeyword.toLowerCase() !== userText.toLowerCase()) {
    res = await buildSearchMessage(userText, 0, 'ALL', 'ALL', ctx.botInfo.username, 'JJ Movies AI');
  }

  if (!res) {
    ctx.react('👀').catch(() => {});
    const { aiSuggestion, similarRows } = await findSpellingOrSimilar(userText);

    let msgText = `🔎 <b>"${escapeHTML(userText)}"</b> mana database lo dorakaledu mawa.\n`;
    msgText += `✍️ <i>Spelling mistake emo oka sari check chey!</i>\n`;
    if (aiSuggestion) msgText += `\n💡 <b>Did you mean:</b> <code>${escapeHTML(aiSuggestion)}</code>?`;

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

// ================= CALLBACK HANDLERS =================
bot.action('addch_back', async (ctx) => {
  if (!isOwnerDM(ctx)) return ctx.answerCbQuery();
  adminState.delete(ctx.chat.id);
  await ctx.answerCbQuery();
  ctx.editMessageText('📢 <b>Select Channel Category to Add:</b>', {
    parse_mode: 'HTML',
    ...channelMenuKeyboard
  }).catch(() => {});
});

bot.action('addch_cancel', async (ctx) => {
  if (!isOwnerDM(ctx)) return ctx.answerCbQuery();
  adminState.delete(ctx.chat.id);
  await ctx.answerCbQuery('Cancelled');
  ctx.editMessageText('❌ Channel setup cancelled.').catch(() => {});
});

bot.action(/^addch_(.+)$/, async (ctx) => {
  if (!isOwnerDM(ctx)) return ctx.answerCbQuery();
  const category = ctx.match[1];
  adminState.set(ctx.chat.id, { action: 'awaiting_channel', category });
  await ctx.answerCbQuery();
  ctx.editMessageText(
    `✅ Selected: <b>${category.toUpperCase()}</b>\n\nIppudu aa Channel ID (<code>-100...</code>) pampandi, LEDA aa channel nunchi edo oka message ikkada forward cheyandi.`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('⬅️ Back', 'addch_back'), Markup.button.callback('❌ Cancel', 'addch_cancel')]
      ])
    }
  ).catch(() => {});
});

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

// ================= KEEP-ALIVE SERVER =================
const app = express();
app.get('/', (req, res) => res.send('JJ AI Movie Bot Pro is Running!'));
app.listen(process.env.PORT || 3000, () => console.log('Server running...'));

bot.launch().then(async () => {
  console.log('🚀 JJ AI Movie Bot Pro Started!');
  if (ADMIN_ID) {
    await bot.telegram.setMyCommands(
      [
        { command: 'admin', description: '👑 Admin Panel' },
        { command: 'addchannel', description: '📢 Add Category Channel' },
        { command: 'channels', description: '📋 View Channels' },
        { command: 'autopost', description: '🚀 Start TMDB Auto-Post' },
        { command: 'adddb', description: '🗄️ Add Extra Supabase DB' },
        { command: 'listdb', description: '📚 View Active DBs' },
        { command: 'admins', description: '👮 View Admins List' },
        { command: 'stats', description: '📊 Bot & File Stats' }
      ],
      { scope: { type: 'chat', chat_id: Number(ADMIN_ID) } }
    ).catch((e) => console.error('Menu setup error:', e.message));
  }
});
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
