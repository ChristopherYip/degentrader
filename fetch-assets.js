// fetch-assets.js (v2)
// Asset sourcing with near-zero FMP usage:
// - Logos:  FMP logo CDN direct URLs (no API key, no quota)  -> assets/logos/TICKER.png
// - CEOs:   hardcoded name map -> Wikipedia pageimage        -> assets/ceos/TICKER.jpg
//           (FMP profile used ONLY for tickers missing from the map,
//            with a circuit breaker after 3 consecutive 429s)
// Resumable: skips any file that already exists.
// Outputs:  assets/manifest.json, assets/misses.txt

import { mkdir, writeFile, appendFile, access } from 'node:fs/promises';
import path from 'node:path';

// ============ CONFIG ============
const FMP_API_KEY = process.env.FMP_API_KEY; // only needed for map-fallback tickers
const WIKI_DELAY_MS = 250;
const CEO_IMAGE_WIDTH = 800;
const ASSETS_DIR = 'assets';
const FMP_429_BREAKER = 3; // consecutive 429s before giving up on FMP for the run

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

// Ticker -> Wikipedia article title for the CEO.
// VERIFY the flagged ones — CEO seats churn. Tickers NOT in this map fall back to FMP.
// SPCX intentionally absent: it's an ETF, no CEO (check whether it belongs on the watchlist).
const CEO_NAMES = {
  NVDA: 'Jensen Huang', TSLA: 'Elon Musk', PLTR: 'Alex Karp', AAPL: 'Tim Cook',
  MSFT: 'Satya Nadella', AMZN: 'Andy Jassy', GOOGL: 'Sundar Pichai',
  META: 'Mark Zuckerberg', NFLX: 'Ted Sarandos', // co-CEO w/ Greg Peters
  AMD: 'Lisa Su', AVGO: 'Hock Tan', MU: 'Sanjay Mehrotra', MRVL: 'Matt Murphy',
  NOW: 'Bill McDermott', ORCL: 'Clay Magouyrk', // co-CEO w/ Mike Sicilia — VERIFY
  CRM: 'Marc Benioff', SMCI: 'Charles Liang', ARM: 'Rene Haas', TSM: 'C. C. Wei',
  ASML: 'Christophe Fouquet', COIN: 'Brian Armstrong', HOOD: 'Vlad Tenev',
  MSTR: 'Michael Saylor', // CEO; Michael Saylor is exec chairman — swap if you want the face
  RDDT: 'Steve Huffman', ASTS: 'Abel Avellan', RKLB: 'Peter Beck',
  NBIS: 'Arkady Volozh', CRWV: 'Michael Intrator', APP: 'Adam Foroughi',
  GME: 'Ryan Cohen', AMC: 'Adam Aron', SOFI: 'Anthony Noto',
  IONQ: 'Niccolo de Masi', RGTI: 'Subodh Kulkarni', QBTS: 'Alan Baratz',
  OKLO: 'Jacob DeWitte', HIMS: 'Andrew Dudum', TEM: 'Eric Lefkofsky',
  CRCL: 'Jeremy Allaire', FIG: 'Dylan Field', CVNA: 'Ernie Garcia III',
  AFRM: 'Max Levchin', UPST: 'Dave Girouard', MARA: 'Fred Thiel',
  RIOT: 'Jason Les', SOUN: 'Keyvan Mohajer',
  BBAI: 'Kevin McAleenan', ACHR: 'Adam Goldstein', JOBY: 'JoeBen Bevirt',
  LUNR: 'Steve Altemus', POET: 'Suresh Venkatesan', PATH: 'Daniel Dines',
  DKNG: 'Jason Robins', RBLX: 'David Baszucki', U: 'Matthew Bromberg',
  SNAP: 'Evan Spiegel', PINS: 'Bill Ready',
  SPOT: 'Gustav Söderström', // co-CEO w/ Alex Norstr\u00f6m; Ek is chairman — VERIFY
  ROKU: 'Anthony Wood', VRT: 'Giordano Albertazzi', ANET: 'Jayshree Ullal',
  DELL: 'Michael Dell', SNOW: 'Sridhar Ramaswamy', CRWD: 'George Kurtz',
  PANW: 'Nikesh Arora', NET: 'Matthew Prince', DDOG: 'Olivier Pomel',
  MDB: 'Dev Ittycheria', LRCX: 'Tim Archer', AMAT: 'Gary Dickerson',
  KLAC: 'Rick Wallace', INTC: 'Lip-Bu Tan', QCOM: 'Cristiano Amon',
  TXN: 'Haviv Ilan', IBM: 'Arvind Krishna', ADBE: 'Shantanu Narayen',
  SHOP: 'Tobias Lutke', UBER: 'Dara Khosrowshahi', LYFT: 'David Risher',
  ABNB: 'Brian Chesky', DASH: 'Tony Xu', ZM: 'Eric Yuan', PYPL: 'Alex Chriss',
  XYZ: 'Jack Dorsey', TTD: 'Jeff Green', DUOL: 'Luis von Ahn',
  AXON: 'Rick Smith (Axon)', RIVN: 'RJ Scaringe', NIO: 'Li Bin',
  F: 'Jim Farley', GM: 'Mary Barra', BA: 'Kelly Ortberg', GE: 'Larry Culp',
  GEV: 'Scott Strazik', CAT: 'Joe Creed', VST: 'Jim Burke',
  CEG: 'Joe Dominguez', JPM: 'Jamie Dimon', GS: 'David Solomon',
  MS: 'Ted Pick', BAC: 'Brian Moynihan', V: 'Ryan McInerney',
  MA: 'Michael Miebach', BABA: 'Eddie Wu', JD: 'Xu Ran', PDD: 'Chen Lei',
  DIS: 'Bob Iger', WMT: 'John Furner', // took over Feb 2026 — VERIFY
  COST: 'Ron Vachris', TGT: 'Michael Fiddelke', // took over Feb 2026 — VERIFY
  HD: 'Ted Decker', SBUX: 'Brian Niccol', CMG: 'Scott Boatwright',
  NKE: 'Elliott Hill', LULU: 'Calvin McDonald', CELH: 'John Fieldly',
  ELF: 'Tarang Amin', LLY: 'David A. Ricks', UNH: 'Stephen Hemsley',
  NVO: 'Mike Doustdar', MRNA: 'Stephane Bancel', XOM: 'Darren Woods',
  DAL: 'Ed Bastian', UAL: 'Scott Kirby',
  // Intentionally omitted (recent turnover / uncertain — will fall back to FMP):
  // WEN, SMR, CLSK, LCID
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

async function downloadImage(url, destBase) {
  const res = await fetch(url, { headers: { 'user-agent': 'DegenTraderAssetFetch/2.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const ext = sniffExt(buf);
  if (!ext) throw new Error(`Unrecognized image bytes from ${url}`);
  const dest = `${destBase}.${ext}`;
  await writeFile(dest, buf);
  return dest;
}

// Logo via FMP's public image CDN — no API key, no quota. Two URL patterns.
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

function cleanCeoName(raw) {
  if (!raw) return null;
  let name = raw.split(',')[0];
  name = name.replace(/\b(Mr|Mrs|Ms|Dr|Prof)\.?\s+/gi, '');
  name = name.replace(/\s+(Jr|Sr|II|III|IV)\.?$/i, '');
  return name.trim() || null;
}

let fmpConsecutive429 = 0;
let fmpDisabled = false;

async function fmpCeoName(symbol) {
  if (fmpDisabled || !FMP_API_KEY) return null;
  const url = `https://financialmodelingprep.com/stable/profile?symbol=${symbol}&apikey=${FMP_API_KEY}`;
  const res = await fetch(url);
  if (res.status === 429) {
    fmpConsecutive429++;
    if (fmpConsecutive429 >= FMP_429_BREAKER) {
      fmpDisabled = true;
      console.warn('FMP circuit breaker tripped — skipping FMP for the rest of this run.');
    }
    throw new Error('HTTP 429');
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  fmpConsecutive429 = 0;
  const json = await res.json();
  const row = Array.isArray(json) ? json[0] : json;
  return cleanCeoName(row?.ceo);
}

async function wikiPageImage(title) {
  const params = new URLSearchParams({
    action: 'query', format: 'json', redirects: '1',
    prop: 'pageimages', pithumbsize: String(CEO_IMAGE_WIDTH),
    titles: title, origin: '*',
  });
  const res = await fetch(`https://en.wikipedia.org/w/api.php?${params}`, {
    headers: { 'user-agent': 'DegenTraderAssetFetch/2.0' },
  });
  if (!res.ok) throw new Error(`Wikipedia API HTTP ${res.status}`);
  const json = await res.json();
  const page = Object.values(json?.query?.pages || {})[0];
  if (!page || page.missing !== undefined) return null;
  return page.thumbnail?.source || null;
}

async function wikiSearchImage(name) {
  const params = new URLSearchParams({
    action: 'query', format: 'json', list: 'search',
    srsearch: `${name} chief executive`, srlimit: '1', origin: '*',
  });
  const res = await fetch(`https://en.wikipedia.org/w/api.php?${params}`, {
    headers: { 'user-agent': 'DegenTraderAssetFetch/2.0' },
  });
  if (!res.ok) return null;
  const json = await res.json();
  const hit = json?.query?.search?.[0]?.title;
  if (!hit) return null;
  await sleep(WIKI_DELAY_MS);
  const img = await wikiPageImage(hit);
  return img ? { img, matchedTitle: hit } : null;
}

async function main() {
  const logosDir = path.join(ASSETS_DIR, 'logos');
  const ceosDir = path.join(ASSETS_DIR, 'ceos');
  await mkdir(logosDir, { recursive: true });
  await mkdir(ceosDir, { recursive: true });

  const missLog = path.join(ASSETS_DIR, 'misses.txt');
  const manifest = {};

  for (const symbol of WATCHLIST) {
    const logoBase = path.join(logosDir, symbol);
    const ceoBase = path.join(ceosDir, symbol);
    const haveLogo = (await exists(`${logoBase}.png`)) || (await exists(`${logoBase}.jpg`));
    const haveCeo = (await exists(`${ceoBase}.jpg`)) || (await exists(`${ceoBase}.png`));

    // ---- Logo (no API quota) ----
    if (haveLogo) {
      console.log(`[${symbol}] logo exists, skipping`);
    } else {
      try {
        const dest = await downloadLogo(symbol, logoBase);
        console.log(`[${symbol}] logo -> ${dest}`);
      } catch (err) {
        console.error(`[${symbol}] logo failed: ${err.message}`);
        await appendFile(missLog, `${symbol}\tLOGO\t${err.message}\n`);
      }
    }

    // ---- CEO photo ----
    if (haveCeo) {
      console.log(`[${symbol}] CEO photo exists, skipping`);
      continue;
    }

    let ceoName = CEO_NAMES[symbol] || null;
    if (!ceoName) {
      try {
        ceoName = await fmpCeoName(symbol);
        await sleep(350);
      } catch (err) {
        await appendFile(missLog, `${symbol}\tCEO\tFMP fallback failed: ${err.message}\n`);
        continue;
      }
      if (!ceoName) {
        await appendFile(missLog, `${symbol}\tCEO\tnot in CEO_NAMES map and no FMP name\n`);
        continue;
      }
    }

    try {
      let imgUrl = await wikiPageImage(ceoName);
      let matchedTitle = ceoName;
      await sleep(WIKI_DELAY_MS);
      if (!imgUrl) {
        const noInitials = ceoName.replace(/\s+[A-Z]\.(?=\s)/g, '').trim();
        if (noInitials !== ceoName) {
          imgUrl = await wikiPageImage(noInitials);
          if (imgUrl) matchedTitle = noInitials;
          await sleep(WIKI_DELAY_MS);
        }
      }
      if (!imgUrl) {
        const fallback = await wikiSearchImage(ceoName);
        if (fallback) ({ img: imgUrl, matchedTitle } = fallback);
      }
      if (!imgUrl) {
        console.warn(`[${symbol}] no Wikipedia image for "${ceoName}"`);
        await appendFile(missLog, `${symbol}\tCEO\tno Wikipedia image for "${ceoName}"\n`);
        continue;
      }
      const dest = await downloadImage(imgUrl, ceoBase);
      console.log(`[${symbol}] CEO (${ceoName}) -> ${dest}`);
      manifest[symbol] = {
        ceo: ceoName,
        wikipediaTitle: matchedTitle,
        ceoImageSource: imgUrl,
        license: 'Wikimedia Commons — verify per-file license before commercial reuse',
      };
      await sleep(WIKI_DELAY_MS);
    } catch (err) {
      console.error(`[${symbol}] CEO image failed: ${err.message}`);
      await appendFile(missLog, `${symbol}\tCEO\t${err.message}\n`);
    }
  }

  await writeFile(path.join(ASSETS_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log('\nDone. Check assets/misses.txt for gaps.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
