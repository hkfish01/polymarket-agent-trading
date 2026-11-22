/**
 * event-feed.js — Polymarket market discovery + probability pricing.
 *
 * Replaces the Alpaca market-data feed for the outcome-market venue. Where broker-alpaca
 * fed the engine price bars for listed equities, this module feeds the engine a list of
 * tradable events with their implied probabilities, so the Prospector can scan for
 * mispricing (market price vs our model's probability) instead of scanning for technical
 * breakouts.
 *
 * Data sources (all public, no auth, no key):
 *   - Gamma API  /markets          market discovery (question, outcomes, endDate, liquidity)
 *   - CLOB  API   /book /midpoint  live order book + implied probability per token
 *
 * Key venue facts this module encapsulates:
 *   - `clobTokenIds` (a JSON string array) aligns index-for-index with `outcomes`.
 *     Index 0 is the FIRST outcome — not always "Yes" in multi-outcome (NegRisk) markets.
 *   - `outcomePrices` are the last-traded / midpoint probabilities as strings in [0,1].
 *   - A price of p on a YES token IS the implied probability that the event resolves Yes.
 *   - `negRisk: true` marks multi-outcome mutually-exclusive markets (elections, awards).
 *
 * Owner: market teammate. Do not edit from other modules.
 *
 * @module event-feed
 */

import { fail } from './contracts.js';
import { parseClobTokenIds, parseNumber, parseTimestamp } from './broker-polymarket.js';

const GAMMA_BASE = 'https://gamma-api.polymarket.com';
export const CLOB_BASE = 'https://clob.polymarket.com';
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * @param {{ fetchImpl?: Function, gammaBaseUrl?: string, clobBaseUrl?: string }} [options]
 */
export function createEventFeed(options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    fail('CONFIG_INVALID', 'event-feed requires global fetch (Node >= 22) or a fetchImpl');
  }
  const gammaBase = String(options.gammaBaseUrl ?? GAMMA_BASE).replace(/\/+$/, '');
  const clobBase = String(options.clobBaseUrl ?? CLOB_BASE).replace(/\/+$/, '');

  /** One public GET with retry-once on 429/5xx (idempotent reads). */
  async function get(host, pathname, { query = null, attempt = 0 } = {}) {
    const url = new URL(pathname, host);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null || value === '') continue;
        url.searchParams.set(key, String(value));
      }
    }
    let response;
    try {
      response = await fetchImpl(url.toString(), {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
      fail(
        'BROKER_ERROR',
        timedOut
          ? `event-feed GET ${url.pathname} timed out after ${REQUEST_TIMEOUT_MS}ms`
          : `event-feed GET ${url.pathname} failed: ${error?.message ?? String(error)}`,
        { path: url.pathname, cause: error?.name ?? 'network' },
      );
    }
    const status = Number(response.status);
    const text = typeof response.text === 'function' ? await response.text() : '';
    if (status >= 200 && status < 300) {
      if (!text) return null;
      try {
        return JSON.parse(text);
      } catch {
        fail('BROKER_ERROR', `event-feed GET ${url.pathname} returned invalid JSON`, { path: url.pathname });
      }
    }
    if ((status === 429 || status >= 500) && attempt === 0) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      return get(host, pathname, { query, attempt: attempt + 1 });
    }
    if (status === 429) fail('BROKER_RATE_LIMIT', 'event-feed rate limited by Polymarket', { path: url.pathname });
    fail('BROKER_ERROR', `event-feed GET ${url.pathname} failed (${status})`, { path: url.pathname, status });
  }

  /**
   * List tradable markets from Gamma, filtered and ranked by liquidity/volume.
   * @param {{ limit?: number, tagSlug?: string, minLiquidity?: number, minVolume24h?: number,
   *           order?: string, excludeEndingWithinHours?: number, nowMs?: number }} [params]
   * @returns {Promise<Array<object>>} normalized market summaries, best first
   */
  async function listMarkets(params = {}) {
    const limit = Math.max(1, Math.min(500, Number(params.limit) || 50));
    const raw = await get(gammaBase, '/markets', {
      query: {
        active: 'true',
        closed: 'false',
        limit,
        order: params.order ?? 'volume24hr',
        ascending: 'false',
        ...(params.tagSlug ? { tag_slug: params.tagSlug } : {}),
      },
    });
    const rows = Array.isArray(raw) ? raw : [];
    const nowMs = Number.isFinite(Number(params.nowMs)) ? Number(params.nowMs) : Date.now();
    const minLiquidity = Number(params.minLiquidity ?? 0);
    const minVolume24h = Number(params.minVolume24h ?? 0);
    const excludeHours = Number(params.excludeEndingWithinHours ?? 0);

    const out = [];
    for (const row of rows) {
      const market = mapGammaMarket(row, nowMs);
      if (!market) continue;
      if (minLiquidity > 0 && market.liquidityUsd < minLiquidity) continue;
      if (minVolume24h > 0 && market.volume24hUsd < minVolume24h) continue;
      if (excludeHours > 0 && market.hoursToClose !== null && market.hoursToClose < excludeHours) continue;
      out.push(market);
    }
    return out;
  }

  /**
   * Live probability pricing for one market, read from the CLOB order book (not the
   * possibly-stale Gamma outcomePrices). Returns best bid/ask/mid per outcome token.
   * @param {object} market a market summary from listMarkets()
   * @returns {Promise<object>} {conditionId, outcomes:[{label, tokenId, bestBid, bestAsk, mid}]}
   */
  async function priceMarket(market) {
    const tokens = Array.isArray(market.tokens) ? market.tokens : [];
    const priced = [];
    for (const token of tokens) {
      const book = await get(clobBase, '/book', { query: { token_id: token.tokenId } });
      priced.push(priceTokenFromBook(book, token));
    }
    return { conditionId: market.conditionId, question: market.question, outcomes: priced };
  }

  /**
   * Live implied probability for one outcome token (mid of the top of book).
   * @param {string} tokenId
   * @returns {Promise<number|null>} implied probability in [0,1]
   */
  async function impliedProbability(tokenId) {
    const tokenIdStr = String(tokenId ?? '').trim();
    if (tokenIdStr === '') fail('DATA_MISSING', 'impliedProbability requires a token_id');
    const mid = await get(clobBase, '/midpoint', { query: { token_id: tokenIdStr } });
    return parseNumber(mid?.mid, null);
  }

  return { listMarkets, priceMarket, impliedProbability };
}

