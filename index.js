const { Telegraf, Markup } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const express = require('express');

// 1. Setup Clients (handlerTimeout: Infinity prevents 90s timeout crash)
const bot = new Telegraf((process.env.BOT_TOKEN || '').trim(), {
  handlerTimeout: Infinity
});
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
  theatre: [], // Theatre Prints (CAM Only)
  marvel: [],  // Marvel & DC
  series: [],  // Web Series
  dubbed: [],  // Hollywood Telugu Dubbed
  telugu: []   // Telugu & Remaining
};
const adminState = new Map();
const pendingAutoPosts = new Map();

// Auto-Post Anti-Ban State
let isAutoPosting = false;
let stopAutoPostFlag = false;

// Supabase Limit / Storage Early Warning Config
const DB_WARN_THRESHOLD = 40000;
let lastDbQuotaAlertAt = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Category Menu Helper
const channelMenuKeyboard = Markup.inlineKeyboard([
  [Markup.button.callback('🎥 Theatre Prints (CAM)', 'addch_theatre')],
  [Markup.button.callback('🦸 Marvel & DC', 'addch_marvel'), Markup.button.callback('📺 Web Series', 'addch_series')],
  [Markup.button.callback('🗣️ Telugu Dubbed (Hollywood)', 'addch_dubbed')],
  [Markup.button.callback('🎬 Telugu & Remaining', 'addch_telugu')],
  [Markup.button.callback('🗄️ Storage (DB Channel)', 'addch_db')],
  [Markup.button.callback('❌ Cancel', 'addch_cancel')]
]);

function normalizeChannelId(rawId) {
  const digits = String(rawId || '').trim().replace(/^-100/, '').replace(/^-/, '');
  return digits ? `-100${digits}` : '';
}

function dedupeChannelList(list = []) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const norm = normalizeChannelId(item);
    if (norm && !seen.has(norm)) {
      seen.add(norm);
      out.push(norm);
    }
  }
  return out;
}

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
    const rawMap = { db: [], theatre: [], marvel: [], series: [], dubbed: [], telugu: [] };
    for (const c of chs || []) {
      if (rawMap[c.channel_type]) {
        rawMap[c.channel_type].push(String(c.channel_id));
      }
    }
    channels = {
      db: dedupeChannelList(rawMap.db),
      theatre: dedupeChannelList(rawMap.theatre),
      marvel: dedupeChannelList(rawMap.marvel),
      series: dedupeChannelList(rawMap.series),
      dubbed: dedupeChannelList(rawMap.dubbed),
      telugu: dedupeChannelList(rawMap.telugu)
    };

    const { data: admins } = await supabase.from('bot_admins').select('user_id');
    extraAdmins = (admins || []).map((a) => String(a.user_id));

    console.log(`✅ Loaded ${extraDbs.length} extra DBs, ${(chs || []).length} channels, ${extraAdmins.length} extra admins.`);
  } catch (err) {
    console.error('Config Load Error:', err.message);
  }
}
loadDynamicConfig();

// Early Warning Alert for Supabase Limit / Storage
async function notifyOwnerDbAlert(reasonText) {
  const now = Date.now();
  if (now - lastDbQuotaAlertAt < 24 * 60 * 60 * 1000) return;
  lastDbQuotaAlertAt = now;

  const recipients = [ADMIN_ID, ...extraAdmins].filter(Boolean);
  const msg =
    `🚨 <b>SUPABASE LIMIT / STORAGE ALERT</b>\n\n` +
    `${reasonText}\n\n` +
    `👉 <i>Supabase lo limit/storage full avvakunda munde kotha Supabase ID (project) create cheskondi, tarvata <code>/adddb</code> tho bot lo add cheyandi!</i>`;

  for (const uid of recipients) {
    await bot.telegram.sendMessage(uid, msg, { parse_mode: 'HTML' }).catch(() => {});
  }
}

async function checkSupabaseThreshold(client = supabase) {
  try {
    const { count } = await client.from('movies_index').select('*', { count: 'exact', head: true });
    if (typeof count === 'number' && count >= DB_WARN_THRESHOLD) {
      await notifyOwnerDbAlert(`📊 <b>Current Indexed Rows:</b> <code>${count}</code> / <code>${DB_WARN_THRESHOLD}</code>`);
    }
  } catch (e) {}
}

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

function isMainOwnerDM(ctx) {
  return ctx.chat?.type === 'private' && String(ctx.from?.id || '') === ADMIN_ID;
}

