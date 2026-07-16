// post-crypto-milestone.js
// "JUST IN" alerts when BTC crosses a $1,000 milestone or ETH crosses a $100 milestone.
// Includes a 1-minute intraday chart image: green line if crossing up, red if crossing down,
// with a gold dashed line marking the milestone price.
// Runs every 5 minutes via Railway cron: */5 * * * *
// Creates its own DB table on first run. First run per coin records state silently (no post).
// No cooldown: every milestone cross posts.

import pg from 'pg';
const { Client } = pg;
import { TwitterApi } from 'twitter-api-v2';
import fetch from 'node-fetch';

// ---------- Config ----------

const COINS = [
  { symbol: 'BTCUSD', name: 'Bitcoin', hashtag: '#Bitcoin', cashtag: '$BTC', step: 1000 },
  { symbol: 'ETHUSD', name: 'Ethereum', hashtag: '#Ethereum', cashtag: '$ETH', step: 100 },
];

const CHART_MINUTES = 120; // how much intraday history to show on the chart

// Brand colors
const BG_NAVY = '#0a1628';
const GOLD = '#fbbf24';
const GREEN = '#22c55e';
const RED = '#ef4444';
const MUTED = '#94a3b8';

// ---------- Clients ----------

const twitter = new TwitterApi({
  appKey: process.env.X_API_KEY,
  appSecret: process.env.X_API_SECRET,
  accessToken: process.env.X_ACCESS_TOKEN,
  accessSecret: process.env.X_ACCESS_SECRET,
});

const db = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ---------- Helpers ----------

function fmt(n) {
  return '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
}

async function getPrice(symbol) {
  const url = `https://financialmodelingprep.com/stable/quote?symbol=${symbol}&apikey=${process.env.FMP_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`FMP ${symbol} HTTP ${res.status}`);
  const data = await res.json();
  const quote = Array.isArray(data) ? data[0] : data;
  if (!quote || typeof quote.price !== 'number') {
    throw new Error(`FMP ${symbol}: no price in response: ${JSON.stringify(data).slice(0, 200)}`);
  }
  return quote.price;
}

// Fetch recent intraday candles, newest-first from FMP, returned oldest-first.
// Tries 1min, falls back to 5min.
async function getIntraday(symbol) {
  for (const interval of ['1min', '5min']) {
    try {
      const url = `https://financialmodelingprep.com/stable/historical-chart/${interval}?symbol=${symbol}&apikey=${process.env.FMP_API_KEY}`;
      const res = await fetch(url);
      if (!res.ok) continue;
      const data = await res.json();
      if (Array.isArray(data) && data.length > 5) {
        const count = interval === '1min' ? CHART_MINUTES : Math.ceil(CHART_MINUTES / 5);
        return { interval, points: data.slice(0, count).reverse() };
      }
    } catch (err) {
      console.error(`FMP intraday ${interval} ${symbol} failed:`, err.message);
    }
  }
  return null;
}

// Render the chart via QuickChart, return a PNG Buffer (or null on failure).
async function buildChartImage(coin, intraday, direction, milestone) {
  try {
    const { interval, points } = intraday;
    const labels = points.map((p) => p.date.slice(11, 16)); // "HH:MM"
    const prices = points.map((p) => p.close);
    const lineColor = direction === 'up' ? GREEN : RED;
    const fillColor = direction === 'up' ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.15)';

    const chartConfig = {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            data: prices,
            borderColor: lineColor,
            backgroundColor: fillColor,
            fill: true,
            pointRadius: 0,
            borderWidth: 3,
            lineTension: 0.1,
          },
        ],
      },
      options: {
        legend: { display: false },
        title: {
          display: true,
          text: `${coin.name} — ${interval} chart`,
          fontColor: GOLD,
          fontSize: 20,
        },
        scales: {
          xAxes: [
            {
              ticks: { fontColor: MUTED, maxTicksLimit: 6, fontSize: 14 },
              gridLines: { display: false },
            },
          ],
          yAxes: [
            {
              ticks: { fontColor: MUTED, fontSize: 14 },
              gridLines: { color: 'rgba(148,163,184,0.15)' },
            },
          ],
        },
        annotation: {
          annotations: [
            {
              type: 'line',
              mode: 'horizontal',
              scaleID: 'y-axis-0',
              value: milestone,
              borderColor: GOLD,
              borderWidth: 2,
              borderDash: [6, 6],
              label: {
                enabled: true,
                content: fmt(milestone),
                backgroundColor: GOLD,
                fontColor: BG_NAVY,
                fontStyle: 'bold',
              },
            },
          ],
        },
      },
    };

    const res = await fetch('https://quickchart.io/chart', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chart: chartConfig,
        width: 1200,
        height: 675,
        backgroundColor: BG_NAVY,
        format: 'png',
        version: '2',
      }),
    });
    if (!res.ok) throw new Error(`QuickChart HTTP ${res.status}`);
    const arrayBuffer = await res.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } catch (err) {
    console.error(`${coin.symbol}: chart generation failed:`, err.message);
    return null;
  }
}

