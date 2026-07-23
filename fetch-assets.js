// fetch-assets.js (v3)
// - Logos:  FMP logo CDN direct URLs (no key, no quota)
// - CEOs:   hardcoded name map -> BATCHED Wikipedia pageimages (50 titles/call)
//           -> throttled downloads with Retry-After-aware backoff
// - No FMP API usage at all.
// Resumable: skips existing files. Outputs assets/manifest.json + assets/misses.txt

import { mkdir, writeFile, appendFile, access } from 'node:fs/promises';
import path from 'node:path';

// ============ CONFIG ============
const CEO_IMAGE_WIDTH = 800;
const ASSETS_DIR = 'assets';
const DOWNLOAD_DELAY_MS = 1500;  // between image downloads (be gentle to upload.wikimedia.org)
const BATCH_DELAY_MS = 2000;     // between batched API calls
const MAX_RETRIES = 3;
const UA = 'DegenTraderAssetFetch/3.0 (github.com/ChristopherYip/degentrader)';

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

// Tickers that CANNOT be auto-fetched safely — ambiguous names or no Wikipedia page.
// Source headshots manually from the company's leadership/press page.
const MANUAL_TICKERS = {
  SPCX: 'ETF — no CEO (verify this ticker belongs on an earnings watchlist)',
  WEN:  'Bob Wright (CEO since May 2026) — "Bob Wright" on Wikipedia is the NBC exec; use wendys.com press page',
  SMR:  'John Hopkins — name collides with Johns Hopkins; use nuscalepower.com leadership page',
  CLSK: 'Matt Schultz — name collides with Iowa politician; use cleanspark.com management page',
  MRVL: 'Matt Murphy — no unambiguous Wikipedia article; use marvell.com leadership page',
};

// Ticker -> exact Wikipedia article title for the CEO.
const CEO_NAMES = {
  NVDA: 'Jensen Huang', TSLA: 'Elon Musk', PLTR: 'Alex Karp', AAPL: 'Tim Cook',
  MSFT: 'Satya Nadella', AMZN: 'Andy Jassy', GOOGL: 'Sundar Pichai',
  META: 'Mark Zuckerberg', NFLX: 'Ted Sarandos',
  AMD: 'Lisa Su', AVGO: 'Hock Tan', MU: 'Sanjay Mehrotra',
  NOW: 'Bill McDermott', ORCL: 'Clay Magouyrk', // co-CEO w/ Mike Sicilia — VERIFY
  CRM: 'Marc Benioff', SMCI: 'Charles Liang', ARM: 'Rene Haas', TSM: 'C. C. Wei',
  ASML: 'Christophe Fouquet', COIN: 'Brian Armstrong', HOOD: 'Vlad Tenev',
  MSTR: 'Phong Le', RDDT: 'Steve Huffman', ASTS: 'Abel Avellan',
  RKLB: 'Peter Beck', NBIS: 'Arkady Volozh', CRWV: 'Michael Intrator',
  APP: 'Adam Foroughi', GME: 'Ryan Cohen', AMC: 'Adam Aron',
  SOFI: 'Anthony Noto', IONQ: 'Niccolo de Masi', RGTI: 'Subodh Kulkarni',
  QBTS: 'Alan Baratz', OKLO: 'Jacob DeWitte', HIMS: 'Andrew Dudum',
  TEM: 'Eric Lefkofsky', CRCL: 'Jeremy Allaire', FIG: 'Dylan Field',
  CVNA: 'Ernie Garcia III', AFRM: 'Max Levchin', UPST: 'Dave Girouard',
  MARA: 'Fred Thiel', RIOT: 'Jason Les', SOUN: 'Keyvan Mohajer',
  BBAI: 'Kevin McAleenan', ACHR: 'Adam Goldstein', JOBY: 'JoeBen Bevirt',
  LUNR: 'Steve Altemus', POET: 'Suresh Venkatesan', PATH: 'Daniel Dines',
  DKNG: 'Jason Robins', RBLX: 'David Baszucki', U: 'Matthew Bromberg',
  SNAP: 'Evan Spiegel', PINS: 'Bill Ready',
  SPOT: 'Gustav S\u00f6derstr\u00f6m', // co-CEO w/ Alex Norstr\u00f6m — VERIFY
  ROKU: 'Anthony Wood', VRT: 'Giordano Albertazzi', ANET: 'Jayshree Ullal',
  DELL: 'Michael Dell', SNOW: 'Sridhar Ramaswamy', CRWD: 'George Kurtz',
  PANW: 'Nikesh Arora', NET: 'Matthew Prince', DDOG: 'Olivier Pomel',
  MDB: 'Dev Ittycheria', LRCX: 'Tim Archer', AMAT: 'Gary Dickerson',
  KLAC: 'Rick Wallace', INTC: 'Lip-Bu Tan', QCOM: 'Cristiano Amon',
  TXN: 'Haviv Ilan', IBM: 'Arvind Krishna', ADBE: 'Shantanu Narayen',
  SHOP: 'Tobias L\u00fctke', UBER: 'Dara Khosrowshahi', LYFT: 'David Risher',
  ABNB: 'Brian Chesky', DASH: 'Tony Xu', ZM: 'Eric Yuan', PYPL: 'Alex Chriss',
  XYZ: 'Jack Dorsey', TTD: 'Jeff Green', DUOL: 'Luis von Ahn',
  AXON: 'Rick Smith (Axon)', RIVN: 'RJ Scaringe', LCID: 'Silvio Napoli',
  NIO: 'Li Bin', F: 'Jim Farley', GM: 'Mary Barra', BA: 'Kelly Ortberg',
  GE: 'Larry Culp', GEV: 'Scott Strazik', CAT: 'Joe Creed', VST: 'Jim Burke',
  CEG: 'Joe Dominguez', JPM: 'Jamie Dimon', GS: 'David Solomon',
  MS: 'Ted Pick', BAC: 'Brian Moynihan', V: 'Ryan McInerney',
  MA: 'Michael Miebach', BABA: 'Eddie Wu', JD: 'Xu Ran', PDD: 'Chen Lei',
  DIS: 'Bob Iger', WMT: 'John Furner', COST: 'Ron Vachris',
  TGT: 'Michael Fiddelke', HD: 'Ted Decker', SBUX: 'Brian Niccol',
  CMG: 'Scott Boatwright', NKE: 'Elliott Hill', LULU: 'Calvin McDonald',
  CELH: 'John Fieldly', ELF: 'Tarang Amin', LLY: 'David A. Ricks',
  UNH: 'Stephen Hemsley', NVO: 'Mike Doustdar', MRNA: 'St\u00e9phane Bancel',
  XOM: 'Darren Woods', DAL: 'Ed Bastian', UAL: 'Scott Kirby',
};
// ================================

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const exists = (p) => access(p).then(() => true, () => false);

