/**
 * calibration.js — probability-scoring dataset (the "who judges well" metric).
 *
 * On an outcome market, the selectable trait is NOT raw P&L (a lucky agent can win a
 * coin flip). It is CALIBRATION: does the agent's stated probability track reality?
 * This module records every agent probability judgment and, once a market resolves,
 * scores it with the Brier score:
 *
 *     Brier = mean( (predictedProbability - actualOutcome)^2 )
 *
 *   actualOutcome ∈ {0, 1}   (did this token resolve to $1 or $0?)
 *   Brier = 0      -> perfect calibration
 *   Brier = 0.25   -> no better than guessing 50/50 on a binary event
 *   Brier = 1      -> perfectly wrong (always confident in the wrong side)
 *
 * Lower is better. This is the metric the evolution layer should select on: an agent
 * that is well-calibrated across many events has genuine forecasting skill, whereas an
 * agent that merely made money on one event may just have been lucky.
 *
 * Records are append-only JSONL (one judgment per line) plus an aggregate state file.
 * Synchronous persistence on purpose: a judgment recorded in-memory only would be lost
 * on restart, and calibration is only meaningful over many settled events.
 *
 * Owner: mortality-core. Contract: docs/CONTRACTS.md ("Calibration").
 *
 * @module calibration
 */

import fs from 'node:fs';
import path from 'node:path';
import { AutomatonError, fail } from './contracts.js';
import { readJsonSync, round4, writeJsonAtomicSync } from './util.js';
import { statePaths } from './config.js';

/** Stable local code for a malformed calibration record. */
export const CALIBRATION_INVALID = 'CALIBRATION_INVALID';

/** The resolution state of a recorded judgment. */
export const JUDGMENT_STATES = Object.freeze(['pending', 'settled']);

const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);

/**
 * Create the calibration store.
 * @param {{ paths?: object, config?: object, clock?: { now: () => number, iso: () => string } }} [options]
 */
