// post-reply-ammo.js
// Runs every 15 min via Railway cron. During US market hours, checks FMP for
// notable moves (index swings, big stock movers, 52-week breaks), has Claude
// draft reply-ready takes, and pushes them to Telegram.
// Exits silently if nothing interesting is happening.

import fetch from 'node-fetch';
import pg from 'pg';
const { Client } = pg;

const FMP_API_KEY = process.env.FMP_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const DATABASE_URL = process.env.DATABASE_URL;

// ---------- CONFIG ----------

const INDICES = [
  { symbol: '^GSPC', name: 'S&P 500' },
  { symbol: '^IXIC', name: 'Nasdaq' },
  { symbol: '^DJI', name: 'Dow' },
];

// High-visibility tickers fintwit actually posts about
const WATCHLIST = [
  'NVDA','TSLA','AAPL','META','AMD','PLTR','COIN',
];

const INDEX_MOVE_THRESHOLD = 0.75;  // % intraday move on an index worth alerting
const STOCK_MOVE_THRESHOLD = 3.0;   // % move on a single stock worth alerting
const DEDUP_HOURS = 2;              // don't re-alert the same symbol within this window
const MAX_EVENTS_PER_ALERT = 3;     // cap how many events go into one Telegram push

// ---------- MARKET HOURS CHECK ----------

function isUSMarketHours() {
  const now = new Date();
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day = et.getDay(); // 0 = Sunday, 6 = Saturday
  if (day === 0 || day === 6) return false;
  const minutes = et.getHours() * 60 + et.getMinutes();
  return minutes >= 570 && minutes <= 960; // 9:30 AM – 4:00 PM ET
}

// ---------- FMP ----------

async function fetchQuotes(symbols) {
  const quotes = [];
  for (const symbol of symbols) {
    const url = `https://financialmodelingprep.com/stable/quote?symbol=${encodeURIComponent(symbol)}&apikey=${FMP_API_KEY}`;
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`FMP quote failed for ${symbol}: ${res.status}`);
      continue;
    }
    const data = await res.json();
    if (Array.isArray(data) && data.length > 0) quotes.push(data[0]);
  }
  return quotes;
}

function pct(q) {
  const v = q.changePercentage ?? q.changesPercentage;
  return typeof v === 'number' ? v : parseFloat(v) || 0;
}

// ---------- EVENT DETECTION ----------

function detectEvents(indexQuotes, stockQuotes) {
  const events = [];

  for (const q of indexQuotes) {
    const change = pct(q);
    if (Math.abs(change) >= INDEX_MOVE_THRESHOLD) {
      const idx = INDICES.find(i => i.symbol === q.symbol);
      events.push({
        key: `INDEX_${q.symbol}`,
        headline: `${idx ? idx.name : q.symbol} ${change > 0 ? 'up' : 'down'} ${Math.abs(change).toFixed(2)}% (${q.price})`,
        detail: `Intraday move of ${change.toFixed(2)}%`,
        priority: Math.abs(change),
      });
    }
  }

  for (const q of stockQuotes) {
    const change = pct(q);
    const price = q.price;
    const yearHigh = q.yearHigh;
    const yearLow = q.yearLow;

    if (Math.abs(change) >= STOCK_MOVE_THRESHOLD) {
      events.push({
        key: `MOVE_${q.symbol}`,
        headline: `$${q.symbol} ${change > 0 ? '+' : ''}${change.toFixed(2)}% to ${price}`,
        detail: `Big session move`,
        priority: Math.abs(change) + 1, // single-stock moves rank above index moves
      });
    } else if (yearHigh && price >= yearHigh) {
      events.push({
        key: `HIGH_${q.symbol}`,
        headline: `$${q.symbol} hits fresh 52-week high at ${price}`,
        detail: `Prior 52w high: ${yearHigh}`,
        priority: 2,
      });
    } else if (yearLow && price <= yearLow) {
      events.push({
        key: `LOW_${q.symbol}`,
        headline: `$${q.symbol} breaks to new 52-week low at ${price}`,
        detail: `Prior 52w low: ${yearLow}`,
        priority: 2,
      });
    }
  }

  events.sort((a, b) => b.priority - a.priority);
  return events;
}

// ---------- DEDUP VIA POSTGRES ----------