/**
 * Map one Gamma market row to a normalized summary. Returns null for rows we cannot use
 * (missing conditionId, missing/invalid clobTokenIds, or outcomes/tokenIds count mismatch).
 */
function mapGammaMarket(raw, nowMs) {
  if (!raw || typeof raw !== 'object') return null;
  const conditionId = String(raw.conditionId ?? '').trim();
  if (conditionId === '') return null;
  const tokenIds = parseClobTokenIds(raw.clobTokenIds);
  let outcomes = raw.outcomes;
  if (typeof outcomes === 'string') {
    try {
      outcomes = JSON.parse(outcomes);
    } catch {
      outcomes = [];
    }
  }
  if (!Array.isArray(outcomes) || tokenIds.length === 0) return null;
  // Index alignment between outcomes and clobTokenIds is the #1 venue pitfall: only build
  // tokens where we have BOTH a label and a tokenId, and stop at the shorter of the two.
  const pairCount = Math.min(outcomes.length, tokenIds.length);
  if (pairCount === 0) return null;
  const tokens = [];
  for (let index = 0; index < pairCount; index += 1) {
    tokens.push({ label: String(outcomes[index] ?? `outcome-${index}`), tokenId: tokenIds[index] });
  }
  let outcomePrices = raw.outcomePrices;
  if (typeof outcomePrices === 'string') {
    try {
      outcomePrices = JSON.parse(outcomePrices);
    } catch {
      outcomePrices = [];
    }
  }
  const endDateMs = parseTimestamp(raw.endDate);
  return {
    conditionId,
    question: String(raw.question ?? '').trim(),
    slug: String(raw.slug ?? '').trim(),
    description: String(raw.description ?? '').trim(),
    resolutionSource: String(raw.resolutionSource ?? '').trim(),
    negRisk: raw.negRisk === true,
    active: raw.active === true,
    tokens,
    // Gamma's last-traded prices, aligned to tokens (may be stale vs the live book).
    outcomePrices: Array.isArray(outcomePrices) ? outcomePrices.map((p) => parseNumber(p, null)) : [],
    liquidityUsd: parseNumber(raw.liquidity, 0) ?? 0,
    volume24hUsd: parseNumber(raw.volume24hr, 0) ?? 0,
    volumeUsd: parseNumber(raw.volume, 0) ?? 0,
    endDate: raw.endDate ?? null,
    endDateMs,
    hoursToClose: endDateMs !== null ? Number(((endDateMs - nowMs) / 3_600_000).toFixed(2)) : null,
    image: String(raw.image ?? '').trim(),
  };
}

/** Derive a token's live pricing from its order book. */
function priceTokenFromBook(book, token) {
  const bids = Array.isArray(book?.bids) ? book.bids : [];
  const asks = Array.isArray(book?.asks) ? book.asks : [];
  const bestBid = parseNumber(bids[0]?.price, null);
  const bestAsk = parseNumber(asks[0]?.price, null);
  const mid = bestBid !== null && bestAsk !== null ? (bestBid + bestAsk) / 2 : (bestBid ?? bestAsk);
  return {
    label: token.label,
    tokenId: token.tokenId,
    bestBid,
    bestAsk,
    mid: mid !== null ? Number(mid.toFixed(6)) : null,
    bidDepth: bids.reduce((sum, level) => sum + (parseNumber(level?.size, 0) ?? 0), 0),
    askDepth: asks.reduce((sum, level) => sum + (parseNumber(level?.size, 0) ?? 0), 0),
  };
}

export default createEventFeed;
