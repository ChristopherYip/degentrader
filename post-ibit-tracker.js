// post-ibit-tracker.js
// Daily IBIT (BlackRock) buy/sell tracker for @DegenTrader
// Data source: Farside Investors via Jina reader proxy
// Runs on Railway cron */15 * * * * — posts once per new flow date, evening window ET

import { TwitterApi } from 'twitter-api-v2';
import pg from 'pg';
import fetch from 'node-fetch';
import fs from 'fs';

const { Client } = pg;

const FARSIDE_URL = 'https://farside.co.uk/btc/';
const FMP_KEY = process.env.FMP_API_KEY;
const FINK_IMAGE_PATH = './assets/ceos/fink.jpg'; // optional — only attached if file exists and is a valid image

// ---- time window: only attempt between 18:00 and 23:59 ET ----
function inWindow() {
  const et = new Date(
    new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })
  );
  return et.getHours() >= 18;
}

// ---- detect real image type from file bytes (extensions lie) ----
function detectImageMime(buf) {
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.length > 12 && buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (buf.length > 6 && ['GIF87a', 'GIF89a'].includes(buf.slice(0, 6).toString('ascii'))) return 'image/gif';
  return null;
}

// ---- fetch + parse Farside flow table (via Jina proxy) ----
async function fetchFarside() {
  const res = await fetch('https://r.jina.ai/' + FARSIDE_URL, {
    headers: {
      'x-respond-with': 'html',
    },
  });
  if (!res.ok) throw new Error(`Farside fetch failed: HTTP ${res.status}`);
  const html = await res.text();

  const rows = [];
  const trRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = trRegex.exec(html)) !== null) {
    const cells = [...m[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(c =>
      c[1].replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim()
    );
    if (cells.length < 2) continue;

    const dm = cells[0].match(/^(\d{1,2}) ([A-Za-z]{3}) (\d{4})$/);
    if (!dm) continue;

    const raw = cells[1]; // IBIT is the first data column
    if (raw === '-' || raw === '') continue;

    const neg = raw.includes('(');
    const num = parseFloat(raw.replace(/[(),]/g, ''));
    if (isNaN(num)) continue;

    const date = new Date(`${dm[1]} ${dm[2]} ${dm[3]} UTC`)
      .toISOString()
      .slice(0, 10);
    rows.push({ date, flow: neg ? -num : num });
  }

  if (rows.length === 0) {
    console.error('Farside response snippet:', html.slice(0, 300));
    throw new Error('Could not parse any flow rows from Farside');
  }
  return rows;
}

// ---- BTC price from FMP ----
async function getBtcPrice() {
  try {
    const res = await fetch(
      `https://financialmodelingprep.com/stable/quote?symbol=BTCUSD&apikey=${FMP_KEY}`
    );
    const data = await res.json();
    return data?.[0]?.price || null;
  } catch {
    return null;
  }
}

// ---- QuickChart: last 7 daily flows, green/red bars ----
// ---- QuickChart: last 7 daily flows, Google Finance style ----
function buildChartUrl(rows) {
  const labels = rows.map(r =>
    new Date(r.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  );
  const values = rows.map(r => Math.round(r.flow * 10) / 10);
  const colors = values.map(v => (v >= 0 ? '#137333' : '#d93025'));
  const config = {
    type: 'bar',
    data: {
      labels,
      datasets: [{ data: values, backgroundColor: colors, borderRadius: 3, barPercentage: 0.6 }],
    },
    options: {
      plugins: {
        legend: { display: false },
        title: {
          display: true,
          text: 'IBIT daily net flows (US$M)',
          color: '#202124',
          align: 'start',
          font: { family: 'Roboto, Arial, sans-serif', size: 18, weight: 'normal' },
          padding: { bottom: 16 },
        },
      },
      scales: {
        x: {
          ticks: { color: '#5f6368', font: { family: 'Roboto, Arial, sans-serif', size: 12 } },
          grid: { display: false, drawBorder: true, borderColor: '#dadce0' },
        },
        y: {
          position: 'right',
          ticks: { color: '#5f6368', font: { family: 'Roboto, Arial, sans-serif', size: 12 } },
          grid: { color: '#e8eaed', drawBorder: false },
        },
      },
    },
  };
  return `https://quickchart.io/chart?v=3&w=800&h=450&bkg=white&c=${encodeURIComponent(JSON.stringify(config))}`;
}

function fmtM(n) {
  const abs = Math.abs(n);
  return abs >= 1000 ? `$${(abs / 1000).toFixed(2)}B` : `$${abs.toFixed(1)}M`;
}

async function main() {
  if (!inWindow()) {
    console.log('Outside posting window, exiting.');
    return;
  }

  const db = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await db.connect();

  await db.query(`
    CREATE TABLE IF NOT EXISTS ibit_flows (
      as_of_date DATE PRIMARY KEY,
      flow_usd_m NUMERIC NOT NULL,
      posted BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  const rows = await fetchFarside();
  const latest = rows[rows.length - 1];
  console.log(`Latest Farside data: ${latest.date} → ${latest.flow} US$m`);

  // skip if already successfully posted (unposted rows from failed attempts will retry)
  const existing = await db.query(
    'SELECT posted FROM ibit_flows WHERE as_of_date = $1',
    [latest.date]
  );
  if (existing.rows.length > 0 && existing.rows[0].posted) {
    console.log('Already posted this date, exiting.');
    await db.end();
    return;
  }

  // upsert BEFORE posting
  await db.query(
    `INSERT INTO ibit_flows (as_of_date, flow_usd_m, posted) VALUES ($1, $2, FALSE)
     ON CONFLICT (as_of_date) DO UPDATE SET flow_usd_m = EXCLUDED.flow_usd_m`,
    [latest.date, latest.flow]
  );

  // freshness guard: don't post data older than ~2 days (e.g. after an outage)
  const daysOld = (Date.now() - new Date(latest.date + 'T00:00:00Z').getTime()) / 86400000;
  if (daysOld > 2.5) {
    console.log(`Data from ${latest.date} is stale (${daysOld.toFixed(1)} days old), marking posted without tweeting.`);
    await db.query('UPDATE ibit_flows SET posted = TRUE WHERE as_of_date = $1', [latest.date]);
    await db.end();
    return;
  }

  if (latest.flow === 0) {
    console.log('Zero flow day, skipping post.');
    await db.query('UPDATE ibit_flows SET posted = TRUE WHERE as_of_date = $1', [latest.date]);
    await db.end();
    return;
  }

  const price = await getBtcPrice();
  const btcAmt = price ? Math.round(Math.abs(latest.flow) * 1e6 / price) : null;
  const btcStr = btcAmt ? ` (~${btcAmt.toLocaleString('en-US')} $BTC)` : '';

  const bought = latest.flow > 0;
  const text = bought
    ? `🚨 BREAKING: BlackRock's Bitcoin ETF just BOUGHT ${fmtM(latest.flow)} of Bitcoin${btcStr} 🟢\n\nLarry keeps stacking. 📈\n\nData: Farside Investors\n\n#Bitcoin #IBIT #Crypto`
    : `🚨 BREAKING: BlackRock's Bitcoin ETF just SOLD ${fmtM(latest.flow)} of Bitcoin${btcStr} 🔴\n\nOutflows hitting. 📉\n\nData: Farside Investors\n\n#Bitcoin #IBIT #Crypto`;

  // ---- chart image (must be a valid PNG or we abort with a useful log) ----
  const chartRes = await fetch(buildChartUrl(rows.slice(-7)));
  const chartBuffer = Buffer.from(await chartRes.arrayBuffer());
  const chartMime = detectImageMime(chartBuffer);
  if (!chartRes.ok || chartMime !== 'image/png') {
    console.error(
      `QuickChart problem. HTTP ${chartRes.status}, detected type: ${chartMime}, body snippet:`,
      chartBuffer.slice(0, 300).toString('utf8')
    );
    throw new Error('QuickChart did not return a valid PNG');
  }

  const client = new TwitterApi({
    appKey: process.env.X_API_KEY,
    appSecret: process.env.X_API_SECRET,
    accessToken: process.env.X_ACCESS_TOKEN,
    accessSecret: process.env.X_ACCESS_SECRET,
  });

const mediaIds = [];

  // ---- Fink image first: validate real type, never let it block the post ----
  if (fs.existsSync(FINK_IMAGE_PATH)) {
    try {
      const finkBuffer = fs.readFileSync(FINK_IMAGE_PATH);
      const finkMime = detectImageMime(finkBuffer);
      if (finkMime) {
        mediaIds.push(await client.v1.uploadMedia(finkBuffer, { mimeType: finkMime }));
        console.log(`Fink image attached (${finkMime}).`);
      } else {
        console.warn('Fink image is not a recognized image format (first bytes: ' +
          finkBuffer.slice(0, 4).toString('hex') + '), skipping it.');
      }
    } catch (e) {
      console.warn('Fink image upload failed, posting without it:', e.message);
    }
  }

  // ---- chart second ----
  mediaIds.push(await client.v1.uploadMedia(chartBuffer, { mimeType: 'image/png' }));

  const tweet = await client.v2.tweet({ text, media: { media_ids: mediaIds } });
  console.log(`Posted: ${tweet.data.id}`);

  await db.query('UPDATE ibit_flows SET posted = TRUE WHERE as_of_date = $1', [latest.date]);
  await db.end();
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
