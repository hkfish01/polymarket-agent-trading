/**
 * broker-polysim.js — Polymarket broker with REAL market data + SIMULATED fills.
 *
 * mode: 'polysim'
 *
 * This is the bridge that lets agents trade the REAL Polymarket venue (weather, crypto
 * price, politics, sports, economics events) without touching a wallet or real funds.
 *
 *   READS   -> real data, no auth, from Gamma (discovery) + CLOB (book/midpoint/history).
 *   WRITES  -> simulated. submitOrder() fills instantly against the real top-of-book
 *              midpoint into an in-memory cash/position book (the same virtual-accounting
 *              pattern as broker-sim.js). Nothing is signed, nothing hits a chain.
 *
 * WHY SHORT SYMBOLS: the engine validates config.symbols as short uppercase tickers
 * (`^[A-Z][A-Z0-9.]{0,9}$`) and threads them through the genome/spec/position path.
 * A Polymarket outcome token_id is a 64-digit number, so broker-polysim discovers real
 * markets per category at construction and maps each configured short code to one real
 * market's YES token (e.g. `PC1` -> the #1 crypto market by 24h volume). Trading the
 * short code trades that market's YES outcome at its live probability.
 *
 * SYMBOL PREFIX CONVENTION (first letter = category):
 *   P + C = crypto      PP = politics     PS = sports
 *   P + E = economics   PW = weather      PX = any/other
 * e.g. config.symbols: ["PC1","PC2","PP1","PS1","PE1","PW1"]
 *
 * Zero wallet/secrets required. Zero npm deps (Node built-ins only).
 */

import { fail } from './contracts.js';
import { sleep } from './util.js';
import { createEventFeed } from './event-feed.js';

const REQUEST_TIMEOUT_MS = 12000;
const CLOB_BASE = 'https://clob.polymarket.com';
const GAMMA_BASE = 'https://gamma-api.polymarket.com';
// When the CLOB fallback's top-of-book spread exceeds this fraction of the bid, treat
// the market as thin and refuse to trust the venue midpoint. See fetchBook().
const THIN_MARKET_SPREAD_PCT = 0.15;

/** Map a short symbol prefix to a Polymarket tag/category we search for. */
function categoryForSymbol(symbol) {
  const code = String(symbol ?? '').toUpperCase();
  // PXY where X is the category letter; default to 'any'.
  const cat = code[1];
  switch (cat) {
    case 'C': return 'crypto';
    case 'P': return 'politics';
    case 'S': return 'sports';
    case 'E': return 'economics';
    case 'W': return 'weather';
    default: return 'any';
  }
}

