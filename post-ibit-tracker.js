// post-ibit-tracker.js
// Daily IBIT (BlackRock) buy/sell tracker for @DegenTrader
// Data source: Farside Investors daily flow table (US$ millions)
// Runs on Railway cron */15 * * * * — posts once per new flow date, evening window ET

import { TwitterApi } from 'twitter-api-v2';
import pg from 'pg';
import fetch from 'node-fetch';
import fs from 'fs';

const { Client } = pg;

const FARSIDE_URL = 'https://farside.co.uk/btc/';
const FMP_KEY = process.env.FMP_API_KEY;
const FINK_IMAGE_PATH = './assets/fink.jpg'; // optional — only attached if file exists

// ---- time window: only attempt between 18:00 and 23:59 ET ----
function inWindow() {
  const et = new Date(
    new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })
  );
  return et.getHours() >= 18;
}

// ---- fetch + parse Farside flow table ----
// Returns chronological array of { date: 'YYYY-MM-DD', flow: Number } (flow in US$ millions)
async function fetchFarside() {
  const res = await fetch(FARSIDE_URL, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml',
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

    // date rows look like "15 Jul 2026"; skip Fee/Total/Average/etc rows
    const dm = cells[0].match(/^(\d{1,2}) ([A-Za-z]{3}) (\d{4})$/);
    if (!dm) continue;

    const raw = cells[1]; // IBIT is the first data column
    if (raw === '-' || raw === '') continue; // data not published yet for that day

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
function buildChartUrl(rows) {
  const labels = rows.map(r =>
    new Date(r.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  );
  const values = rows.map(r => r.flow);
  const colors = values.map(v => (v >= 0 ? '#22c55e' : '#ef4444'));
  const config = {
    type: 'bar',
    data: { labels, datasets: [{ data: values, backgroundColor: colors, borderRadius: 4 }] },
    options: {
      plugins: {
        legend: { display: false },
        title: {
          display: true,
          text: 'IBIT DAILY FLOWS (US$M)',
          color: '#d4af37',
          font: { family: 'monospace', size: 20, weight: 'bold' },
        },
      },
      scales: {
        x: { ticks: { color: '#e0e1dd', font: { family: 'monospace' } }, grid: { display: false } },
        y: {
          ticks: { color: '#e0e1dd', font: { family: 'monospace' } },
          grid: { color: 'rgba(255,255,255,0.08)' },
        },
      },
    },
  };
  return `https://quickchart.io/chart?w=800&h=450&bkg=${encodeURIComponent('#0d1b2a')}&c=${encodeURIComponent(JSON.stringify(config))}`;
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

  const existing = await db.query('SELECT 1 FROM ibit_flows WHERE as_of_date = $1', [
    latest.date,
  ]);
  if (existing.rows.length > 0) {
    console.log('Already processed this date, exiting.');
    await db.end();
    return;
  }

  // Save BEFORE posting
  await db.query(
    'INSERT INTO ibit_flows (as_of_date, flow_usd_m, posted) VALUES ($1, $2, FALSE)',
    [latest.date, latest.flow]
  );

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

  const chartUrl = buildChartUrl(rows.slice(-7));
  const chartRes = await fetch(chartUrl);
  const chartBuffer = Buffer.from(await chartRes.arrayBuffer());

  const client = new TwitterApi({
    appKey: process.env.X_API_KEY,
    appSecret: process.env.X_API_SECRET,
    accessToken: process.env.X_ACCESS_TOKEN,
    accessSecret: process.env.X_ACCESS_SECRET,
  });

  const mediaIds = [await client.v1.uploadMedia(chartBuffer, { mimeType: 'image/png' })];

  if (fs.existsSync(FINK_IMAGE_PATH)) {
    const finkBuffer = fs.readFileSync(FINK_IMAGE_PATH);
    mediaIds.push(await client.v1.uploadMedia(finkBuffer, { mimeType: 'image/jpeg' }));
  }

  const tweet = await client.v2.tweet({ text, media: { media_ids: mediaIds } });
  console.log(`Posted: ${tweet.data.id}`);

  await db.query('UPDATE ibit_flows SET posted = TRUE WHERE as_of_date = $1', [latest.date]);
  await db.end();
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
