/**
 * Scout Bot — a standalone sentiment scout for MEAT / Polymarket.
 *
 * Every SCAN_INTERVAL_MS it:
 *   1. Reads /state/markets.json (the engine's symbol -> market snapshot).
 *   2. For each market, queries SearXNG's news API for fresh headlines.
 *   3. Asks the LLM to score the headlines' sentiment and a probability nudge
 *      (how much the news should shift our estimate of the market's YES probability).
 *   4. Upserts one row per market into the `scout_signals` Postgres table.
 *
 * prob-trader.js then reads the latest signal per market and feeds the headline +
 * sentiment into its LLM prompt, so the trader conditions its probability estimate
 * on real news instead of just the model's parametric memory.
 *
 * Env: DATABASE_URL, STATE_DIR, SEARXNG_URL, SCAN_INTERVAL_MS,
 *      RESEARCH_API_KEY, RESEARCH_BASE_URL, RESEARCH_MODEL (falls back to DEEPSEEK_*).
 * Zero engine deps; installs `pg` in its own image.
 */

import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const DATABASE_URL = process.env.DATABASE_URL;
const STATE_DIR = process.env.STATE_DIR ?? '/app/state';
const SEARXNG_URL = process.env.SEARXNG_URL ?? 'http://192.168.16.202:8080';
const SCAN_INTERVAL_MS = Number(process.env.SCAN_INTERVAL_MS ?? 900000); // 15 min default
const MAX_MARKETS = Number(process.env.SCOUT_MAX_MARKETS ?? 20);
const MAX_HEADLINES = Number(process.env.SCOUT_MAX_HEADLINES ?? 5);
const REQUEST_TIMEOUT_MS = Number(process.env.SCOUT_TIMEOUT_MS ?? 15000);

if (!DATABASE_URL) {
  console.log('[scout] DATABASE_URL is required');
  process.exit(1);
}

const apiKey = process.env.RESEARCH_API_KEY ?? process.env.DEEPSEEK_API_KEY;
const baseUrl = String(process.env.RESEARCH_BASE_URL ?? process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com').replace(/\/+$/, '');
const model = process.env.RESEARCH_MODEL ?? process.env.DEEPSEEK_MODEL ?? 'deepseek-chat';
if (!apiKey) {
  console.log('[scout] RESEARCH_API_KEY is required for sentiment scoring');
  process.exit(1);
}

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ---------------------------------------------------------------------------
// SearXNG headlines
// ---------------------------------------------------------------------------

/** Fetch fresh news headlines for a query via SearXNG's JSON API. */
async function fetchHeadlines(query) {
  const url = `${SEARXNG_URL}/search?q=${encodeURIComponent(query)}&format=json&categories=news`;
  const response = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`searxng ${response.status}`);
  const data = await response.json();
  const results = Array.isArray(data?.results) ? data.results : [];
  return results
    .filter((r) => r && r.title)
    .slice(0, MAX_HEADLINES)
    .map((r) => ({
      title: String(r.title).slice(0, 300),
      url: String(r.url ?? '').slice(0, 500),
      content: String(r.content ?? '').slice(0, 500),
    }));
}

// ---------------------------------------------------------------------------
// LLM sentiment scoring
// ---------------------------------------------------------------------------

const SCOUT_SYSTEM_PROMPT = `You are a financial news sentiment analyst for prediction markets.
Your output MUST be a single JSON object and NOTHING else. No preamble, no thinking out loud.

Format (exactly this structure, nothing more):
{"sentiment": <number -1.0 to 1.0>, "prob_nudge": <number -0.10 to 0.10>, "summary": "<one sentence>"}

- "sentiment": how positive/negative the news is for the market's YES outcome.
  -1.0 = extremely bearish for YES, 0.0 = neutral, +1.0 = extremely bullish for YES.
- "prob_nudge": how much the news should shift our estimate of the YES probability, as a decimal.
  Range -0.10 to +0.10. Use 0.0 if the news is irrelevant or too weak to move the needle.
  Example: +0.05 means "the news suggests YES is 5 percentage points more likely than the market thinks".
- "summary": one sentence explaining your reasoning.

Begin your response with { and end with }. Do NOT start with any text before the opening brace.`;

/** Build the user prompt from the market question + headlines. */
function buildPrompt(question, headlines) {
  const lines = headlines.map((h, i) => `${i + 1}. ${h.title}${h.content ? ` — ${h.content.slice(0, 150)}` : ''}`).join('\n');
  return `Market question: ${question}

Recent headlines:
${lines}

Based on these headlines, score the sentiment and probability nudge for this market's YES outcome. Reply with JSON only.`;
}

/** Call TM·DeepSeek (or fallback) via the OpenAI-compatible chat completions API. */
async function callLLM(userPrompt) {
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: SCOUT_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.2,
      max_tokens: 300,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS * 2),
  });
  if (!response.ok) throw new Error(`llm ${response.status}`);
  const body = await response.json();
  return body?.choices?.[0]?.message?.content ?? null;
}

