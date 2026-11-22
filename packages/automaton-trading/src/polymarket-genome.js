/**
 * polymarket-genome.js — the outcome-market probability genome + single-mutation rule.
 *
 * The stock MEAT genome (MUTABLE in replicator.js) encodes technical parameters
 * (lookback, entryZ, stopPct...) that only make sense against price bars. An outcome
 * market has no K-line technicals: the tradable signal is a PROBABILITY JUDGMENT
 * ("this resolves Yes with ~62% confidence; the market prices 45% — I buy Yes").
 *
 * This module defines the probability genome the Polymarket strategy layer evolves, and
 * preserves the one invariant that makes the evolution interpretable:
 *
 *     a child is the parent's genome plus EXACTLY ONE mutation.
 *
 * One mutation, because changing several axes at once teaches the population nothing —
 * you cannot attribute a child's performance to any single gene. This is copied verbatim
 * from replicator.js's design intent (docs/CONTRACTS.md "Mortality modules").
 *
 * Genome fields (all probability/sizing semantics, no price technicals):
 *   edgeThreshold    min |ourProbability - marketPrice| to act at all (mispricing floor)
 *   kellyFraction    fraction of full Kelly to bet (fractional Kelly damps over-betting)
 *   maxPositionPct   hard cap on notional as a fraction of agent equity
 *   minConfidence    min model confidence (0-1) to open a position
 *   convictionPower  exponent on confidence when scaling size (convexity of conviction)
 *   exitEdge         |ourProbability - marketPrice| below which we take profit / exit
 *   stopOnProbability adverse probability move (against the position) that forces exit
 *   maxHoldHours     max hours to hold before a time-based exit
 *   maxOpenPositions max concurrent outcome positions per agent
 *   spreadMaxBps     max top-of-book spread (in bps of price) to enter
 *   negRiskAffinity  willingness (0-1) to trade multi-outcome (NegRisk) markets
 *
 * Owner: strategy layer. Do not edit from other modules.
 *
 * @module polymarket-genome
 */

import { fail } from './contracts.js';

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** Discrete option lists (single-mutation picks a DIFFERENT element deterministically). */
const EDGE_THRESHOLDS = Object.freeze([0.03, 0.05, 0.08, 0.1, 0.15, 0.2]);
const KELLY_FRACTIONS = Object.freeze([0.1, 0.2, 0.25, 0.33, 0.5, 0.75]);
const MAX_POSITION_PCTS = Object.freeze([0.05, 0.1, 0.15, 0.2, 0.3]);
const MIN_CONFIDENCES = Object.freeze([0.5, 0.55, 0.6, 0.65, 0.7, 0.75]);
const CONVICTION_POWERS = Object.freeze([0.5, 1, 1.5, 2]);
const EXIT_EDGES = Object.freeze([0.01, 0.02, 0.03, 0.05, 0.08]);
const STOP_ON_PROBABILITY = Object.freeze([0.05, 0.08, 0.1, 0.15, 0.2]);
const MAX_HOLD_HOURS = Object.freeze([6, 12, 24, 48, 72, 168]);
const MAX_OPEN_POSITIONS = Object.freeze([1, 2, 3, 4, 5]);
const SPREAD_MAX_BPS = Object.freeze([100, 200, 300, 500, 800]);
const NEGRISK_AFFINITIES = Object.freeze([0, 0.25, 0.5, 0.75, 1]);

/**
 * The mutable catalogue: exactly ONE of these changes per birth.
 * Signature: `(currentValue, rng) => newValue`; guaranteed to differ from `current`.
 */
export const MUTABLE = Object.freeze({
  edgeThreshold: (value, rng) => pickOther(rng, EDGE_THRESHOLDS, value),
  kellyFraction: (value, rng) => pickOther(rng, KELLY_FRACTIONS, value),
  maxPositionPct: (value, rng) => pickOther(rng, MAX_POSITION_PCTS, value),
  minConfidence: (value, rng) => pickOther(rng, MIN_CONFIDENCES, value),
  convictionPower: (value, rng) => pickOther(rng, CONVICTION_POWERS, value),
  exitEdge: (value, rng) => pickOther(rng, EXIT_EDGES, value),
  stopOnProbability: (value, rng) => pickOther(rng, STOP_ON_PROBABILITY, value),
  maxHoldHours: (value, rng) => pickOther(rng, MAX_HOLD_HOURS, value),
  maxOpenPositions: (value, rng) => pickOther(rng, MAX_OPEN_POSITIONS, value),
  spreadMaxBps: (value, rng) => pickOther(rng, SPREAD_MAX_BPS, value),
  negRiskAffinity: (value, rng) => pickOther(rng, NEGRISK_AFFINITIES, value),
});

/** Catalogue field names, in a stable order (useful for tests and the UI). */
export const MUTABLE_FIELDS = Object.freeze(Object.keys(MUTABLE));

