/**
 * Polymarket CLOB broker client (market side) — dependency-free REST over global `fetch`.
 *
 * Port of broker-alpaca.js to Polymarket's outcome-market venue. Safety surface is
 * inherited from the Alpaca client (brake D1): this file implements ONLY market/account
 * READS plus order submission/cancellation. There is no transfer, withdrawal, bridge,
 * or account-configuration method here, and no way to add one from config.
 *
 * Venue model (Polymarket CLOB V2):
 *   - Gamma API  https://gamma-api.polymarket.com   market discovery (public)
 *   - CLOB API   https://clob.polymarket.com        book/price/order entry
 *   - Data API   https://data-api.polymarket.com    positions/fills history
 *
 * A "position" is an outcome token (e.g. YES on a question), identified by its
 * `token_id`. We surface `token_id` as the broker `symbol` so the rest of the engine
 * (ledger/executor/reaper) is venue-agnostic: a symbol is just the thing being traded.
 *
 * Authentication is two-tier and only needed for order entry / private reads:
 *   L1  EIP-712 signature with the wallet private key -> derives L2 API credentials.
 *   L2  HMAC-SHA256 over (apiKey, secret, passphrase).
 * The official SDK (`@polymarket/clob-client`) does the EIP-712 signing locally, so the
 * private key never leaves the machine. We load it lazily: public reads work with NO
 * credentials, and order entry fails fast with a clear code if the SDK/keys are missing.
 *
 * Contract: docs/CONTRACTS.md § "Broker interface".
 * Owner: market teammate. Do not edit from other modules.
 *
 * @module broker-polymarket
 */

import { fail } from './contracts.js';
import { sleep, DAY_MS, timeframeToMs } from './util.js';
import { normalizeSymbols } from './broker-alpaca.js';

/** Request timeout enforced with AbortSignal.timeout(ms). */
export const REQUEST_TIMEOUT_MS = 15_000;
const RETRY_DELAY_MS = 250;
const BODY_SNIPPET_LIMIT = 280;

const GAMMA_BASE = 'https://gamma-api.polymarket.com';
export const CLOB_BASE = 'https://clob.polymarket.com';
const DATA_BASE = 'https://data-api.polymarket.com';
/** Polygon mainnet chain id (Polymarket settles on Polygon). */
export const POLYGON_CHAIN_ID = 137;

// ---------------------------------------------------------------------------
// parsing helpers (Polymarket returns numbers as JSON strings and timestamps as ms)
// ---------------------------------------------------------------------------

/**
 * Parse a broker numeric field into a float. Returns `fallback` for null/invalid.
 * @param {unknown} value
 * @param {number|null} [fallback]
 * @returns {number|null}
 */
export function parseNumber(value, fallback = null) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

