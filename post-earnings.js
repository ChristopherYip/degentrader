// post-earnings.js — Long-form earnings reaction posts for @DegenTrader
// Requires X Premium (posts exceed 280 chars) + images attached.
// Runs every 15 min via Railway cron. Three ET windows:
//   4:00–4:59 PM ET → snapshot closing prices for today's after-close (amc) reporters
//   6:00–6:59 PM ET → post amc earnings with true after-hours movement
//   8:00–8:59 AM ET → post pre-open (bmo) earnings with premarket movement + catch leftovers
// Data: Finnhub (calendar, quotes, profile, metrics, news), FMP (chart history, CEO name),
//       QuickChart (chart image), Wikipedia (CEO photo). Dedupe via Postgres.

import { TwitterApi } from 'twitter-api-v2';
import pg from 'pg';
const { Client } = pg;

const FINNHUB_KEY = process.env.FINNHUB_API_KEY;
const FMP_KEY = process.env.FMP_API_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

const MAX_POSTS_PER_RUN = 3;
const CHART_LOOKBACK_DAYS = 120; // calendar days back for the 3-month chart
const MAX_IMAGE_BYTES = 4.8 * 1024 * 1024; // stay under X's 5MB photo limit

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

// ---------- API helpers ----------

async function finnhub(path, params = {}) {
  const qs = new URLSearchParams({ ...params, token: FINNHUB_KEY }).toString();
  const res = await fetch(`https://finnhub.io/api/v1/${path}?${qs}`);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Finnhub ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

async function getEarningsCalendar(fromDate, toDate) {
  const data = await finnhub('calendar/earnings', { from: fromDate, to: toDate });
  return data?.earningsCalendar || [];
}

// Quote. Returns { c: current, dp: % change vs prev close, pc: prev close, t: unix sec of last trade }
async function getQuote(symbol) {
  return finnhub('quote', { symbol });
}

// Extra metrics for the post body + logo URL. Everything here is optional.
async function getExtras(symbol) {
  const out = {};
  try {
    const p = await finnhub('stock/profile2', { symbol });
    if (p) {
      out.name = p.name || null;
      out.logoUrl = p.logo || null;
      out.marketCapM = p.marketCapitalization || null; // in millions USD
    }
  } catch (err) {
    console.log(`profile2 failed for ${symbol}: ${err.message}`);
  }
  try {
    const m = await finnhub('stock/metric', { symbol, metric: 'all' });
    const met = m?.metric || {};
    out.wkHigh = met['52WeekHigh'] ?? null;
    out.wkLow = met['52WeekLow'] ?? null;
    out.revGrowthYoy = met.revenueGrowthTTMYoy ?? null; // percent
  } catch (err) {
    console.log(`metric failed for ${symbol}: ${err.message}`);
  }
  return out;
}

// Recent news headlines for a symbol (last ~24h). On earnings night this is
// coverage of the release itself — guidance, segment numbers, key quotes.
async function getCompanyNews(symbol) {
  try {
    const news = await finnhub('company-news', {
      symbol,
      from: easternDateOffset(-1),
      to: easternDateOffset(0),
    });
    return (news || [])
      .sort((a, b) => (b.datetime || 0) - (a.datetime || 0))
      .slice(0, 6)
      .map(n => `- ${n.headline}${n.summary ? `: ${String(n.summary).slice(0, 200)}` : ''}`);
  } catch (err) {
    console.log(`News fetch failed for ${symbol}: ${err.message}`);
    return [];
  }
}

// ---------- images ----------

// Magic-byte image type detection — X rejects mislabeled uploads.
function detectImageType(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf[0] === 0x47 && buf[1] === 0x49) return 'image/gif';
  if (buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp';
  return null;
}

async function downloadImage(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'DegenTraderBot/1.0' } });
  if (!res.ok) throw new Error(`image HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_IMAGE_BYTES) throw new Error('image too large');
  const mimeType = detectImageType(buf);
  if (!mimeType) throw new Error('unrecognized image type');
  return { buffer: buf, mimeType };
}

// 3-month price chart in DegenTrader style, rendered by QuickChart.
// Price history from FMP (Finnhub candles are paid).
async function renderChartImage(symbol) {
  const from = easternDateOffset(-CHART_LOOKBACK_DAYS);
  const to = easternDateOffset(0);
  const hist = await fetchJson(
    `https://financialmodelingprep.com/stable/historical-price-eod/light?symbol=${symbol}&from=${from}&to=${to}&apikey=${FMP_KEY}`
  );
  const rows = (Array.isArray(hist) ? hist : [])
    .filter(r => r.date && r.price != null)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (rows.length < 10) throw new Error('not enough price history');

  const labels = rows.map(r => r.date.slice(5)); // MM-DD
  const closes = rows.map(r => Number(r.price));
  const up = closes[closes.length - 1] >= closes[0];
  const lineColor = up ? '#22c55e' : '#ef4444';

  const config = {
    type: 'line',
    data: {
      labels,
      datasets: [{
        data: closes,
        borderColor: lineColor,
        backgroundColor: up ? 'rgba(34,197,94,0.12)' : 'rgba(239,68,68,0.12)',
        fill: true,
        pointRadius: 0,
        borderWidth: 2,
        tension: 0.15,
      }],
    },
    options: {
      plugins: {
        legend: { display: false },
        title: {
          display: true,
          text: `$${symbol} — last 3 months`,
          color: '#FFD700',
          font: { size: 20, family: 'monospace', weight: 'bold' },
        },
      },
      scales: {
        x: {
          ticks: { color: '#8b93a7', maxTicksLimit: 6, font: { family: 'monospace' } },
          grid: { color: 'rgba(255,255,255,0.05)' },
        },
        y: {
          ticks: { color: '#8b93a7', font: { family: 'monospace' } },
          grid: { color: 'rgba(255,255,255,0.08)' },
        },
      },
    },
  };

  const res = await fetch('https://quickchart.io/chart', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chart: config,
      width: 800,
      height: 450,
      backgroundColor: '#0b1220',
      version: '3',
      format: 'png',
    }),
  });
  if (!res.ok) throw new Error(`QuickChart ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const mimeType = detectImageType(buf);
  if (!mimeType) throw new Error('QuickChart returned non-image');
  return { buffer: buf, mimeType };
}

// CEO portrait: get the CEO's name from FMP's company profile, then pull
// their Wikipedia portrait if one exists. Skips silently if not found.
async function getCeoImage(symbol) {
  const profile = await fetchJson(
    `https://financialmodelingprep.com/stable/profile?symbol=${symbol}&apikey=${FMP_KEY}`
  );
  const ceo = Array.isArray(profile) ? profile[0]?.ceo : profile?.ceo;
  if (!ceo || ceo.length < 4) throw new Error('no CEO name in profile');

  // Strip honorifics/suffixes that break Wikipedia lookups ("Mr. Timothy D. Cook")
  const cleaned = ceo
    .replace(/^(Mr\.|Ms\.|Mrs\.|Dr\.)\s+/i, '')
    .replace(/\s+(Jr\.|Sr\.|II|III|IV)\.?$/i, '')
    .trim();

  const wiki = await fetchJson(
    `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(cleaned)}`
  );
  if (wiki.type !== 'standard') throw new Error('no standard Wikipedia page');
  const imgUrl = wiki.originalimage?.source || wiki.thumbnail?.source;
  if (!imgUrl) throw new Error('no portrait on Wikipedia page');
  return downloadImage(imgUrl);
}