function isOwnerDM(ctx) {
  const uid = String(ctx.from?.id || '');
  return ctx.chat?.type === 'private' && (uid === ADMIN_ID || extraAdmins.includes(uid));
}

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
  const cleanStr = (rawName || '')
    .replace(/\.(mkv|mp4|avi|mov|webm)$/i, '')
    .replace(/[\._]/g, ' ');

  const isSeries = /\b(S\d{1,2}\s*E\d{1,2}|S\d{1,2}|Season\s*\d{1,2}|E\d{1,2}|EP\s*\d{1,2}|Episode\s*\d{1,2})\b/i.test(cleanStr);
  const seasonMatch = cleanStr.match(/\b(?:S|Season\s*)0?(\d{1,2})(?:\s*E\d{1,2}|\b)/i);
  const seasonNum = seasonMatch ? parseInt(seasonMatch[1], 10) : null;

  const isSample = /\b(sample\s*video|print\s*sample|video\s*sample|sample)\b/i.test(cleanStr);
  const isCamPrint = /\b(PreDVD|PreDVDRip|HDCAM|CAMRip|HQCAM|HDTS|TSRip|Telesync|DVDScr|Theatre\s*Print|Cam\s*Print|S-Print|HQ\s*S-Print|CAM|TS)\b/i.test(cleanStr);
  const isTheatreFile = isCamPrint || isSample;

  const yearMatch = cleanStr.match(/\b(19\d{2}|20\d{2})\b/);
  const year = yearMatch ? yearMatch[1] : null;

  const langs = [];
  if (/\b(telugu|tel)\b/i.test(cleanStr)) langs.push('Telugu');
  if (/\b(tamil|tam)\b/i.test(cleanStr)) langs.push('Tamil');
  if (/\b(hindi|hin)\b/i.test(cleanStr)) langs.push('Hindi');
  if (/\b(english|eng)\b/i.test(cleanStr)) langs.push('English');
  if (/\b(malayalam|mal)\b/i.test(cleanStr)) langs.push('Malayalam');
  if (/\b(kannada|kan)\b/i.test(cleanStr)) langs.push('Kannada');

  const qualMatch = cleanStr.match(/\b(480p|720p|1080p|2160p|4K)\b/i);
  const quality = qualMatch ? qualMatch[1].toUpperCase() : 'HD';

  let title = cleanStr
    .replace(/\b(19\d{2}|20\d{2})\b.*/i, '')
    .replace(/\b(S\d{1,2}\s*E\d{1,2}|S\d{1,2}|Season\s*\d+|E\d{1,2}|EP\s*\d+|Episode\s*\d+|480p|720p|1080p|2160p|4K|WEB-DL|WEBRip|HDRip|BluRay|HQ|PreDVD|PreDVDRip|HDCAM|CAMRip|HQCAM|HDTS|TSRip|Telesync|DVDScr|Theatre\s*Print|Cam\s*Print|S-Print|CAM|TS|V\d+|Sample\s*Video|Sample|Rip|Dual\s*Audio|Telugu|Tamil|Hindi|English|Malayalam|Kannada|Dubbed|Uncut|ESub|x264|x265|HEVC|10bit|AAC|5\.1|2\.0)\b.*/i, '')
    .replace(/[\(\)\[\]\{\}\-–—_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!title || title.length < 2) {
    title = cleanStr.replace(/[\(\)\[\]\-–—]+/g, ' ').replace(/\s+/g, ' ').slice(0, 35).trim();
  }

  const groupKey = `${title.toLowerCase().replace(/[^a-z0-9]/g, '')}_${year || 'na'}${isSeries && seasonNum ? `_s${seasonNum}` : ''}${isTheatreFile ? '_cam' : ''}`;
  return { title, year, langs, quality, isSeries, seasonNum, isCamPrint, isSample, isTheatreFile, groupKey };
}

// Strict Category Resolver (Theatre -> Marvel/DC including X-Men -> Series -> Dubbed -> Telugu)
function resolveCategory(meta, tmdb, langsArr) {
  if (meta.isTheatreFile) return 'theatre';
  if (tmdb?.isMarvelOrDc) return 'marvel';
  if (meta.isSeries) return 'series';
  if (!tmdb?.isIndian && tmdb?.originalLang === 'en' && langsArr.includes('Telugu')) {
    return 'dubbed';
  }
  return 'telugu';
}

// Anti-Ban FloodWait Guard
async function sendWithFloodGuard(fn) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const retryAfter = err?.response?.parameters?.retry_after;
      if (retryAfter) {
        console.log(`⏳ Telegram FloodWait: waiting ${retryAfter + 2}s...`);
        await sleep((retryAfter + 2) * 1000);
        continue;
      }
      throw err;
    }
  }
}

// Permanent Photo Upload Helper (Downloads as Buffer -> Uploads to Telegram)
async function sendBannerPhoto(targetCh, imageUrl, caption) {
  if (!imageUrl) {
    return await sendWithFloodGuard(() =>
      bot.telegram.sendMessage(targetCh, caption, { parse_mode: 'HTML' })
    );
  }
  try {
    const imgRes = await fetch(imageUrl, {
      headers: { 'User-Agent': 'JJMoviesBot/1.0 (Telegram)' }
    });
    if (!imgRes.ok) throw new Error(`HTTP ${imgRes.status}`);
    const buffer = Buffer.from(await imgRes.arrayBuffer());
    return await sendWithFloodGuard(() =>
      bot.telegram.sendPhoto(targetCh, { source: buffer }, { caption, parse_mode: 'HTML' })
    );
  } catch (e) {
    return await sendWithFloodGuard(() =>
      bot.telegram.sendPhoto(targetCh, imageUrl, { caption, parse_mode: 'HTML' })
    ).catch(() =>
      sendWithFloodGuard(() =>
        bot.telegram.sendMessage(targetCh, caption, { parse_mode: 'HTML' })
      )
    );
  }
}