function sniffExt(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpg';
  if (buf[0] === 0x47 && buf[1] === 0x49) return 'gif';
  if (buf.slice(0, 4).toString() === 'RIFF') return 'webp';
  return null;
}

// fetch with retry/backoff; honors Retry-After on 429/503.
async function fetchWithRetry(url, opts = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, { ...opts, headers: { 'user-agent': UA, ...(opts.headers || {}) } });
      if (res.status === 429 || res.status === 503) {
        const ra = parseInt(res.headers.get('retry-after') || '0', 10);
        const wait = ra > 0 ? ra * 1000 : Math.min(5000 * 3 ** attempt, 60000);
        console.warn(`  ${res.status} from ${new URL(url).host} — waiting ${Math.round(wait / 1000)}s (attempt ${attempt + 1}/${MAX_RETRIES + 1})`);
        await sleep(wait);
        lastErr = new Error(`HTTP ${res.status}`);
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      await sleep(3000 * (attempt + 1));
    }
  }
  throw lastErr;
}

async function downloadImage(url, destBase) {
  const res = await fetchWithRetry(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const ext = sniffExt(buf);
  if (!ext) throw new Error(`Unrecognized image bytes from ${url}`);
  const dest = `${destBase}.${ext}`;
  await writeFile(dest, buf);
  return dest;
}

async function downloadLogo(symbol, destBase) {
  const candidates = [
    `https://images.financialmodelingprep.com/symbol/${symbol}.png`,
    `https://financialmodelingprep.com/image-stock/${symbol}.png`,
  ];
  let lastErr;
  for (const url of candidates) {
    try { return await downloadImage(url, destBase); }
    catch (err) { lastErr = err; }
  }
  throw lastErr;
}

// Batch: up to 50 titles per API call -> Map(requestedTitle -> imageUrl|null)
async function wikiBatchImages(titles) {
  const result = new Map();
  for (let i = 0; i < titles.length; i += 50) {
    const chunk = titles.slice(i, i + 50);
    const params = new URLSearchParams({
      action: 'query', format: 'json', redirects: '1', maxlag: '5',
      prop: 'pageimages', pilimit: 'max', pithumbsize: String(CEO_IMAGE_WIDTH),
      titles: chunk.join('|'), origin: '*',
    });
    const res = await fetchWithRetry(`https://en.wikipedia.org/w/api.php?${params}`);
    if (!res.ok) throw new Error(`Wikipedia API HTTP ${res.status}`);
    const json = await res.json();
    const q = json?.query || {};

    // requested title -> final title, via normalized + redirects chains
    const normalized = new Map((q.normalized || []).map((n) => [n.from, n.to]));
    const redirects = new Map((q.redirects || []).map((r) => [r.from, r.to]));
    const pagesByTitle = new Map(Object.values(q.pages || {}).map((p) => [p.title, p]));

    for (const requested of chunk) {
      let t = normalized.get(requested) || requested;
      const seen = new Set();
      while (redirects.has(t) && !seen.has(t)) { seen.add(t); t = redirects.get(t); }
      const page = pagesByTitle.get(t);
      const missing = !page || page.missing !== undefined;
      result.set(requested, missing ? null : (page.thumbnail?.source || null));
    }
    if (i + 50 < titles.length) await sleep(BATCH_DELAY_MS);
  }
  return result;
}

async function main() {
  const logosDir = path.join(ASSETS_DIR, 'logos');
  const ceosDir = path.join(ASSETS_DIR, 'ceos');
  await mkdir(logosDir, { recursive: true });
  await mkdir(ceosDir, { recursive: true });

  const missLog = path.join(ASSETS_DIR, 'misses.txt');
  const manifest = {};

  // ---- Phase 1: logos (no quota, no throttling issues) ----
  for (const symbol of WATCHLIST) {
    const logoBase = path.join(logosDir, symbol);
    if ((await exists(`${logoBase}.png`)) || (await exists(`${logoBase}.jpg`))) continue;
    try {
      const dest = await downloadLogo(symbol, logoBase);
      console.log(`[${symbol}] logo -> ${dest}`);
    } catch (err) {
      console.error(`[${symbol}] logo failed: ${err.message}`);
      await appendFile(missLog, `${symbol}\tLOGO\t${err.message}\n`);
    }
    await sleep(400);
  }

  // ---- Phase 2: figure out which CEO photos are still needed ----
  const needed = []; // { symbol, title }
  for (const symbol of WATCHLIST) {
    const ceoBase = path.join(ceosDir, symbol);
    if ((await exists(`${ceoBase}.jpg`)) || (await exists(`${ceoBase}.png`))) continue;
    if (MANUAL_TICKERS[symbol]) {
      await appendFile(missLog, `${symbol}\tCEO\tMANUAL: ${MANUAL_TICKERS[symbol]}\n`);
      continue;
    }
    const title = CEO_NAMES[symbol];
    if (!title) {
      await appendFile(missLog, `${symbol}\tCEO\tnot in CEO_NAMES map\n`);
      continue;
    }
    needed.push({ symbol, title });
  }
  console.log(`\nCEO photos needed: ${needed.length} (${Math.ceil(needed.length / 50)} batched API calls)`);

  // ---- Phase 3: batch-resolve titles -> image URLs ----
  const urlByTitle = needed.length
    ? await wikiBatchImages(needed.map((n) => n.title))
    : new Map();

  // ---- Phase 4: throttled downloads ----
  for (const { symbol, title } of needed) {
    const imgUrl = urlByTitle.get(title);
    if (!imgUrl) {
      console.warn(`[${symbol}] no Wikipedia image for "${title}"`);
      await appendFile(missLog, `${symbol}\tCEO\tno Wikipedia image for "${title}"\n`);
      continue;
    }
    try {
      const dest = await downloadImage(imgUrl, path.join(ceosDir, symbol));
      console.log(`[${symbol}] CEO (${title}) -> ${dest}`);
      manifest[symbol] = {
        ceo: title,
        ceoImageSource: imgUrl,
        license: 'Wikimedia Commons — verify per-file license before commercial reuse',
      };
    } catch (err) {
      console.error(`[${symbol}] CEO download failed: ${err.message}`);
      await appendFile(missLog, `${symbol}\tCEO\t${err.message}\n`);
    }
    await sleep(DOWNLOAD_DELAY_MS);
  }

  await writeFile(path.join(ASSETS_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log('\nDone. Check assets/misses.txt for gaps (MANUAL entries need hand-sourcing).');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
