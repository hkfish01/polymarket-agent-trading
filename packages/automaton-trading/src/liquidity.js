/**
 * liquidity.js — order-book depth and slippage estimation (the thin-market wall).
 *
 * Polymarket outcome markets are far thinner than listed equities. An agent that sizes a
 * trade off equity alone can move the market against itself, and the Reaper's
 * market-sell liquidation can fail to fill at a sane price. This module is the pre-trade
 * wall that stops both:
 *
 *   - walk the live book and accumulate notional to fill a target size;
 *   - estimate the realized (volume-weighted) price and the slippage vs the top of book;
 *   - expose `sizeCapForNotional`, the largest size tradeable within a slippage budget.
 *
 * This is the venue-specific gate brakes.js calls before allowing an outcome-market
 * order. Equity markets assume you can fill at the mark; outcome markets cannot make
 * that assumption, so we check depth explicitly.
 *
 * Owner: market teammate. Do not edit from other modules.
 *
 * @module liquidity
 */

import { fail } from './contracts.js';

/**
 * Create the liquidity estimator.
 * @param {{ maxSlippagePct?: number, maxNotionalShareOfDepth?: number }} [limits]
 *        maxSlippagePct: reject a fill whose realized price moves worse than this % off
 *                        the top of book (e.g. 0.02 = 2%).
 *        maxNotionalShareOfDepth: reject a fill whose notional exceeds this share of the
 *                        total book depth on the relevant side (e.g. 0.25 = 25%).
 */
