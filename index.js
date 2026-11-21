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

// Dynamic Multi-Supabase, Admins, Channels & Settings State
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
let activeGroupLink = GROUP_LINK;
let realtimeAutoPostEnabled = false; // Default OFF: nuvvu ON chesthene DB files live update avuthayi
let fileDeleteMinutes = 5;           // Dynamic file auto-delete timer (0 = OFF)
let autoAnnounceEnabled = true;      // Daily 5 auto-expiring movie spotlights
let lastAnnounceMsgId = null;        // Tracks last group announcement for auto-expire
const recentSpotlights = new Set();

const adminState = new Map();
const pendingAutoPosts = new Map();

// Auto-Post Anti-Ban State
let isAutoPosting = false;
let stopAutoPostFlag = false;

// 80% Limit / Storage Early Warning Config (Approx ~1 KB metadata per row in Postgres)
const DB_MAX_ROWS = 50000;
const DB_WARN_THRESHOLD = Math.floor(DB_MAX_ROWS * 0.8); // 40,000 rows (80%)
const DB_MAX_MB = 500;
const DB_WARN_MB = Math.floor(DB_MAX_MB * 0.8); // 400 MB (80%)
const KB_PER_ROW = 1;
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

async function saveSetting(key, value) {
  try {
    await supabase
      .from('bot_settings')
      .upsert({ setting_key: key, setting_value: String(value) }, { onConflict: 'setting_key' });
  } catch (e) {}
}

async function registerUser(user) {
  if (!user || user.is_bot) return;
  try {
    await supabase.from('bot_users').upsert(
      {
        user_id: user.id,
        first_name: user.first_name || '',
        username: user.username || ''
      },
      { onConflict: 'user_id' }
    );
  } catch (e) {}
}

// Load Dynamic DBs, Channels, Admins & Settings from Main Supabase
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

    try {
      const { data: settings } = await supabase.from('bot_settings').select('setting_key, setting_value');
      const getVal = (k) => (settings || []).find((s) => s.setting_key === k)?.setting_value;

      activeGroupLink = (getVal('group_link') || GROUP_LINK).trim();

      const autoPostVal = getVal('realtime_autopost');
      if (autoPostVal !== undefined) realtimeAutoPostEnabled = autoPostVal === 'true';

      const delVal = parseInt(getVal('delete_time_mins'), 10);
      if (!isNaN(delVal)) fileDeleteMinutes = delVal;

      const annVal = getVal('auto_announce');
      if (annVal !== undefined) autoAnnounceEnabled = annVal === 'true';

      const lastAnnId = parseInt(getVal('last_announce_msg_id'), 10);
      if (!isNaN(lastAnnId)) lastAnnounceMsgId = lastAnnId;
    } catch (e) {
      activeGroupLink = GROUP_LINK;
    }

    console.log(`✅ Loaded ${extraDbs.length} extra DBs, ${(chs || []).length} channels, ${extraAdmins.length} extra admins. LiveAutoPost=${realtimeAutoPostEnabled}, DelTime=${fileDeleteMinutes}m`);
  } catch (err) {
    console.error('Config Load Error:', err.message);
  }
}
loadDynamicConfig();

// Early Warning Alert for Supabase Limit / Storage (80% Threshold)
async function notifyOwnerDbAlert(reasonText) {
  const now = Date.now();
  if (now - lastDbQuotaAlertAt < 24 * 60 * 60 * 1000) return;
  lastDbQuotaAlertAt = now;

  const recipients = [ADMIN_ID, ...extraAdmins].filter(Boolean);
  const msg =
    `🚨 <b>SUPABASE 80% STORAGE / LIMIT ALERT</b>\n\n` +
    `${reasonText}\n\n` +
    `👉 <i>Supabase lo limit/storage full avvakunda munde kotha Supabase ID (project) create cheskondi, tarvata <code>/adddb</code> tho bot lo add cheyandi!</i>`;

  for (const uid of recipients) {
    await bot.telegram.sendMessage(uid, msg, { parse_mode: 'HTML' }).catch(() => {});
  }
}

