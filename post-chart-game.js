// post-chart-game.js
// Guess the Chart game for @DailyBrainDrop
// - Posts an unlabeled 6-month price chart of a mystery stock
// - Immediately replies with a native X poll (4 company options, 120 min)
// - Reveals the answer in a reply 2 hours later
// Runs on the same */15 cron as your other scripts. Safe to run every tick:
// it only posts inside its UTC slots and only answers when a game is due.

import { TwitterApi } from 'twitter-api-v2';
import pg from 'pg';
const { Client } = pg;

// ============ CONFIG ============

// UTC posting slots (hour, minute). Matches your +/-30 min window pattern.
const POST_SLOTS_UTC = [
  { hour: 3, minute: 30 },   // Asia prime time
  { hour: 12, minute: 30 },  // EU afternoon + US premarket overlap
];
const SLOT_WINDOW_MINUTES = 30;      // +/- window around each slot
const ANSWER_DELAY_HOURS = 2;        // reveal answer 2h after posting
const CHART_DAYS = 180;              // ~6 months of price history

// Ticker pool: US-listed symbols only (your FMP plan blocks native
// international tickers like 7203.T, but ADRs work fine and still
// give global coverage). Region is used to pick harder decoys.
const TICKERS = [
  // US
  { symbol: 'AAPL', name: 'Apple', region: 'US' },
  { symbol: 'TSLA', name: 'Tesla', region: 'US' },
  { symbol: 'NVDA', name: 'Nvidia', region: 'US' },
  { symbol: 'MSFT', name: 'Microsoft', region: 'US' },
  { symbol: 'AMZN', name: 'Amazon', region: 'US' },
  { symbol: 'META', name: 'Meta', region: 'US' },
  { symbol: 'GOOGL', name: 'Google', region: 'US' },
  { symbol: 'NFLX', name: 'Netflix', region: 'US' },
  { symbol: 'DIS', name: 'Disney', region: 'US' },
  { symbol: 'KO', name: 'Coca-Cola', region: 'US' },
  { symbol: 'MCD', name: "McDonald's", region: 'US' },
  { symbol: 'NKE', name: 'Nike', region: 'US' },
  { symbol: 'SBUX', name: 'Starbucks', region: 'US' },
  { symbol: 'AMD', name: 'AMD', region: 'US' },
  { symbol: 'UBER', name: 'Uber', region: 'US' },
  { symbol: 'ABNB', name: 'Airbnb', region: 'US' },
  // Japan (ADRs)
  { symbol: 'TM', name: 'Toyota', region: 'Asia' },
  { symbol: 'SONY', name: 'Sony', region: 'Asia' },
  { symbol: 'HMC', name: 'Honda', region: 'Asia' },
  { symbol: 'MUFG', name: 'Mitsubishi UFJ', region: 'Asia' },
  // China / HK (ADRs)
  { symbol: 'BABA', name: 'Alibaba', region: 'Asia' },
  { symbol: 'JD', name: 'JD.com', region: 'Asia' },
  { symbol: 'BIDU', name: 'Baidu', region: 'Asia' },
  { symbol: 'NIO', name: 'NIO', region: 'Asia' },
  // Taiwan / Korea / SG (ADRs & US listings)
  { symbol: 'TSM', name: 'TSMC', region: 'Asia' },
  { symbol: 'CPNG', name: 'Coupang', region: 'Asia' },
  { symbol: 'SE', name: 'Sea Limited', region: 'Asia' },
  { symbol: 'GRAB', name: 'Grab', region: 'Asia' },
  // UK / EU (ADRs)
  { symbol: 'SHEL', name: 'Shell', region: 'Europe' },
  { symbol: 'HSBC', name: 'HSBC', region: 'Europe' },
  { symbol: 'AZN', name: 'AstraZeneca', region: 'Europe' },
  { symbol: 'ASML', name: 'ASML', region: 'Europe' },
  { symbol: 'SAP', name: 'SAP', region: 'Europe' },
  { symbol: 'NVO', name: 'Novo Nordisk', region: 'Europe' },
  { symbol: 'SPOT', name: 'Spotify', region: 'Europe' },
];

// Brand palette
const CHART_LINE_COLOR = '#FF6B6B';       // coral
const CHART_FILL_COLOR = 'rgba(255,107,107,0.12)';
const CHART_BG_COLOR = '#FFF9E6';         // soft yellow

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

function inPostingWindow(now = new Date()) {
  const minutesNow = now.getUTCHours() * 60 + now.getUTCMinutes();
  return POST_SLOTS_UTC.some((slot) => {
    const slotMinutes = slot.hour * 60 + slot.minute;
    return Math.abs(minutesNow - slotMinutes) <= SLOT_WINDOW_MINUTES;
  });
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Pick 3 decoys, preferring the same region so the poll is a real challenge
function pickDecoys(answer) {
  const sameRegion = TICKERS.filter(
    (t) => t.symbol !== answer.symbol && t.region === answer.region
  );
  const others = TICKERS.filter(
    (t) => t.symbol !== answer.symbol && t.region !== answer.region
  );
  const pool = shuffle(sameRegion);
  const decoys = pool.slice(0, 3);
  const filler = shuffle(others);
  while (decoys.length < 3 && filler.length) decoys.push(filler.pop());
  return decoys;
}

async function fetchPriceHistory(symbol) {
  const to = new Date();
  const from = new Date(to.getTime() - CHART_DAYS * 24 * 60 * 60 * 1000);
  const fmt = (d) => d.toISOString().slice(0, 10);
  const url =
    `https://financialmodelingprep.com/stable/historical-price-eod/light` +
    `?symbol=${encodeURIComponent(symbol)}&from=${fmt(from)}&to=${fmt(to)}` +
    `&apikey=${process.env.FMP_API_KEY}`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`FMP ${res.status} for ${symbol}`);
  const data = await res.json();
  if (!Array.isArray(data) || data.length < 30) {
    throw new Error(`Not enough price data for ${symbol}`);
  }
  // FMP returns newest-first; flip to oldest-first for charting
  return data.reverse().map((d) => d.price);
}