async function filterAlreadyAlerted(client, events) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS reply_ammo_alerts (
      id SERIAL PRIMARY KEY,
      event_key TEXT NOT NULL,
      alerted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const fresh = [];
  for (const event of events) {
    const { rows } = await client.query(
      `SELECT 1 FROM reply_ammo_alerts
       WHERE event_key = $1 AND alerted_at > NOW() - INTERVAL '${DEDUP_HOURS} hours'
       LIMIT 1`,
      [event.key]
    );
    if (rows.length === 0) fresh.push(event);
  }
  return fresh;
}

async function markAlerted(client, events) {
  for (const event of events) {
    await client.query(
      `INSERT INTO reply_ammo_alerts (event_key) VALUES ($1)`,
      [event.key]
    );
  }
}

// ---------- CLAUDE: DRAFT REPLY TAKES ----------

async function draftTakes(events) {
  const eventText = events
    .map(e => `- ${e.headline} (${e.detail})`)
    .join('\n');

  const prompt = `You write replies for @DegenTrader, a WallStreetBets-energy stock market account on X. These market events just happened:

${eventText}

Write exactly 3 short reply-ready takes (each under 240 characters) that could be dropped as replies under big fintwit accounts posting about these moves. Rules:
- Punchy, meme-literate, slightly unhinged degen voice. Confident, funny, never boring.
- Include at least one real number from the events in each take.
- No hashtags. Cashtags ($TICKER) are fine.
- Vary the angle: one joke, one sharp observation, one data-forward take.

Respond ONLY with a JSON array of 3 strings. No preamble, no markdown fences.`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 600,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) throw new Error(`Anthropic API failed: ${res.status}`);
  const data = await res.json();
  const text = (data.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('\n');

  try {
    const cleaned = text.replace(/```json|```/g, '').trim();
    const takes = JSON.parse(cleaned);
    if (Array.isArray(takes)) return takes.slice(0, 3);
  } catch (err) {
    console.error('Could not parse takes as JSON, using raw text');
  }
  return [text.trim()];
}

// ---------- TELEGRAM ----------

async function sendTelegram(events, takes) {
  const lines = [];
  lines.push('🚨 REPLY AMMO 🚨');
  lines.push('');
  lines.push('WHAT JUST HAPPENED:');
  for (const e of events) lines.push(`• ${e.headline}`);
  lines.push('');
  lines.push('TAKES (copy, tweak, fire):');
  takes.forEach((t, i) => {
    lines.push(`${i + 1}. ${t}`);
    lines.push('');
  });
  lines.push('👉 Search these tickers on X now. Reply to the biggest account posting about it. Speed > polish.');

  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text: lines.join('\n'),
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Telegram send failed: ${res.status} ${body}`);
  }
}

// ---------- MAIN ----------

async function main() {
  if (!isUSMarketHours()) {
    console.log('Outside US market hours. Exiting.');
    return;
  }

  console.log('Market hours — checking for reply ammo...');

  const [indexQuotes, stockChunk1, stockChunk2] = await Promise.all([
    fetchQuotes(INDICES.map(i => i.symbol)),
    fetchQuotes(WATCHLIST.slice(0, 20)),
    fetchQuotes(WATCHLIST.slice(20)),
  ]);

  const allEvents = detectEvents(indexQuotes, [...stockChunk1, ...stockChunk2]);
  if (allEvents.length === 0) {
    console.log('Nothing notable happening. Exiting.');
    return;
  }

  const client = new Client({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  try {
    const freshEvents = (await filterAlreadyAlerted(client, allEvents))
      .slice(0, MAX_EVENTS_PER_ALERT);

    if (freshEvents.length === 0) {
      console.log('All notable events already alerted recently. Exiting.');
      return;
    }

    console.log(`Fresh events: ${freshEvents.map(e => e.key).join(', ')}`);

    // Mark alerted BEFORE sending, so a Telegram hiccup can't cause spam loops
    await markAlerted(client, freshEvents);

    const takes = await draftTakes(freshEvents);
    await sendTelegram(freshEvents, takes);

    console.log('Reply ammo sent to Telegram. ✅');
  } finally {
    await client.end();
  }
}

main().catch(err => {
  console.error('Reply ammo script failed:', err);
  process.exit(1);
});