async function checkSupabaseThreshold(client = supabase) {
  try {
    const { count } = await client
      .from('movies_index')
      .select('*', { count: 'exact', head: true });

    const rowCount = count ?? 0;
    const estMetadataMb = (rowCount * KB_PER_ROW) / 1024;
    const rowPct = Math.round((rowCount / DB_MAX_ROWS) * 100);
    const sizePct = Math.round((estMetadataMb / DB_MAX_MB) * 100);

    if (rowCount >= DB_WARN_THRESHOLD || estMetadataMb >= DB_WARN_MB) {
      await notifyOwnerDbAlert(
        `📊 <b>Usage Reached ~${Math.max(rowPct, sizePct)}% (80% Threshold)</b>\n` +
        `• Rows: <code>${rowCount}</code> / <code>${DB_MAX_ROWS}</code>\n` +
        `• Est. DB Metadata: <code>${estMetadataMb.toFixed(2)} MB</code> / <code>${DB_MAX_MB} MB</code>`
      );
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
  const liveStatus = realtimeAutoPostEnabled ? '🟢 ON' : '🔴 OFF';
  const annStatus = autoAnnounceEnabled ? '🟢 ON' : '🔴 OFF';
  const delStatus = fileDeleteMinutes === 0 ? 'OFF' : `${fileDeleteMinutes}m`;
  return (
    `👑 <b>JJ FILES ADMIN PANEL</b>\n\n` +
    `⚡ <b>Live Channel Update:</b> ${liveStatus} (<code>/toggleautopost</code>)\n` +
    `📢 <b>Daily Spotlights (5/day):</b> ${annStatus} (<code>/toggleannounce</code>)\n` +
    `⏱️ <b>File Auto-Delete:</b> <code>${delStatus}</code> (<code>/setdeltime</code>)\n\n` +
    `• /setdeltime - Set File Auto-Delete Timer (mins)\n` +
    `• /announce - Post Custom Group Announcement\n` +
    `• /spotlightnow - Trigger Movie Spotlight Now\n` +
    `• /toggleannounce - ON/OFF Daily 5 Spotlights\n` +
    `• /broadcast - DM Broadcast to All Users\n` +
    `• /toggleautopost - ON/OFF DB Live Channel Updates\n` +
    `• /autopost - Post Remaining Unposted (Year-Wise)\n` +
    `• /stopautopost - Stop Running Auto-Post\n` +
    `• /setlink - Change File Caption Link\n` +
    `• /addchannel - Add Category Channel\n` +
    `• /channels - View Connected Channels\n` +
    `• /delchannel - Remove Channel\n` +
    `• /clearposts - 1-Click Clear Category Channel\n` +
    `• /resetbatches - Reset Posted History\n` +
    `• /adddb - Add Extra Supabase DB\n` +
    `• /listdb - View Active DBs & Storage (%)\n` +
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

// ================= DAILY AUTO-EXPIRING SPOTLIGHT (5 MOVIES / DAY) =================
async function clearPreviousAnnouncement() {
  if (!TARGET_GROUP_ID || !lastAnnounceMsgId) return;
  await bot.telegram.deleteMessage(TARGET_GROUP_ID, lastAnnounceMsgId).catch(() => {});
  lastAnnounceMsgId = null;
}

async function postDailySpotlight() {
  if (!autoAnnounceEnabled || !TARGET_GROUP_ID) return;

  try {
    const { count } = await supabase.from('movies_index').select('*', { count: 'exact', head: true });
    if (!count || count === 0) return;

    let movie = null;
    for (let tries = 0; tries < 5; tries++) {
      const randomOffset = Math.floor(Math.random() * count);
      const { data } = await supabase
        .from('movies_index')
        .select('*')
        .range(randomOffset, randomOffset);

      if (data && data[0] && !recentSpotlights.has(data[0].message_id)) {
        movie = data[0];
        break;
      }
    }
    if (!movie) return;

    recentSpotlights.add(movie.message_id);
    if (recentSpotlights.size > 25) recentSpotlights.clear();

    await clearPreviousAnnouncement();

    const botUsername = bot.botInfo?.username || (await bot.telegram.getMe()).username;
    const movieLink = `https://t.me/${botUsername}?start=file_${movie.message_id}`;

    const text =
      `🎬 <b>Featured Movie of the Day</b>\n\n` +
      `<b>${escapeHTML(movie.file_name)}</b>\n` +
      `📦 <b>Size:</b> ${escapeHTML(movie.file_size || 'HD')}  •  <b>Quality:</b> ${escapeHTML(movie.quality || 'HD')}\n\n` +
      `Available now in our official channel! You can also type any movie name right here in the group to get instant files.\n\n` +
      `<i>⏳ This spotlight auto-updates with a new movie every few hours.</i>`;

    const sent = await bot.telegram.sendMessage(TARGET_GROUP_ID, text, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...Markup.inlineKeyboard([
        [
          Markup.button.url('🎬 ɢᴇᴛ ᴍᴏᴠɪᴇ', movieLink),
          Markup.button.url('📢 ᴊᴏɪɴ ᴄʜᴀɴɴᴇʟ', activeGroupLink)
        ]
      ])
    });

    lastAnnounceMsgId = sent.message_id;
    await saveSetting('last_announce_msg_id', lastAnnounceMsgId);
  } catch (e) {
    console.error('Spotlight error:', e.message);
  }
}

// Schedule 5 times/day (~every 4.8 hours)
setInterval(postDailySpotlight, 4.8 * 60 * 60 * 1000);

// ================= OWNER & ADMIN PRIVATE DM COMMANDS =================
bot.command('admin', (ctx) => {
  if (!isOwnerDM(ctx)) return;
  ctx.reply(getAdminPanelText(), {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([[Markup.button.callback('📢 Add Channel', 'addch_back')]])
  });
});

bot.command('setdeltime', async (ctx) => {
  if (!isOwnerDM(ctx)) return;
  const mins = parseInt(ctx.message.text.replace('/setdeltime', '').trim(), 10);

  if (isNaN(mins) || mins < 0 || mins > 1440) {
    return ctx.reply(
      `❌ Usage: <code>/setdeltime 5</code> (in minutes, <code>0</code> = OFF)\n\n⏱️ Current Auto-Delete: <b>${fileDeleteMinutes === 0 ? 'OFF' : `${fileDeleteMinutes} min(s)`}</b>`,
      { parse_mode: 'HTML' }
    );
  }

  fileDeleteMinutes = mins;
  await saveSetting('delete_time_mins', mins);

  ctx.reply(
    mins === 0
      ? '✅ File Auto-Delete: <b>OFF</b> (Files will not be deleted)'
      : `✅ File Auto-Delete Timer updated to <b>${mins} minute(s)</b>!`,
    { parse_mode: 'HTML' }
  );
});

bot.command('toggleannounce', async (ctx) => {
  if (!isOwnerDM(ctx)) return;
  autoAnnounceEnabled = !autoAnnounceEnabled;
  await saveSetting('auto_announce', autoAnnounceEnabled);
  ctx.reply(`✅ Daily Auto-Movie Spotlights (5/day): <b>${autoAnnounceEnabled ? '🟢 ON' : '🔴 OFF'}</b>`, { parse_mode: 'HTML' });
});

bot.command('spotlightnow', async (ctx) => {
  if (!isOwnerDM(ctx)) return;
  if (!TARGET_GROUP_ID) return ctx.reply('❌ GROUP_ID is not set in environment variables.');
  await postDailySpotlight();
  ctx.reply('✅ Movie spotlight posted to official group!');
});

bot.command('announce', async (ctx) => {
  if (!isOwnerDM(ctx)) return;
  if (!TARGET_GROUP_ID) return ctx.reply('❌ GROUP_ID is not set in environment variables.');

  const customText = ctx.message.text.replace('/announce', '').trim();
  const replyMsg = ctx.message.reply_to_message;

  if (!customText && !replyMsg) {
    return ctx.reply('❌ Usage: <code>/announce Your message here</code>\nOr reply to any photo/message with <code>/announce</code>.', { parse_mode: 'HTML' });
  }

  await clearPreviousAnnouncement();

  try {
    let sent;
    if (replyMsg) {
      sent = await ctx.telegram.copyMessage(TARGET_GROUP_ID, ctx.chat.id, replyMsg.message_id, {
        ...Markup.inlineKeyboard([[Markup.button.url('📢 ᴊᴏɪɴ ᴄʜᴀɴɴᴇʟ', activeGroupLink)]])
      });
    } else {
      sent = await ctx.telegram.sendMessage(
        TARGET_GROUP_ID,
        `📢 <b>Announcement</b>\n\n${escapeHTML(customText)}`,
        {
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          ...Markup.inlineKeyboard([[Markup.button.url('📢 ᴊᴏɪɴ ᴄʜᴀɴɴᴇʟ', activeGroupLink)]])
        }
      );
    }

    lastAnnounceMsgId = sent.message_id;
    await saveSetting('last_announce_msg_id', lastAnnounceMsgId);
    ctx.reply('✅ Custom announcement posted to official group! (Previous announcement cleared)');
  } catch (e) {
    ctx.reply(`❌ Failed to announce: <code>${escapeHTML(e.message)}</code>`, { parse_mode: 'HTML' });
  }
});

bot.command('broadcast', async (ctx) => {
  if (!isOwnerDM(ctx)) return;
  const textMsg = ctx.message.text.replace('/broadcast', '').trim();
  const replyMsg = ctx.message.reply_to_message;

  if (!textMsg && !replyMsg) {
    return ctx.reply('❌ Usage: <code>/broadcast Your message</code>\nOr reply to any photo/post with <code>/broadcast</code>.', { parse_mode: 'HTML' });
  }

  const { data: users, error } = await supabase.from('bot_users').select('user_id');
  if (error || !users || users.length === 0) {
    return ctx.reply('❌ No users found in database yet.');
  }

  const statusMsg = await ctx.reply(`🚀 Broadcasting to <b>${users.length}</b> users...`, { parse_mode: 'HTML' });
  let sent = 0, blocked = 0, failed = 0;

  for (const u of users) {
    try {
      if (replyMsg) {
        await ctx.telegram.copyMessage(u.user_id, ctx.chat.id, replyMsg.message_id);
      } else {
        await ctx.telegram.sendMessage(u.user_id, textMsg, { parse_mode: 'HTML', disable_web_page_preview: true });
      }
      sent++;
    } catch (e) {
      if (e.code === 403) blocked++;
      else failed++;
    }
    await sleep(60);
  }

  await ctx.telegram
    .editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      null,
      `✅ <b>Broadcast Completed!</b>\n\n📤 Sent: <b>${sent}</b>\n🚫 Blocked: <b>${blocked}</b>\n⚠️ Failed: <b>${failed}</b>`,
      { parse_mode: 'HTML' }
    )
    .catch(() => {});
});

bot.command('toggleautopost', async (ctx) => {
  if (!isOwnerDM(ctx)) return;
  realtimeAutoPostEnabled = !realtimeAutoPostEnabled;
  await saveSetting('realtime_autopost', realtimeAutoPostEnabled);

  const msg = realtimeAutoPostEnabled
    ? '🟢 <b>DB Live Channel Update: ON</b>\n\nIppudu DB channel lo kotha file padagane category channels ki live update velthundi.'
    : '🔴 <b>DB Live Channel Update: OFF</b>\n\nIppudu DB lo kotha files index matrame avuthayi, channels ki live update velladu. Kavalsinappudu <code>/toggleautopost</code> tho ON chesko ledha <code>/autopost</code> tho remaining vatini post chesko.';

  ctx.reply(msg, { parse_mode: 'HTML' });
});

bot.command('setlink', async (ctx) => {
  if (!isOwnerDM(ctx)) return;
  const newLink = ctx.message.text.replace('/setlink', '').trim();
  if (!/^https?:\/\/\S+/i.test(newLink)) {
    return ctx.reply(
      `❌ Usage: <code>/setlink https://t.me/+YourGroupLink</code>\n\n📌 Current Link: <code>${escapeHTML(activeGroupLink)}</code>`,
      { parse_mode: 'HTML' }
    );
  }

  activeGroupLink = newLink;
  await saveSetting('group_link', newLink);

  ctx.reply(`✅ Group link updated! Ippudu nunchi files caption lo ee link vasthundi:\n<code>${escapeHTML(newLink)}</code>`, {
    parse_mode: 'HTML'
  });
});

bot.command('stats', async (ctx) => {
  const allowed = await isAdmin(ctx);
  if (!allowed) return;

  const { count: movieCount, error } = await supabase
    .from('movies_index')
    .select('*', { count: 'exact', head: true });
  const { count: userCount } = await supabase
    .from('bot_users')
    .select('*', { count: 'exact', head: true });

  if (error) {
    return ctx.reply(`❌ DB Error: <code>${escapeHTML(error.message)}</code>`, { parse_mode: 'HTML' });
  }
  ctx.reply(
    `📊 <b>JJ AI BOT STATS</b>\n\n` +
    `🎬 <b>Total Indexed Files:</b> <code>${movieCount ?? 0}</code>\n` +
    `👥 <b>Total Bot Users:</b> <code>${userCount ?? 0}</code>\n` +
    `⏱️ <b>File Auto-Delete:</b> <code>${fileDeleteMinutes === 0 ? 'OFF' : `${fileDeleteMinutes}m`}</code>\n` +
    `📢 <b>Daily Spotlights:</b> <code>${autoAnnounceEnabled ? 'ON' : 'OFF'}</code>\n` +
    `⚡ <b>DB Live Update:</b> <code>${realtimeAutoPostEnabled ? 'ON' : 'OFF'}</code>\n` +
    `🗄️ <b>Extra DBs:</b> <code>${extraDbs.length}</code>\n` +
    `👮 <b>Extra Admins:</b> <code>${extraAdmins.length}</code>\n` +
    `🟢 <b>Status:</b> Online & Ready`,
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

bot.command('listdb', async (ctx) => {
  if (!isOwnerDM(ctx)) return;

  const allDbs = [
    { label: 'Main DB', url: process.env.SUPABASE_URL || 'Default', client: supabase },
    ...extraDbs.map((d, i) => ({ label: `Extra DB #${i + 1}`, url: d.url, client: d.client }))
  ];

  let text = `🗄️ <b>ACTIVE DATABASES & STORAGE (%)</b>\n\n`;

  for (const dbItem of allDbs) {
    try {
      const { count, error } = await dbItem.client
        .from('movies_index')
        .select('*', { count: 'exact', head: true });

      if (error) {
        text += `• <b>${dbItem.label}</b> (${escapeHTML(dbItem.url)})\n   ❌ Error: <code>${escapeHTML(error.message)}</code>\n\n`;
        continue;
      }

      const rowCount = count ?? 0;
      const estMetadataMb = Number(((rowCount * KB_PER_ROW) / 1024).toFixed(2));
      const sizePct = Math.min(100, Number(((estMetadataMb / DB_MAX_MB) * 100).toFixed(1)));
      const rowPct = Math.min(100, Number(((rowCount / DB_MAX_ROWS) * 100).toFixed(1)));
      const maxPct = Math.max(sizePct, rowPct);
      const statusEmoji = maxPct >= 80 ? '🚨' : maxPct >= 50 ? '⚠️' : '🟢';

      text +=
        `${statusEmoji} <b>${dbItem.label}</b>\n` +
        `   🔗 <code>${escapeHTML(dbItem.url)}</code>\n` +
        `   📊 <b>DB Usage:</b> <code>${sizePct}%</code> (${estMetadataMb}/${DB_MAX_MB} MB) | <b>Rows:</b> <code>${rowPct}%</code> (${rowCount}/${DB_MAX_ROWS})\n\n`;
    } catch (e) {
      text += `• <b>${dbItem.label}:</b> ❌ Failed to fetch usage\n\n`;
    }
  }

  ctx.reply(text.trim(), { parse_mode: 'HTML' });
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

// ================= SAFE ANTI-BAN BACKGROUND YEAR-WISE AUTO-POST (REMAINING UNPOSTED ONLY) =================
bot.command('autopost', async (ctx) => {
  if (!isOwnerDM(ctx)) return;
  if (isAutoPosting) {
    return ctx.reply('⚠️ `/autopost` already running! Stop cheyalante `/stopautopost` kottu.');
  }

  isAutoPosting = true;
  stopAutoPostFlag = false;
  await ctx.reply('🔄 Scanning Supabase DBs & skipping already posted batches (Remaining unposted movies year-wise post avuthayi)...');

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

      const { data: existing } = await supabase.from('movie_batches').select('movie_key, posted');
      const postedKeys = new Set(
        (existing || []).filter((e) => e.posted === true).map((e) => e.movie_key)
      );

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
          if (targetChannels.length === 0) continue;

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
        ? `🛑 Auto-Post Stopped! Total remaining posted: <b>${postedCount}</b>`
        : `✅ Remaining Auto-Post Complete! Total new posts: <b>${postedCount}</b>`;
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

// ================= REAL-TIME AUTO-INDEX + TOGGLEABLE LIVE CHANNEL UPDATE =================
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
      const { data: prevVersions } = await supabase
        .from('movie_batches')
        .select('movie_key')
        .like('movie_key', `${movieKey}%`);

      const versionNum = (prevVersions?.length || 0) + 1;
      finalMovieKey = `${movieKey}_v${versionNum}`;
      versionTag = ` [V${versionNum}]`;
    } else {
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

    const sortedItems = [...items].sort((a, b) => (b.isSample ? 1 : 0) - (a.isSample ? 1 : 0));
    const hasSample = sortedItems.some((it) => it.isSample);

    const tmdb = await fetchTmdbInfo(meta.title, meta.year, meta.isSeries);
    const finalTitle = tmdb?.title || meta.title;
    const finalYear = tmdb?.year || meta.year || 'N/A';
    const langsArr = Array.from(langs);

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
        console.log(`🚀 Live Channel Updated: ${finalTitle}${versionTag} -> ${targetType.toUpperCase()} (${targetCh})`);
        await sleep(3000);
      } catch (err) {
        console.error(`Live Post failed for ${finalTitle} in ${targetCh}:`, err.message);
      }
    }
  } catch (err) {
    console.error('Realtime Auto-Post Error:', err.message);
  }
}

function scheduleRealtimeAutoPost(record) {
  if (!realtimeAutoPostEnabled) {
    console.log(`⏸️ DB Live Channel Update is OFF — indexed "${record.file_name}" only.`);
    return;
  }

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
    if (/quota|storage|limit|space|full|exceeded|size|disk/i.test(errMsg)) {
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

// ================= FILE DELIVERY (SINGLE, SEND ALL & BATCH) + DYNAMIC AUTO-DELETE =================
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
        `${samplePrefix}<a href="${activeGroupLink}"><b>${escapeHTML(rawTitle)}</b></a>\n\n` +
        (fileSize ? `💾 <a href="${activeGroupLink}"><b>Size: ${escapeHTML(fileSize)}</b></a>\n\n` : '') +
        `📢 <a href="${activeGroupLink}"><b>Join Our Movies Group</b></a>`;

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
  const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(activeGroupLink)}&text=${encodeURIComponent('🎬 Free HD Movies Group mawa! Join avvu:')}`;

  const noteLine = fileDeleteMinutes > 0
    ? `\n\n⚠️ <b>Note:</b> Ee file(s) <b>${fileDeleteMinutes} minute(s)</b> lo auto-delete avuthayi. Ventane Saved Messages ki forward chesko!`
    : '';

  const warnMsg = await ctx.reply(
    `${shareText}${noteLine}`,
    {
      parse_mode: 'HTML',
      reply_to_message_id: sentIds[sentIds.length - 1],
      ...Markup.inlineKeyboard([[Markup.button.url('📤 Share Group with Friends', shareUrl)]])
    }
  );

  if (fileDeleteMinutes > 0) {
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
    }, fileDeleteMinutes * 60 * 1000);
  }
}

// ================= DEEP LINK DELIVERY (/start) =================
bot.start(async (ctx) => {
  await registerUser(ctx.from);
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
      return ctx.reply(res.response.text().trim(), Markup.inlineKeyboard([[Markup.button.url('🎬 Join Movies Group', activeGroupLink)]]));
    } catch (e) {
      return ctx.reply(`🎬 Hey ${labelName} mawa! Welcome to AI Movie Bot.\n\nGroup lo movie name type cheyandi, ventane HD files isthanu! 🍿`, Markup.inlineKeyboard([[Markup.button.url('🎬 Join Movies Group', activeGroupLink)]]));
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

// ================= STYLISH COMPACT GROUP SEARCH UI =================
async function buildSearchMessage(query, page = 0, qual = 'ALL', lang = 'ALL', botUsername, season = 'ALL', startTime = Date.now()) {
  const limit = 10;
  let dbQuery = supabase
    .from('movies_index')
    .select('*', { count: 'exact' })
    .ilike('file_name', `%${query}%`);

  if (qual !== 'ALL') dbQuery = dbQuery.ilike('quality', `%${qual}%`);
  if (lang !== 'ALL') dbQuery = dbQuery.ilike('language', `%${lang}%`);
  if (season !== 'ALL') dbQuery = dbQuery.ilike('file_name', `%${season}%`);

  const { data, count, error } = await dbQuery
    .order('created_at', { ascending: false })
    .range(page * limit, (page + 1) * limit - 1);

  if (error || !data || data.length === 0) return null;

  const totalPages = Math.ceil(count / limit);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);

  let text = `✦ ʀᴇꜱᴜʟᴛ ɪɴ : <b>${elapsed} ꜱᴇᴄᴏɴᴅꜱ</b>\n`;
  text += `⚡ ᴘᴏᴡᴇʀᴇᴅ ʙʏ : <a href="${activeGroupLink}"><b>ᴊᴊ ᴍᴏᴠɪᴇꜱ</b></a>\n\n`;

  const batchIds = data.slice(0, 5).map(i => i.message_id).join('_');
  const sendAllUrl = `https://t.me/${botUsername}?start=all_${batchIds}`;

  data.forEach((item, idx) => {
    const num = page * limit + idx + 1;
    const link = `https://t.me/${botUsername}?start=file_${item.message_id}`;
    const sizeLabel = item.file_size || 'HD';
    text += `<b>${num}.</b> <a href="${link}"><b>[${escapeHTML(sizeLabel)}]</b> ${escapeHTML(item.file_name)}</a>\n\n`;
  });

  const qShort = query.slice(0, 15);
  const buttons = [
    [
      Markup.button.url('ᴊᴏɪɴ ᴄʜᴀɴɴᴇʟ', activeGroupLink),
      Markup.button.url('ꜱᴇɴᴅ ᴀʟʟ', sendAllUrl)
    ],
    [
      Markup.button.callback(qual === 'ALL' ? 'Qᴜᴀʟɪᴛʏ' : `✓ ${qual}`, `m|q|${qShort}|${qual}|${lang}|${season}`),
      Markup.button.callback(lang === 'ALL' ? 'ʟᴀɴɢᴜᴀɢᴇ' : `✓ ${lang.slice(0, 3)}`, `m|l|${qShort}|${qual}|${lang}|${season}`),
      Markup.button.callback(season === 'ALL' ? 'ꜱᴇᴀꜱᴏɴ' : `✓ ${season}`, `m|s|${qShort}|${qual}|${lang}|${season}`)
    ]
  ];

  const navRow = [];
  if (page > 0) {
    navRow.push(Markup.button.callback('⋖ ᴘʀᴇᴠ', `f|${qShort}|${page - 1}|${qual}|${lang}|${season}`));
  } else {
    navRow.push(Markup.button.callback('ᴘᴀɢᴇ', 'noop'));
  }
  navRow.push(Markup.button.callback(`${page + 1}/${totalPages}`, 'noop'));
  if (page + 1 < totalPages) {
    navRow.push(Markup.button.callback('ɴᴇxᴛ ⋗', `f|${qShort}|${page + 1}|${qual}|${lang}|${season}`));
  }
  buttons.push(navRow);

  return { text: text.trim(), keyboard: Markup.inlineKeyboard(buttons) };
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

  const startTime = Date.now();
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

  let res = await buildSearchMessage(searchKeyword, 0, 'ALL', 'ALL', ctx.botInfo.username, 'ALL', startTime);
  if (!res && searchKeyword.toLowerCase() !== userText.toLowerCase()) {
    res = await buildSearchMessage(userText, 0, 'ALL', 'ALL', ctx.botInfo.username, 'ALL', startTime);
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

// Filter Sub-Menus (Quality / Language / Season)
bot.action(/^m\|(q|l|s)\|(.+)\|(.+)\|(.+)\|(.+)$/, async (ctx) => {
  const [, type, qShort, qual, lang, season] = ctx.match;
  let rows = [];

  if (type === 'q') {
    rows = [
      [
        Markup.button.callback(qual === '480p' ? '✅ 480ᴘ' : '480ᴘ', `f|${qShort}|0|480p|${lang}|${season}`),
        Markup.button.callback(qual === '720p' ? '✅ 720ᴘ' : '720ᴘ', `f|${qShort}|0|720p|${lang}|${season}`)
      ],
      [
        Markup.button.callback(qual === '1080p' ? '✅ 1080ᴘ' : '1080ᴘ', `f|${qShort}|0|1080p|${lang}|${season}`),
        Markup.button.callback(qual === 'ALL' ? '✅ ᴀʟʟ' : 'ᴀʟʟ', `f|${qShort}|0|ALL|${lang}|${season}`)
      ]
    ];
  } else if (type === 'l') {
    rows = [
      [
        Markup.button.callback(lang === 'Telugu' ? '✅ ᴛᴇʟᴜɢᴜ' : 'ᴛᴇʟᴜɢᴜ', `f|${qShort}|0|${qual}|Telugu|${season}`),
        Markup.button.callback(lang === 'Hindi' ? '✅ ʜɪɴᴅɪ' : 'ʜɪɴᴅɪ', `f|${qShort}|0|${qual}|Hindi|${season}`)
      ],
      [
        Markup.button.callback(lang === 'Tamil' ? '✅ ᴛᴀᴍɪʟ' : 'ᴛᴀᴍɪʟ', `f|${qShort}|0|${qual}|Tamil|${season}`),
        Markup.button.callback(lang === 'English' ? '✅ ᴇɴɢʟɪꜱʜ' : 'ᴇɴɢʟɪꜱʜ', `f|${qShort}|0|${qual}|English|${season}`)
      ],
      [Markup.button.callback(lang === 'ALL' ? '✅ ᴀʟʟ ʟᴀɴɢᴜᴀɢᴇꜱ' : 'ᴀʟʟ ʟᴀɴɢᴜᴀɢᴇꜱ', `f|${qShort}|0|${qual}|ALL|${season}`)]
    ];
  } else if (type === 's') {
    rows = [
      [
        Markup.button.callback(season === 'S01' ? '✅ ꜱ01' : 'ꜱ01', `f|${qShort}|0|${qual}|${lang}|S01`),
        Markup.button.callback(season === 'S02' ? '✅ ꜱ02' : 'ꜱ02', `f|${qShort}|0|${qual}|${lang}|S02`),
        Markup.button.callback(season === 'S03' ? '✅ ꜱ03' : 'ꜱ03', `f|${qShort}|0|${qual}|${lang}|S03`)
      ],
      [Markup.button.callback(season === 'ALL' ? '✅ ᴀʟʟ ꜱᴇᴀꜱᴏɴꜱ' : 'ᴀʟʟ ꜱᴇᴀꜱᴏɴꜱ', `f|${qShort}|0|${qual}|${lang}|ALL`)]
    ];
  }

  rows.push([Markup.button.callback('⋖ ʙᴀᴄᴋ', `f|${qShort}|0|${qual}|${lang}|${season}`)]);
  await ctx.editMessageReplyMarkup(Markup.inlineKeyboard(rows).reply_markup).catch(() => {});
  ctx.answerCbQuery();
});

// Pagination & Filter Apply
bot.action(/^f\|(.+)\|(\d+)\|(.+)\|(.+)\|(.+)$/, async (ctx) => {
  const [, query, pageStr, qual, lang, season] = ctx.match;
  const res = await buildSearchMessage(query, parseInt(pageStr, 10), qual, lang, ctx.botInfo.username, season);
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
      { command: 'setdeltime', description: '⏱️ Set File Auto-Delete Timer' },
      { command: 'announce', description: '📢 Custom Group Announcement' },
      { command: 'spotlightnow', description: '🎬 Post Movie Spotlight Now' },
      { command: 'toggleannounce', description: '🔄 ON/OFF Daily 5 Spotlights' },
      { command: 'broadcast', description: '📣 DM Broadcast to All Users' },
      { command: 'toggleautopost', description: '⚡ ON/OFF DB Live Channel Update' },
      { command: 'autopost', description: '🚀 Post Remaining (Year-Wise)' },
      { command: 'stopautopost', description: '🛑 Stop Running Auto-Post' },
      { command: 'setlink', description: '🔗 Change File Caption Link' },
      { command: 'addchannel', description: '📢 Add Category Channel' },
      { command: 'channels', description: '📺 View Channels' },
      { command: 'delchannel', description: '🗑️ Remove Channel' },
      { command: 'clearposts', description: '🧹 1-Click Clear Category Channel' },
      { command: 'resetbatches', description: '🔄 Reset Posted History' },
      { command: 'adddb', description: '🗄️ Add Extra Supabase DB' },
      { command: 'listdb', description: '📚 View Active DBs & Storage (%)' },
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
