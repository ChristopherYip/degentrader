// post-ibit-tracker.js
// Daily IBIT (BlackRock iShares Bitcoin Trust) buy/sell tracker for @DegenTrader
// Runs on Railway cron */15 * * * * — posts once per new holdings date, evening window ET

import { TwitterApi } from 'twitter-api-v2';
import pg from 'pg';
import fetch from 'node-fetch';
import fs from 'fs';

const { Client } = pg;

const HOLDINGS_URL =
  'https://www.ishares.com/us/products/333011/ishares-bitcoin-trust-etf/1467271812596.ajax?fileType=csv&fileName=IBIT_holdings&dataType=fund';
const FMP_KEY = process.env.FMP_API_KEY;
const FINK_IMAGE_PATH = './assets/fink.jpg'; // optional — only attached if file exists

// ---- time window: only attempt between 18:00 and 23:59 ET ----
function inWindow() {
  const et = new Date(
    new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })
  );
  return et.getHours() >= 18;
}

// ---- fetch + parse iShares holdings CSV ----
async function fetchHoldings() {
  const res = await fetch(HOLDINGS_URL, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DegenTraderBot/1.0)' },
  });
  if (!res.ok) throw new Error(`iShares fetch failed: ${res.status}`);
  const text = await res.text();
  const lines = text.split('\n');

  // "Fund Holdings as of,"Jun 27, 2026""
  let asOf = null;
  for (const line of lines) {
    if (line.toLowerCase().includes('holdings as of')) {
      const m = line.match(/"([^"]+)"/);
      if (m) asOf = new Date(m[1]).toISOString().slice(0, 10);
      break;
    }
  }
  if (!asOf) throw new Error('Could not parse as-of date from CSV');

  // find the bitcoin row, quantity is a quoted number with commas
  let btc = null;
  for (const line of lines) {
    if (line.toUpperCase().includes('BITCOIN') || line.startsWith('BTC,') || line.startsWith('"BTC"')) {
      // split respecting quoted fields
      const fields = line.match(/("[^"]*"|[^,]+)/g).map(f => f.replace(/"/g, '').trim());
      // quantity is the largest plausible numeric field with commas (BTC count is ~700k)
      for (const f of fields) {
        const n = parseFloat(f.replace(/,/g, ''));
        if (!isNaN(n) && n > 100000 && n < 5000000) { btc = n; break; }
      }
      if (btc) break;
    }
  }
  if (!btc) throw new Error('Could not parse BTC quantity from CSV');
  return { asOf, btc };
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

// ---- QuickChart: last 7 daily changes, green/red bars ----
function buildChartUrl(rows) {
  const labels = rows.map(r =>
    new Date(r.as_of_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  );
  const values = rows.map(r => Number(r.change_btc));
  const colors = values.map(v => (v >= 0 ? '#22c55e' : '#ef4444'));
  const config = {
    type: 'bar',
    data: { labels, datasets: [{ data: values, backgroundColor: colors, borderRadius: 4 }] },
    options: {
      plugins: {
        legend: { display: false },
        title: {
          display: true,
          text: 'IBIT DAILY BTC FLOWS',
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

function fmt(n) {
  return Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
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
    CREATE TABLE IF NOT EXISTS ibit_holdings (
      as_of_date DATE PRIMARY KEY,
      btc_held NUMERIC NOT NULL,
      change_btc NUMERIC,
      posted BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  const { asOf, btc } = await fetchHoldings();
  console.log(`iShares data as of ${asOf}: ${btc} BTC`);

  const existing = await db.query('SELECT 1 FROM ibit_holdings WHERE as_of_date = $1', [asOf]);
  if (existing.rows.length > 0) {
    console.log('Already processed this date, exiting.');
    await db.end();
    return;
  }

  const prev = await db.query(
    'SELECT btc_held FROM ibit_holdings ORDER BY as_of_date DESC LIMIT 1'
  );

  // First run: seed baseline, don't post
  if (prev.rows.length === 0) {
    await db.query(
      'INSERT INTO ibit_holdings (as_of_date, btc_held, change_btc, posted) VALUES ($1, $2, 0, TRUE)',
      [asOf, btc]
    );
    console.log('Baseline seeded. Posting starts tomorrow.');
    await db.end();
    return;
  }

  const change = btc - Number(prev.rows[0].btc_held);

  // Save BEFORE posting (learned this the hard way)
  await db.query(
    'INSERT INTO ibit_holdings (as_of_date, btc_held, change_btc, posted) VALUES ($1, $2, $3, FALSE)',
    [asOf, btc, change]
  );

  if (Math.abs(change) < 1) {
    console.log('No meaningful change, skipping post.');
    await db.query('UPDATE ibit_holdings SET posted = TRUE WHERE as_of_date = $1', [asOf]);
    await db.end();
    return;
  }

  const price = await getBtcPrice();
  const usd = price ? Math.abs(change) * price : null;
  const usdStr = usd
    ? ` (~$${usd >= 1e9 ? (usd / 1e9).toFixed(2) + 'B' : (usd / 1e6).toFixed(0) + 'M'})`
    : '';

  const bought = change > 0;
  const text = bought
    ? `🚨 BREAKING: BlackRock's Bitcoin ETF just BOUGHT ${fmt(change)} $BTC${usdStr} 🟢\n\nTotal $IBIT stack: ${fmt(btc)} BTC\n\nLarry keeps stacking. 📈\n\n#Bitcoin #IBIT #Crypto`
    : `🚨 BREAKING: BlackRock's Bitcoin ETF just SOLD ${fmt(change)} $BTC${usdStr} 🔴\n\nTotal $IBIT stack: ${fmt(btc)} BTC\n\nOutflows hitting. 📉\n\n#Bitcoin #IBIT #Crypto`;

  // chart of last 7 days
  const hist = await db.query(
    'SELECT as_of_date, change_btc FROM ibit_holdings ORDER BY as_of_date DESC LIMIT 7'
  );
  const chartUrl = buildChartUrl(hist.rows.reverse());
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

  await db.query('UPDATE ibit_holdings SET posted = TRUE WHERE as_of_date = $1', [asOf]);
  await db.end();
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