/** Parse the LLM's JSON reply into { sentiment, probNudge, summary }. */
function parseSignalReply(text) {
  if (!text) return null;
  // Strip thinking-model wrappers and markdown fences.
  let cleaned = text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '')
    .replace(/```json\s*/gi, '')
    .replace(/```/g, '')
    .trim();
  let parsed = null;
  try { parsed = JSON.parse(cleaned); } catch { /* fall through */ }
  if (!parsed) {
    const matches = [...cleaned.matchAll(/\{[^{}]*(?:"(?:sentiment|prob_nudge)"\s*:)[^{}]*\}/g)];
    if (matches.length > 0) {
      try { parsed = JSON.parse(matches[matches.length - 1][0]); } catch { /* fall through */ }
    }
  }
  if (!parsed) {
    const anyMatch = cleaned.match(/\{[^{}]+\}/);
    if (anyMatch) { try { parsed = JSON.parse(anyMatch[0]); } catch { return null; } }
  }
  if (!parsed) return null;
  const sentiment = num(parsed?.sentiment, 0);
  const probNudge = num(parsed?.prob_nudge, 0);
  const summary = String(parsed?.summary ?? '').slice(0, 300);
  return {
    sentiment: clamp(sentiment, -1, 1),
    probNudge: clamp(probNudge, -0.1, 0.1),
    summary,
  };
}

// ---------------------------------------------------------------------------
// Postgres upsert
// ---------------------------------------------------------------------------

let pool = null;
async function getPool() {
  if (!pool) pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });
  return pool;
}

async function ensureSchema() {
  const p = await getPool();
  const sql = `CREATE TABLE IF NOT EXISTS scout_signals (
    id             BIGSERIAL PRIMARY KEY,
    symbol         TEXT NOT NULL,
    question       TEXT,
    category       TEXT,
    headline       TEXT,
    headline_url   TEXT,
    sentiment      NUMERIC,
    prob_nudge     NUMERIC,
    summary        TEXT,
    sources        INTEGER,
    at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (symbol, at)
  )`;
  await p.query(sql);
  await p.query(`CREATE INDEX IF NOT EXISTS scout_symbol_at_idx ON scout_signals (symbol, at DESC)`);
}

async function saveSignal(client, signal) {
  await client.query(
    `INSERT INTO scout_signals (symbol, question, category, headline, headline_url, sentiment, prob_nudge, summary, sources, at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now())
     ON CONFLICT (symbol, at) DO NOTHING`,
    [signal.symbol, signal.question, signal.category, signal.headline, signal.headlineUrl,
     signal.sentiment, signal.probNudge, signal.summary, signal.sources],
  );
}

// ---------------------------------------------------------------------------
// Main scan loop
// ---------------------------------------------------------------------------

async function scanOnce() {
  const marketsFile = path.join(STATE_DIR, 'markets.json');
  if (!fs.existsSync(marketsFile)) {
    console.log('[scout] markets.json not found yet, skipping');
    return;
  }
  const snap = JSON.parse(fs.readFileSync(marketsFile, 'utf8'));
  const markets = Object.values(snap.markets ?? {}).slice(0, MAX_MARKETS);
  if (markets.length === 0) {
    console.log('[scout] no markets in snapshot, skipping');
    return;
  }

  const p = await getPool();
  let ok = 0, skip = 0, err = 0;
  for (const market of markets) {
    if (!market.question) { skip += 1; continue; }
    try {
      const headlines = await fetchHeadlines(market.question);
      if (headlines.length === 0) {
        console.log(`[scout] ${market.symbol}: no headlines`);
        skip += 1;
        continue;
      }
      const userPrompt = buildPrompt(market.question, headlines);
      const reply = await callLLM(userPrompt);
      const signal = parseSignalReply(reply);
      if (!signal) {
        console.log(`[scout] ${market.symbol}: LLM parse failed`);
        err += 1;
        continue;
      }
      const client = await p.connect();
      try {
        await saveSignal(client, {
          symbol: market.symbol,
          question: market.question,
          category: market.category ?? null,
          headline: headlines[0].title,
          headlineUrl: headlines[0].url,
          sentiment: signal.sentiment,
          probNudge: signal.probNudge,
          summary: signal.summary,
          sources: headlines.length,
        });
      } finally {
        client.release();
      }
      ok += 1;
      console.log(`[scout] ${market.symbol}: sentiment=${signal.sentiment.toFixed(2)} nudge=${signal.probNudge.toFixed(3)}`);
    } catch (error) {
      console.log(`[scout] ${market.symbol}: ${String(error?.message ?? error).slice(0, 100)}`);
      err += 1;
    }
  }
  console.log(`[scout] scan done: ${ok} ok, ${skip} skip, ${err} err`);
}

async function main() {
  console.log(`[scout] starting (interval=${SCAN_INTERVAL_MS}ms, searxng=${SEARXNG_URL}, model=${model})`);
  const p = await getPool();
  await ensureSchema();
  console.log('[scout] schema ready');
  // Run once immediately, then on interval.
  await scanOnce().catch((e) => console.log('[scout] scan error:', String(e?.message ?? e)));
  setInterval(() => scanOnce().catch((e) => console.log('[scout] scan error:', String(e?.message ?? e))), SCAN_INTERVAL_MS);
}

main().catch((e) => { console.log('[scout] fatal:', String(e?.message ?? e)); process.exit(1); });