async function fetchWikipediaPoster(title, year) {
  try {
    const query = encodeURIComponent(`${title} ${year || ''} film`.trim());
    const searchRes = await fetch(`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${query}&format=json&srlimit=1`, {
      headers: { 'User-Agent': 'JJMoviesBot/1.0' }
    });
    const searchData = await searchRes.json();
    const pageTitle = searchData?.query?.search?.[0]?.title;
    if (!pageTitle) return null;

    const imgRes = await fetch(`https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(pageTitle)}&prop=pageimages&format=json&pithumbsize=800`, {
      headers: { 'User-Agent': 'JJMoviesBot/1.0' }
    });
    const imgData = await imgRes.json();
    const pages = imgData?.query?.pages || {};
    const firstPage = Object.values(pages)[0];
    return firstPage?.thumbnail?.source || null;
  } catch (err) {
    console.error('Wikipedia Poster Error:', err.message);
    return null;
  }
}

async function fetchTmdbInfo(title, year, isSeries) {
  if (!TMDB_API_KEY) return null;
  try {
    const type = isSeries ? 'tv' : 'movie';

    async function searchTmdb(q, y) {
      const yearParam = y ? (isSeries ? `&first_air_date_year=${y}` : `&year=${y}`) : '';
      let res = await fetch(`https://api.themoviedb.org/3/search/${type}?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(q)}${yearParam}`);
      let data = await res.json();
      let match = data.results?.[0];

      if (!match && y) {
        res = await fetch(`https://api.themoviedb.org/3/search/${type}?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(q)}`);
        data = await res.json();
        match = data.results?.[0];
      }
      return match || null;
    }

    let first = await searchTmdb(title, year);

    // 1. TMDB lo dorakakapothe -> Gemini tho exact official title theeskuni malli try chey
    let correctedTitle = title;
    if (!first) {
      try {
        const prompt = `Give ONLY the exact official English/TMDB title of the Indian/Hollywood ${isSeries ? 'TV series' : 'movie'} "${title}" (${year || ''}). No quotes, no extra words.`;
        const aiRes = await aiModel.generateContent(prompt);
        const aiTitle = aiRes.response.text().trim().replace(/['"]/g, '');
        if (aiTitle && aiTitle.length < 60 && aiTitle.toLowerCase() !== title.toLowerCase()) {
          correctedTitle = aiTitle;
          first = await searchTmdb(correctedTitle, year);
        }
      } catch (e) {}
    }

    let finalTitle = correctedTitle;
    let finalYear = year || '';
    let originalLang = '';
    let isIndian = false;
    let isMarvelOrDc = false;
    let posterUrl = null;

    if (first) {
      const detailUrl = `https://api.themoviedb.org/3/${type}/${first.id}?api_key=${TMDB_API_KEY}&append_to_response=images&include_image_language=en,te,null`;
      const detRes = await fetch(detailUrl);
      const det = await detRes.json();

      const companies = (det.production_companies || []).map((c) => c.name.toLowerCase());
      const networks = (det.networks || []).map((n) => n.name.toLowerCase());
      const combinedText = `${det.title || det.name || ''} ${det.overview || ''} ${companies.join(' ')} ${networks.join(' ')}`.toLowerCase();

      isMarvelOrDc = /(marvel|dc films|dc entertainment|dc studios|avengers|spider-man|batman|superman|deadpool|wolverine|thunderbolts|loki|daredevil|peacemaker|joker|aquaman|flash|iron man|thor|captain america|x-men|x men|magneto|cyclops|storm|mystique|logan)/i.test(combinedText);

      const backdrops = det.images?.backdrops || [];
      const titledBanner = backdrops.find((b) => b.iso_639_1 === 'en' || b.iso_639_1 === 'te');
      const bannerPath = titledBanner?.file_path || det.backdrop_path || first.backdrop_path || det.poster_path || first.poster_path;

      finalTitle = det.title || det.name || first.title || first.name || correctedTitle;
      finalYear = (det.release_date || det.first_air_date || year || '').slice(0, 4);
      originalLang = det.original_language || first.original_language || '';

      const countries = [
        ...(det.origin_country || []),
        ...(det.production_countries || []).map((c) => c.iso_3166_1)
      ];
      isIndian = countries.includes('IN') || ['te', 'ta', 'hi', 'ml', 'kn'].includes(originalLang);

      posterUrl = bannerPath ? `https://image.tmdb.org/t/p/w780${bannerPath}` : null;
    }

    // 2. TMDB lo image lekapothe -> Wikipedia nunchi direct photo fetch chey
    if (!posterUrl) {
      posterUrl = await fetchWikipediaPoster(finalTitle, finalYear);
    }

    return { title: finalTitle, year: finalYear, originalLang, isIndian, posterUrl, isMarvelOrDc };
  } catch (err) {
    console.error('TMDB/Wiki Error:', err.message);
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
    `• /autopost - Safe Year-Wise Auto-Post\n` +
    `• /stopautopost - Stop Running Auto-Post\n` +
    `• /clearposts - 1-Click Clear Category Channel\n` +
    `• /resetbatches - Reset Posted History\n` +
    `• /adddb - Add Extra Supabase DB\n` +
    `• /listdb - View Active DBs\n` +
    `• /addadmin - Add Bot Admin (Owner)\n` +
    `• /deladmin - Remove Bot Admin (Owner)\n` +
    `• /admins - View Admins List\n` +
    `• /stats - Bot & File Stats`
  );
}

// Helper to wipe a single display channel safely
async function clearChannelMessages(targetCh, maxId) {
  let deleted = 0;
  const CHUNK = 20;
  for (let id = maxId; id >= 1; id -= CHUNK) {
    const batch = [];
    for (let j = id; j > Math.max(0, id - CHUNK); j--) {
      batch.push(
        bot.telegram.deleteMessage(targetCh, j)
          .then(() => { deleted++; })
          .catch(() => {})
      );
    }
    await Promise.all(batch);
    await sleep(600);
  }
  return deleted;
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
  const { error } = await supabase.from('bot_admins').upsert({ user_id: uid }, { onConflict: 'user_id' });
  if (error) return ctx.reply(`❌ DB Error: <code>${escapeHTML(error.message)}</code>`, { parse_mode: 'HTML' });
  await loadDynamicConfig();
  ctx.reply(`✅ Admin <code>${uid}</code> added!`, { parse_mode: 'HTML' });
});

bot.command('deladmin', async (ctx) => {
  if (!isMainOwnerDM(ctx)) return;
  const uid = ctx.message.text.replace('/deladmin', '').trim();
  if (!/^\d+$/.test(uid)) {
    return ctx.reply('❌ Usage: <code>/deladmin 1234567890</code>', { parse_mode: 'HTML' });
  }
  const { error } = await supabase.from('bot_admins').delete().eq('user_id', uid);
  if (error) return ctx.reply(`❌ DB Error: <code>${escapeHTML(error.message)}</code>`, { parse_mode: 'HTML' });
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
    `🗄️ <b>Storage (DB):</b> ${channels.db.join(', ') || normalizeChannelId(DB_CHANNEL_ID)}\n` +
    `🎥 <b>Theatre Prints:</b> ${channels.theatre.join(', ') || 'None'}\n` +
    `🦸 <b>Marvel & DC:</b> ${channels.marvel.join(', ') || 'None'}\n` +
    `📺 <b>Web Series:</b> ${channels.series.join(', ') || 'None'}\n` +
    `🗣️ <b>Telugu Dubbed:</b> ${channels.dubbed.join(', ') || 'None'}\n` +
    `🎬 <b>Telugu/Remaining:</b> ${channels.telugu.join(', ') || 'None'}\n\n` +
    `Remove cheyadaniki: <code>/delchannel -100xxxx</code>`;
  ctx.reply(text, { parse_mode: 'HTML' });
});

bot.command('delchannel', async (ctx) => {
  if (!isOwnerDM(ctx)) return;
  const rawInput = ctx.message.text.replace('/delchannel', '').trim();
  if (!/^-?\d+$/.test(rawInput)) {
    return ctx.reply('❌ Usage: <code>/delchannel -1001234567890</code>', { parse_mode: 'HTML' });
  }

  const cleanTarget = rawInput.replace(/^-100/, '').replace(/^-/, '');
  const { data: rows, error: fetchErr } = await supabase.from('bot_channels').select('id, channel_id');
  if (fetchErr) {
    return ctx.reply(`❌ DB Error: <code>${escapeHTML(fetchErr.message)}</code>`, { parse_mode: 'HTML' });
  }

  const matchingIds = (rows || [])
    .filter((r) => {
      const cleanRow = String(r.channel_id).replace(/^-100/, '').replace(/^-/, '');
      return String(r.channel_id) === rawInput || cleanRow === cleanTarget;
    })
    .map((r) => r.id);

  if (matchingIds.length === 0) {
    return ctx.reply(`⚠️ Channel <code>${escapeHTML(rawInput)}</code> database lo kanipinchaledu.`, { parse_mode: 'HTML' });
  }

  const { error: delErr } = await supabase.from('bot_channels').delete().in('id', matchingIds);
  if (delErr) {
    return ctx.reply(`❌ Delete Error: <code>${escapeHTML(delErr.message)}</code>`, { parse_mode: 'HTML' });
  }

  await loadDynamicConfig();
  ctx.reply(`🗑️ Channel <code>${escapeHTML(rawInput)}</code> (${matchingIds.length} record(s)) removed!`, { parse_mode: 'HTML' });
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

// ================= EASY 1-CLICK CLEAR CATEGORY CHANNELS (EXCLUDES STORAGE DB) =================
bot.command('clearposts', async (ctx) => {
  if (!isOwnerDM(ctx)) return;
  const parts = ctx.message.text.trim().split(/\s+/);

  if (parts.length >= 3) {
    const targetCh = normalizeChannelId(parts[1]);
    const maxId = parseInt(parts[2], 10);
    const dbCleanIds = [DB_CHANNEL_ID, ...channels.db].map(id => normalizeChannelId(id));
    if (dbCleanIds.includes(targetCh)) {
      return ctx.reply('🚫 Safety Lock: Storage (DB) channel ni `/clearposts` tho delete cheyalemu!');
    }
    if (!targetCh || isNaN(maxId) || maxId < 1) {
      return ctx.reply('❌ Valid Channel ID & Last Message ID ivvandi.');
    }
    await ctx.reply(`🗑️ Deleting messages 1 to ${maxId} in <code>${targetCh}</code>...`, { parse_mode: 'HTML' });
    (async () => {
      const deleted = await clearChannelMessages(targetCh, maxId);
      await ctx.reply(`✅ Done! Total deleted posts: <b>${deleted}</b>`, { parse_mode: 'HTML' }).catch(() => {});
    })();
    return;
  }

  const buttons = [];
  if (channels.theatre.length > 0) buttons.push([Markup.button.callback('🎥 Clear Theatre Prints', 'clearcat_theatre')]);
  if (channels.marvel.length > 0) buttons.push([Markup.button.callback('🦸 Clear Marvel & DC', 'clearcat_marvel')]);
  if (channels.series.length > 0) buttons.push([Markup.button.callback('📺 Clear Web Series', 'clearcat_series')]);
  if (channels.dubbed.length > 0) buttons.push([Markup.button.callback('🗣️ Clear Telugu Dubbed', 'clearcat_dubbed')]);
  if (channels.telugu.length > 0) buttons.push([Markup.button.callback('🎬 Clear Telugu & Remaining', 'clearcat_telugu')]);

  if (buttons.length === 0) {
    return ctx.reply('⚠️ Clear cheyadaniki category channels em connect ayyi levu.');
  }
  buttons.push([Markup.button.callback('❌ Cancel', 'clearcat_cancel')]);

  ctx.reply(
    '🧹 <b>Select Category Channel to Clear Old Posts:</b>\n<i>(Storage DB channel safe ga untundi, touch cheyadu)</i>',
    { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) }
  );
});

bot.command('resetbatches', async (ctx) => {
  if (!isOwnerDM(ctx)) return;
  const { error } = await supabase.from('movie_batches').delete().neq('id', 0);
  if (error) {
    return ctx.reply(`❌ DB Error: <code>${escapeHTML(error.message)}</code>`, { parse_mode: 'HTML' });
  }
  ctx.reply('🔄 <b>movie_batches</b> cleared! Ippudu kotha uploads or <code>/autopost</code> fresh ga post avuthayi.', { parse_mode: 'HTML' });
});

bot.command('stopautopost', (ctx) => {
  if (!isOwnerDM(ctx)) return;
  if (!isAutoPosting) return ctx.reply('ℹ️ Currently `/autopost` run avvatledu.');
  stopAutoPostFlag = true;
  ctx.reply('🛑 Stopping `/autopost` safely after current post...');
});

// ================= SAFE ANTI-BAN BACKGROUND YEAR-WISE AUTO-POST =================
bot.command('autopost', async (ctx) => {
  if (!isOwnerDM(ctx)) return;
  if (isAutoPosting) {
    return ctx.reply('⚠️ `/autopost` already running! Stop cheyalante `/stopautopost` kottu.');
  }

  isAutoPosting = true;
  stopAutoPostFlag = false;
  await ctx.reply('🔄 Scanning Supabase DBs & sorting movies year-wise (Anti-Ban safe speed lo post avuthayi)...');

  // Run in background so /stopautopost responds instantly & no 90s timeout
  (async () => {
    try {
      let allFiles = [];
      const dbsToRead = [supabase, ...extraDbs.map((d) => d.client)];
      for (const client of dbsToRead) {
        const { data } = await client.from('movies_index').select('file_name, message_id, channel_id, file_size').limit(5000);
        if (data) allFiles = allFiles.concat(data);
      }

      if (allFiles.length === 0) {
        return ctx.reply('❌ Supabase lo files em levu.');
      }

      const groups = new Map();
      for (const f of allFiles) {
        if (!f.message_id) continue;
        const chId = normalizeChannelId(f.channel_id || DB_CHANNEL_ID);
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
        g.items.push({
          channel_id: chId,
          message_id: f.message_id,
          file_name: f.file_name,
          file_size: f.file_size,
          isSample: meta.isSample
        });
      }

      const { data: existing } = await supabase.from('movie_batches').select('movie_key').eq('posted', true);
      const postedKeys = new Set((existing || []).map((e) => e.movie_key));

      // Filter unposted & Sort Ascending by Year (Oldest first, Newest at bottom)
      const pendingEntries = Array.from(groups.entries())
        .filter(([key]) => {
          if (postedKeys.has(key)) return false;
          if (key.endsWith('_cam') && postedKeys.has(`${key}_v1`)) return false;
          return true;
        })
        .sort(([, a], [, b]) => {
          const yearA = parseInt(a.meta.year, 10) || 0;
          const yearB = parseInt(b.meta.year, 10) || 0;
          if (yearA !== yearB) return yearA - yearB;
          return a.meta.title.localeCompare(b.meta.title);
        });

      let postedCount = 0;
      const CHUNK_SIZE = 5;

      for (let i = 0; i < pendingEntries.length; i += CHUNK_SIZE) {
        if (stopAutoPostFlag) break;
        const chunk = pendingEntries.slice(i, i + CHUNK_SIZE);

        const prepared = await Promise.all(chunk.map(async ([movieKey, g]) => {
          const tmdb = await fetchTmdbInfo(g.meta.title, g.meta.year, g.meta.isSeries);
          return { movieKey, g, tmdb };
        }));

        for (const { movieKey, g, tmdb } of prepared) {
          if (stopAutoPostFlag) break;

          const finalTitle = tmdb?.title || g.meta.title;
          const finalYear = tmdb?.year || g.meta.year || 'N/A';
          const langsArr = Array.from(g.langs);

          const targetType = resolveCategory(g.meta, tmdb, langsArr);
          const targetChannels = channels[targetType] || [];
          if (targetChannels.length === 0) continue; // Strict: do NOT post to another category

          const isTheatre = g.meta.isTheatreFile;
          const finalMovieKey = isTheatre ? `${movieKey}_v1` : movieKey;
          const versionTag = isTheatre ? ' [V1]' : '';

          const sortedItems = [...g.items].sort((a, b) => (b.isSample ? 1 : 0) - (a.isSample ? 1 : 0));
          const hasSample = sortedItems.some((it) => it.isSample);

          const batchCode = `b_${Date.now().toString(36)}${Math.floor(Math.random() * 900 + 100)}`;
          const deepLink = `https://t.me/${ctx.botInfo.username}?start=${batchCode}`;

          const { error: saveErr } = await supabase.from('movie_batches').upsert({
            batch_code: batchCode,
            movie_key: finalMovieKey,
            movie_title: `${finalTitle}${versionTag}`,
            file_items: sortedItems,
            posted: true
          }, { onConflict: 'movie_key' });

          if (saveErr) {
            console.error('Batch Save Error:', saveErr.message);
            continue;
          }

          const seasonTag = g.meta.isSeries && g.meta.seasonNum ? ` Season ${g.meta.seasonNum}` : '';
          const audioLabel = langsArr.length > 1
            ? (langsArr.includes('Telugu') ? 'Telugu + Multi Audio' : 'Multi Audio')
            : (langsArr[0] || 'Telugu');

          const sampleHighlight = (isTheatre && hasSample) ? `\n🎞️ <b>Sample Video Included</b>` : '';
          const caption =
            `<b>${escapeHTML(finalTitle)}${seasonTag} (${escapeHTML(finalYear)}) ${escapeHTML(audioLabel)}${escapeHTML(versionTag)}</b>` +
            `${sampleHighlight}\n\n${deepLink}`;

          for (const targetCh of targetChannels) {
            if (stopAutoPostFlag) break;
            try {
              await sendBannerPhoto(targetCh, tmdb?.posterUrl, caption);
              postedCount++;

              // Anti-Ban Safe Delay: 3.5s per post + 15s cooldown every 15 posts
              await sleep(3500);
              if (postedCount % 15 === 0) {
                console.log(`🧊 Anti-Ban Cooldown: 15s rest after ${postedCount} posts...`);
                await sleep(15000);
              }
            } catch (err) {
              console.error(`Post failed for ${finalTitle} in ${targetCh}:`, err.message);
            }
          }
        }
      }

      const statusMsg = stopAutoPostFlag
        ? `🛑 Auto-Post Stopped! Total posted so far: <b>${postedCount}</b>`
        : `✅ Year-Wise Auto-Post Complete! Total new posts: <b>${postedCount}</b>`;
      await ctx.reply(statusMsg, { parse_mode: 'HTML' }).catch(() => {});
    } catch (err) {
      console.error('Auto-Post Error:', err.message);
      await ctx.reply(`❌ Auto-Post Error: <code>${escapeHTML(err.message)}</code>`, { parse_mode: 'HTML' }).catch(() => {});
    } finally {
      isAutoPosting = false;
      stopAutoPostFlag = false;
    }
  })();
});

// ================= REAL-TIME AUTO-INDEX + AUTO-POST =================
async function processRealtimeBatch(movieKey) {
  const entry = pendingAutoPosts.get(movieKey);
  if (!entry) return;
  pendingAutoPosts.delete(movieKey);

  try {
    const { meta, langs, items } = entry;
    const isTheatre = meta.isTheatreFile;

    let finalMovieKey = movieKey;
    let versionTag = '';

    if (isTheatre) {
      // ONLY for Theatre Prints: Auto-detect V1, V2, V3...
      const { data: prevVersions } = await supabase
        .from('movie_batches')
        .select('movie_key')
        .like('movie_key', `${movieKey}%`);

      const versionNum = (prevVersions?.length || 0) + 1;
      finalMovieKey = `${movieKey}_v${versionNum}`;
      versionTag = ` [V${versionNum}]`;
    } else {
      // Normal HD Movies: No duplicate reposts, merge into existing batch
      const { data: existing } = await supabase
        .from('movie_batches')
        .select('*')
        .eq('movie_key', movieKey)
        .maybeSingle();

      if (existing) {
        const oldItems = Array.isArray(existing.file_items) ? existing.file_items : [];
        const seenMsgIds = new Set(oldItems.map((it) => it.message_id));
        const mergedItems = [...oldItems];

        for (const it of items) {
          if (!seenMsgIds.has(it.message_id)) {
            seenMsgIds.add(it.message_id);
            mergedItems.push(it);
          }
        }

        if (mergedItems.length > oldItems.length) {
          await supabase
            .from('movie_batches')
            .update({ file_items: mergedItems })
            .eq('movie_key', movieKey);
          console.log(`🔄 Updated existing batch for "${existing.movie_title}" (+${mergedItems.length - oldItems.length} file(s), no repost)`);
        }
        return;
      }
    }

    // Put Sample Video first in the batch if present
    const sortedItems = [...items].sort((a, b) => (b.isSample ? 1 : 0) - (a.isSample ? 1 : 0));
    const hasSample = sortedItems.some((it) => it.isSample);

    // Fetch TMDB 16:9 Banner (with Gemini + Wikipedia fallback)
    const tmdb = await fetchTmdbInfo(meta.title, meta.year, meta.isSeries);
    const finalTitle = tmdb?.title || meta.title;
    const finalYear = tmdb?.year || meta.year || 'N/A';
    const langsArr = Array.from(langs);

    // Strict Category Routing
    const targetType = resolveCategory(meta, tmdb, langsArr);
    const targetChannels = channels[targetType] || [];
    if (targetChannels.length === 0) {
      console.log(`⚠️ Skipped posting "${finalTitle}" — no channel configured for category: ${targetType.toUpperCase()}`);
      return;
    }

    const botUsername = bot.botInfo?.username || (await bot.telegram.getMe()).username;
    const batchCode = `b_${Date.now().toString(36)}${Math.floor(Math.random() * 900 + 100)}`;
    const deepLink = `https://t.me/${botUsername}?start=${batchCode}`;

    const { error: saveErr } = await supabase.from('movie_batches').upsert({
      batch_code: batchCode,
      movie_key: finalMovieKey,
      movie_title: `${finalTitle}${versionTag}`,
      file_items: sortedItems,
      posted: true
    }, { onConflict: 'movie_key' });

    if (saveErr) {
      console.error('Realtime Batch Save Error:', saveErr.message);
      return;
    }

    const seasonTag = meta.isSeries && meta.seasonNum ? ` Season ${meta.seasonNum}` : '';
    const audioLabel = langsArr.length > 1
      ? (langsArr.includes('Telugu') ? 'Telugu + Multi Audio' : 'Multi Audio')
      : (langsArr[0] || 'Telugu');

    const sampleHighlight = (isTheatre && hasSample) ? `\n🎞️ <b>Sample Video Included</b>` : '';
    const caption =
      `<b>${escapeHTML(finalTitle)}${seasonTag} (${escapeHTML(finalYear)}) ${escapeHTML(audioLabel)}${escapeHTML(versionTag)}</b>` +
      `${sampleHighlight}\n\n${deepLink}`;

    for (const targetCh of targetChannels) {
      try {
        await sendBannerPhoto(targetCh, tmdb?.posterUrl, caption);
        console.log(`🚀 Realtime Auto-Posted: ${finalTitle}${versionTag} -> ${targetType.toUpperCase()} (${targetCh})`);
        await sleep(3000);
      } catch (err) {
        console.error(`Realtime Post failed for ${finalTitle} in ${targetCh}:`, err.message);
      }
    }
  } catch (err) {
    console.error('Realtime Auto-Post Error:', err.message);
  }
}

function scheduleRealtimeAutoPost(record) {
  const meta = parseFileMeta(record.file_name);
  let entry = pendingAutoPosts.get(meta.groupKey);

  if (!entry) {
    entry = {
      meta,
      langs: new Set(meta.langs),
      items: [],
      timer: null
    };
    pendingAutoPosts.set(meta.groupKey, entry);
  } else {
    meta.langs.forEach((l) => entry.langs.add(l));
    clearTimeout(entry.timer);
  }

  entry.items.push({
    channel_id: record.channel_id,
    message_id: record.message_id,
    file_name: record.file_name,
    file_size: record.file_size,
    isSample: meta.isSample
  });

  // 15 seconds debounce so multiple qualities + Sample Video combine into 1 post
  entry.timer = setTimeout(() => processRealtimeBatch(meta.groupKey), 15000);
}

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
    channel_id: normalizeChannelId(post.chat.id),
    file_name: cleanName,
    file_size: fileSize,
    quality,
    language
  };

  const { error } = await supabase.from('movies_index').upsert(record, { onConflict: 'message_id' });
  if (error) {
    const errMsg = String(error.message || '').toLowerCase();
    if (/quota|storage|limit|space|full|exceeded/i.test(errMsg)) {
      await notifyOwnerDbAlert(`❌ <b>DB Error:</b> <code>${escapeHTML(error.message)}</code>`);
    }
    if (extraDbs.length > 0) {
      for (const db of extraDbs) {
        const res = await db.client.from('movies_index').upsert(record, { onConflict: 'message_id' });
        if (!res.error) break;
      }
    }
  } else {
    console.log(`✅ Indexed: ${cleanName} (${fileSize})`);
    await checkSupabaseThreshold(supabase);
    scheduleRealtimeAutoPost(record);
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
    const chId = normalizeChannelId(typeof item === 'object' && item.channel_id ? item.channel_id : DB_CHANNEL_ID);

    try {
      const { data: movie } = await supabase
        .from('movies_index')
        .select('file_name, file_size')
        .eq('message_id', msgId)
        .single();

      const rawTitle = movie ? movie.file_name : (item.file_name || 'Watch Movie');
      const fileSize = movie?.file_size || item.file_size || '';
      lastTitle = rawTitle;

      const samplePrefix = item.isSample ? `🎞️ <b>[SAMPLE VIDEO]</b>\n` : '';
      const customCaption =
        `${samplePrefix}<a href="${GROUP_LINK}"><b>${escapeHTML(rawTitle)}</b></a>\n\n` +
        (fileSize ? `💾 <a href="${GROUP_LINK}"><b>Size: ${escapeHTML(fileSize)}</b></a>\n\n` : '') +
        `📢 <a href="${GROUP_LINK}"><b>Join Our Movies Group</b></a>`;

      const sent = await ctx.telegram.copyMessage(ctx.chat.id, chId, msgId, {
        caption: customCaption,
        parse_mode: 'HTML'
      });
      sentIds.push(sent.message_id);
      await sleep(500);
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
    let rawId = null;
    if (ctx.message.forward_from_chat && ctx.message.forward_from_chat.type === 'channel') {
      rawId = String(ctx.message.forward_from_chat.id);
    } else if (ctx.message.text && /^-?\d+$/.test(ctx.message.text.trim())) {
      rawId = ctx.message.text.trim();
    }

    const chId = normalizeChannelId(rawId);
    if (!chId) {
      return ctx.reply('❌ Invalid Channel ID. Forward a message from the channel or send <code>-100...</code> ID.', { parse_mode: 'HTML' });
    }

    const { error } = await supabase
      .from('bot_channels')
      .upsert({ channel_id: chId, channel_type: state.category }, { onConflict: 'channel_id' });

    if (error) {
      return ctx.reply(`❌ Failed to save channel: <code>${escapeHTML(error.message)}</code>`, { parse_mode: 'HTML' });
    }

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
    const { error } = await supabase.from('bot_databases').upsert({ url, anon_key }, { onConflict: 'url' });
    if (error) {
      return ctx.reply(`❌ Failed to save DB: <code>${escapeHTML(error.message)}</code>`, { parse_mode: 'HTML' });
    }
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
bot.action('clearcat_cancel', async (ctx) => {
  if (!isOwnerDM(ctx)) return ctx.answerCbQuery();
  await ctx.answerCbQuery('Cancelled');
  ctx.editMessageText('❌ Clear posts cancelled.').catch(() => {});
});

bot.action(/^clearcat_(.+)$/, async (ctx) => {
  if (!isOwnerDM(ctx)) return ctx.answerCbQuery();
  const cat = ctx.match[1];
  const targetList = channels[cat] || [];
  if (targetList.length === 0) return ctx.answerCbQuery('No channels found!', { show_alert: true });

  await ctx.answerCbQuery();
  ctx.editMessageText(
    `⚠️ <b>Confirm Clear Posts</b>\n\nCategory: <b>${cat.toUpperCase()}</b>\nChannels: <code>${targetList.join(', ')}</code>\n\nEe channel(s) lo unna anni old posts delete cheyala?`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('✅ Yes, Delete All', `confirmclear_${cat}`)],
        [Markup.button.callback('❌ Cancel', 'clearcat_cancel')]
      ])
    }
  ).catch(() => {});
});