// Gather up to 3 images: chart, logo, CEO. Every step is non-fatal.
async function gatherImages(symbol, logoUrl) {
  const images = [];
  try {
    images.push(await renderChartImage(symbol));
    console.log(`${symbol}: chart image ready`);
  } catch (err) {
    console.log(`${symbol}: chart image skipped (${err.message})`);
  }
  if (logoUrl) {
    try {
      images.push(await downloadImage(logoUrl));
      console.log(`${symbol}: logo image ready`);
    } catch (err) {
      console.log(`${symbol}: logo skipped (${err.message})`);
    }
  }
  try {
    images.push(await getCeoImage(symbol));
    console.log(`${symbol}: CEO image ready`);
  } catch (err) {
    console.log(`${symbol}: CEO image skipped (${err.message})`);
  }
  return images;
}

// ---------- movement logic ----------

function afterHoursMove(quote, snapshotClose, todayET) {
  if (!quote || !quote.c || !quote.t) return null;
  const trade = etPartsFromDate(new Date(quote.t * 1000));
  const tradeMinutes = trade.hour * 60 + trade.minute;

  if (snapshotClose > 0 && trade.dateStr === todayET && tradeMinutes > 16 * 60 + 5) {
    const pct = ((quote.c - snapshotClose) / snapshotClose) * 100;
    return { pct, label: 'after hours' };
  }
  if (trade.dateStr === todayET && quote.dp != null) {
    return { pct: Number(quote.dp), label: 'on the day' };
  }
  return null;
}

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