/** Polymarket timestamps are epoch-ms strings; normalize to epoch ms. */
export function parseTimestamp(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    // pure-numeric string -> already epoch ms
    if (/^\d+$/.test(value.trim())) {
      const n = Number(value.trim());
      return Number.isFinite(n) ? n : null;
    }
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Bounded snippet of an error body, safe for logs (never contains key material). */
export function bodySnippet(text) {
  const body = String(text ?? '');
  return body.length > BODY_SNIPPET_LIMIT ? `${body.slice(0, BODY_SNIPPET_LIMIT)}…` : body;
}

/**
 * Parse a `clobTokenIds` field (a JSON string array) into token ids.
 * Index alignment with `outcomes` is guaranteed by Gamma; index 0 is the first outcome.
 * @param {unknown} raw
 * @returns {string[]}
 */
export function parseClobTokenIds(raw) {
  let list = raw;
  if (typeof raw === 'string') {
    try {
      list = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(list)) return [];
  return list.map((id) => String(id ?? '').trim()).filter((id) => id !== '');
}

// ---------------------------------------------------------------------------
// credentials (order entry only)
// ---------------------------------------------------------------------------

/**
 * Resolve Polymarket credentials from the config + secrets. Returns null when no
 * private key is configured — public reads still work, only order entry needs this.
 * Supports signature_type 1 (proxy wallet) and 3 (deposit wallet), the two flows the
 * CLOB docs recommend for API users.
 */
function resolvePolymarketCredentials(config, secrets = {}) {
  const pick = (...names) => {
    for (const name of names) {
      const value = secrets?.[name];
      if (typeof value === 'string' && value.trim() !== '') return value.trim();
    }
    return null;
  };
  const privateKey = pick('POLY_PRIVATE_KEY', 'POLYMARKET_PRIVATE_KEY');
  if (!privateKey) return null;
  const funder = pick('POLY_FUNDER', 'POLYMARKET_FUNDER');
  const signatureType = Number(
    pick('POLY_SIGNATURE_TYPE', 'POLYMARKET_SIGNATURE_TYPE') ?? (funder ? 1 : 0),
  );
  return {
    privateKey,
    funder,
    signatureType: Number.isFinite(signatureType) ? signatureType : 0,
    apiKey: pick('POLY_API_KEY', 'POLYMARKET_API_KEY'),
    secret: pick('POLY_SECRET', 'POLYMARKET_SECRET'),
    passphrase: pick('POLY_PASSPHRASE', 'POLYMARKET_PASSPHRASE'),
    chainId: POLYGON_CHAIN_ID,
  };
}

// ---------------------------------------------------------------------------
// broker
// ---------------------------------------------------------------------------

/**
 * @param {object} config the merged engine config (mode, instruments, polymarket block)
 * @param {{ fetchImpl?: Function, secrets?: object, sleepImpl?: Function }} [options]
 */
export function createBroker(config, options = {}) {
  if (!config || typeof config !== 'object') {
    fail('CONFIG_INVALID', 'broker-polymarket requires a config object');
  }
  if (config.mode === 'sim') {
    fail('CONFIG_INVALID', 'mode=sim uses broker-sim.js, not broker-polymarket.js');
  }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    fail('CONFIG_INVALID', 'broker-polymarket requires global fetch (Node >= 22) or a fetchImpl');
  }
  const sleepImpl = options.sleepImpl ?? sleep;
  const mode = config.mode;
  const clobBase = String(config.polymarket?.clobBaseUrl ?? CLOB_BASE).replace(/\/+$/, '');
  const gammaBase = String(config.polymarket?.gammaBaseUrl ?? GAMMA_BASE).replace(/\/+$/, '');
  const dataBase = String(config.polymarket?.dataBaseUrl ?? DATA_BASE).replace(/\/+$/, '');

  let credentials = null;
  /** Lazily-created ClobClient (only when order entry is used). */
  let clobClient = null;

  function creds() {
    if (!credentials) {
      credentials = resolvePolymarketCredentials(config, options.secrets ?? {});
    }
    return credentials;
  }

  /**
   * Public (unauthenticated) request against one of the three hosts. Retries
   * idempotent GETs once on 429/5xx — there is nothing to duplicate on a read.
   */
  async function publicRequest(host, pathname, { method = 'GET', query = null, attempt = 0 } = {}) {
    const url = new URL(pathname, host);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null || value === '') continue;
        url.searchParams.set(key, String(value));
      }
    }
    const init = { method, headers: { accept: 'application/json' }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) };
    let response;
    try {
      response = await fetchImpl(url.toString(), init);
    } catch (error) {
      const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
      fail(
        'BROKER_ERROR',
        timedOut
          ? `Polymarket ${method} ${url.pathname} timed out after ${REQUEST_TIMEOUT_MS}ms`
          : `Polymarket ${method} ${url.pathname} failed: ${error?.message ?? String(error)}`,
        { method, path: url.pathname, cause: error?.name ?? 'network', mode },
      );
    }
    const status = Number(response.status);
    const text = typeof response.text === 'function' ? await response.text() : '';
    if (status >= 200 && status < 300) {
      if (!text) return null;
      try {
        return JSON.parse(text);
      } catch {
        fail('BROKER_ERROR', `Polymarket ${method} ${url.pathname} returned invalid JSON`, {
          status,
          method,
          path: url.pathname,
        });
      }
    }
    const retryable = status === 429 || (status >= 500 && status <= 599);
    if (retryable && attempt === 0) {
      await sleepImpl(RETRY_DELAY_MS);
      return publicRequest(host, pathname, { method, query, attempt: attempt + 1 });
    }
    const detail = { status, method, path: url.pathname, body: bodySnippet(text), mode };
    if (status === 404) {
      // Closed/unknown market: /book /price /midpoint return 404. Surface as missing data.
      fail('DATA_MISSING', `Polymarket ${method} ${url.pathname} not found (closed market?)`, detail);
    }
    if (status === 401 || status === 403) {
      fail('BROKER_AUTH', `Polymarket rejected credentials (${status})`, detail);
    }
    if (status === 429) {
      fail('BROKER_RATE_LIMIT', 'Polymarket rate limit exceeded', detail);
    }
    fail('BROKER_ERROR', `Polymarket ${method} ${url.pathname} failed (${status})`, detail);
  }

  /**
   * Lazily build the official ClobClient for order entry. Requires the SDK and a
   * private key; fails with a clear, non-secret-leaking message when absent.
   */
  async function getClient() {
    if (clobClient) return clobClient;
    const resolved = creds();
    if (!resolved) {
      fail(
        'BROKER_AUTH',
        'Polymarket order entry requires POLY_PRIVATE_KEY (and POLY_FUNDER for a proxy wallet) in the environment',
        { mode },
      );
    }
    let ClobClientCtor;
    let ethersWallet;
    try {
      // Lazily import so public-read-only installs never need the SDK.
      const mod = await import('@polymarket/clob-client');
      ClobClientCtor = mod.ClobClient ?? mod.default?.ClobClient ?? mod.default;
      // The SDK's signer must be an ethers-compatible Wallet (it calls .getAddress() and
      // ._signTypedData()). Build one from the private key.
      const ethers = await import('ethers');
      const WalletCtor = ethers.Wallet ?? ethers.default?.Wallet;
      if (typeof WalletCtor !== 'function') throw new Error('ethers Wallet not found');
      ethersWallet = new WalletCtor(resolved.privateKey);
    } catch (error) {
      fail(
        'NOT_IMPLEMENTED',
        'Polymarket wallet ops need @polymarket/clob-client and ethers installed',
        { cause: error?.message ?? String(error) },
      );
    }
    if (typeof ClobClientCtor !== 'function') {
      fail('NOT_IMPLEMENTED', '@polymarket/clob-client did not export a ClobClient constructor', {});
    }
    // This SDK version takes POSITIONAL args:
    //   new ClobClient(host, chainId, signer, creds, signatureType, funderAddress)
    // The signer must be a real ethers Wallet (a { key } object will not work). There is no
    // setApiCreds() on this version: credentials are passed via the constructor, so we build
    // a provisional client, derive L2 creds (unless pre-supplied), then rebuild with them.
    const buildClient = (l2Creds) =>
      new ClobClientCtor(
        clobBase,
        resolved.chainId,
        ethersWallet,
        l2Creds,
        resolved.signatureType,
        resolved.funder || undefined,
      );

    let l2Creds = null;
    if (resolved.apiKey && resolved.secret && resolved.passphrase) {
      // Operator pre-supplied L2 credentials (cached): skip derivation entirely.
      l2Creds = { apiKey: resolved.apiKey, secret: resolved.secret, passphrase: resolved.passphrase };
    } else {
      // Derive L2 creds by signing an L1 EIP-712 message with the wallet.
      const provisional = buildClient(null);
      try {
        l2Creds = await provisional.createOrDeriveApiKey();
      } catch (error) {
        fail('BROKER_AUTH', `Polymarket could not derive API credentials: ${error?.message ?? error}`, { mode });
      }
      if (!l2Creds) fail('BROKER_AUTH', 'Polymarket API credential derivation returned nothing', { mode });
    }
    clobClient = buildClient(l2Creds);
    return clobClient;
  }

  const broker = {
    kind: 'polymarket',
    mode,

    /**
     * Polymarket trades 24/7 — there is no market clock. We always report open so the
     * engine's trading-hours gate never blocks a 24/7 outcome market. `nextOpen/Close`
     * are null by construction (no session boundaries).
     * @returns {Promise<{isOpen:boolean, timestamp:number|null, nextOpen:number|null, nextClose:number|null}>}
     */
    async getClock() {
      return { isOpen: true, timestamp: Date.now(), nextOpen: null, nextClose: null };
    },

    /**
     * Account equity. Polymarket collateral is pUSD (USDC, 6 decimals). Reads the
     * balance-allowance endpoint (authenticated) for the funder wallet; falls back to
     * the collateral balance as equity when no separate cash figure exists.
     * @returns {Promise<object>}
     */
    async getAccount() {
      const resolved = creds();
      if (!resolved || !resolved.funder) {
        fail(
          'BROKER_AUTH',
          'Polymarket getAccount requires POLY_FUNDER (the proxy/deposit wallet holding pUSD)',
          { mode },
        );
      }
      const client = await getClient();
      const raw = await client.getBalanceAllowance({
        assetType: 'COLLATERAL',
      });
      const balanceUsd = parseNumber(raw?.balance, 0) ?? 0;
      return {
        equityUsd: balanceUsd,
        cashUsd: balanceUsd,
        buyingPowerUsd: balanceUsd,
        optionsBuyingPowerUsd: 0,
        marginMultiplier: 1,
        shortingEnabled: false,
        optionsTradingLevel: 0,
        longMarketValueUsd: null,
        shortMarketValueUsd: null,
        maintenanceMarginUsd: null,
        status: 'ACTIVE',
        currency: 'USDC',
        mode,
      };
    },

    /**
     * Open outcome-token positions for the funder wallet, via the Data API. Each row is
     * normalized to the engine position shape; `symbol` is the token_id.
     * @returns {Promise<Array<object>>}
     */
    async getPositions() {
      const resolved = creds();
      if (!resolved || !resolved.funder) return [];
      const rows = await publicRequest(dataBase, `/positions`, {
        query: { user: resolved.funder, sizeThreshold: 0 },
      });
      const list = Array.isArray(rows) ? rows : [];
      return list.map(mapPolymarketPosition).filter(Boolean);
    },

    /**
     * Order book for one outcome token. Public (no auth). `symbol` is a token_id.
     * @param {string} symbol token_id
     * @returns {Promise<object>} {symbol, bids, asks, bestBid, bestAsk, mid, spread}
     */
    async getOrderBook(symbol) {
      const tokenId = String(symbol ?? '').trim();
      if (!tokenId) fail('DATA_MISSING', 'getOrderBook requires a token_id');
      const raw = await publicRequest(clobBase, `/book`, { query: { token_id: tokenId } });
      return mapOrderBook(raw, tokenId);
    },

    /**
     * Asset permissions for the instrument gates. Outcome tokens are always tradable,
     * never shortable (you express "short YES" by buying NO), and never marginable.
     * @param {string} symbol token_id
     * @returns {Promise<object>}
     */
    async getAsset(symbol) {
      const tokenId = String(symbol ?? '').trim();
      if (!tokenId) fail('DATA_MISSING', 'getAsset requires a token_id');
      return {
        symbol: tokenId,
        assetClass: 'polymarket_outcome',
        tradable: true,
        shortable: false,
        marginable: false,
        fractionable: false,
        easyToBorrow: false,
        maintenanceMarginPct: null,
      };
    },

    /**
     * Recent orders (authenticated). `status` maps onto the CLOB filter.
     * @param {{status?: string, limit?: number}} [query]
     * @returns {Promise<Array<object>>}
     */
    async getOrders({ status = 'all', limit = 100 } = {}) {
      const client = await getClient();
      const raw = await client.getOrders({
        ...(status !== 'all' ? { status } : {}),
        ...(Number.isFinite(Number(limit)) ? { limit: Math.max(1, Math.min(500, Number(limit))) } : {}),
      });
      const rows = Array.isArray(raw) ? raw : [];
      return rows.map(mapPolymarketOrder).filter(Boolean);
    },

    /** One order by id (authenticated). */
    async getOrder(id) {
      if (!id) fail('SPEC_INVALID', 'getOrder requires an order id');
      const client = await getClient();
      return mapPolymarketOrder(await client.getOrder(String(id)));
    },

    /**
     * Submit an order. `order.symbol` is the token_id; `side` is BUY/SELL; price is the
     * outcome probability in [tick, 1-tick]; `qty` is shares (not USD). Signed locally
     * via EIP-712 by the SDK — the private key never leaves the machine.
     * @param {object} order
     * @returns {Promise<object>} normalized order with id + status
     */
    async submitOrder(order = {}) {
      const tokenId = String(order.symbol ?? '').trim();
      if (!tokenId) fail('SPEC_INVALID', 'submitOrder requires symbol (token_id)');
      const side = String(order.side ?? '').toUpperCase();
      if (side !== 'BUY' && side !== 'SELL') {
        fail('SPEC_INVALID', 'submitOrder side must be BUY or SELL', { side: order.side });
      }
      const price = parseNumber(order.price ?? order.limitPrice, null);
      if (!Number.isFinite(price) || price <= 0 || price >= 1) {
        fail('SPEC_INVALID', 'submitOrder price must be an outcome probability in (0,1)', { price });
      }
      const size = parseNumber(order.qty, parseNumber(order.notional, null));
      if (!Number.isFinite(size) || size <= 0) {
        fail('SPEC_INVALID', 'submitOrder requires qty (shares)', { qty: order.qty });
      }
      const client = await getClient();
      // Read tick size so we round to a market-valid increment before signing.
      let tickSize = '0.01';
      try {
        const tick = await publicRequest(clobBase, `/tick-size`, { query: { token_id: tokenId } });
        const min = parseNumber(tick?.minimum_tick_size, 0.01);
        tickSize = String(min);
      } catch {
        /* default to 0.01 if the read fails; the exchange will reject off-tick prices */
      }
      const signed = await client.createOrder({
        token_id: tokenId,
        price: roundToTick(price, Number(tickSize)),
        size,
        side,
      });
      const response = await client.postOrder(signed, 'GTC');
      return mapPolymarketOrder({
        id: response?.orderID ?? response?.id ?? null,
        symbol: tokenId,
        side,
        qty: size,
        price: String(price),
        status: response?.status ?? 'submitted',
        type: 'limit',
        time_in_force: 'gtc',
      });
    },

    /** Cancel one order (authenticated). */
    async cancelOrder(id) {
      if (!id) fail('SPEC_INVALID', 'cancelOrder requires an order id');
      const client = await getClient();
      await client.cancel(String(id));
      return { id: String(id), status: 'canceled' };
    },

    /**
     * Probability bars for one or more outcome tokens, built from the CLOB
     * `/prices-history` endpoint (public, no auth). Each token's implied probability over
     * time is the price series; we bucket it into OHLC bars of the requested timeframe.
     *
     * This is REAL venue data, not a stub: the probability of an outcome evolving over time
     * is exactly the price series a probability-driven strategy consumes. Volume is the
     * number of price prints per bucket (Polymarket does not expose traded size here).
     *
     * @param {{ symbols: string|string[], timeframe?: string, limit?: number, start?: string, end?: string }} params
     * @returns {Promise<Record<string, Array<object>>>} map symbol -> ascending bars {t,o,h,l,c,v}
     */
    async getBars({ symbols, timeframe = '1Hour', limit = 120, start, end } = {}) {
      const list = normalizeSymbols(symbols);
      if (list.length === 0) fail('DATA_MISSING', 'getBars requires at least one symbol (token_id)');
      const effectiveLimit = Math.max(1, Math.min(5000, Number(limit) || 120));
      const intervalMs = timeframeToMs(timeframe);
      const nowMs = Date.now();
      const effectiveEndMs = end ? Date.parse(end) : nowMs;
      const effectiveStartMs = start ? Date.parse(start) : nowMs - Math.min(intervalMs * effectiveLimit * 4, 400 * DAY_MS);

      /** @type {Record<string, Array<object>>} */
      const out = {};
      await Promise.all(
        list.map(async (symbol) => {
          try {
            // /prices-history requires a time window as startTs/endTs (epoch SECONDS) or a
            // named interval. We always send startTs/endTs derived from the timeframe so the
            // bars line up with the requested window.
            const query = {
              market: symbol,
              // Polymarket fidelity is in minutes; align to the timeframe bucket.
              fidelity: Math.max(1, Math.min(1440, Math.round(intervalMs / 60_000))),
              ...(Number.isFinite(effectiveStartMs) ? { startTs: Math.floor(effectiveStartMs / 1000) } : {}),
              ...(Number.isFinite(effectiveEndMs) ? { endTs: Math.floor(effectiveEndMs / 1000) } : {}),
            };
            const raw = await publicRequest(clobBase, '/prices-history', { query });
            const history = Array.isArray(raw?.history) ? raw.history : [];
            out[symbol] = bucketProbabilityHistory(history, intervalMs).slice(-effectiveLimit);
          } catch (error) {
            // A closed/unknown token yields no history rather than failing the batch.
            if (error?.code === 'DATA_MISSING' || error?.code === 'BROKER_ERROR') {
              out[symbol] = [];
              return;
            }
            throw error;
          }
        }),
      );
      return out;
    },

    /**
     * Latest probability quote for one token. Returns a normalized quote shape the
     * executor expects: { symbol, priceUsd, bidUsd, askUsd, sizeUsd, ts }.
     * @param {string} symbol token_id
     * @returns {Promise<object>}
     */
    async getLatestQuote(symbol) {
      const tokenId = String(symbol ?? '').trim();
      if (!tokenId) fail('DATA_MISSING', 'getLatestQuote requires a token_id');
      const book = await this.getOrderBook(tokenId);
      return {
        symbol: tokenId,
        priceUsd: book.mid,
        bidUsd: book.bestBid,
        askUsd: book.bestAsk,
        sizeUsd: null,
        ts: book.ts,
      };
    },

    /**
     * No bar streaming on Polymarket: outcome markets are polled, not pushed. Returns
     * the poll interval so callers degrade gracefully.
     */
    async advanceBar() {
      return { intervalMs: 60_000, streaming: false };
    },

    /** Base URL of the CLOB data host (diagnostics only). */
    getDataUrl() {
      return clobBase;
    },

    /** Polymarket has no options. Returned as an empty chain so instrument gates degrade. */
    async getOptionChain() {
      return [];
    },

    /** No options market: no quote. */
    async getOptionQuote() {
      return null;
    },
  };

  return broker;
}