bot.action(/^confirmclear_(.+)$/, async (ctx) => {
  if (!isOwnerDM(ctx)) return ctx.answerCbQuery();
  const cat = ctx.match[1];
  const targetList = channels[cat] || [];
  if (targetList.length === 0) return ctx.answerCbQuery('No channels found!', { show_alert: true });

  await ctx.answerCbQuery('Clearing started...');
  await ctx.editMessageText(`🧹 Clearing all posts in <b>${cat.toUpperCase()}</b> channel(s)... Please wait...`, { parse_mode: 'HTML' }).catch(() => {});

  (async () => {
    let totalDeleted = 0;
    for (const chId of targetList) {
      try {
        const probe = await bot.telegram.sendMessage(chId, '.', { disable_notification: true });
        const maxId = probe.message_id;
        totalDeleted += await clearChannelMessages(chId, maxId);
      } catch (err) {
        console.error(`Clear failed for ${chId}:`, err.message);
      }
    }
    await ctx.reply(`✅ Done! Cleared <b>${totalDeleted}</b> posts from <b>${cat.toUpperCase()}</b> channel(s).`, { parse_mode: 'HTML' }).catch(() => {});
  })();
});

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

// ================= GLOBAL CRASH GUARDS & KEEP-ALIVE SERVER =================
process.on('unhandledRejection', (err) => console.error('Unhandled Rejection:', err?.message || err));
process.on('uncaughtException', (err) => console.error('Uncaught Exception:', err?.message || err));