function formatMarketCap(millions) {
  if (millions == null || isNaN(millions) || millions <= 0) return null;
  if (millions >= 1e6) return `$${(millions / 1e6).toFixed(2)}T`;
  if (millions >= 1e3) return `$${(millions / 1e3).toFixed(0)}B`;
  return `$${millions.toFixed(0)}M`;
}

function formatPrice(n) {
  if (n == null || isNaN(n)) return null;
  return n >= 1000
    ? `$${Math.round(n).toLocaleString('en-US')}`
    : `$${Number(n).toFixed(2)}`;
}

function surprisePct(actual, estimate) {
  if (actual == null || estimate == null || estimate === 0) return '';
  const pct = ((actual - estimate) / Math.abs(estimate)) * 100;
  const sign = pct >= 0 ? '+' : '';
  return ` (${sign}${pct.toFixed(1)}%)`;
}

function beatMissEmoji(actual, estimate) {
  if (actual == null || estimate == null) return '';
  if (actual > estimate) return ' ✅ BEAT';
  if (actual < estimate) return ' ❌ MISS';
  return ' ➖ INLINE';
}

function buildMainTweet(e, move, extras, commentary) {
  const yr = e.year ? ` ${e.year}` : '';
  const header = e.quarter
    ? `🚨 $${e.symbol} Q${e.quarter}${yr} EARNINGS`
    : `🚨 $${e.symbol} EARNINGS OUT`;
  const lines = [header, ''];

  if (e.epsActual != null) {
    let epsLine = `📊 EPS: $${Number(e.epsActual).toFixed(2)}`;
    if (e.epsEstimate != null) {
      epsLine += ` vs $${Number(e.epsEstimate).toFixed(2)} est${beatMissEmoji(e.epsActual, e.epsEstimate)}${surprisePct(e.epsActual, e.epsEstimate)}`;
    }
    lines.push(epsLine);
  }

  const revActual = formatRevenue(e.revenueActual);
  if (revActual) {
    let revLine = `💰 Rev: ${revActual}`;
    const revEst = formatRevenue(e.revenueEstimate);
    if (revEst) {
      revLine += ` vs ${revEst} est${beatMissEmoji(e.revenueActual, e.revenueEstimate)}${surprisePct(e.revenueActual, e.revenueEstimate)}`;
    }
    lines.push(revLine);
  }

  // Extra metrics block
  const metricLines = [];
  if (extras.revGrowthYoy != null && !isNaN(extras.revGrowthYoy)) {
    const sign = extras.revGrowthYoy >= 0 ? '+' : '';
    metricLines.push(`📈 Rev growth: ${sign}${Number(extras.revGrowthYoy).toFixed(1)}% YoY`);
  }
  const mcap = formatMarketCap(extras.marketCapM);
  if (mcap) metricLines.push(`🏦 Market cap: ${mcap}`);
  const lo = formatPrice(extras.wkLow);
  const hi = formatPrice(extras.wkHigh);
  if (lo && hi) metricLines.push(`📏 52-wk range: ${lo} – ${hi}`);
  if (metricLines.length > 0) lines.push('', ...metricLines);

  if (move) {
    const arrow = move.pct >= 0 ? '🚀' : '📉';
    const sign = move.pct >= 0 ? '+' : '';
    lines.push('', `${arrow} ${sign}${move.pct.toFixed(1)}% ${move.label}`);
  }

  if (commentary) lines.push('', commentary);

  lines.push('', '#Earnings #Stocks');
  return lines.join('\n');
}