// ---------------------------------------------------------------------------
// mapping helpers
// ---------------------------------------------------------------------------

/** Round a price to a market tick increment (avoids off-tick rejections). */
function roundToTick(price, tick) {
  if (!Number.isFinite(tick) || tick <= 0) return price;
  const decimals = Math.max(0, Math.round(-Math.log10(tick)));
  return Number((Math.round(price / tick) * tick).toFixed(decimals));
}

/**
 * Bucket a probability history (list of {t, p} seconds/ms timestamps) into OHLC bars of
 * `intervalMs` width. Each bar's o/h/l/c come from the first/max/min/last probability in
 * the bucket; volume is the number of prints (Polymarket prices-history carries no size).
 * Returns ascending bars (oldest first).
 */
function bucketProbabilityHistory(history, intervalMs) {
  const prints = history
    .map((point) => {
      const rawT = parseTimestamp(point?.t);
      const p = parseNumber(point?.p, null);
      if (rawT === null || p === null) return null;
      // prices-history returns epoch SECONDS; normalize to ms.
      const tMs = rawT < 1e12 ? rawT * 1000 : rawT;
      return { tMs, p };
    })
    .filter(Boolean)
    .sort((a, b) => a.tMs - b.tMs);
  if (prints.length === 0) return [];
  const bars = [];
  let bucketStart = null;
  let current = null;
  const flush = () => {
    if (current) bars.push(current);
  };
  for (const print of prints) {
    const start = Math.floor(print.tMs / intervalMs) * intervalMs;
    if (bucketStart !== start) {
      flush();
      bucketStart = start;
      current = { t: start, o: print.p, h: print.p, l: print.p, c: print.p, v: 1 };
    } else {
      current.h = Math.max(current.h, print.p);
      current.l = Math.min(current.l, print.p);
      current.c = print.p;
      current.v += 1;
    }
  }
  flush();
  return bars;
}

