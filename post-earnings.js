// post-earnings.js — Earnings reaction posts for @DegenTrader (Finnhub edition)
// Runs every 15 min via Railway cron. Three ET windows:
//   4:00–4:59 PM ET → snapshot closing prices for today's after-close (amc) reporters
//   6:00–6:59 PM ET → post amc earnings with true after-hours movement
//   8:00–8:59 AM ET → post pre-open (bmo) earnings with premarket movement + catch leftovers
// Dedupe via Postgres so nothing posts twice.

import { TwitterApi } from 'twitter-api-v2';
import pg from 'pg';
const { Client } = pg;

const FINNHUB_KEY = process.env.FINNHUB_API_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

const MAX_POSTS_PER_RUN = 3;

// Watchlist — only post earnings for names people actually care about.
// Ordered roughly by hype/priority; earlier = posted first when multiple report.
const WATCHLIST = [
  'NVDA','TSLA','SPCX','PLTR','AAPL','MSFT','AMZN','GOOGL','META','NFLX',
  'AMD','AVGO','MU','MRVL','NOW','ORCL','CRM','SMCI','ARM','TSM',
  'ASML','COIN','HOOD','MSTR','RDDT','ASTS','RKLB','NBIS','CRWV','APP',
  'GME','AMC','WEN','SOFI','IONQ','RGTI','QBTS','OKLO','SMR','HIMS',
  'TEM','CRCL','FIG','CVNA','AFRM','UPST','MARA','RIOT','CLSK','SOUN',
  'BBAI','ACHR','JOBY','LUNR','POET','PATH','DKNG','RBLX','U','SNAP',
  'PINS','SPOT','ROKU','VRT','ANET','DELL','SNOW','CRWD','PANW','NET',
  'DDOG','MDB','LRCX','AMAT','KLAC','INTC','QCOM','TXN','IBM','ADBE',
  'SHOP','UBER','LYFT','ABNB','DASH','ZM','PYPL','XYZ','TTD','DUOL',
  'AXON','RIVN','LCID','NIO','F','GM','BA','GE','GEV','CAT',
  'VST','CEG','JPM','GS','MS','BAC','V','MA','BABA','JD',
  'PDD','DIS','WMT','COST','TGT','HD','SBUX','CMG','NKE','LULU',
  'CELH','ELF','LLY','UNH','NVO','MRNA','XOM','DAL','UAL',
];

// ---------- time helpers ----------

function etPartsFromDate(d) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short',
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const p = Object.fromEntries(fmt.formatToParts(d).map(x => [x.type, x.value]));
  return {
    hour: parseInt(p.hour, 10) % 24,
    minute: parseInt(p.minute, 10),
    weekday: p.weekday,
    dateStr: `${p.year}-${p.month}-${p.day}`,
  };
}

function nowEastern() {
  return etPartsFromDate(new Date());
}