// Build a fully unlabeled chart image via QuickChart (free, no key needed)
async function generateChartImage(prices) {
  const chartConfig = {
    type: 'line',
    data: {
      labels: prices.map(() => ''),
      datasets: [
        {
          data: prices,
          borderColor: CHART_LINE_COLOR,
          backgroundColor: CHART_FILL_COLOR,
          borderWidth: 3,
          pointRadius: 0,
          fill: true,
          tension: 0.15,
        },
      ],
    },
    options: {
      plugins: { legend: { display: false }, title: { display: false } },
      scales: {
        x: { display: false },
        y: { display: false }, // hide prices too — no free hints!
      },
    },
  };

  const res = await fetch('https://quickchart.io/chart', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chart: chartConfig,
      width: 800,
      height: 450,
      format: 'png',
      backgroundColor: CHART_BG_COLOR,
      version: '4',
    }),
  });
  if (!res.ok) throw new Error(`QuickChart error ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

function percentChange(prices) {
  const first = prices[0];
  const last = prices[prices.length - 1];
  return (((last - first) / first) * 100).toFixed(1);
}

// ============ POST A NEW GAME ============

async function maybePostNewGame(db) {
  if (!inPostingWindow()) {
    console.log('Not in a chart-game posting window. Skipping post.');
    return;
  }

  // Dedup guard: don't double-post within the same window
  const recent = await db.query(
    `SELECT id FROM chart_games WHERE posted_at > NOW() - INTERVAL '90 minutes'`
  );
  if (recent.rows.length > 0) {
    console.log('Chart game already posted this window. Skipping.');
    return;
  }

  // Avoid repeating any stock used in the last 14 days
  const recentSymbols = await db.query(
    `SELECT symbol FROM chart_games WHERE posted_at > NOW() - INTERVAL '14 days'`
  );
  const used = new Set(recentSymbols.rows.map((r) => r.symbol));
  const available = TICKERS.filter((t) => !used.has(t.symbol));
  const answer = pickRandom(available.length ? available : TICKERS);

  console.log(`Posting chart game: ${answer.name} (${answer.symbol})`);

  const prices = await fetchPriceHistory(answer.symbol);
  const imageBuffer = await generateChartImage(prices);

  const mediaId = await twitterClient.v1.uploadMedia(imageBuffer, {
    mimeType: 'image/png',
  });

  const questionText =
    `🧠📈 GUESS THE CHART\n\n` +
    `This is a well-known company's stock over the last 6 months.\n\n` +
    `Can you name it? Vote in the poll below 👇\n` +
    `Answer drops in 2 hours!`;

  const question = await twitterClient.v2.tweet({
    text: questionText,
    media: { media_ids: [mediaId] },
  });
  const questionId = question.data.id;
  console.log(`Chart posted: ${questionId}`);

  // Poll reply with shuffled options (poll options max 25 chars)
  const options = shuffle([answer, ...pickDecoys(answer)]).map((t) =>
    t.name.slice(0, 25)
  );
  await twitterClient.v2.reply(
    `Which company is it? 🤔`,
    questionId,
    { poll: { options, duration_minutes: 120 } }
  );
  console.log('Poll reply posted.');

  await db.query(
    `INSERT INTO chart_games (tweet_id, symbol, company, pct_change, posted_at, answered)
     VALUES ($1, $2, $3, $4, NOW(), FALSE)`,
    [questionId, answer.symbol, answer.name, percentChange(prices)]
  );
  console.log('Game saved to database.');
}

// ============ ANSWER DUE GAMES ============

async function answerDueGames(db) {
  const due = await db.query(
    `SELECT id, tweet_id, symbol, company, pct_change
     FROM chart_games
     WHERE answered = FALSE
       AND posted_at < NOW() - INTERVAL '${ANSWER_DELAY_HOURS} hours'`
  );

  for (const game of due.rows) {
    const direction = parseFloat(game.pct_change) >= 0 ? '📈 up' : '📉 down';
    const answerText =
      `⏰ ANSWER TIME!\n\n` +
      `The mystery chart was... ${game.company} ($${game.symbol})! 🎉\n\n` +
      `It's ${direction} ${Math.abs(parseFloat(game.pct_change))}% over the last 6 months.\n\n` +
      `Did you get it? Drop a 🧠 if you nailed it!`;

    try {
      await twitterClient.v2.reply(answerText, game.tweet_id);
      await db.query(`UPDATE chart_games SET answered = TRUE WHERE id = $1`, [
        game.id,
      ]);
      console.log(`Answer posted for ${game.company} (game ${game.id}).`);
    } catch (err) {
      console.error(`Failed to answer game ${game.id}:`, err.message);
    }
  }

  if (due.rows.length === 0) console.log('No chart-game answers due.');
}

// ============ MAIN ============

async function main() {
  const db = newDbClient();
  await db.connect();

  await db.query(`
    CREATE TABLE IF NOT EXISTS chart_games (
      id SERIAL PRIMARY KEY,
      tweet_id TEXT NOT NULL,
      symbol TEXT NOT NULL,
      company TEXT NOT NULL,
      pct_change TEXT,
      posted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      answered BOOLEAN NOT NULL DEFAULT FALSE
    )
  `);

  try {
    await answerDueGames(db); // answers first — never blocked by post errors
    await maybePostNewGame(db);
  } catch (err) {
    console.error('Chart game error:', err.message);
  } finally {
    await db.end();
  }
}

main();
