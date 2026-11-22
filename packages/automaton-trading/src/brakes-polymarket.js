/**
 * brakes-polymarket.js — the hard order wall for the outcome-market venue.
 *
 * A venue-specific port of brakes.js. It keeps the rules that are universal to trading
 * risk and drops the ones that only make sense for equities/options/margin:
 *
 *   KEPT (universal):
 *     D1  transfers/withdrawals/bridges never exist on this broker surface
 *     D3  a market must be open/tradable before an order (Polymarket is 24/7, so this is
 *         effectively always open, but we still gate on the broker clock for symmetry)
 *     D5  per-order notional, per-position %, and max open positions
 *     D6  daily order cap and one order per token per cycle
 *     D7  loss limits and drawdown are fatal (death), never a pause; dead/halted = exit-only
 *     D11 operator kill-switch file blocks every order
 *     D13 allocated capital can never exceed allocationCapPct of account equity
 *
 *   DROPPED (equity/derivatives only — no equivalent on Polymarket):
 *     D15 short sales (you express "short YES" by buying NO)
 *     D16 options structures, DTE windows, covered calls, spreads
 *     D17 margin debt / buying power / leverage
 *
 *   ADDED (venue-specific):
 *     DL  LIQUIDITY — the order must be fillable within the slippage budget given the
 *         live book, and its notional must not be an outsized share of book depth.
 *         This is the thin-market wall: without it an agent moves the market against
 *         itself and the Reaper's liquidation cannot fill.
 *
 * Outcome-market specifics enforced here:
 *   - `symbol` is a token_id; price is a probability in (0,1), never 0 or 1.
 *   - side is BUY or SELL only (no short-sale concept).
 *   - a BUY of token T is a bet the event resolves to T; a SELL is closing/laying off.
 *
 * Contract: docs/CONTRACTS.md § "Broker interface".
 * Owner: strategy layer. Do not edit from other modules.
 *
 * @module brakes-polymarket
 */

import fs from 'node:fs';
import { fail } from './contracts.js';
import { statePaths } from './config.js';
import { createLiquidity } from './liquidity.js';

const EPSILON = 1e-9;

/** Stable codes for the outcome-market brake catalogue. */
export const BRAKES_POLY = Object.freeze([
  { id: 'D1', code: 'TRANSFER_FORBIDDEN', rule: 'No transfers, withdrawals, or bridges exist in the broker client.' },
  { id: 'D3', code: 'MARKET_CLOSED', rule: 'No orders when the venue reports the market closed.' },
  { id: 'D5', code: 'SIZE_FORBIDDEN', rule: 'Per-order notional, per-position %, and max open positions are capped.' },
  { id: 'D6', code: 'RATE_FORBIDDEN', rule: 'Daily order cap per agent and max one order per token per cycle.' },
  { id: 'D7', code: 'LOSS_LIMIT', rule: 'Daily loss and drawdown limits are fatal; dead/halted is exit-only.' },
  { id: 'D11', code: 'KILL_SWITCH', rule: 'Operator kill-switch file blocks every order.' },
  { id: 'D13', code: 'ALLOCATION_FORBIDDEN', rule: 'Allocated capital never exceeds allocationCapPct of account equity.' },
  { id: 'DL', code: 'LIQUIDITY_FORBIDDEN', rule: 'Order must fill within the slippage budget and not dominate book depth.' },
]);

const BRAKE_BY_ID = Object.freeze(Object.fromEntries(BRAKES_POLY.map((brake) => [brake.id, brake])));

/**
 * @param {{ config: object, paths?: object, clock?: { now: () => number }, liquidity?: object }} options
 */