function easternDateOffset(days) {
  const d = new Date(Date.now() + days * 86400000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(d);
}

// ---------- Finnhub helpers ----------

async function finnhub(path, params = {}) {
  const qs = new URLSearchParams({ ...params, token: FINNHUB_KEY }).toString();
  const res = await fetch(`https://finnhub.io/api/v1/${path}?${qs}`);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Finnhub ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

// Earnings calendar. Returns entries with:
// symbol, date, hour ('bmo'|'amc'|'dmh'|''), quarter, year,
// epsActual, epsEstimate, revenueActual, revenueEstimate
async function getEarningsCalendar(fromDate, toDate) {
  const data = await finnhub('calendar/earnings', { from: fromDate, to: toDate });
  return data?.earningsCalendar || [];
}

// Quote. Returns { c: current, dp: % change vs prev close, pc: prev close, t: unix sec of last trade }
async function getQuote(symbol) {
  return finnhub('quote', { symbol });
}

// ---------- movement logic ----------

// After-hours move using our own 4PM close snapshot.
// Returns { pct, label } or null if we can't compute an honest number.
function afterHoursMove(quote, snapshotClose, todayET) {
  if (!quote || !quote.c || !quote.t) return null;
  const trade = etPartsFromDate(new Date(quote.t * 1000));
  const tradeMinutes = trade.hour * 60 + trade.minute;

  // Snapshot path: last trade is today, after ~4:05 PM ET → feed has extended-hours trades
  if (snapshotClose > 0 && trade.dateStr === todayET && tradeMinutes > 16 * 60 + 5) {
    const pct = ((quote.c - snapshotClose) / snapshotClose) * 100;
    return { pct, label: 'after hours' };
  }
  // Fallback: feed frozen at the close → today's regular-session change
  if (trade.dateStr === todayET && quote.dp != null) {
    return { pct: Number(quote.dp), label: 'on the day' };
  }
  return null;
}

// Premarket move: dp = current vs yesterday's close. If the last trade is from
// today (premarket), that IS the earnings reaction. If the feed is stale
// (last trade yesterday), dp is pre-earnings noise — skip the price line.
function premarketMove(quote, todayET) {
  if (!quote || !quote.t || quote.dp == null) return null;
  const trade = etPartsFromDate(new Date(quote.t * 1000));
  if (trade.dateStr !== todayET) return null;
  const tradeMinutes = trade.hour * 60 + trade.minute;
  const label = tradeMinutes < 9 * 60 + 30 ? 'premarket' : 'on the day';
  return { pct: Number(quote.dp), label };
}

// ---------- formatting ----------

function formatRevenue(n) {
  if (n == null || isNaN(n) || n === 0) return null;
  const abs = Math.abs(n);
  if (abs >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(0)}M`;
  return `$${Number(n).toLocaleString('en-US')}`;
}

function beatMissEmoji(actual, estimate) {
  if (actual == null || estimate == null) return '';
  if (actual > estimate) return ' ✅ BEAT';
  if (actual < estimate) return ' ❌ MISS';
  return ' ➖ INLINE';
}

function buildMainTweet(e, move) {
  const header = e.quarter
    ? `🚨 $${e.symbol} Q${e.quarter} EARNINGS`
    : `🚨 $${e.symbol} EARNINGS OUT`;
  const lines = [header, ''];

  if (e.epsActual != null) {
    let epsLine = `📊 EPS: $${Number(e.epsActual).toFixed(2)}`;
    if (e.epsEstimate != null) {
      epsLine += ` vs $${Number(e.epsEstimate).toFixed(2)} est${beatMissEmoji(e.epsActual, e.epsEstimate)}`;
    }
    lines.push(epsLine);
  }

  const revActual = formatRevenue(e.revenueActual);
  if (revActual) {
    let revLine = `💰 Rev: ${revActual}`;
    const revEst = formatRevenue(e.revenueEstimate);
    if (revEst) {
      revLine += ` vs ${revEst} est${beatMissEmoji(e.revenueActual, e.revenueEstimate)}`;
    }
    lines.push(revLine);
  }

  if (move) {
    const arrow = move.pct >= 0 ? '🚀' : '📉';
    const sign = move.pct >= 0 ? '+' : '';
    lines.push('', `${arrow} ${sign}${move.pct.toFixed(1)}% ${move.label}`);
  }

  lines.push('', '#Earnings #Stocks');
  return lines.join('\n');
}

async function generateTake(e, move) {
  const fallback = move && move.pct < 0
    ? `Numbers in, market not impressed. Overreaction or warning sign? 👇`
    : `Numbers in. Bulls eating good tonight or is this priced in? 👇`;
  if (!ANTHROPIC_KEY) return fallback;
  try {
    const moveDesc = move ? `${move.pct >= 0 ? '+' : ''}${move.pct.toFixed(1)}% ${move.label}` : 'no price data yet';
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 150,
        messages: [{
          role: 'user',
          content: `You write for a high-energy "degen trader" stock market X account. ${e.symbol} just reported Q${e.quarter || '?'} earnings: EPS ${e.epsActual} vs ${e.epsEstimate} est, revenue ${e.revenueActual} vs ${e.revenueEstimate} est. Stock is ${moveDesc}. Write a punchy 1-2 sentence take, then end with a short question to spark replies. Max 200 characters total. No hashtags, no cashtags, no quotes around the output.`,
        }],
      }),
    });
    const data = await res.json();
    const text = data?.content?.find(c => c.type === 'text')?.text?.trim();
    return text && text.length <= 270 ? text : fallback;
  } catch (err) {
    console.log(`Claude take failed (${err.message}), using fallback.`);
    return fallback;
  }
}

// ---------- windows ----------

// 4 PM window: store closing prices for today's amc reporters on the watchlist.
async function runSnapshotWindow(db, todayET) {
  const calendar = await getEarningsCalendar(todayET, todayET);
  const amcToday = calendar.filter(
    e => WATCHLIST.includes(e.symbol) && (e.hour === 'amc' || e.hour === 'dmh' || !e.hour)
  );
  console.log(`Snapshot window: ${amcToday.length} watchlist reporters after the close today.`);

  for (const e of amcToday) {
    try {
      const quote = await getQuote(e.symbol);
      if (quote?.c > 0) {
        await db.query(
          `INSERT INTO earnings_snapshots (symbol, snap_date, close_price)
           VALUES ($1, $2, $3)
           ON CONFLICT (symbol, snap_date) DO UPDATE SET close_price = EXCLUDED.close_price`,
          [e.symbol, todayET, quote.c]
        );
        console.log(`Snapshot ${e.symbol}: ${quote.c}`);
      }
    } catch (err) {
      console.log(`Snapshot failed for ${e.symbol}: ${err.message}`);
    }
  }
}

// Posting windows (evening = amc with after-hours move; morning = bmo/premarket + leftovers)
async function runPostingWindow(db, isMorning, todayET) {
  const fromDate = isMorning ? easternDateOffset(-1) : todayET;
  const calendar = await getEarningsCalendar(fromDate, todayET);

  const candidates = calendar
    .filter(e => e.epsActual != null && WATCHLIST.includes(e.symbol))
    .sort((a, b) => WATCHLIST.indexOf(a.symbol) - WATCHLIST.indexOf(b.symbol));

  console.log(`Posting window: ${candidates.length} watchlist candidates with reported actuals.`);
  if (candidates.length === 0) return;

  const twitter = new TwitterApi({
    appKey: process.env.X_API_KEY,
    appSecret: process.env.X_API_SECRET,
    accessToken: process.env.X_ACCESS_TOKEN,
    accessSecret: process.env.X_ACCESS_SECRET,
  });

  let posted = 0;
  for (const e of candidates) {
    if (posted >= MAX_POSTS_PER_RUN) break;

    const already = await db.query(
      'SELECT 1 FROM posted_earnings WHERE symbol = $1 AND report_date = $2',
      [e.symbol, e.date]
    );
    if (already.rows.length > 0) continue;

    // Price movement
    let move = null;
    try {
      const quote = await getQuote(e.symbol);
      if (isMorning) {
        move = premarketMove(quote, todayET);
      } else {
        const snap = await db.query(
          'SELECT close_price FROM earnings_snapshots WHERE symbol = $1 AND snap_date = $2',
          [e.symbol, todayET]
        );
        const snapshotClose = snap.rows[0] ? Number(snap.rows[0].close_price) : 0;
        move = afterHoursMove(quote, snapshotClose, todayET);
      }
    } catch (err) {
      console.log(`Quote failed for ${e.symbol}: ${err.message}`);
    }

    const mainText = buildMainTweet(e, move);
    console.log(`Posting ${e.symbol}:\n${mainText}`);
    const mainTweet = await twitter.v2.tweet(mainText);

    // Save to DB immediately after main post succeeds, before the reply
    await db.query(
      'INSERT INTO posted_earnings (symbol, report_date) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [e.symbol, e.date]
    );
    posted++;

    // Threaded engagement reply — failure here must not block anything
    try {
      const take = await generateTake(e, move);
      await twitter.v2.reply(take, mainTweet.data.id);
      console.log(`Reply posted for ${e.symbol}`);
    } catch (err) {
      console.log(`Reply failed for ${e.symbol}: ${err.message}`);
    }
  }

  console.log(`Done — posted ${posted} earnings update(s).`);
}

// ---------- main ----------

async function main() {
  const et = nowEastern();
  console.log(`Tick at ET ${et.hour}:${String(et.minute).padStart(2, '0')}, ${et.weekday} ${et.dateStr}`);

  if (['Sat', 'Sun'].includes(et.weekday)) {
    console.log('Weekend — skipping.');
    return;
  }

  const isSnapshotWindow = et.hour === 16; // 4:00–4:59 PM ET
  const isEveningWindow = et.hour === 18;  // 6:00–6:59 PM ET
  const isMorningWindow = et.hour === 8;   // 8:00–8:59 AM ET
  if (!isSnapshotWindow && !isEveningWindow && !isMorningWindow) {
    console.log('Outside all windows — skipping.');
    return;
  }

  const db = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await db.connect();
  await db.query(`
    CREATE TABLE IF NOT EXISTS posted_earnings (
      symbol TEXT NOT NULL,
      report_date DATE NOT NULL,
      posted_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (symbol, report_date)
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS earnings_snapshots (
      symbol TEXT NOT NULL,
      snap_date DATE NOT NULL,
      close_price NUMERIC NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (symbol, snap_date)
    )
  `);

  try {
    if (isSnapshotWindow) {
      await runSnapshotWindow(db, et.dateStr);
    } else {
      await runPostingWindow(db, isMorningWindow, et.dateStr);
    }
  } finally {
    await db.end();
  }
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
  });
