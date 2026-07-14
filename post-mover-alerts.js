// post-mover-alerts.js
// DegenTrader mover alerts:
//   - Premarket movers (±3% vs previous close, from extended-hours bid/ask)
//   - Intraday movers (±3% on the day)
//   - Post-market movers (±3% vs today's close)
//   - New 52-week highs (ratcheting watermark stored in Postgres)
//   - Down 30% from 52-week high (drawdown crossing)
//
// Railway cron: */15 * * * *  (script decides internally what to run based on ET time)
// Env vars: X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET, FMP_API_KEY, DATABASE_URL
// Optional: RUN_NOW=premarket|intraday|postmarket  (forces a scan for testing)

import { TwitterApi } from 'twitter-api-v2';
import pg from 'pg';
import fetch from 'node-fetch';

const { Client } = pg;

// ===================== CONFIG =====================
const MOVE_THRESHOLD = 3;        // % intraday move to trigger alert
const EXTENDED_THRESHOLD = 3;    // % pre/post-market move to trigger alert
const DRAWDOWN_THRESHOLD = 30;   // % below watermark high
const MAX_ALERTS_PER_SCAN = 3;   // hard cap on tweets per scan
const MAX_SPREAD_PCT = 2;        // skip extended-hours quotes with bid/ask spread wider than this
const MIN_PRICE = 5;             // ignore stocks under $5
const QUOTE_CHUNK_SIZE = 150;    // symbols per FMP batch call

// Cooldowns (hours) per alert type per symbol — prevents re-alerting the same thing
const COOLDOWN_HOURS = {
  premarket_up: 20,
  premarket_down: 20,
  move_up: 20,
  move_down: 20,
  postmarket_up: 20,
  postmarket_down: 20,
  new_high: 168,   // once a week per symbol
  drawdown: 720,   // once a month per symbol
};

// ============ TICKER POOL ============
// PASTE YOUR 561-TICKER ARRAY FROM post-chart-game.js HERE.
// Symbols only, e.g.: const TICKERS = ['AAPL', 'MSFT', 'NVDA', ...];
const TICKERS = [
  'AAPL', 'MSFT', 'NVDA', // <-- REPLACE THIS PLACEHOLDER WITH YOUR FULL POOL
];

// ===================== TIME WINDOWS (ET) =====================
function getETParts() {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
    weekday: 'short',
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map(p => [p.type, p.value]));
  return {
    hour: parseInt(parts.hour, 10) % 24,
    minute: parseInt(parts.minute, 10),
    weekday: parts.weekday, // 'Mon'..'Sun'
  };
}

function decideSession() {
  if (process.env.RUN_NOW) return process.env.RUN_NOW;

  const { hour, minute, weekday } = getETParts();
  if (weekday === 'Sat' || weekday === 'Sun') return null;

  // Premarket scan: 8:30–8:44 AM ET (one tick)
  if (hour === 8 && minute >= 30 && minute <= 44) return 'premarket';

  // Intraday scans: :30 tick of each hour, 10:30 AM – 3:30 PM ET
  if (hour >= 10 && hour <= 15 && minute >= 30 && minute <= 44) return 'intraday';

  // Post-market scan: 5:00–5:14 PM ET (one tick)
  if (hour === 17 && minute >= 0 && minute <= 14) return 'postmarket';

  return null;
}

// ===================== FMP =====================
const FMP_BASE = 'https://financialmodelingprep.com/stable';

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function fmpGet(path, params = {}) {
  const qs = new URLSearchParams({ ...params, apikey: process.env.FMP_API_KEY });
  const res = await fetch(`${FMP_BASE}/${path}?${qs}`);
  if (!res.ok) throw new Error(`FMP ${path} failed: ${res.status}`);
  return res.json();
}

async function getQuotes(symbols) {
  const results = [];
  for (const batch of chunk(symbols, QUOTE_CHUNK_SIZE)) {
    const data = await fmpGet('batch-quote', { symbols: batch.join(',') });
    if (Array.isArray(data)) results.push(...data);
  }
  return results;
}