export function createBrakesPolymarket({ config, paths, clock, liquidity } = {}) {
  if (!config || typeof config !== 'object') {
    fail('CONFIG_INVALID', 'createBrakesPolymarket requires a config object', {});
  }
  const currentClock = clock && typeof clock.now === 'function' ? clock : { now: () => Date.now() };
  const liq = liquidity ?? createLiquidity({
    maxSlippagePct: Number(config.polymarket?.maxSlippagePct ?? 0.02),
    maxNotionalShareOfDepth: Number(config.polymarket?.maxNotionalShareOfDepth ?? 0.25),
  });

  // Resolve the kill-switch path defensively: prefer an explicit paths.killSwitch, and
  // only fall back to statePaths(config) when a full (loadConfig) config is present. A
  // minimal config must not crash construction — the kill switch simply stays unarmed.
  let killSwitchPath = paths?.killSwitch ?? null;
  if (!killSwitchPath && config?.paths?.stateDir) {
    try {
      killSwitchPath = statePaths(config).killSwitch ?? null;
    } catch {
      killSwitchPath = null;
    }
  }

  function killSwitchPresent() {
    if (!killSwitchPath) return false;
    try {
      return fs.existsSync(killSwitchPath);
    } catch {
      return false;
    }
  }

  /**
   * The single entry point the Polymarket executor calls before any order.
   *
   * @param {object} input
   * @param {object} input.order { symbol(token_id), side, price(probability), qty(shares) }
   * @param {object} [input.mandate] Treasurer mandate (sizeBudgetUsd, maxOrderNotionalUsd,
   *                                  maxDailyOrdersRemaining, allowExitOnly)
   * @param {object} [input.dayStats] { ordersCount, tokensThisCycle }
   * @param {object} [input.positions] map token_id -> { qty, valueUsd }
   * @param {number} [input.equityUsd]
   * @param {object} [input.book] { side, bestPriceUsd, levels:[{price,size}] } for the
   *                              relevant side of the live order book (DL gate)
   * @param {number} [input.accountEquityUsd]
   * @param {number} [input.allocatedEquityUsd]
   * @returns {{ decision:'ALLOW'|'DENY', code:string|null, brakeId:string|null, reason:string, sizeCap?:number }}
   */
  function checkOrder(input = {}) {
    const params = input && typeof input === 'object' ? input : {};
    const order = params.order;
    const dayStats = params.dayStats && typeof params.dayStats === 'object' ? params.dayStats : {};
    const mandate = params.mandate && typeof params.mandate === 'object' ? params.mandate : null;
    const positions = params.positions && typeof params.positions === 'object' ? params.positions : {};
    const risk = config.risk ?? {};

    const deny = (brakeId, reason, extra = {}) => ({
      decision: 'DENY',
      code: BRAKE_BY_ID[brakeId]?.code ?? 'BRAKE_DENIED',
      brakeId,
      reason,
      ...extra,
    });
    const allow = (reason = 'all brakes passed', extra = {}) => ({
      decision: 'ALLOW',
      code: null,
      brakeId: null,
      reason,
      ...extra,
    });

    // ---- D11: operator kill switch, before anything else ------------------------
    if (killSwitchPresent()) {
      return deny('D11', `kill switch armed: ${killSwitchPath} exists; every order is denied`);
    }

    if (!order || typeof order !== 'object') {
      return deny('D1', 'order is malformed: a BUY/SELL order object is required');
    }
    const symbol = String(order.symbol ?? '').trim();
    const side = String(order.side ?? '').toUpperCase();
    if (symbol === '') return deny('D1', 'order.symbol (token_id) is required');
    if (side !== 'BUY' && side !== 'SELL') return deny('D1', `order.side must be BUY or SELL (got ${order.side})`);
    const price = Number(order.price);
    if (!Number.isFinite(price) || price <= 0 || price >= 1) {
      return deny('D1', `order.price must be an outcome probability in (0,1) (got ${order.price})`);
    }
    const qty = Number(order.qty);
    if (!Number.isFinite(qty) || qty <= 0) return deny('D1', `order.qty (shares) must be positive (got ${order.qty})`);
    const notionalUsd = qty * price;

    // ---- D3: venue must be open (Polymarket is 24/7; gate keeps symmetry + tests) --
    if (params.marketOpen === false) {
      return deny('D3', 'venue reports the market closed');
    }

    // ---- D7 at order time: no mandate (dead/halted) => no new exposure ----------
    if (!mandate) {
      return deny('D7', 'no Treasurer mandate: the agent is dead/halted or has not been sized');
    }
    if (typeof mandate.agentId === 'string' && typeof params.agentId === 'string' && mandate.agentId !== params.agentId) {
      return deny('D7', `mandate belongs to "${mandate.agentId}", not "${params.agentId}"`);
    }
    const halted = params.halted === true || mandate.allowExitOnly === true;
    const isClosing = params.isClosing === true;
    if (halted && side === 'BUY' && !isClosing) {
      return deny('D7', 'treasury is halted: exit-only, new exposure is denied');
    }

    // ---- D5: mandate size caps, position concentration, open positions ---------
    const equityUsd = Number(params.equityUsd);
    if (!Number.isFinite(equityUsd) || equityUsd <= 0) {
      return deny('D5', 'agent equity is unavailable; cannot size the order');
    }
    const caps = [
      Number(risk.maxOrderNotionalUsd),
      Number(risk.maxOrderPctOfEquity) * equityUsd,
      Number(mandate.maxOrderNotionalUsd),
      Number(mandate.sizeBudgetUsd),
    ].filter((cap) => Number.isFinite(cap) && cap > 0);
    if (caps.length > 0) {
      const cap = Math.min(...caps);
      if (notionalUsd > cap + EPSILON) {
        return deny('D5', `order notional ${notionalUsd.toFixed(2)} exceeds the mandate/risk cap ${cap.toFixed(2)}`);
      }
    }
    const held = positions[symbol] ?? { qty: 0, valueUsd: 0 };
    const opensExposure = side === 'BUY' && !isClosing;
    if (opensExposure) {
      const existingValue = Number(held.valueUsd) || 0;
      const projected = existingValue + notionalUsd;
      const maxPositionValue = Number(risk.maxPositionPct ?? 0) * equityUsd;
      if (projected > maxPositionValue + EPSILON) {
        return deny('D5', `position notional in token would be ${projected.toFixed(2)} (above the ${risk.maxPositionPct} of equity cap)`);
      }
      const isNewPosition = !(Number(held.qty) > 0);
      if (isNewPosition) {
        const openCount = Object.values(positions).filter((position) => (Number(position.qty) || 0) !== 0).length;
        if (openCount >= Number(risk.maxOpenPositions ?? Infinity)) {
          return deny('D5', `already holding ${openCount} positions; maxOpenPositions is ${risk.maxOpenPositions}`);
        }
      }
    }

    // ---- D6: daily order cap and one order per token per cycle ----------------
    const ordersCount = Number(dayStats.ordersCount) || 0;
    if (ordersCount >= Number(risk.maxDailyOrders)) {
      return deny('D6', `daily order cap reached (${ordersCount}/${risk.maxDailyOrders})`);
    }
    const remaining = Number(mandate.maxDailyOrdersRemaining);
    if (Number.isFinite(remaining) && remaining <= 0) {
      return deny('D6', 'mandate has no daily orders remaining');
    }
    const cycleTokens = new Set(
      (Array.isArray(dayStats.tokensThisCycle) ? dayStats.tokensThisCycle : []).map((item) => String(item)),
    );
    if (cycleTokens.has(symbol)) {
      return deny('D6', `already ordered this token this cycle (one order per token per cycle)`);
    }
    const ordersThisCycle = Number(dayStats.ordersThisCycle);
    if (Number.isFinite(ordersThisCycle) && ordersThisCycle >= Number(risk.maxOrdersPerCycle)) {
      return deny('D6', `cycle order cap reached (${ordersThisCycle}/${risk.maxOrdersPerCycle})`);
    }

    // ---- D13: allocated capital never exceeds allocationCapPct -----------------
    if (side === 'BUY' && !isClosing) {
      const accountEquityUsd = Number(params.accountEquityUsd);
      const allocatedEquityUsd = Number(params.allocatedEquityUsd);
      const allocationsKnown = !(
        Number.isFinite(accountEquityUsd) &&
        accountEquityUsd === equityUsd &&
        allocatedEquityUsd === equityUsd
      );
      if (Number.isFinite(accountEquityUsd) && accountEquityUsd > 0 && Number.isFinite(allocatedEquityUsd) && allocationsKnown) {
        const allocationCap = Number(config.account?.allocationCapPct ?? 0) * accountEquityUsd;
        if (allocatedEquityUsd + notionalUsd > allocationCap + EPSILON) {
          return deny('D13', `allocation ${(allocatedEquityUsd + notionalUsd).toFixed(2)} would exceed ${(config.account?.allocationCapPct ?? 0) * 100}% of account equity`);
        }
      }
    }

    // ---- DL: thin-market liquidity gate ---------------------------------------
    if (params.book && typeof params.book === 'object') {
      const book = params.book;
      const depth = liq.checkDepth(
        { side, bestPriceUsd: Number(book.bestPriceUsd), levels: Array.isArray(book.levels) ? book.levels : [] },
        qty,
      );
      if (!depth.allowed) {
        return deny('DL', `liquidity gate: ${depth.reason}`, { sizeCap: depth.sizeCap });
      }
      return allow('all brakes passed (incl. liquidity)', { sizeCap: depth.sizeCap, avgPriceUsd: depth.avgPriceUsd });
    }

    return allow();
  }

  /** The outcome-market brake catalogue (for the UI and tests). */
  function describe() {
    return BRAKES_POLY.map((brake) => ({ ...brake }));
  }

  return { checkOrder, describe };
}

export default createBrakesPolymarket;
