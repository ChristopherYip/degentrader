// post-crypto-milestone.js
// "JUST IN" alerts when BTC crosses a $1,000 milestone or ETH crosses a $100 milestone.
// Includes a 1-minute intraday chart image: green line if crossing up, red if crossing down,
// with a gold dashed line marking the milestone price.
// Runs every 5 minutes via Railway cron: */5 * * * *
//
// Anti-spam rules (tunable in Config below):
//   1. Buffer: price must be a set distance PAST the milestone before it counts
//   2. Min gap: at most one post per coin every MIN_GAP_MINUTES
//   3. Dedupe: same milestone + same direction won't repost within REPEAT_HOURS
// Blocked crosses are swallowed silently (no stale alerts later).

import pg from 'pg';
const { Client } = pg;
import { TwitterApi } from 'twitter-api-v2';
import fetch from 'node-fetch';

// ---------- Config ----------

const COINS = [
  { symbol: 'BTCUSD', name: 'Bitcoin', hashtag: '#Bitcoin', cashtag: '$BTC', step: 1000, buffer: 150 },
  { symbol: 'ETHUSD', name: 'Ethereum', hashtag: '#Ethereum', cashtag: '$ETH', step: 100, buffer: 15 },
];

const MIN_GAP_MINUTES = 180; // at most one post per coin every 3 hours
const REPEAT_HOURS = 24;     // same milestone+direction won't repost within 24h
const CHART_MINUTES = 120;   // how much intraday history to show on the chart

// Brand colors
const BG_NAVY = '#0a1628';
const GOLD = '#fbbf24';
const GREEN = '#22c55e';
const RED = '#ef4444';
const MUTED = '#94a3b8';

// Variety pools so back-to-back posts don't sound alike
const STYLE_ANGLES = [
  'rocket/space metaphor',
  'casino/poker metaphor',
  'sports/championship metaphor',
  'weather/storm metaphor',
  'gym/heavy-lifting metaphor',
  'street-racing/speed metaphor',
  'chess/strategy metaphor',
  'clearance-sale/shopping metaphor',
];

const FALLBACK_UP = [
  'Bulls are wide awake. Momentum looks hungry for the next level. 🚀',
  'Another level cleared like it was nothing. Eyes up. 📈',
  'The tape does not lie — buyers showed up in force.',
  'Resistance? Never heard of her. 🚀',
];

const FALLBACK_DOWN = [
  'Volatility is the price of admission. Degens call this a sale. 👀',
  'Red candles, calm hands. Some see pain, others see the discount rack.',
  'Chop happens. Tourists panic, degens window-shop. 🛒',
  'Gravity check. Weak hands out, patient hands watching. 👀',
];

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

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

async function generateTake(coin, milestone, direction, price, usedTakes = []) {
  const styleAngle = pick(STYLE_ANGLES);
  const angle =
    direction === 'up'
      ? `${coin.name} just broke above ${fmt(milestone)} (now ${fmt(price)}). Write a punchy, bullish 1-2 sentence take using a ${styleAngle}.`
      : `${coin.name} just slipped below ${fmt(milestone)} (now ${fmt(price)}). Write a cheeky, degen "buy the dip / discount season" style 1-2 sentence take using a ${styleAngle}. Playful, not doom-y.`;

  const avoidClause = usedTakes.length
    ? ` IMPORTANT: This account just posted the following, so your take must use completely different wording, imagery, and themes: ${usedTakes.map((t) => `"${t}"`).join(' | ')}`
    : '';

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
            content: `You write for @DegenTrader, a high-energy WallStreetBets-style crypto/stocks X account. ${angle} Max 140 characters. No hashtags, no cashtags, no quotes around the text, no emojis at the start. Do not give financial advice or tell people to buy/sell.${avoidClause}`,
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

  // Randomized fallbacks if the API call fails
  return direction === 'up' ? pick(FALLBACK_UP) : pick(FALLBACK_DOWN);
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
  await db.query(`ALTER TABLE crypto_milestones ADD COLUMN IF NOT EXISTS last_posted_milestone NUMERIC`);
  await db.query(`ALTER TABLE crypto_milestones ADD COLUMN IF NOT EXISTS last_posted_direction TEXT`);

  const usedTakes = [];

  for (const coin of COINS) {
    try {
      const price = await getPrice(coin.symbol);
      console.log(`${coin.symbol}: price ${fmt(price)}`);

      const { rows } = await db.query(
        'SELECT last_price, last_bucket, last_posted_at, last_posted_milestone, last_posted_direction FROM crypto_milestones WHERE symbol = $1',
        [coin.symbol]
      );

      // First run for this coin: record state, don't post
      if (rows.length === 0) {
        await db.query(
          'INSERT INTO crypto_milestones (symbol, last_price, last_bucket) VALUES ($1, $2, $3)',
          [coin.symbol, price, Math.floor(price / coin.step)]
        );
        console.log(`${coin.symbol}: first run, state recorded, no post.`);
        continue;
      }

      const prev = rows[0];
      const prevBucket = Number(prev.last_bucket);

      // Buffered cross detection: price must be `buffer` dollars PAST the line to count
      const upBucket = Math.floor((price - coin.buffer) / coin.step);
      const downBucket = Math.floor((price + coin.buffer) / coin.step);

      let direction = null;
      let newBucket = prevBucket;
      let milestone = null;

      if (upBucket > prevBucket) {
        direction = 'up';
        newBucket = upBucket;
        milestone = upBucket * coin.step;
      } else if (downBucket < prevBucket) {
        direction = 'down';
        newBucket = downBucket;
        milestone = (downBucket + 1) * coin.step;
      }

      // No confirmed cross: refresh price only (bucket stays put so a later cross can fire)
      if (!direction) {
        await db.query(
          'UPDATE crypto_milestones SET last_price = $2, updated_at = NOW() WHERE symbol = $1',
          [coin.symbol, price]
        );
        continue;
      }

      // Anti-spam checks
      const lastPosted = prev.last_posted_at ? new Date(prev.last_posted_at) : null;
      const minsSincePost = lastPosted ? (Date.now() - lastPosted.getTime()) / 60000 : Infinity;
      const gapBlocked = minsSincePost < MIN_GAP_MINUTES;
      const dedupeBlocked =
        Number(prev.last_posted_milestone) === milestone &&
        prev.last_posted_direction === direction &&
        minsSincePost < REPEAT_HOURS * 60;

      if (gapBlocked || dedupeBlocked) {
        // Swallow the cross silently: update state so it won't fire later as a stale alert
        await db.query(
          'UPDATE crypto_milestones SET last_price = $2, last_bucket = $3, updated_at = NOW() WHERE symbol = $1',
          [coin.symbol, price, newBucket]
        );
        console.log(
          `${coin.symbol}: crossed ${direction} ${fmt(milestone)} but skipped (${gapBlocked ? 'min gap' : 'same milestone within 24h'}).`
        );
        continue;
      }

      // Save state BEFORE tweeting (missed alert beats duplicate posts)
      await db.query(
        `UPDATE crypto_milestones
         SET last_price = $2, last_bucket = $3, last_posted_at = NOW(),
             last_posted_milestone = $4, last_posted_direction = $5, updated_at = NOW()
         WHERE symbol = $1`,
        [coin.symbol, price, newBucket, milestone, direction]
      );

      // Build chart image (null if anything fails — we post text-only in that case)
      const intraday = await getIntraday(coin.symbol);
      const chartBuffer = intraday
        ? await buildChartImage(coin, intraday, direction, milestone)
        : null;

      const take = await generateTake(coin, milestone, direction, price, usedTakes);
      usedTakes.push(take);
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