function num(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function round6(value) {
  return Math.round((Number(value) || 0) * 1e6) / 1e6;
}

/**
 * Construct a polysim broker.
 * @param {object} config full engine config (uses config.symbols, config.polysim, config.sim)
 * @param {{ fetchImpl?: Function, sleepImpl?: Function, eventFeed?: object, clock?: object }} [options]
 */
export function createBroker(config, options = {}) {
  if (!config || typeof config !== 'object') {
    fail('CONFIG_INVALID', 'broker-polysim requires a config object');
  }
  const mode = 'polysim';
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    fail('CONFIG_INVALID', 'broker-polysim requires global fetch (Node >= 22) or a fetchImpl');
  }
  const sleepImpl = options.sleepImpl ?? sleep;
  const eventFeed = options.eventFeed ?? createEventFeed({ fetchImpl });
  const clobBase = String(config.polysim?.clobBaseUrl ?? CLOB_BASE).replace(/\/+$/, '');
  const gammaBase = String(config.polysim?.gammaBaseUrl ?? GAMMA_BASE).replace(/\/+$/, '');

  const configuredSymbols = Array.isArray(config.symbols) ? [...config.symbols] : [];
  if (configuredSymbols.length === 0) {
    fail('CONFIG_INVALID', 'broker-polysim needs at least one configured symbol');
  }
  const baseEquity = num(config.sim?.accountEquityUsd, 100000);
  const commissionBps = num(config.sim?.commissionBps, 0);

  // -------------------------------------------------------------------------
  // market discovery: map each short symbol -> one real market (YES token)
  // -------------------------------------------------------------------------
  /** @type {Map<string, object>} shortCode -> {tokenId, conditionId, question, category, label} */
  const marketMap = new Map();
  /** @type {Array<object>} discovery log for status/introspection */
  const assignments = [];

  /**
   * Discover real markets and bind each configured short symbol to a live one.
   * Uses the Gamma /events endpoint because each event carries `tags[].slug` (the
   * category) and nests its tradable markets; the bare /markets endpoint has no tags.
   */
  async function discoverMarkets() {
    const host = gammaBase;
    const limit = Math.max(20, Math.min(200, num(config.polysim?.discoveryLimit, 120)));
    const nowMs = Date.now();
    const url = `${host}/events?active=true&closed=false&limit=${limit}&order=volume24hr&ascending=false`;
    let events = [];
    try {
      const response = await fetchImpl(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const text = await response.text();
      events = response.ok && text ? JSON.parse(text) : [];
      if (!Array.isArray(events)) events = [];
    } catch (error) {
      fail('BROKER_ERROR', `polysim discovery failed: ${error?.message ?? error}`, { cause: error?.name ?? 'network' });
    }

    // Flatten events -> candidate markets tagged with their category.
    const byCategory = new Map(); // category -> [{tokenId, conditionId, question, label, liquidity, volume24hr}]
    for (const event of events) {
      const tags = Array.isArray(event?.tags) ? event.tags : [];
      const category = classifyEvent(tags);
      const markets = Array.isArray(event?.markets) ? event.markets : [];
      for (const market of markets) {
        const tokenIds = parseClobTokenIds(market.clobTokenIds);
        let outcomes = market.outcomes;
        if (typeof outcomes === 'string') {
          try { outcomes = JSON.parse(outcomes); } catch { outcomes = []; }
        }
        if (!Array.isArray(tokenIds) || tokenIds.length === 0) continue;
        if (!Array.isArray(outcomes) || outcomes.length === 0) continue;
        // For binary markets the YES token is index 0. For multi-outcome we take each
        // token as its own tradable line; the short code binds to the first (YES).
        const yesIndex = findYesIndex(outcomes);
        const tokenId = tokenIds[yesIndex] ?? tokenIds[0];
        const label = String(outcomes[yesIndex] ?? outcomes[0] ?? 'YES');
        const endDate = market.endDateIso ?? market.endDate ?? event.endDate ?? null;
        const hoursToClose = hoursUntil(endDate, nowMs);
        // Skip markets already resolved or closing in <2 hours (thin/illiquid at expiry).
        if (hoursToClose !== null && hoursToClose < 2) continue;
        // Skip markets with essentially no liquidity — can't price them meaningfully.
        const liquidity = num(market.liquidity, 0) ?? 0;
        if (liquidity < 500) continue;
        const entry = {
          tokenId,
          conditionId: String(market.conditionId ?? event.id ?? '').trim(),
          question: String(market.question ?? event.title ?? '').trim(),
          slug: String(market.slug ?? event.slug ?? '').trim(),
          label,
          category,
          liquidityUsd: liquidity,
          volume24hrUsd: num(market.volume24hr, 0) ?? 0,
          endDateIso: endDate,
          hoursToClose,
        };
        if (!byCategory.has(category)) byCategory.set(category, []);
        byCategory.get(category).push(entry);
      }
    }
    // Rank each category by 24h volume (deepest, most tradable first).
    for (const list of byCategory.values()) {
      list.sort((a, b) => b.volume24hrUsd - a.volume24hrUsd);
    }
    byCategory.set('any', mergeRanked(byCategory));

    // Bind each configured short symbol to the next unused market in its category.
    const usedTokenIds = new Set();
    const counters = new Map();
    for (const symbol of configuredSymbols) {
      const category = categoryForSymbol(symbol);
      const pool = byCategory.get(category) ?? [];
      const pick = pool.find((candidate) => !usedTokenIds.has(candidate.tokenId));
      if (!pick) continue;
      usedTokenIds.add(pick.tokenId);
      const seq = (counters.get(category) ?? 0) + 1;
      counters.set(category, seq);
      marketMap.set(symbol, { ...pick, shortCode: symbol });
      assignments.push({ symbol, category, question: pick.question, tokenId: pick.tokenId, hoursToClose: pick.hoursToClose });
    }
    if (marketMap.size === 0) {
      fail('BROKER_ERROR', 'polysim discovery matched no tradable markets to the configured symbols', {
        configured: configuredSymbols.length,
      });
    }
  }

  // -------------------------------------------------------------------------
  // virtual account (mirrors broker-sim accounting)
  // -------------------------------------------------------------------------
  /** @type {{ cashUsd: number, positions: Map, orders: Array, seq: number } | null} */
  let account = null;
  function initAccount() {
    if (account) return;
    account = { cashUsd: baseEquity, positions: new Map(), orders: [], seq: 0 };
  }

  /** Mark-to-market equity: outcome tokens valued at the live book midpoint. */
  function accountEquityEstimate(marks) {
    let positionsValue = 0;
    for (const [symbol, position] of account.positions) {
      const mark = marks.get(symbol);
      if (mark === null || mark === undefined) continue;
      positionsValue += position.qty * mark * (position.multiplier || 1);
    }
    return round2(account.cashUsd + positionsValue);
  }

  /** Apply one signed fill to the position book (avg entry; flip through zero supported). */
  function applyPositionDelta({ symbol, delta, price, orderId }) {
    const existing = account.positions.get(symbol);
    const currentQty = existing?.qty ?? 0;
    if (Math.abs(delta) < 1e-9) return;
    if (Math.abs(currentQty) < 1e-9 || Math.sign(currentQty) === Math.sign(delta)) {
      const totalAbs = Math.abs(currentQty) + Math.abs(delta);
      const average = (Math.abs(currentQty) * (existing?.avgPriceUsd ?? price) + Math.abs(delta) * price) / Math.max(totalAbs, 1e-9);
      account.positions.set(symbol, {
        symbol,
        qty: round6(currentQty + delta),
        avgPriceUsd: round6(average),
        openedAt: new Date().toISOString(),
        assetClass: 'polymarket_outcome',
        multiplier: 1,
        orderId: orderId ?? existing?.orderId ?? null,
      });
      return;
    }
    const remaining = round6(currentQty + delta);
    if (Math.abs(remaining) < 1e-9) {
      account.positions.delete(symbol);
      return;
    }
    if (Math.abs(delta) <= Math.abs(currentQty) + 1e-9) {
      existing.qty = remaining;
      return;
    }
    account.positions.set(symbol, {
      symbol,
      qty: remaining,
      avgPriceUsd: round6(price),
      openedAt: new Date().toISOString(),
      assetClass: 'polymarket_outcome',
      multiplier: 1,
      orderId: orderId ?? null,
    });
  }

  /** Fill one order against the real book midpoint + update the virtual account. */
  function fillVirtual(order, fillPrice) {
    const signedQty = order.side === 'sell' ? -order.qty : order.qty;
    const gross = round2(Math.abs(signedQty) * fillPrice);
    const commission = round4((gross * commissionBps) / 10000);
    const cashDelta = order.side === 'buy' ? -(gross + commission) : (gross - commission);
    account.cashUsd = round2(account.cashUsd + cashDelta);
    applyPositionDelta({
      symbol: order.symbol,
      delta: signedQty,
      price: fillPrice,
      orderId: order.id,
    });
    order.status = 'filled';
    order.filledQty = order.qty;
    order.avgFillPriceUsd = fillPrice;
    order.filledAvgPriceUsd = fillPrice;
    order.notionalUsd = gross;
    order.filledAt = new Date().toISOString();
    return { cashDelta, notionalUsd: gross };
  }

  // -------------------------------------------------------------------------
  // contract surface (mirrors broker-alpaca.js / broker-sim.js)
  // -------------------------------------------------------------------------
  const broker = {
    kind: 'polysim',
    mode,
    symbols: configuredSymbols,
    /** Discovery log: which real market each short code is bound to. */
    assignments,
  };

  Object.assign(broker, {
    async getClock() {
      const now = Date.now();
      return { isOpen: true, timestamp: now, nextOpen: now, nextClose: now + 3600_000 };
    },

    async getAccount() {
      initAccount();
      const marks = await collectMarks();
      const equity = accountEquityEstimate(marks);
      const cash = round2(account.cashUsd);
      return {
        equityUsd: equity,
        cashUsd: cash,
        buyingPowerUsd: round2(Math.max(0, cash)),
        optionsBuyingPowerUsd: 0,
        marginMultiplier: 1,
        shortingEnabled: false,
        optionsTradingLevel: 0,
        longMarketValueUsd: round2(equity - cash),
        shortMarketValueUsd: 0,
        maintenanceMarginUsd: 0,
        status: 'ACTIVE',
        currency: 'USDC',
        mode,
      };
    },

    async getPositions() {
      initAccount();
      const marks = await collectMarks();
      const out = [];
      for (const [symbol, position] of account.positions) {
        const mark = marks.get(symbol);
        out.push({
          symbol,
          assetClass: 'polymarket_outcome',
          qty: position.qty,
          qtySigned: position.qty,
          avgPriceUsd: position.avgPriceUsd,
          marketValueUsd: mark !== null && mark !== undefined ? round2(position.qty * mark) : null,
          multiplier: 1,
          option: null,
        });
      }
      return out;
    },

    async getAsset(symbol) {
      return {
        symbol: String(symbol),
        assetClass: 'polymarket_outcome',
        tradable: marketMap.has(String(symbol).toUpperCase()),
        shortable: false,
        marginable: false,
        optionsEnabled: false,
        multiplier: 1,
        tickSize: 0.001,
      };
    },

    /**
     * Probability K-lines for one short code, read from the real CLOB /prices-history.
     * Reuses broker-polymarket's bucketing approach; the OHLC is the outcome price's
     * (i.e. implied probability's) open/high/low/close over each time bucket.
     */
    async getBars({ symbols, timeframe = '1Hour', limit = 120, start, end } = {}) {
      const list = (Array.isArray(symbols) ? symbols : [symbols]).map((s) => String(s).toUpperCase());
      const out = {};
      const intervalMs = timeframeToMs(timeframe);
      const nowMs = Date.now();
      const effectiveEndMs = end ? Date.parse(end) : nowMs;
      const effectiveStartMs = start ? Date.parse(start) : nowMs - Math.min(intervalMs * num(limit, 120) * 4, 400 * 86400_000);
      await Promise.all(list.map(async (symbol) => {
        const market = marketMap.get(symbol);
        if (!market) { out[symbol] = []; return; }
        try {
          const query = {
            market: market.tokenId,
            fidelity: Math.max(1, Math.min(1440, Math.round(intervalMs / 60000))),
            ...(Number.isFinite(effectiveStartMs) ? { startTs: Math.floor(effectiveStartMs / 1000) } : {}),
            ...(Number.isFinite(effectiveEndMs) ? { endTs: Math.floor(effectiveEndMs / 1000) } : {}),
          };
          const url = `${clobBase}/prices-history?${new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined)).toString()}`;
          const response = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
          const text = await response.text();
          const raw = response.ok && text ? JSON.parse(text) : null;
          const history = Array.isArray(raw?.history) ? raw.history : [];
          out[symbol] = bucketProbabilityHistory(history, intervalMs).slice(-num(limit, 120));
        } catch {
          out[symbol] = [];
        }
      }));
      return out;
    },

    /** Live probability quote for one short code, from the real CLOB book. */
    async getLatestQuote(symbol) {
      const code = String(symbol).toUpperCase();
      const market = marketMap.get(code);
      if (!market) fail('DATA_MISSING', `polysim: unknown symbol ${code}`);
      const book = await fetchBook(market);
      return {
        symbol: code,
        priceUsd: book.mid,
        bidUsd: book.bestBid,
        askUsd: book.bestAsk,
        sizeUsd: null,
        ts: Date.now(),
        question: market.question,
      };
    },

    /** Advance the synthetic clock (no-op: real time). Executor may call this in sim. */
    async advanceBar() {
      return { advanced: 0 };
    },

    /** Executor data-url seam (unused for outcome markets). */
    async getDataUrl() {
      return null;
    },

    async getOptionChain() {
      return null; // outcome markets have no options
    },

    async getOptionQuote() {
      return null;
    },

    async getOrder(id) {
      initAccount();
      return account.orders.find((order) => order.id === id) ?? null;
    },

    async getOrders({ status = 'all', limit = 100 } = {}) {
      initAccount();
      const filtered = status === 'all' ? account.orders : account.orders.filter((order) => order.status === status);
      return filtered.slice(-limit);
    },

    /** Submit one outcome bet. Fills instantly at the real book midpoint (virtual). */
    async submitOrder(order = {}) {
      initAccount();
      const symbol = String(order.symbol ?? '').toUpperCase();
      const market = marketMap.get(symbol);
      if (!market) fail('SPEC_INVALID', `polysim: unknown symbol ${symbol}`, { symbol });
      const side = String(order.side ?? '').trim().toLowerCase();
      if (side !== 'buy' && side !== 'sell') fail('SPEC_INVALID', 'polysim order side must be buy or sell', { symbol, side });
      const qty = num(order.qty, null);
      if (!(qty > 0)) fail('SPEC_INVALID', 'polysim order requires qty > 0', { symbol, qty });
      const type = String(order.type ?? 'market').toLowerCase();

      // Fill at the real book midpoint (paper fill on live price).
      const book = await fetchBook(market);
      if (book.mid === null || book.mid === undefined) {
        fail('BROKER_ERROR', `polysim: no live midpoint for ${symbol}`, { symbol, tokenId: market.tokenId });
      }
      // Apply a small adverse slippage vs mid so paper fills are not optimistically free.
      const slip = num(config.sim?.slippageBps, 5) / 10000;
      const fillPrice = side === 'buy' ? Math.min(1, round6(book.mid * (1 + slip))) : Math.max(0, round6(book.mid * (1 - slip)));

      account.seq += 1;
      const id = `polysim-${String(account.seq).padStart(6, '0')}`;
      const record = {
        id,
        symbol,
        side,
        qty,
        type,
        limitPrice: num(order.limitPrice, null),
        status: 'filled',
        filledQty: qty,
        avgFillPriceUsd: fillPrice,
        filledAvgPriceUsd: fillPrice,
        notionalUsd: round2(qty * fillPrice),
        assetClass: 'polymarket_outcome',
        // Metadata so the archive/dashboard can show the real event being traded.
        question: market.question,
        category: market.category,
        tokenId: market.tokenId,
        label: market.label,
        conditionId: market.conditionId,
      };
      fillVirtual(record, fillPrice);
      account.orders.push(record);
      return normalizeOrderResponse(record);
    },

    async cancelOrder(id) {
      initAccount();
      const order = account.orders.find((o) => o.id === id);
      if (order && order.status !== 'filled') order.status = 'canceled';
      return { id: String(id), status: 'canceled' };
    },

    /** Introspection: which real market does each short code trade? */
    async getMarketMap() {
      return [...marketMap.entries()].map(([symbol, market]) => ({
        symbol,
        category: market.category,
        question: market.question,
        slug: market.slug,
        tokenId: market.tokenId,
        label: market.label,
        hoursToClose: market.hoursToClose,
      }));
    },
  });

  // -------------------------------------------------------------------------
  // helpers
  // -------------------------------------------------------------------------

  /**
   * Best available mid for one token. Uses the CLOB /midpoint endpoint (venue's own
   * reference mid) when the top-of-book is crossed/thin, because a self-computed
   * (bestBid+bestAsk)/2 on a book like $0.01 x $0.99 yields a meaningless $0.50.
   * We still return bestBid/bestAsk so the caller can gauge spread quality.
   */
  async function fetchBook(market) {
    const tokenId = market.tokenId;
    let bestBid = null;
    let bestAsk = null;
    let mid = null;

    // ---- PRIMARY: gamma API authoritative quote ---------------------------
    try {
      const gammaUrl = `${gammaBase}/markets?slug=${encodeURIComponent(market.slug ?? '')}`;
      const gammaRes = await fetchImpl(gammaUrl, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      const gammaText = await gammaRes.text();
      if (gammaRes.ok && gammaText) {
        const arr = JSON.parse(gammaText);
        const gm = Array.isArray(arr) ? arr[0] : null;
        if (gm) {
          bestBid = num(gm.bestBid ?? gm.bestBid?.toString(), null);
          bestAsk = num(gm.bestAsk ?? gm.bestAsk?.toString(), null);
          const lastTrade = num(gm.lastTradePrice ?? gm.lastTradePrice?.toString(), null);
          if (lastTrade !== null && lastTrade > 0) {
            mid = lastTrade;
          } else if (bestBid !== null && bestAsk !== null) {
            mid = Number(((bestBid + bestAsk) / 2).toFixed(6));
          } else if (bestBid !== null) {
            mid = bestBid;
          } else if (bestAsk !== null) {
            mid = bestAsk;
          }
          if (mid !== null) return { bestBid, bestAsk, mid };
        }
      }
    } catch {
      // fall through to CLOB endpoints
    }

    // ---- FALLBACK: CLOB book + midpoint (only when gamma failed) -----------
    const url = `${clobBase}/book?token_id=${encodeURIComponent(tokenId)}`;
    try {
      const response = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      const text = await response.text();
      if (response.ok && text) {
        const raw = JSON.parse(text);
        const bids = Array.isArray(raw?.bids) ? raw.bids : [];
        const asks = Array.isArray(raw?.asks) ? raw.asks : [];
        bestBid = num(bids[0]?.price, null);
        bestAsk = num(asks[0]?.price, null);
      }
    } catch {
      // fall through to /midpoint
    }
    try {
      const midUrl = `${clobBase}/midpoint?token_id=${encodeURIComponent(tokenId)}`;
      const midResponse = await fetchImpl(midUrl, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      const midText = await midResponse.text();
      if (midResponse.ok && midText) {
        mid = num(JSON.parse(midText)?.mid, null);
      }
    } catch {
      // keep mid null; caller treats null as "no tradable price"
    }
    if (mid === null && bestBid !== null && bestAsk !== null) {
      mid = Number(((bestBid + bestAsk) / 2).toFixed(6));
    }

    // ---- thin-market guard (CLOB fallback only) ----------------------------
    const spreadPct = bestBid !== null && bestAsk !== null && bestBid > 0
      ? (bestAsk - bestBid) / bestBid
      : (bestBid === null || bestAsk === null ? Infinity : 0);
    const wideSpread = bestBid === null || bestAsk === null || spreadPct > THIN_MARKET_SPREAD_PCT;
    if (wideSpread) {
      const lastTrade = await fetchLastTradePrice(tokenId);
      if (lastTrade !== null && lastTrade > 0) {
        mid = lastTrade;
      } else if (bestBid !== null) {
        mid = bestBid;
      }
    }
    return { bestBid, bestAsk, mid };
  }

  /**
   * Fetch the most recent confirmed trade price for a token via CLOB /trades.
   * Returns null when no trade history is available (e.g. a brand-new market).
   */
  async function fetchLastTradePrice(tokenId) {
    try {
      const url = `${clobBase}/trades?market=${encodeURIComponent(tokenId)}&limit=1&taker_only=false`;
      const response = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      const text = await response.text();
      if (!response.ok || !text) return null;
      const raw = JSON.parse(text);
      const trades = Array.isArray(raw) ? raw : (Array.isArray(raw?.trades) ? raw.trades : []);
      const last = trades[0];
      const price = last ? num(last.price ?? last.priceUsd ?? null, null) : null;
      return price !== null && price > 0 ? price : null;
    } catch {
      return null;
    }
  }

  /** Collect a live mark price per held short code (for mark-to-market). */
  async function collectMarks() {
    initAccount();
    const marks = new Map();
    const held = [...account.positions.keys()];
    await Promise.all(held.map(async (symbol) => {
      const market = marketMap.get(symbol);
      if (!market) { marks.set(symbol, null); return; }
      try {
        const book = await fetchBook(market);
        marks.set(symbol, book.mid);
      } catch {
        marks.set(symbol, null);
      }
    }));
    return marks;
  }

  // Discover real markets eagerly at construction (async); keep a ready promise so the
  // first broker call awaits discovery without the engine needing to know about it.
  const ready = discoverMarkets().catch((error) => {
    // Surface the discovery error on the first broker call rather than at import.
    broker.__discoveryError = error;
    throw error;
  });
  const readyGuard = async () => {
    if (ready) await ready;
  };

  // Wrap every contract method to await discovery first (keeps the surface clean).
  for (const key of Object.keys(broker)) {
    if (key === 'kind' || key === 'mode' || key === 'symbols' || key === 'assignments') continue;
    const original = broker[key];
    if (typeof original === 'function') {
      broker[key] = async (...args) => {
        await readyGuard();
        return original.apply(broker, args);
      };
    }
  }

  return broker;
}

// -------------------------------------------------------------------------
// pure helpers
// -------------------------------------------------------------------------

/** Normalize an internal fill record into the order-response shape the executor reads. */
function normalizeOrderResponse(record) {
  return {
    id: record.id,
    symbol: record.symbol,
    side: record.side,
    qty: record.qty,
    status: record.status,
    filledQty: record.filledQty,
    avgFillPriceUsd: record.avgFillPriceUsd,
    filledAvgPriceUsd: record.filledAvgPriceUsd,
    notionalUsd: record.notionalUsd,
    assetClass: record.assetClass,
    question: record.question,
    category: record.category,
  };
}

/** Map Gamma event tags to one of our categories. */
function classifyEvent(tags) {
  const slugs = new Set((Array.isArray(tags) ? tags : []).map((tag) => String(tag?.slug ?? '').toLowerCase()));
  if (slugs.has('crypto')) return 'crypto';
  if (slugs.has('politics')) return 'politics';
  if (slugs.has('sports')) return 'sports';
  if (slugs.has('weather')) return 'weather';
  if (slugs.has('economics') || slugs.has('business') || slugs.has('finance')) return 'economics';
  if (slugs.has('world') || slugs.has('us-politics')) return 'politics';
  return 'any';
}

/** Merge every category into a single 'any' pool ranked by volume. */
function mergeRanked(byCategory) {
  const all = [];
  for (const [category, list] of byCategory.entries()) {
    if (category === 'any') continue;
    all.push(...list);
  }
  all.sort((a, b) => b.volume24hrUsd - a.volume24hrUsd);
  return all;
}

/** For binary markets prefer the YES outcome index; fall back to 0. */
function findYesIndex(outcomes) {
  const index = outcomes.findIndex((label) => String(label).trim().toUpperCase() === 'YES');
  return index >= 0 ? index : 0;
}

function hoursUntil(endIso, nowMs) {
  if (!endIso) return null;
  const end = Date.parse(endIso);
  if (!Number.isFinite(end)) return null;
  return (end - nowMs) / 3600_000;
}

function parseClobTokenIds(raw) {
  if (Array.isArray(raw)) return raw.map((v) => String(v));
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((v) => String(v)) : [];
  } catch {
    return [];
  }
}

function timeframeToMs(timeframe) {
  const tf = String(timeframe ?? '').toLowerCase();
  const multipliers = { min: 60_000, hour: 3_600_000, day: 86_400_000, week: 604_800_000 };
  const match = tf.match(/^(\d+)\s*(min|hour|day|week)/);
  if (match) return Number(match[1]) * multipliers[match[2]];
  if (tf.includes('hour')) return 3_600_000;
  if (tf.includes('day')) return 86_400_000;
  if (tf.includes('week')) return 604_800_000;
  return 3_600_000;
}

/** Bucket a raw probability price-history into OHLC bars (probability in [0,1]).
 *  CLOB /prices-history returns `t` as UNIX SECONDS (not ms), so we convert to ms first. */
function bucketProbabilityHistory(history, intervalMs) {
  const points = history
    .map((point) => ({ t: num(point.t, null), p: num(point.p, null) }))
    .filter((point) => point.t !== null && point.p !== null)
    .sort((a, b) => a.t - b.t);
  if (points.length === 0) return [];
  const buckets = new Map();
  for (const point of points) {
    // Convert seconds → ms so bucket math lines up with intervalMs.
    const tMs = point.t < 1e12 ? point.t * 1000 : point.t;
    const bucket = Math.floor(tMs / intervalMs) * intervalMs;
    if (!buckets.has(bucket)) buckets.set(bucket, []);
    buckets.get(bucket).push({ ...point, tMs });
  }
  const out = [];
  for (const [bucketStart, list] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
    const opens = list[0].p;
    const closes = list[list.length - 1].p;
    const highs = Math.max(...list.map((point) => point.p));
    const lows = Math.min(...list.map((point) => point.p));
    out.push({
      t: new Date(bucketStart).toISOString(),
      o: Number(opens.toFixed(6)),
      h: Number(highs.toFixed(6)),
      l: Number(lows.toFixed(6)),
      c: Number(closes.toFixed(6)),
      v: 0,
    });
  }
  return out;
}

export default createBroker;