/** Map a CLOB order book to the engine book shape (bids desc, asks asc). */
function mapOrderBook(raw, tokenId) {
  const bids = Array.isArray(raw?.bids) ? raw.bids.map(mapLevel).filter(Boolean) : [];
  const asks = Array.isArray(raw?.asks) ? raw.asks.map(mapLevel).filter(Boolean) : [];
  // CLOB returns bids ascending; the engine expects best (highest) bid first.
  bids.sort((a, b) => b.price - a.price);
  asks.sort((a, b) => a.price - b.price);
  const bestBid = bids[0]?.price ?? null;
  const bestAsk = asks[0]?.price ?? null;
  const mid =
    bestBid !== null && bestAsk !== null ? Number(((bestBid + bestAsk) / 2).toFixed(6)) : (bestBid ?? bestAsk);
  return {
    symbol: tokenId,
    bids,
    asks,
    bestBid,
    bestAsk,
    mid,
    spread: bestBid !== null && bestAsk !== null ? Number((bestAsk - bestBid).toFixed(6)) : null,
    ts: parseTimestamp(raw?.timestamp),
  };
}

function mapLevel(raw) {
  const price = parseNumber(raw?.price, null);
  const size = parseNumber(raw?.size, null);
  if (price === null || size === null) return null;
  return { price, size };
}