async function generateCommentary(e, move) {
  const fallback = move && move.pct < 0
    ? `Numbers in, market not impressed. Overreaction or warning sign? 👇`
    : `Numbers in. Bulls eating good tonight or is this priced in? 👇`;
  if (!ANTHROPIC_KEY) return fallback;
  try {
    const headlines = await getCompanyNews(e.symbol);
    const moveDesc = move ? `${move.pct >= 0 ? '+' : ''}${move.pct.toFixed(1)}% ${move.label}` : 'no price data yet';
    const newsBlock = headlines.length > 0
      ? `\n\nRecent news coverage of the release:\n${headlines.join('\n')}`
      : '';
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 350,
        messages: [{
          role: 'user',
          content: `You write for a high-energy "degen trader" stock market X account. ${e.symbol} just reported Q${e.quarter || '?'} earnings: EPS ${e.epsActual} vs ${e.epsEstimate} est, revenue ${e.revenueActual} vs ${e.revenueEstimate} est. Stock is ${moveDesc}.${newsBlock}

Write a punchy 2-4 sentence take on the release. If the news coverage above contains specific details (guidance, subscriber/user numbers, segment results, buybacks, margin commentary), anchor the take on those details — that's usually the real story, not the headline beat/miss. NEVER invent numbers or facts that aren't in the data provided above. If no coverage is available, keep it general. End with a short question to spark replies. Max 450 characters total. No hashtags, no cashtags, no quotes around the output, no emoji at the start.`,
        }],
      }),
    });
    const data = await res.json();
    const text = data?.content?.find(c => c.type === 'text')?.text?.trim();
    return text && text.length <= 600 ? text : fallback;
  } catch (err) {
    console.log(`Claude commentary failed (${err.message}), using fallback.`);
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

    // Extra metrics + logo URL (non-fatal)
    const extras = await getExtras(e.symbol);

    // Commentary anchored to release coverage
    const commentary = await generateCommentary(e, move);

    // Images: chart, logo, CEO — all non-fatal
    const images = await gatherImages(e.symbol, extras.logoUrl);
    const mediaIds = [];
    for (const img of images.slice(0, 4)) {
      try {
        const id = await twitter.v1.uploadMedia(img.buffer, { mimeType: img.mimeType });
        mediaIds.push(id);
      } catch (err) {
        console.log(`Media upload failed for ${e.symbol}: ${err.message}`);
      }
    }

    const mainText = buildMainTweet(e, move, extras, commentary);
    console.log(`Posting ${e.symbol} with ${mediaIds.length} image(s):\n${mainText}`);
    await twitter.v2.tweet(
      mediaIds.length > 0
        ? { text: mainText, media: { media_ids: mediaIds } }
        : { text: mainText }
    );

    // Save to DB immediately after the post succeeds
    await db.query(
      'INSERT INTO posted_earnings (symbol, report_date) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [e.symbol, e.date]
    );
    posted++;
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
