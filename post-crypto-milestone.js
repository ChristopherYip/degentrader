// post-crypto-milestone.js
// "JUST IN" alerts when BTC crosses a $1,000 milestone or ETH crosses a $100 milestone.
// Runs every 5 minutes via Railway cron: */5 * * * *
// Creates its own DB table on first run. First run per coin records state silently (no post).

import pg from 'pg';
const { Client } = pg;
import { TwitterApi } from 'twitter-api-v2';
import fetch from 'node-fetch';

// ---------- Config ----------

const COINS = [
  { symbol: 'BTCUSD', name: 'Bitcoin', hashtag: '#Bitcoin', cashtag: '$BTC', step: 1000 },
  { symbol: 'ETHUSD', name: 'Ethereum', hashtag: '#Ethereum', cashtag: '$ETH', step: 100 },
];

const COOLDOWN_MINUTES = 120; // don't post about the same coin more than once per 2 hours

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

      // Cooldown check: swallow the cross silently to avoid whipsaw spam
      const lastPosted = prev.last_posted_at ? new Date(prev.last_posted_at) : null;
      const cooldownActive =
        lastPosted && (Date.now() - lastPosted.getTime()) / 60000 < COOLDOWN_MINUTES;

      if (cooldownActive) {
        await db.query(
          'UPDATE crypto_milestones SET last_price = $2, last_bucket = $3, updated_at = NOW() WHERE symbol = $1',
          [coin.symbol, price, bucket]
        );
        console.log(`${coin.symbol}: crossed milestone but cooldown active, skipping post.`);
        continue;
      }

      // Milestone crossed and cooldown clear
      const direction = bucket > prevBucket ? 'up' : 'down';
      const milestone = direction === 'up' ? bucket * coin.step : prevBucket * coin.step;

      // Save state BEFORE tweeting (missed alert beats duplicate posts)
      await db.query(
        'UPDATE crypto_milestones SET last_price = $2, last_bucket = $3, last_posted_at = NOW(), updated_at = NOW() WHERE symbol = $1',
        [coin.symbol, price, bucket]
      );

      const take = await generateTake(coin, milestone, direction, price);
      const tweet = buildTweet(coin, milestone, direction, take);

      try {
        await twitter.v2.tweet(tweet);
        console.log(`${coin.symbol}: posted milestone alert (${direction} ${fmt(milestone)})`);
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