export function createLiquidity(limits = {}) {
  const maxSlippagePct = Number(limits.maxSlippagePct ?? 0.02);
  const maxNotionalShareOfDepth = Number(limits.maxNotionalShareOfDepth ?? 0.25);

  /**
   * Walk one side of the book to fill `size` shares, accumulating notional and computing
   * the volume-weighted realized price.
   *
   * Book levels are `{price, size}`. For a BUY we consume asks (ascending, cheapest
   * first). For a SELL we consume bids (descending, highest first).
   *
   * @param {Array<{price:number,size:number}>} levels one side of the book (any order)
   * @param {number} size shares to fill (positive)
   * @param {'BUY'|'SELL'} side
   * @returns {{ fillableSize:number, notionalUsd:number, avgPriceUsd:number|null,
   *             topPriceUsd:number|null, slippagePct:number|null, levelsConsumed:number,
   *             fullyFilled:boolean }}
   */
  function estimateFill(levels, size, side) {
    const wanted = Number(size);
    if (!Number.isFinite(wanted) || wanted <= 0) {
      fail('SPEC_INVALID', 'estimateFill requires a positive size', { size });
    }
    const normalized = (Array.isArray(levels) ? levels : [])
      .map((level) => ({ price: Number(level?.price), size: Number(level?.size) }))
      .filter((level) => Number.isFinite(level.price) && level.price > 0 && Number.isFinite(level.size) && level.size > 0);
    if (normalized.length === 0) {
      return {
        fillableSize: 0,
        notionalUsd: 0,
        avgPriceUsd: null,
        topPriceUsd: null,
        slippagePct: null,
        levelsConsumed: 0,
        fullyFilled: false,
      };
    }
    // Sort so we consume the best price first for the given side.
    const sorted = side === 'BUY' ? normalized.sort((a, b) => a.price - b.price) : normalized.sort((a, b) => b.price - a.price);
    const topPrice = sorted[0].price;
    let remaining = wanted;
    let notional = 0;
    let filled = 0;
    let consumed = 0;
    for (const level of sorted) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, level.size);
      notional += take * level.price;
      filled += take;
      remaining -= take;
      consumed += 1;
    }
    const fullyFilled = remaining <= 1e-9;
    const avgPrice = filled > 0 ? notional / filled : null;
    const slippagePct =
      avgPrice !== null && topPrice > 0
        ? (side === 'BUY' ? (avgPrice - topPrice) / topPrice : (topPrice - avgPrice) / topPrice)
        : null;
    return {
      fillableSize: filled,
      notionalUsd: notional,
      avgPriceUsd: avgPrice,
      topPriceUsd: topPrice,
      slippagePct,
      levelsConsumed: consumed,
      fullyFilled,
    };
  }

  /**
   * The gate brakes.js calls. Decide whether a target order is tradeable given the live
   * book, and at what realized price.
   *
   * @param {{ bestPriceUsd: number|null, levels: Array<{price:number,size:number}>, side:'BUY'|'SELL' }} book
   *        For a BUY pass the asks (and bestAsk); for a SELL pass the bids (and bestBid).
   * @param {number} size shares wanted
   * @returns {{ allowed:boolean, reason:string|null, avgPriceUsd:number|null,
   *             slippagePct:number|null, notionalUsd:number, sizeCap:number }}
   */
  function checkDepth(book, size) {
    const side = String(book?.side ?? '').toUpperCase();
    if (side !== 'BUY' && side !== 'SELL') {
      fail('SPEC_INVALID', 'checkDepth requires side BUY or SELL', { side: book?.side });
    }
    const levels = Array.isArray(book?.levels) ? book.levels : [];
    const estimate = estimateFill(levels, Math.max(1e-9, Number(size) || 0), side);

    if (estimate.fillableSize <= 0 || estimate.topPriceUsd === null) {
      return { allowed: false, reason: 'empty_book', avgPriceUsd: null, slippagePct: null, notionalUsd: 0, sizeCap: 0 };
    }
    if (!estimate.fullyFilled) {
      return {
        allowed: false,
        reason: 'insufficient_depth',
        avgPriceUsd: estimate.avgPriceUsd,
        slippagePct: estimate.slippagePct,
        notionalUsd: estimate.notionalUsd,
        sizeCap: estimate.fillableSize,
      };
    }
    if (estimate.slippagePct !== null && estimate.slippagePct > maxSlippagePct) {
      // Walk back to the largest size that stays within the slippage budget.
      const sizeCap = sizeCapForSlippage(levels, side, maxSlippagePct);
      return {
        allowed: false,
        reason: `slippage ${(estimate.slippagePct * 100).toFixed(2)}% exceeds max ${(maxSlippagePct * 100).toFixed(2)}%`,
        avgPriceUsd: estimate.avgPriceUsd,
        slippagePct: estimate.slippagePct,
        notionalUsd: estimate.notionalUsd,
        sizeCap,
      };
    }
    const totalDepth = levels.reduce((sum, level) => sum + Number(level?.size ?? 0), 0);
    const notionalShare = totalDepth > 0 ? estimate.notionalUsd / (estimate.notionalUsd + totalDepth * estimate.topPriceUsd) : 1;
    if (maxNotionalShareOfDepth > 0 && notionalShare > maxNotionalShareOfDepth) {
      return {
        allowed: false,
        reason: `notional is ${(notionalShare * 100).toFixed(1)}% of book depth (max ${(maxNotionalShareOfDepth * 100).toFixed(1)}%)`,
        avgPriceUsd: estimate.avgPriceUsd,
        slippagePct: estimate.slippagePct,
        notionalUsd: estimate.notionalUsd,
        sizeCap: estimate.fillableSize,
      };
    }
    return {
      allowed: true,
      reason: null,
      avgPriceUsd: estimate.avgPriceUsd,
      slippagePct: estimate.slippagePct,
      notionalUsd: estimate.notionalUsd,
      sizeCap: estimate.fillableSize,
    };
  }

  /**
   * Largest size (shares) fillable within a slippage budget, walking the book greedily.
   * Binary-search-free: we accumulate levels and stop when crossing the budget.
   */
  function sizeCapForSlippage(levels, side, budget) {
    const sorted = side === 'BUY' ? [...levels].sort((a, b) => a.price - b.price) : [...levels].sort((a, b) => b.price - a.price);
    if (sorted.length === 0) return 0;
    const top = Number(sorted[0].price);
    let notional = 0;
    let filled = 0;
    let prevNotional = 0;
    let prevFilled = 0;
    for (const level of sorted) {
      const price = Number(level.price);
      const levelSize = Number(level.size);
      notional += levelSize * price;
      filled += levelSize;
      const avg = notional / filled;
      const slip = side === 'BUY' ? (avg - top) / top : (top - avg) / top;
      if (slip > budget) {
        // Interpolate within this level for a tighter cap.
        if (filled - prevFilled > 0 && notional > prevNotional) {
          const avgPrev = prevFilled > 0 ? prevNotional / prevFilled : top;
          const slipPrev = side === 'BUY' ? (avgPrev - top) / top : (top - avgPrev) / top;
          if (slip > slipPrev) {
            const frac = (budget - slipPrev) / (slip - slipPrev);
            return prevFilled + frac * (filled - prevFilled);
          }
        }
        return prevFilled;
      }
      prevNotional = notional;
      prevFilled = filled;
    }
    return filled;
  }

  return { estimateFill, checkDepth };
}

export default createLiquidity;