/** Pick a different element deterministically from an option list. */
function pickOther(rng, options, current) {
  const pool = options.filter((option) => option !== current);
  if (pool.length === 0) return current;
  return pool[Math.floor(rng() * pool.length) % pool.length];
}

/** The genesis (first-generation) probability genome. */
export function genesisGenome() {
  return {
    edgeThreshold: 0.05,
    kellyFraction: 0.25,
    maxPositionPct: 0.15,
    minConfidence: 0.6,
    convictionPower: 1,
    exitEdge: 0.02,
    stopOnProbability: 0.1,
    maxHoldHours: 48,
    maxOpenPositions: 3,
    spreadMaxBps: 300,
    negRiskAffinity: 0.5,
  };
}

/**
 * Apply EXACTLY ONE mutation to a parent genome. Returns the child genome plus the
 * mutation record `{field, from, to}`. Refuses to produce a clone (throws if the
 * mutation cannot change the value).
 *
 * @param {object} parentGenome
 * @param {() => number} [rng]
 * @returns {{ childGenome: object, mutation: { field: string, from: unknown, to: unknown } }}
 */
export function mutate(parentGenome, rng = Math.random) {
  if (!isPlainObject(parentGenome)) fail('SPEC_INVALID', 'mutate requires a parent genome object', {});
  const currentRng = typeof rng === 'function' ? rng : Math.random;
  const field = MUTABLE_FIELDS[Math.floor(currentRng() * MUTABLE_FIELDS.length) % MUTABLE_FIELDS.length];
  const from = parentGenome[field];
  let to = from;
  for (let attempt = 0; attempt < 25 && to === from; attempt += 1) {
    to = MUTABLE[field](from, currentRng);
  }
  if (to === from) {
    fail('SPEC_INVALID', `mutation of "${field}" produced no change; refusing a clone`, { field, value: from });
  }
  return {
    childGenome: { ...parentGenome, [field]: to },
    mutation: { field, from: from === undefined ? null : from, to },
  };
}

/**
 * Position size (shares) for one judgment, using fractional Kelly on the estimated edge.
 *
 * Kelly for a binary outcome at decimal odds implied by the market price:
 *   p = our probability, q = 1 - p, b = (1/marketPrice - 1) for a Yes bet
 *   f* = (p*b - q) / b, scaled by kellyFraction and clamped to maxPositionPct.
 * We return a FRACTION of equity to risk; the caller converts to shares at the entry price.
 *
 * @param {object} genome
 * @param {{ ourProbability: number, marketPrice: number, confidence?: number|null }} judgment
 * @returns {{ edge:number, kellyFractionOfEquity:number, sizedFractionOfEquity:number, actionable:boolean }}
 */
export function sizeJudgment(genome, judgment) {
  const ourProbability = Number(judgment.ourProbability);
  const marketPrice = Number(judgment.marketPrice);
  if (!Number.isFinite(ourProbability) || !Number.isFinite(marketPrice)) {
    fail('SPEC_INVALID', 'sizeJudgment requires ourProbability and marketPrice', {});
  }
  const edge = ourProbability - marketPrice;
  const minEdge = Number(genome.edgeThreshold ?? 0.05);
  if (Math.abs(edge) < minEdge) {
    return { edge, kellyFractionOfEquity: 0, sizedFractionOfEquity: 0, actionable: false };
  }
  // Confidence gate: below minConfidence the agent stands down.
  const confidence = Number.isFinite(Number(judgment.confidence)) ? Number(judgment.confidence) : 1;
  if (confidence < Number(genome.minConfidence ?? 0.6)) {
    return { edge, kellyFractionOfEquity: 0, sizedFractionOfEquity: 0, actionable: false };
  }
  const side = edge > 0 ? 'YES' : 'NO';
  const p = Math.min(0.999, Math.max(0.001, edge > 0 ? ourProbability : 1 - ourProbability));
  const q = 1 - p;
  // For the chosen side, entry price is the cheaper of the market price and its complement.
  const entryPrice = side === 'YES' ? marketPrice : 1 - marketPrice;
  const b = entryPrice > 0 ? 1 / entryPrice - 1 : 0;
  const fullKelly = b > 0 ? (p * b - q) / b : 0;
  const kellyScaled = Math.max(0, fullKelly) * Number(genome.kellyFraction ?? 0.25);
  // Conviction scaling: raise confidence by convictionPower.
  const conviction = Math.pow(Math.max(0, confidence), Number(genome.convictionPower ?? 1));
  const sized = Math.min(Number(genome.maxPositionPct ?? 0.15), kellyScaled * conviction);
  return { edge, kellyFractionOfEquity: kellyScaled, sizedFractionOfEquity: sized, actionable: sized > 0 };
}

export default { genesisGenome, mutate, sizeJudgment, MUTABLE, MUTABLE_FIELDS };