/** Map a Data-API position row to the engine position shape (symbol = token_id). */
function mapPolymarketPosition(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const tokenId = String(raw.asset ?? raw.token_id ?? raw.tokenId ?? '').trim();
  if (tokenId === '') return null;
  const qtySigned = parseNumber(raw.size ?? raw.amount, 0) ?? 0;
  const avgPrice = parseNumber(raw.avgPrice ?? raw.avg_price, null);
  const curPrice = parseNumber(raw.curPrice ?? raw.current_price ?? raw.price, null);
  const marketValue = parseNumber(raw.currentValue ?? raw.market_value, null) ?? qtySigned * (curPrice ?? 0);
  return {
    symbol: tokenId,
    assetClass: 'polymarket_outcome',
    qty: qtySigned,
    qtySigned,
    avgEntryPriceUsd: avgPrice,
    avgPriceUsd: avgPrice,
    marketValueUsd: marketValue,
    unrealizedPlUsd:
      parseNumber(raw.unrealizedPnl ?? raw.unrealized_pnl, null) ??
      (avgPrice !== null ? qtySigned * ((curPrice ?? avgPrice) - avgPrice) : null),
    side: qtySigned >= 0 ? 'long' : 'short',
    multiplier: 1,
    option: null,
  };
}

/** Map a CLOB order row to the engine order shape. */
function mapPolymarketOrder(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const symbol = String(raw.symbol ?? raw.token_id ?? raw.asset_id ?? '').trim();
  return {
    id: raw.id ?? raw.orderID ?? raw.orderId ?? null,
    clientOrderId: raw.client_order_id ?? null,
    symbol,
    side: raw.side ?? null,
    qty: parseNumber(raw.qty ?? raw.size ?? raw.original_size, 0),
    filledQty: parseNumber(raw.filled_qty ?? raw.size_matched, 0),
    avgFillPriceUsd: parseNumber(raw.avg_fill_price ?? raw.price, null),
    filledAvgPriceUsd: parseNumber(raw.avg_fill_price ?? raw.price, null),
    status: raw.status ?? null,
    submittedAt: parseTimestamp(raw.submitted_at ?? raw.createdAt ?? raw.created_at),
    filledAt: parseTimestamp(raw.filled_at),
    type: raw.type ?? null,
    notionalUsd: parseNumber(raw.notional, null),
    assetClass: 'polymarket_outcome',
    orderClass: 'simple',
    positionIntent: null,
    timeInForce: raw.time_in_force ?? null,
    legs: [],
    limitPrice: parseNumber(raw.price, null),
  };
}

export default createBroker;
