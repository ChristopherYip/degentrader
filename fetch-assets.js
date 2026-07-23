// fetch-assets.js
// One-time (re-runnable) asset sourcing for earnings posts.
// - Logos:  FMP profile `image` URL  -> assets/logos/TICKER.png
// - CEOs:   FMP profile `ceo` name   -> Wikipedia pageimage -> assets/ceos/TICKER.jpg
// Resumable: skips any file that already exists.
// Outputs:  assets/manifest.json (ticker -> ceo name, sources, license note)
//           assets/misses.log    (tickers needing manual sourcing)
//
// Run locally:  FMP_API_KEY=yourkey node fetch-assets.js

import { mkdir, writeFile, appendFile, access } from 'node:fs/promises';
import path from 'node:path';

// ============ CONFIG ============
const FMP_API_KEY = process.env.FMP_API_KEY;
const FMP_DELAY_MS = 350;        // pacing between FMP calls
const WIKI_DELAY_MS = 250;       // pacing between Wikipedia calls
const CEO_IMAGE_WIDTH = 800;     // requested thumbnail width (px)
const ASSETS_DIR = 'assets';

// Paste your full ~129-ticker watchlist here (same order as post-earnings.js):
const WATCHLIST = [
  'NVDA', 'TSLA', 'NFLX', 'AAPL', 'MSFT', 'AMZN', 'GOOGL', 'META', 'AMD', 'PLTR',
  // ...rest of watchlist
];

// FMP `ceo` values are sometimes stale or formatted oddly. Hard overrides win.
// Key = ticker, value = exact Wikipedia article title for the CEO.
const CEO_OVERRIDES = {
  NVDA: 'Jensen Huang',       // FMP has "Jen-Hsun Huang" — redirect works, but be explicit
  NFLX: 'Ted Sarandos',       // co-CEO field can list Greg Peters
  GOOGL: 'Sundar Pichai',
};
// ================================

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const exists = (p) => access(p).then(() => true, () => false);

// Magic-byte sniff (same lesson as the X media upload): trust bytes, not extensions.
function sniffExt(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpg';
  if (buf[0] === 0x47 && buf[1] === 0x49) return 'gif';
  if (buf.slice(0, 4).toString() === 'RIFF') return 'webp';
  return null;
}

async function downloadImage(url, destBase) {
  const res = await fetch(url, { headers: { 'user-agent': 'DegenTraderAssetFetch/1.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const ext = sniffExt(buf);
  if (!ext) throw new Error(`Unrecognized image bytes from ${url}`);
  const dest = `${destBase}.${ext}`;
  await writeFile(dest, buf);
  return dest;
}

// Strip honorifics/suffixes FMP sometimes includes: "Mr. John A. Smith Jr., CPA"
function cleanCeoName(raw) {
  if (!raw) return null;
  let name = raw.split(',')[0]; // drop credentials after comma
  name = name.replace(/\b(Mr|Mrs|Ms|Dr|Prof)\.?\s+/gi, '');
  name = name.replace(/\s+(Jr|Sr|II|III|IV)\.?$/i, '');
  return name.trim() || null;
}

async function fmpProfile(symbol) {
  const url = `https://financialmodelingprep.com/stable/profile?symbol=${symbol}&apikey=${FMP_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`FMP profile ${symbol}: HTTP ${res.status}`);
  const json = await res.json();
  const row = Array.isArray(json) ? json[0] : json;
  if (!row) throw new Error(`FMP profile ${symbol}: empty response`);
  return { image: row.image || null, ceo: row.ceo || null };
}

// Wikipedia: title -> lead image URL (Commons-hosted, usually CC-licensed)
async function wikiPageImage(title) {
  const params = new URLSearchParams({
    action: 'query', format: 'json', redirects: '1',
    prop: 'pageimages', pithumbsize: String(CEO_IMAGE_WIDTH),
    titles: title, origin: '*',
  });
  const res = await fetch(`https://en.wikipedia.org/w/api.php?${params}`, {
    headers: { 'user-agent': 'DegenTraderAssetFetch/1.0 (contact: your-email)' },
  });
  if (!res.ok) throw new Error(`Wikipedia API HTTP ${res.status}`);
  const json = await res.json();
  const pages = json?.query?.pages || {};
  const page = Object.values(pages)[0];
  if (!page || page.missing !== undefined) return null;
  return page.thumbnail?.source || null;
}

// Fallback: full-text search, then retry pageimages on the top hit
async function wikiSearchImage(name) {
  const params = new URLSearchParams({
    action: 'query', format: 'json', list: 'search',
    srsearch: `${name} chief executive`, srlimit: '1', origin: '*',
  });
  const res = await fetch(`https://en.wikipedia.org/w/api.php?${params}`, {
    headers: { 'user-agent': 'DegenTraderAssetFetch/1.0' },
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
  if (!FMP_API_KEY) {
    console.error('Set FMP_API_KEY env var.');
    process.exit(1);
  }

  const logosDir = path.join(ASSETS_DIR, 'logos');
  const ceosDir = path.join(ASSETS_DIR, 'ceos');
  await mkdir(logosDir, { recursive: true });
  await mkdir(ceosDir, { recursive: true });

  const missLog = path.join(ASSETS_DIR, 'misses.log');
  const manifest = {};
  let fmpCalls = 0;

  for (const symbol of WATCHLIST) {
    const logoBase = path.join(logosDir, symbol);
    const ceoBase = path.join(ceosDir, symbol);
    const haveLogo = (await exists(`${logoBase}.png`)) || (await exists(`${logoBase}.jpg`));
    const haveCeo = (await exists(`${ceoBase}.jpg`)) || (await exists(`${ceoBase}.png`));

    let profile = null;
    if (!haveLogo || !haveCeo) {
      try {
        profile = await fmpProfile(symbol);
        fmpCalls++;
        await sleep(FMP_DELAY_MS);
      } catch (err) {
        console.error(`[${symbol}] FMP profile failed: ${err.message}`);
        await appendFile(missLog, `${symbol}\tPROFILE\t${err.message}\n`);
        continue;
      }
    }

    // ---- Logo ----
    if (haveLogo) {
      console.log(`[${symbol}] logo exists, skipping`);
    } else if (profile?.image) {
      try {
        const dest = await downloadImage(profile.image, logoBase);
        console.log(`[${symbol}] logo -> ${dest}`);
      } catch (err) {
        console.error(`[${symbol}] logo download failed: ${err.message}`);
        await appendFile(missLog, `${symbol}\tLOGO\t${err.message}\n`);
      }
    } else {
      await appendFile(missLog, `${symbol}\tLOGO\tno image URL in profile\n`);
    }

    // ---- CEO photo ----
    if (haveCeo) {
      console.log(`[${symbol}] CEO photo exists, skipping`);
      continue;
    }
    const ceoName = CEO_OVERRIDES[symbol] || cleanCeoName(profile?.ceo);
    if (!ceoName) {
      await appendFile(missLog, `${symbol}\tCEO\tno CEO name in profile\n`);
      continue;
    }

    try {
      let imgUrl = await wikiPageImage(ceoName);
      let matchedTitle = ceoName;
      await sleep(WIKI_DELAY_MS);
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
  console.log(`\nDone. FMP calls used: ${fmpCalls}. Check ${missLog} for gaps.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