async function generateTake(coin, milestone, direction, price) {
  const angle =
    direction === 'up'
      ? `${coin.name} just broke above ${fmt(milestone)} (now ${fmt(price)}). Write a punchy, bullish 1-2 sentence take. High energy, rocket/moon vibes welcome.`
      : `${coin.name} just slipped below ${fmt(milestone)} (now ${fmt(price)}). Write a cheeky, degen "buy the dip / discount season" style 1-2 sentence take. Playful, not doom-y.`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 150,
        messages: [
          {
            role: 'user',
            content: `You write for @DegenTrader, a high-energy WallStreetBets-style crypto/stocks X account. ${angle} Max 140 characters. No hashtags, no cashtags, no quotes around the text, no emojis at the start. Do not give financial advice or tell people to buy/sell.`,
          },
        ],
      }),
    });
    const data = await res.json();
    const text = data?.content?.[0]?.text?.trim();
    if (text) return text.slice(0, 140);
  } catch (err) {
    console.error('Claude API failed, using fallback take:', err.message);
  }

  // Fallbacks if the API call fails
  return direction === 'up'
    ? 'Bulls are wide awake. Momentum looks hungry for the next level. 🚀'
    : 'Volatility is the price of admission. Degens call this a sale. 👀';
}

function buildTweet(coin, milestone, direction, take) {
  const headline =
    direction === 'up'
      ? `🚨 JUST IN: ${coin.hashtag} crosses ${fmt(milestone)}`
      : `🚨 JUST IN: ${coin.hashtag} slips below ${fmt(milestone)}`;

  let tweet = `${headline}\n\n${take}\n\n${coin.cashtag} #Crypto`;
  if (tweet.length > 280) {
    tweet = `${headline}\n\n${coin.cashtag} #Crypto`;
  }
  return tweet;
}

// ---------- Main ----------

async function run() {
  await db.connect();

  await db.query(`
    CREATE TABLE IF NOT EXISTS crypto_milestones (
      symbol TEXT PRIMARY KEY,
      last_price NUMERIC NOT NULL,
      last_bucket INTEGER NOT NULL,
      last_posted_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  for (const coin of COINS) {
    try {
      const price = await getPrice(coin.symbol);
      const bucket = Math.floor(price / coin.step);
      console.log(`${coin.symbol}: price ${fmt(price)}, bucket ${bucket}`);

      const { rows } = await db.query(
        'SELECT last_price, last_bucket, last_posted_at FROM crypto_milestones WHERE symbol = $1',
        [coin.symbol]
      );

      // First run for this coin: record state, don't post
      if (rows.length === 0) {
        await db.query(
          'INSERT INTO crypto_milestones (symbol, last_price, last_bucket) VALUES ($1, $2, $3)',
          [coin.symbol, price, bucket]
        );
        console.log(`${coin.symbol}: first run, state recorded, no post.`);
        continue;
      }

      const prev = rows[0];
      const prevBucket = Number(prev.last_bucket);

      // No milestone crossed: just refresh price
      if (bucket === prevBucket) {
        await db.query(
          'UPDATE crypto_milestones SET last_price = $2, last_bucket = $3, updated_at = NOW() WHERE symbol = $1',
          [coin.symbol, price, bucket]
        );
        continue;
      }

      // Milestone crossed
      const direction = bucket > prevBucket ? 'up' : 'down';
      const milestone = direction === 'up' ? bucket * coin.step : prevBucket * coin.step;

      // Save state BEFORE tweeting (missed alert beats duplicate posts)
      await db.query(
        'UPDATE crypto_milestones SET last_price = $2, last_bucket = $3, last_posted_at = NOW(), updated_at = NOW() WHERE symbol = $1',
        [coin.symbol, price, bucket]
      );

      // Build chart image (null if anything fails — we post text-only in that case)
      const intraday = await getIntraday(coin.symbol);
      const chartBuffer = intraday
        ? await buildChartImage(coin, intraday, direction, milestone)
        : null;

      const take = await generateTake(coin, milestone, direction, price);
      const tweet = buildTweet(coin, milestone, direction, take);

      try {
        if (chartBuffer) {
          const mediaId = await twitter.v1.uploadMedia(chartBuffer, {
            mimeType: 'image/png',
          });
          await twitter.v2.tweet({ text: tweet, media: { media_ids: [mediaId] } });
          console.log(`${coin.symbol}: posted milestone alert with chart (${direction} ${fmt(milestone)})`);
        } else {
          await twitter.v2.tweet(tweet);
          console.log(`${coin.symbol}: posted milestone alert, text-only (${direction} ${fmt(milestone)})`);
        }
      } catch (err) {
        console.error(`${coin.symbol}: tweet failed (state already saved):`, err.message);
      }
    } catch (err) {
      console.error(`${coin.symbol}: error:`, err.message);
    }
  }

  await db.end();
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
  });
