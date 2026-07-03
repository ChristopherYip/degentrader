// discover-drafts.js
// Finds high-engagement posts relevant to @DailyBrainDrop's niche, and drafts
// 2 candidate replies for each using the Anthropic API. Saves everything to
// the database and prints a digest to the logs.
//
// IMPORTANT: This script does NOT post anything to X. It only discovers and
// drafts. Posting the reply is a manual, human step -- this is intentional,
// since X's automation policy prohibits automated replies to posts you
// weren't invited to reply to. Automating the "find + draft" step is fine;
// automating the "post" step is not. See:
// https://help.x.com/en/rules-and-policies/x-automation
//
// Required environment variables:
//   ANTHROPIC_KEY     - Anthropic API key
//   X_BEARER_TOKEN     - X API App-only Bearer token (needs Basic tier or
//                         higher for the recent search endpoint)
//   DATABASE_URL        - Postgres connection string (same DB as your other scripts)
//
// Optional environment variables:
//   TARGET_ACCOUNTS      - comma-separated X handles to pull posts from, e.g. "QuizWhiz,MathIsFun"
//                            (takes priority over SEARCH_TOPICS if both are set)
//   SEARCH_TOPICS         - comma-separated keywords/hashtags, e.g. "trivia,math puzzle,riddle"
//                            (used if TARGET_ACCOUNTS is not set)
//   MIN_LIKES               - minimum like count for a candidate to qualify (default: 20)
//   TOP_N                    - how many candidates to draft replies for (default: 8)
//   ACCOUNT_HANDLE            - your X handle for prompt context (default: "DailyBrainDrop")
//   DRY_RUN                    - "true" to run without saving to the database

import Anthropic from "@anthropic-ai/sdk";
import pg from "pg";

function requireEnv(name) {
  const val = process.env[name];
  if (!val) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return val;
}