async function getExtendedQuotes(symbols) {
  const results = [];
  for (const batch of chunk(symbols, QUOTE_CHUNK_SIZE)) {
    const data = await fmpGet('batch-aftermarket-quote', { symbols: batch.join(',') });
    if (Array.isArray(data)) results.push(...data);
  }
  return results;
}

// ===================== DATABASE =====================
async function initDb(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS mover_alerts (
      id SERIAL PRIMARY KEY,
      symbol TEXT NOT NULL,
      alert_type TEXT NOT NULL,
      pct NUMERIC,
      price NUMERIC,
      tweet_id TEXT,
      posted_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS high_watermarks (
      symbol TEXT PRIMARY KEY,
      high NUMERIC NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
}

async function isOnCooldown(db, symbol, alertType) {
  const hours = COOLDOWN_HOURS[alertType] || 20;
  const { rows } = await db.query(
    `SELECT 1 FROM mover_alerts
     WHERE symbol = $1 AND alert_type = $2
       AND posted_at > NOW() - ($3 || ' hours')::interval
     LIMIT 1`,
    [symbol, alertType, String(hours)]
  );
  return rows.length > 0;
}

async function loadWatermarks(db) {
  const { rows } = await db.query('SELECT symbol, high FROM high_watermarks');
  const map = new Map();
  for (const r of rows) map.set(r.symbol, parseFloat(r.high));
  return map;
}

async function upsertWatermark(db, symbol, high) {
  await db.query(
    `INSERT INTO high_watermarks (symbol, high, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (symbol) DO UPDATE
       SET high = EXCLUDED.high, updated_at = NOW()
       WHERE high_watermarks.high < EXCLUDED.high`,
    [symbol, high]
  );
}

// ===================== TWEET BUILDERS =====================
function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function fmtPrice(p) {
  return p >= 1000 ? p.toLocaleString('en-US', { maximumFractionDigits: 2 }) : p.toFixed(2);
}

function fmtPct(p) {
  const sign = p > 0 ? '+' : '';
  return `${sign}${p.toFixed(1)}%`;
}

const UP_LINES = [
  'Something\u2019s cooking \uD83D\uDC40',
  'Bulls are awake \uD83D\uDCC8',
  'Send it \uD83D\uDE80',
  'Green candles printing \uD83D\uDFE2',
  'Degens, eyes on this one \uD83D\uDC40',
];

const DOWN_LINES = [
  'Someone\u2019s getting rekt \uD83D\uDC80',
  'Knife catching, anyone? \uD83D\uDD2A',
  'Bears feasting today \uD83D\uDC3B',
  'Red wedding vibes \uD83D\uDD3B',
  'That\u2019s gonna leave a mark \uD83D\uDE2C',
];

function buildTweet(alert) {
  const { type, symbol, name, pct, price, high } = alert;

  switch (type) {
    case 'premarket_up':
      return `\uD83D\uDEA8 PREMARKET MOVER\n\n$${symbol} ${fmtPct(pct)} before the bell\n\n${name}\nLast close $${fmtPrice(alert.baseline)} \u2192 ~$${fmtPrice(price)}\n\n${pick(UP_LINES)}\n\n#premarket #stocks #trading`;
    case 'premarket_down':
      return `\uD83D\uDEA8 PREMARKET MOVER\n\n$${symbol} ${fmtPct(pct)} before the bell\n\n${name}\nLast close $${fmtPrice(alert.baseline)} \u2192 ~$${fmtPrice(price)}\n\n${pick(DOWN_LINES)}\n\n#premarket #stocks #trading`;
    case 'move_up':
      return `\uD83D\uDFE2 $${symbol} ripping ${fmtPct(pct)} today\n\n${name}\nNow trading at $${fmtPrice(price)}\n\n${pick(UP_LINES)}\n\n#stocks #trading`;
    case 'move_down':
      return `\uD83D\uDD34 $${symbol} dumping ${fmtPct(pct)} today\n\n${name}\nNow trading at $${fmtPrice(price)}\n\n${pick(DOWN_LINES)}\n\n#stocks #trading`;
    case 'postmarket_up':
      return `\uD83C\uDF19 AFTER-HOURS MOVER\n\n$${symbol} ${fmtPct(pct)} post-market\n\n${name}\nClosed $${fmtPrice(alert.baseline)} \u2192 ~$${fmtPrice(price)}\n\n${pick(UP_LINES)}\n\n#afterhours #stocks`;
    case 'postmarket_down':
      return `\uD83C\uDF19 AFTER-HOURS MOVER\n\n$${symbol} ${fmtPct(pct)} post-market\n\n${name}\nClosed $${fmtPrice(alert.baseline)} \u2192 ~$${fmtPrice(price)}\n\n${pick(DOWN_LINES)}\n\n#afterhours #stocks`;
    case 'new_high':
      return `\uD83C\uDFD4 NEW 52-WEEK HIGH\n\n$${symbol} just printed $${fmtPrice(price)}\n\n${name} has never been higher in the last year\n\nAll-time-high energy \uD83D\uDE80\n\n#stocks #52weekhigh #ATH`;
    case 'drawdown':
      return `\uD83D\uDCC9 DOWN BAD ALERT\n\n$${symbol} is now ${DRAWDOWN_THRESHOLD}%+ below its 52-week high\n\n${name}\nHigh: $${fmtPrice(high)} \u2192 now $${fmtPrice(price)}\n\nDip or falling knife? \uD83D\uDD2A\n\n#stocks #buythedip`;
    default:
      return null;
  }
}

// ===================== SCAN LOGIC =====================
function scanExtended(quotes, extQuotes, session) {
  const extMap = new Map(extQuotes.map(q => [q.symbol, q]));
  const candidates = [];

  for (const q of quotes) {
    const ext = extMap.get(q.symbol);
    if (!ext || !ext.bidPrice || !ext.askPrice) continue;
    if (ext.bidPrice <= 0 || ext.askPrice <= 0) continue;

    const mid = (ext.bidPrice + ext.askPrice) / 2;
    if (mid < MIN_PRICE) continue;

    // skip stale/illiquid quotes with wide spreads
    const spreadPct = ((ext.askPrice - ext.bidPrice) / mid) * 100;
    if (spreadPct > MAX_SPREAD_PCT) continue;

    // premarket: compare to previous regular close; postmarket: compare to today's close
    const baseline = session === 'premarket' ? q.previousClose : q.price;
    if (!baseline || baseline <= 0) continue;

    const pct = ((mid - baseline) / baseline) * 100;
    if (Math.abs(pct) < EXTENDED_THRESHOLD) continue;

    const direction = pct > 0 ? 'up' : 'down';
    candidates.push({
      type: `${session}_${direction}`,
      symbol: q.symbol,
      name: q.name,
      pct,
      price: mid,
      baseline,
    });
  }
  return candidates;
}

function scanIntraday(quotes) {
  const candidates = [];
  for (const q of quotes) {
    if (!q.price || q.price < MIN_PRICE) continue;
    const pct = q.changePercentage;
    if (typeof pct !== 'number' || Math.abs(pct) < MOVE_THRESHOLD) continue;
    const direction = pct > 0 ? 'up' : 'down';
    candidates.push({
      type: `move_${direction}`,
      symbol: q.symbol,
      name: q.name,
      pct,
      price: q.price,
    });
  }
  return candidates;
}

function scanHighsAndDrawdowns(quotes, watermarks) {
  const candidates = [];
  for (const q of quotes) {
    if (!q.price || q.price < MIN_PRICE || !q.yearHigh) continue;

    const stored = watermarks.get(q.symbol) || 0;
    const watermark = Math.max(stored, q.yearHigh);

    // New 52-week high: price at/above yearHigh AND above anything we've seen before
    if (q.price >= q.yearHigh && q.price > stored) {
      candidates.push({
        type: 'new_high',
        symbol: q.symbol,
        name: q.name,
        pct: q.changePercentage || 0,
        price: q.price,
        high: q.price,
      });
    }

    // Drawdown: price at/below threshold vs watermark
    if (watermark > 0 && q.price <= watermark * (1 - DRAWDOWN_THRESHOLD / 100)) {
      const ddPct = ((q.price - watermark) / watermark) * 100;
      candidates.push({
        type: 'drawdown',
        symbol: q.symbol,
        name: q.name,
        pct: ddPct,
        price: q.price,
        high: watermark,
      });
    }
  }
  return candidates;
}

const TYPE_PRIORITY = {
  drawdown: 0,
  new_high: 1,
  premarket_up: 2,
  premarket_down: 2,
  postmarket_up: 2,
  postmarket_down: 2,
  move_up: 2,
  move_down: 2,
};

// ===================== MAIN =====================
async function main() {
  const session = decideSession();
  if (!session) {
    console.log('Outside scan windows (or weekend). Exiting.');
    return;
  }
  console.log(`Running ${session} scan for ${TICKERS.length} tickers...`);

  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  await initDb(db);

  const twitter = new TwitterApi({
    appKey: process.env.X_API_KEY,
    appSecret: process.env.X_API_SECRET,
    accessToken: process.env.X_ACCESS_TOKEN,
    accessSecret: process.env.X_ACCESS_SECRET,
  });

  try {
    const quotes = await getQuotes(TICKERS);
    console.log(`Got ${quotes.length} quotes.`);

    let candidates = [];

    if (session === 'premarket' || session === 'postmarket') {
      const extQuotes = await getExtendedQuotes(TICKERS);
      console.log(`Got ${extQuotes.length} extended-hours quotes.`);
      candidates = scanExtended(quotes, extQuotes, session);
    } else {
      candidates = scanIntraday(quotes);
    }

    // Highs/drawdowns use regular-session prices — skip during premarket
    const watermarks = await loadWatermarks(db);
    if (session !== 'premarket') {
      candidates.push(...scanHighsAndDrawdowns(quotes, watermarks));
    }

    console.log(`${candidates.length} raw candidates.`);

    // Sort: drawdowns first, then new highs, then biggest movers
    candidates.sort((a, b) => {
      const pa = TYPE_PRIORITY[a.type] ?? 9;
      const pb = TYPE_PRIORITY[b.type] ?? 9;
      if (pa !== pb) return pa - pb;
      return Math.abs(b.pct) - Math.abs(a.pct);
    });

    let posted = 0;
    for (const alert of candidates) {
      if (posted >= MAX_ALERTS_PER_SCAN) break;

      if (await isOnCooldown(db, alert.symbol, alert.type)) {
        continue;
      }

      const text = buildTweet(alert);
      if (!text || text.length > 280) {
        console.log(`Skipping ${alert.symbol} ${alert.type}: bad tweet length.`);
        continue;
      }

      // Save to DB BEFORE posting (prevents duplicate spam if post partially fails)
      const { rows } = await db.query(
        `INSERT INTO mover_alerts (symbol, alert_type, pct, price)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [alert.symbol, alert.type, alert.pct, alert.price]
      );
      const alertId = rows[0].id;

      try {
        const tweet = await twitter.v2.tweet(text);
        await db.query('UPDATE mover_alerts SET tweet_id = $1 WHERE id = $2', [
          tweet.data.id,
          alertId,
        ]);
        console.log(`Posted ${alert.type} for $${alert.symbol} (${fmtPct(alert.pct)}): ${tweet.data.id}`);
        posted++;
      } catch (err) {
        console.error(`Tweet failed for ${alert.symbol}:`, err.message);
      }
    }

    console.log(`Posted ${posted} alert(s).`);

    // Ratchet watermarks upward (regular-session data only)
    if (session !== 'premarket') {
      let updated = 0;
      for (const q of quotes) {
        if (!q.yearHigh && !q.price) continue;
        const newHigh = Math.max(q.yearHigh || 0, q.price || 0);
        const stored = watermarks.get(q.symbol) || 0;
        if (newHigh > stored) {
          await upsertWatermark(db, q.symbol, newHigh);
          updated++;
        }
      }
      console.log(`Watermarks updated for ${updated} symbols.`);
    }
  } finally {
    await db.end();
  }
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