const app = express();
app.get('/', (req, res) => res.send('JJ AI Movie Bot Pro is Running!'));
app.listen(process.env.PORT || 3000, () => console.log('Server running...'));

if (ADMIN_ID) {
  bot.telegram.setMyCommands(
    [
      { command: 'start', description: '👑 Admin Panel' },
      { command: 'admin', description: '📋 Admin Commands' },
      { command: 'addchannel', description: '📢 Add Category Channel' },
      { command: 'channels', description: '📺 View Channels' },
      { command: 'delchannel', description: '🗑️ Remove Channel' },
      { command: 'autopost', description: '🚀 Safe Year-Wise Auto-Post' },
      { command: 'stopautopost', description: '🛑 Stop Running Auto-Post' },
      { command: 'clearposts', description: '🧹 1-Click Clear Category Channel' },
      { command: 'resetbatches', description: '🔄 Reset Posted History' },
      { command: 'adddb', description: '🗄️ Add Extra Supabase DB' },
      { command: 'listdb', description: '📚 View Active DBs' },
      { command: 'addadmin', description: '👮 Add Bot Admin (Owner)' },
      { command: 'deladmin', description: '❌ Remove Bot Admin (Owner)' },
      { command: 'admins', description: '👥 View Admins List' },
      { command: 'stats', description: '📊 Bot & File Stats' }
    ],
    { scope: { type: 'chat', chat_id: Number(ADMIN_ID) } }
  ).then(() => console.log('✅ Owner Menu Commands Set!'))
   .catch((e) => console.error('Menu setup error:', e.message));
}

bot.launch();
console.log('🚀 JJ AI Movie Bot Pro Started!');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