export function createCalibration({ paths, config, clock } = {}) {
  if (!paths?.calibration && !config) {
    throw new AutomatonError('CONFIG_INVALID', 'createCalibration requires { paths } or { config }', {});
  }
  const resolved = { ...(config ? statePaths(config) : {}), ...(paths ?? {}) };
  if (!resolved.calibration) {
    throw new AutomatonError('CONFIG_INVALID', 'calibration path is required', {});
  }
  const calibrationPath = path.resolve(resolved.calibration);
  const statePath = path.resolve(resolved.calibrationState ?? path.join(path.dirname(calibrationPath), 'calibration-state.json'));
  const currentClock = clock ?? { now: () => Date.now(), iso: () => new Date().toISOString() };

  /** Ensure the containing directory exists (best effort; append will retry). */
  function ensureDir() {
    try {
      fs.mkdirSync(path.dirname(calibrationPath), { recursive: true });
    } catch {
      /* append will surface a real error if the dir truly cannot be made */
    }
  }

  function readAll() {
    let text;
    try {
      text = fs.readFileSync(calibrationPath, 'utf8');
    } catch (error) {
      if (error && error.code === 'ENOENT') return [];
      throw error;
    }
    const rows = [];
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        rows.push(JSON.parse(line));
      } catch {
        /* a torn line is skipped, not fatal: judgments are append-only */
      }
    }
    return rows;
  }

  /**
   * Validate one judgment record.
   * @param {object} judgment
   * @returns {object} the same judgment
   */
  function validateJudgment(judgment) {
    if (!judgment || typeof judgment !== 'object') fail(CALIBRATION_INVALID, 'judgment must be an object', {});
    for (const field of ['agentId', 'conditionId', 'tokenId', 'predictedProbability', 'recordedAt']) {
      if (!Object.prototype.hasOwnProperty.call(judgment, field)) {
        fail(CALIBRATION_INVALID, `judgment field "${field}" is required`, { field });
      }
    }
    if (typeof judgment.agentId !== 'string' || judgment.agentId.trim() === '') {
      fail(CALIBRATION_INVALID, 'agentId must be a non-empty string', { agentId: judgment.agentId });
    }
    if (typeof judgment.conditionId !== 'string' || judgment.conditionId.trim() === '') {
      fail(CALIBRATION_INVALID, 'conditionId must be a non-empty string', {});
    }
    if (typeof judgment.tokenId !== 'string' || judgment.tokenId.trim() === '') {
      fail(CALIBRATION_INVALID, 'tokenId must be a non-empty string', {});
    }
    if (!isFiniteNumber(judgment.predictedProbability) || judgment.predictedProbability < 0 || judgment.predictedProbability > 1) {
      fail(CALIBRATION_INVALID, 'predictedProbability must be in [0,1]', { value: judgment.predictedProbability });
    }
    if (typeof judgment.recordedAt !== 'string' || Number.isNaN(Date.parse(judgment.recordedAt))) {
      fail(CALIBRATION_INVALID, 'recordedAt must be an ISO timestamp', { value: judgment.recordedAt });
    }
    return judgment;
  }

  /**
   * Record one agent probability judgment (pending until the market resolves).
   * @param {{ agentId: string, conditionId: string, tokenId: string,
   *           predictedProbability: number, marketQuestion?: string|null,
   *           confidence?: number|null, at?: string }} judgment
   * @returns {object} the stored judgment
   */
  function record(judgment) {
    const at = judgment?.at ?? currentClock.iso();
    const record = validateJudgment({
      agentId: judgment.agentId,
      conditionId: judgment.conditionId,
      tokenId: judgment.tokenId,
      predictedProbability: judgment.predictedProbability,
      marketQuestion: judgment.marketQuestion ?? null,
      confidence: isFiniteNumber(judgment.confidence) ? judgment.confidence : null,
      recordedAt: at,
      state: 'pending',
      outcome: null,
      brier: null,
    });
    ensureDir();
    fs.appendFileSync(calibrationPath, `${JSON.stringify(record)}\n`, 'utf8');
    return record;
  }

  /**
   * Settle every pending judgment for a resolved market. A market resolves to exactly one
   * winning token (outcome $1); every other token resolves to $0. For each judgment we
   * score (predictedProbability - outcome)^2 against the token the agent judged.
   *
   * @param {string} conditionId the resolved market
   * @param {string} winningTokenId the token that resolved to $1
   * @param {{ at?: string }} [options]
   * @returns {{ settled: number, brierByAgent: Record<string, number> }}
   */
  function settle(conditionId, winningTokenId, { at } = {}) {
    const resolvedCondition = String(conditionId ?? '').trim();
    const winner = String(winningTokenId ?? '').trim();
    if (resolvedCondition === '' || winner === '') {
      fail(CALIBRATION_INVALID, 'settle requires conditionId and winningTokenId', {});
    }
    const rows = readAll();
    const settledAt = at ?? currentClock.iso();
    const brierByAgent = {};
    let settled = 0;
    for (const row of rows) {
      if (row.conditionId !== resolvedCondition) continue;
      if (row.state !== 'pending') continue;
      const outcome = row.tokenId === winner ? 1 : 0;
      const brier = (row.predictedProbability - outcome) ** 2;
      row.state = 'settled';
      row.outcome = outcome;
      row.brier = round4(brier);
      row.settledAt = settledAt;
      settled += 1;
      brierByAgent[row.agentId] = (brierByAgent[row.agentId] ?? 0) + brier;
    }
    // Rewrite the whole file with settled values (small files; atomic + simple).
    writeJsonAtomicSync(calibrationPath + '.tmp', rows);
    // writeJsonAtomicSync writes JSON, but we need JSONL — write lines manually.
    ensureDir();
    fs.writeFileSync(calibrationPath, rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length > 0 ? '\n' : ''), 'utf8');
    try {
      fs.unlinkSync(calibrationPath + '.tmp');
    } catch {
      /* best effort cleanup */
    }
    saveAggregate();
    return { settled, brierByAgent };
  }

  /** Persist an aggregate summary (per-agent Brier over settled judgments). */
  function saveAggregate() {
    const rows = readAll().filter((row) => row.state === 'settled');
    const byAgent = {};
    for (const row of rows) {
      const entry = (byAgent[row.agentId] ??= { settled: 0, brierSum: 0 });
      entry.settled += 1;
      entry.brierSum += row.brier ?? 0;
    }
    const agents = {};
    for (const [agentId, entry] of Object.entries(byAgent)) {
      agents[agentId] = {
        settled: entry.settled,
        brier: entry.settled > 0 ? round4(entry.brierSum / entry.settled) : null,
      };
    }
    writeJsonAtomicSync(statePath, {
      version: 1,
      updatedAt: currentClock.iso(),
      totalSettled: rows.length,
      agents,
    });
  }

  /**
   * Brier score for one agent over its settled judgments. Lower is better.
   * @param {string} agentId
   * @returns {{ settled: number, brier: number|null }} null brier = no settled data yet
   */
  function score(agentId) {
    const rows = readAll().filter((row) => row.state === 'settled' && row.agentId === agentId);
    if (rows.length === 0) return { settled: 0, brier: null };
    const sum = rows.reduce((total, row) => total + (row.brier ?? 0), 0);
    return { settled: rows.length, brier: round4(sum / rows.length) };
  }

  /** Brier scores for every agent that has settled judgments, best (lowest) first. */
  function leaderboard() {
    const rows = readAll().filter((row) => row.state === 'settled');
    const byAgent = {};
    for (const row of rows) {
      const entry = (byAgent[row.agentId] ??= { settled: 0, brierSum: 0 });
      entry.settled += 1;
      entry.brierSum += row.brier ?? 0;
    }
    return Object.entries(byAgent)
      .map(([agentId, entry]) => ({
        agentId,
        settled: entry.settled,
        brier: round4(entry.brierSum / entry.settled),
      }))
      .sort((a, b) => a.brier - b.brier || b.settled - a.settled);
  }

  /** Count of pending (unresolved) judgments. */
  function pending() {
    return readAll().filter((row) => row.state === 'pending').length;
  }

  /** Pending judgments for a condition, used to find what to settle after resolution. */
  function pendingFor(conditionId) {
    const resolved = String(conditionId ?? '').trim();
    return readAll().filter((row) => row.state === 'pending' && row.conditionId === resolved);
  }

  return { record, settle, score, leaderboard, pending, pendingFor };
}

export default createCalibration;