async function searchRecentPosts(bearerToken, query, maxResults = 30) {
  const url = new URL("https://api.x.com/2/tweets/search/recent");
  url.searchParams.set("query", query);
  url.searchParams.set("max_results", String(maxResults));
  url.searchParams.set("tweet.fields", "public_metrics,author_id,created_at,lang");
  url.searchParams.set("expansions", "author_id");
  url.searchParams.set("user.fields", "username");

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${bearerToken}` },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`X search failed (${res.status}): ${body}`);
  }

  return res.json();
}

function buildQuery() {
  const targetAccounts = (process.env.TARGET_ACCOUNTS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const searchTopics = (process.env.SEARCH_TOPICS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (targetAccounts.length > 0) {
    const fromClause = targetAccounts.map((h) => `from:${h}`).join(" OR ");
    return `(${fromClause}) -is:reply -is:retweet lang:en`;
  }

  if (searchTopics.length > 0) {
    const topicClause = searchTopics.map((t) => `"${t}"`).join(" OR ");
    return `(${topicClause}) -is:reply -is:retweet lang:en`;
  }

  console.error(
    "Set either TARGET_ACCOUNTS or SEARCH_TOPICS so the script knows what to search for."
  );
  process.exit(1);
}

function scorePost(metrics) {
  const likes = metrics.like_count || 0;
  const replies = metrics.reply_count || 0;
  const retweets = metrics.retweet_count || 0;
  return likes + replies * 2 + retweets * 1.5;
}

async function draftReplies(anthropic, handle, authorHandle, tweetText) {
  const prompt = `You are drafting X (Twitter) reply options for the account @${handle}, a math/trivia/riddle quiz account with a fun, witty, brainy personality.

Someone posted this on X (from @${authorHandle}):
"${tweetText}"

Write exactly 2 short reply options that @${handle} could post as a reply. Rules:
- On-topic and genuinely adds something (a mini riddle, a fun fact, a clever observation) -- not generic praise
- Match the tone: playful, brainy, a little cheeky, never salesy
- Do NOT mention or promote @${handle} or invite people to follow/check it out
- Do NOT include any links
- Each reply under 200 characters
- No hashtags

Return ONLY valid JSON, nothing else, in this exact format:
{"reply_1": "...", "reply_2": "..."}`;

  const msg = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 300,
    messages: [{ role: "user", content: prompt }],
  });

  const text = msg.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim()
    .replace(/```json|```/g, "")
    .trim();

  try {
    return JSON.parse(text);
  } catch (e) {
    console.error("Failed to parse draft JSON, raw response:", text);
    return null;
  }
}

async function main() {
  const anthropicKey = requireEnv("ANTHROPIC_KEY");
  const bearerToken = requireEnv("X_BEARER_TOKEN");
  const dryRun = process.env.DRY_RUN === "true";
  const dbUrl = dryRun ? process.env.DATABASE_URL : requireEnv("DATABASE_URL");

  const handle = process.env.ACCOUNT_HANDLE || "DailyBrainDrop";
  const minLikes = parseInt(process.env.MIN_LIKES || "20", 10);
  const topN = parseInt(process.env.TOP_N || "8", 10);

  const query = buildQuery();
  console.log(`[${new Date().toISOString()}] Searching X with query: ${query}`);

  const searchResults = await searchRecentPosts(bearerToken, query, 40);
  const posts = searchResults.data || [];
  const users = (searchResults.includes && searchResults.includes.users) || [];
  const userMap = Object.fromEntries(users.map((u) => [u.id, u.username]));

  if (posts.length === 0) {
    console.log("No posts found for this query. Nothing to draft.");
    return;
  }

  let client = null;
  let alreadySeen = new Set();

  if (dbUrl) {
    client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
    await client.connect();
    await client.query(`
      CREATE TABLE IF NOT EXISTS reply_drafts (
        id SERIAL PRIMARY KEY,
        tweet_id TEXT UNIQUE NOT NULL,
        author_handle TEXT,
        tweet_text TEXT,
        tweet_url TEXT,
        engagement_score NUMERIC,
        draft_1 TEXT,
        draft_2 TEXT,
        discovered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        reviewed BOOLEAN NOT NULL DEFAULT FALSE,
        posted BOOLEAN NOT NULL DEFAULT FALSE
      );
    `);
    const seenRows = await client.query(`SELECT tweet_id FROM reply_drafts;`);
    alreadySeen = new Set(seenRows.rows.map((r) => r.tweet_id));
  }

  // Filter, dedupe, and rank
  const candidates = posts
    .filter((p) => !alreadySeen.has(p.id))
    .filter((p) => scorePost(p.public_metrics) >= minLikes)
    .map((p) => ({
      id: p.id,
      author: userMap[p.author_id] || "unknown",
      text: p.text,
      score: scorePost(p.public_metrics),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topN);

  if (candidates.length === 0) {
    console.log("No new candidates above the engagement threshold today.");
    if (client) await client.end();
    return;
  }

  console.log(`Found ${candidates.length} new candidates. Drafting replies...\n`);

  const anthropic = new Anthropic({ apiKey: anthropicKey });
  const digestLines = [];

  for (const c of candidates) {
    const drafts = await draftReplies(anthropic, handle, c.author, c.text);
    if (!drafts) continue;

    const tweetUrl = `https://x.com/${c.author}/status/${c.id}`;

    digestLines.push(
      `\n---\n@${c.author} (score: ${c.score})\n"${c.text}"\n${tweetUrl}\n\nDraft 1: ${drafts.reply_1}\nDraft 2: ${drafts.reply_2}`
    );

    if (client) {
      await client.query(
        `INSERT INTO reply_drafts (tweet_id, author_handle, tweet_text, tweet_url, engagement_score, draft_1, draft_2)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (tweet_id) DO NOTHING;`,
        [c.id, c.author, c.text, tweetUrl, c.score, drafts.reply_1, drafts.reply_2]
      );
    }
  }

  console.log("==================== DAILY REPLY DIGEST ====================");
  console.log(digestLines.join("\n"));
  console.log("\n==============================================================");
  console.log(
    `${digestLines.length} drafts ready. Review in the reply_drafts table (or the logs above) and post manually.`
  );

  if (client) await client.end();
}

main().catch((err) => {
  console.error("Script failed:", err);
  process.exit(1);
});
