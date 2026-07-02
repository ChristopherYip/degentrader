// post-quiz.js
// Generates one quiz post (math / trivia / riddle) using the Anthropic API
// and publishes it to X. Designed to run as a one-shot script on a
// Railway Cron Schedule (one Railway service per time slot).
//
// Required environment variables:
//   ANTHROPIC_KEY        - Anthropic API key
//   X_API_KEY             - X (Twitter) app API key
//   X_API_SECRET          - X app API secret
//   X_ACCESS_TOKEN        - X user access token
//   X_ACCESS_SECRET       - X user access token secret
//
// Optional environment variables:
//   POST_TYPE              - "math" | "trivia" | "riddle" | "mixed" (default: "mixed")
//   DIFFICULTY              - "easy" | "medium" | "hard" (default: "medium")
//   TONE                    - "engaging" | "competitive" | "educational" (default: "engaging")
//   ACCOUNT_HANDLE          - your X handle for prompt context (default: "DailyBrainDrop")
//   DRY_RUN                 - "true" to generate and log without posting to X

import Anthropic from "@anthropic-ai/sdk";
import { TwitterApi } from "twitter-api-v2";
import pg from "pg";

function requireEnv(name) {
  const val = process.env[name];
  if (!val) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return val;
}

async function main() {
  const anthropicKey = requireEnv("ANTHROPIC_KEY");
  const dryRun = process.env.DRY_RUN === "true";

  const xApiKey = dryRun ? process.env.X_API_KEY : requireEnv("X_API_KEY");
  const xApiSecret = dryRun ? process.env.X_API_SECRET : requireEnv("X_API_SECRET");
  const xAccessToken = dryRun ? process.env.X_ACCESS_TOKEN : requireEnv("X_ACCESS_TOKEN");
  const xAccessSecret = dryRun ? process.env.X_ACCESS_SECRET : requireEnv("X_ACCESS_SECRET");

  // Maps exact ET time (hour:minute) to content type, per your schedule.
  // Any run that doesn't land on one of these exact times is skipped.
  const scheduleMap = {
    "7:30": "math",
    "9:0": "trivia",
    "12:15": "riddle",
    "15:0": "math",
    "17:30": "trivia",
    "20:0": "riddle",
    "22:0": "math",
  };

  const types = ["math", "trivia", "riddle"];
  let postType = (process.env.POST_TYPE || "mixed").toLowerCase();

  if (postType === "mixed") {
    const now = new Date();
    const utcHour = now.getUTCHours();
    const utcMinute = now.getUTCMinutes();

    const scheduled = [
      { h: 0,  m: 0,  type: "math" },
      { h: 3,  m: 30, type: "trivia" },
      { h: 7,  m: 0,  type: "riddle" },
      { h: 10, m: 30, type: "math" },
      { h: 14, m: 0,  type: "trivia" },
      { h: 17, m: 30, type: "riddle" },
      { h: 21, m: 0,  type: "math" },
    ];

    const match = scheduled.find(
      (s) => s.h === utcHour && Math.abs(s.m - utcMinute) <= 30
    );

    if (!match) {
      console.log(`No scheduled post for ${utcHour}:${utcMinute} UTC. Skipping.`);
      process.exit(0);
    }
    postType = match.type;
  }
  if (!types.includes(postType)) {
    console.error(`Invalid POST_TYPE "${postType}". Must be one of: ${types.join(", ")}, mixed`);
    process.exit(1);
  }

  const difficulty = (process.env.DIFFICULTY || "medium").toLowerCase();
  const tone = (process.env.TONE || "engaging").toLowerCase();
  const handle = process.env.ACCOUNT_HANDLE || "DailyBrainDrop";

  const difficultyLabel = {
    easy: "easy (broad audience appeal)",
    medium: "medium difficulty",
    hard: "hard (for enthusiasts)",
  }[difficulty] || "medium difficulty";

  const toneLabel = {
    engaging: "fun and engaging",
    competitive: "bold and competitive",
    educational: "educational and informative",
  }[tone] || "fun and engaging";

  const prompt = `Generate one ${postType} question post for X (Twitter) for an account called @${handle}.

Rules:
- Start with a relevant emoji  
- Ask an engaging ${postType} question
- Do NOT include multiple choice options in the post
- End with "Drop your answer below! 👇"
- Tone: ${toneLabel}
- Difficulty: ${difficultyLabel}
- Maximum 240 characters total
- No hashtags

Then on a new line write "OPTIONS:" followed by 4 multiple choice options labeled A) B) C) D) as a short follow-up reply (max 200 chars total for all 4 options combined).

Then on a new line write "ANSWER:" followed by the correct letter and a one-sentence explanation.

Return ONLY:
Line 1: the tweet text
Blank line
OPTIONS: A) ... B) ... C) ... D) ...
Blank line  
ANSWER: [letter] - [explanation]
Nothing else.`;

  console.log(`[${new Date().toISOString()}] Generating ${postType} post (difficulty=${difficulty}, tone=${tone})...`);

  const anthropic = new Anthropic({ apiKey: anthropicKey });

  const msg = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 400,
    messages: [{ role: "user", content: prompt }],
  });

  const fullText = msg.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();

  const parts = fullText.split(/\n\s*\n/);
  const tweetText = parts[0].trim();
  const optionsMatch = fullText.match(/OPTIONS:\s*(.+?)(?:\n\s*\n|ANSWER:)/s);
  const optionsText = optionsMatch ? optionsMatch[1].trim() : null;
  const answerMatch = fullText.match(/ANSWER:\s*(.+)/s);
  const answerText = answerMatch ? answerMatch[1].trim() : null;

  if (!tweetText) {
    console.error("Failed to parse generated tweet text. Raw response:");
    console.error(fullText);
    process.exit(1);
  }

  if (tweetText.length > 280) {
    console.error(`Generated tweet is ${tweetText.length} chars, exceeds 280 limit. Aborting post.`);
    console.error(tweetText);
    process.exit(1);
  }

  console.log("Generated post:");
  console.log(tweetText);
  console.log(`(${tweetText.length} characters)`);
  if (optionsText) {
    console.log("Options (for immediate reply):", optionsText);
  }
  if (answerText) {
    console.log("Answer (for later reply):", answerText);
  }

  if (dryRun) {
    console.log("DRY_RUN=true, skipping actual post to X.");
    return;
  }

  const twitter = new TwitterApi({
    appKey: xApiKey,
    appSecret: xApiSecret,
    accessToken: xAccessToken,
    accessSecret: xAccessSecret,
  });

  const result = await twitter.v2.tweet(tweetText);
  console.log("Posted successfully. Tweet ID:", result.data.id);

  // Post options as immediate reply
  if (optionsText) {
    try {
      const optionsReply = await twitter.v2.reply(optionsText, result.data.id);
      console.log("Posted options reply. Reply ID:", optionsReply.data.id);
    } catch (optErr) {
      console.error("Failed to post options reply:", optErr.message);
    }
  }

  if (answerText) {
    const dbUrl = process.env.DATABASE_URL;
    if (dbUrl) {
      const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
      try {
        await client.connect();
          await client.query(`
          CREATE TABLE IF NOT EXISTS pending_answers (
            id SERIAL PRIMARY KEY,
            tweet_id TEXT NOT NULL,
            options_text TEXT,
            answer_text TEXT NOT NULL,
            posted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            options_replied BOOLEAN NOT NULL DEFAULT FALSE,
            replied BOOLEAN NOT NULL DEFAULT FALSE
          );
        `);
        await client.query(
          `INSERT INTO pending_answers (tweet_id, options_text, answer_text) VALUES ($1, $2, $3);`,
          [result.data.id, optionsText, answerText]
        );
        console.log("Saved answer for later reply.");
      } catch (dbErr) {
        console.error("Failed to save answer to database:", dbErr.message);
      } finally {
        await client.end();
      }
    } else {
      console.log("No DATABASE_URL set, skipping answer save.");
    }
  }
}

main().catch((err) => {
  console.error("Script failed:", err);
  process.exit(1);
});
