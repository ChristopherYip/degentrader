// post-market-pulse.js
// Market pulse for @DailyBrainDrop — posts THREE times per weekday,
// once at each region's market open, with that region's indices:
//   01:30 UTC — Asia open   (Nikkei, KOSPI, Hang Seng, Straits Times)
//   07:30 UTC — Europe open (FTSE 100, DAX, CAC 40)
//   14:00 UTC — US open     (S&P 500, Nasdaq, Dow Jones)
//
// Cron (Railway): 0,15,30,45 1,7,14 * * 1-5
// (extra ticks are free retries; DB dedup allows one post per slot per day)

import { TwitterApi } from 'twitter-api-v2';
import pg from 'pg';
const { Client } = pg;

// ============ CONFIG ============

const SLOT_WINDOW_MINUTES = 20;

// UTC slots. Europe/US hours match summer time (DST) — shift 1h in November.
const PULSE_SLOTS = [
  {
    key: 'asia_open',
    hour: 1,
    minute: 30,
    title: '🌏 ASIA MARKETS OPEN',
    indices: ['^N225', '^KS11', '^HSI', '^STI'],
  },
  {
    key: 'europe_open',
    hour: 7,
    minute: 30,
    title: '🌍 EUROPE MARKETS OPEN',
    indices: ['^FTSE', '^GDAXI', '^FCHI'],
  },
  {
    key: 'us_open',
    hour: 14,
    minute: 0,
    title: '🇺🇸 US MARKETS OPEN',
    indices: ['^GSPC', '^IXIC', '^DJI'],
  },
];

const INDEX_META = {
  '^N225': { flag: '🇯🇵', name: 'Nikkei 225' },
  '^KS11': { flag: '🇰🇷', name: 'KOSPI' },
  '^HSI': { flag: '🇭🇰', name: 'Hang Seng' },
  '^STI': { flag: '🇸🇬', name: 'Straits Times' },
  '^FTSE': { flag: '🇬🇧', name: 'FTSE 100' },
  '^GDAXI': { flag: '🇩🇪', name: 'DAX' },
  '^FCHI': { flag: '🇫🇷', name: 'CAC 40' },
  '^GSPC': { flag: '🇺🇸', name: 'S&P 500' },
  '^IXIC': { flag: '🇺🇸', name: 'Nasdaq' },
  '^DJI': { flag: '🇺🇸', name: 'Dow Jones' },
};

// ============ CLIENTS ============

const twitterClient = new TwitterApi({
  appKey: process.env.X_API_KEY,
  appSecret: process.env.X_API_SECRET,
  accessToken: process.env.X_ACCESS_TOKEN,
  accessSecret: process.env.X_ACCESS_SECRET,
});

function newDbClient() {
  return new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
}

// ============ HELPERS ============

function currentSlot(now = new Date()) {
  const minutesNow = now.getUTCHours() * 60 + now.getUTCMinutes();
  return PULSE_SLOTS.find((slot) => {
    const slotMinutes = slot.hour * 60 + slot.minute;
    return Math.abs(minutesNow - slotMinutes) <= SLOT_WINDOW_MINUTES;
  });
}

async function fetchIndexQuote(symbol) {
  const url =
    `https://financialmodelingprep.com/stable/quote` +
    `?symbol=${encodeURIComponent(symbol)}&apikey=${process.env.FMP_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`FMP ${res.status} for ${symbol}`);
  const data = await res.json();
  if (!Array.isArray(data) || !data[0]) {
    throw new Error(`No quote data for ${symbol}`);
  }
  return data[0];
}

function formatLine(symbol, quote) {
  const meta = INDEX_META[symbol];
  const pct = Number(quote.changePercentage ?? 0);
  const arrow = pct >= 0 ? '📈' : '📉';
  const sign = pct >= 0 ? '+' : '';
  const price = Number(quote.price).toLocaleString('en-US', {
    maximumFractionDigits: 0,
  });
  return `${meta.flag} ${meta.name}: ${price} (${sign}${pct.toFixed(2)}%) ${arrow}`;
}

// Optional AI one-liner via Claude (skipped gracefully on any failure)
async function generateHeadline(slotTitle, lines) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 100,
        messages: [
          {
            role: 'user',
            content:
              `Write ONE short punchy line (max 60 characters, no hashtags, no quotes) ` +
              `summarizing the mood of this market update titled "${slotTitle}":\n` +
              `${lines.join('\n')}\n` +
              `Respond with only the line itself. Stick strictly to what the numbers show — no predictions.`,
          },
        ],
      }),
    });
    const data = await res.json();
    const text = data?.content?.[0]?.text?.trim();
    if (text && text.length <= 80) return text;
    return null;
  } catch (err) {
    console.error('Headline generation skipped:', err.message);
    return null;
  }
}

// ============ MAIN ============

async function main() {
  const slot = currentSlot();
  if (!slot) {
    console.log('Not in a market-pulse slot. Exiting.');
    return;
  }

  const db = newDbClient();
  await db.connect();

  await db.query(`
    CREATE TABLE IF NOT EXISTS market_pulses (
      id SERIAL PRIMARY KEY,
      slot_key TEXT NOT NULL,
      posted_date DATE NOT NULL,
      tweet_id TEXT,
      UNIQUE (slot_key, posted_date)
    )
  `);

  try {
    // Dedup: one post per slot per UTC day
    const today = new Date().toISOString().slice(0, 10);
    const existing = await db.query(
      `SELECT id FROM market_pulses WHERE slot_key = $1 AND posted_date = $2`,
      [slot.key, today]
    );
    if (existing.rows.length > 0) {
      console.log(`Already posted ${slot.key} today. Skipping.`);
      return;
    }

    // Fetch quotes (skip any index that errors rather than failing the post)
    const lines = [];
    let flatCount = 0;
    for (const symbol of slot.indices) {
      try {
        const quote = await fetchIndexQuote(symbol);
        lines.push(formatLine(symbol, quote));
        if (Math.abs(Number(quote.changePercentage ?? 0)) < 0.02) flatCount++;
      } catch (err) {
        console.error(`Skipping ${symbol}:`, err.message);
      }
    }

    if (lines.length === 0) {
      console.error('No index data available. Skipping post.');
      return;
    }
    if (flatCount === lines.length) {
      console.log('All indices flat (probable holiday). Skipping post.');
      return;
    }

    const headline = await generateHeadline(slot.title, lines);

    let text =
      `${slot.title}\n\n` +
      (headline ? `${headline}\n\n` : '') +
      `${lines.join('\n')}\n\n` +
      `#markets #stocks`;
    if (text.length > 280) {
      text = `${slot.title}\n\n${lines.join('\n')}\n\n#markets`;
    }
    if (text.length > 280) {
      text = `${slot.title}\n\n${lines.join('\n')}`;
    }

    const tweet = await twitterClient.v2.tweet({ text });
    console.log(`Pulse posted (${slot.key}): ${tweet.data.id}`);

    await db.query(
      `INSERT INTO market_pulses (slot_key, posted_date, tweet_id)
       VALUES ($1, $2, $3)`,
      [slot.key, today, tweet.data.id]
    );
    console.log('Pulse saved to database.');
  } catch (err) {
    console.error('Market pulse error:', err.message);
  } finally {
    await db.end();
  }
}

main();
