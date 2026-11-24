/**
 * prob-trader.js — LLM-driven probability trader for Polymarket outcome markets.
 *
 * Runs alongside the existing technical-analysis executor when broker is 'polysim'.
 * Completely bypasses bar-based signal scanning; instead:
 *
 *   1. For each market in the agent's basket, read the current implied probability
 *      from the real CLOB order book (via broker.getLatestQuote).
 *   2. Ask the LLM to estimate the true probability + confidence for that question.
 *   3. If |our_prob − market_price| > edge_threshold, size a bet with the Kelly
 *      criterion and submit a buy order for the YES or NO token.
 *   4. Book the fill in the ledger immediately (polysim fills are instant).
 *
 * This is the "correct Polymarket strategy" — a trader reads news, reasons about
 * likelihood, and bets when they disagree with the crowd's implied probability.
 */

import { fail } from './contracts.js';
import { sizeJudgment } from './polymarket-genome.js';
import fs from 'node:fs';
import path from 'node:path';

const SYSTEM_PROMPT = `You are a probability estimator for prediction markets.
IMPORTANT: Your output MUST be a single JSON object and NOTHING else. No preamble, no thinking out loud, no explanation before or after. Just the JSON.

Format (exactly this structure, nothing more):
{"probability": <number 0.01-0.99>, "confidence": <number 0.0-1.0>, "reasoning": "<one sentence>"}

Example valid output:
{"probability": 0.65, "confidence": 0.7, "reasoning": "BTC unlikely to fall 30% in remaining time"}

Begin your response with { and end with }. Do NOT start with any text before the opening brace.`;

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

/**
 * @param {{
 *   broker: object,
 *   ledger: object,
 *   brakes: object,
 *   config: object,
 *   generate: Function,
 *   clock?: { now: () => number, iso: () => string },
 * }} deps
 * @returns {{ runForAgent: Function, describe: Function }}
 */
export function createProbTrader({ broker, ledger, brakes, config, generate, clock, paths } = {}) {
  if (!broker || typeof broker.submitOrder !== 'function') {
    fail('CONFIG_INVALID', 'createProbTrader requires a broker with submitOrder()');
  }
  if (!ledger || typeof ledger.applyFill !== 'function') {
    fail('CONFIG_INVALID', 'createProbTrader requires a ledger with applyFill()');
  }
  if (!brakes || typeof brakes.checkOrder !== 'function') {
    fail('CONFIG_INVALID', 'createProbTrader requires brakes.checkOrder()');
  }
  if (typeof generate !== 'function') {
    fail('CONFIG_INVALID', 'createProbTrader requires a generate() LLM function');
  }

  const risk = config.risk ?? {};
  const maxOrderNotionalUsd = num(risk.maxOrderNotionalUsd, 2000);
  const maxPositionPct = num(risk.maxPositionPct, 0.5);
  const minOrderNotionalUsd = num(risk.minOrderNotionalUsd, 5);
  const maxOrdersPerCycle = num(risk.maxOrdersPerCycle, 4);
  const edgeThreshold = num(config.polysim?.edgeThreshold, 0.01); // min |our_prob − market| to act
  const minConfidence = num(config.polysim?.minConfidence, 0.30);
  const maxInputChars = num(config.polysim?.maxInputChars, 4000);
  const maxOutputTokens = num(config.polysim?.maxOutputTokens, 600);
  const maxMarketsPerCycle = num(config.polysim?.maxMarketsPerCycle, 3);
  const slippageBps = num(config.sim?.slippageBps, 8);
  const systemClock = clock ?? { now: () => Date.now(), iso: () => new Date().toISOString() };

  // Scout Bot signals (optional): if the Scout service has written scout_signals.json
  // into the state dir, we feed the latest headline + sentiment for each market into
  // the LLM prompt, so the probability estimate conditions on real news, not just the
  // model's parametric memory. Signals are best-effort — absence is fine.
  const scoutFile = paths?.stateDir
    ? path.join(paths.stateDir, 'scout_signals.json')
    : null;
  let scoutSignals = {};

  function loadScoutSignals() {
    if (!scoutFile || !fs.existsSync(scoutFile)) return;
    try {
      const snap = JSON.parse(fs.readFileSync(scoutFile, 'utf8'));
      scoutSignals = snap?.signals ?? {};
    } catch {
      scoutSignals = {}; // corrupt/missing snapshot -> trade without news context
    }
  }

  /**
   * Run one LLM probability evaluation cycle for one agent.
   * @param {object} agent  registry agent record (has .genome, .symbols, .id, .equityUsd)
   * @param {object} mandate treasurer mandate { sizeBudgetUsd, maxOrderNotionalUsd, ... }
   * @param {object} book    ledger.book(agent.id) for current positions
   * @param {object} dayStats daily counters { ordersCount }
   * @returns {Promise<object>} { actions:[...], rejected:[...], spentUsd, llmCalls }
   */
  async function runForAgent({ agent, mandate, book, dayStats }) {
    const agentId = agent.id;
    const genome = agent.genome ?? {};
    const basket = Array.isArray(agent.symbols) && agent.symbols.length > 0
      ? agent.symbols
      : (Array.isArray(genome.symbols) ? genome.symbols : []);
    // Refresh Scout signals each run so the LLM sees the freshest headlines.
    loadScoutSignals();
    const result = {
      agentId,
      actions: [],
      rejected: [],
      spentUsd: 0,
      llmCalls: 0,
    };

    if (basket.length === 0) {
      result.rejected.push({ reason: 'NO_BASKET', detail: 'agent has no symbols' });
      return result;
    }

    // Get market map (cached on broker from discovery).
    let marketMap;
    try {
      marketMap = await broker.getMarketMap();
    } catch (error) {
      result.rejected.push({ reason: 'MAP_ERROR', detail: String(error?.message ?? error).slice(0, 100) });
      return result;
    }

    // Map basket symbols → real market entries.
    const candidates = basket
      .map((symbol) => marketMap.find((m) => m.symbol === symbol))
      .filter(Boolean)
      .slice(0, maxMarketsPerCycle);

    if (candidates.length === 0) {
      result.rejected.push({ reason: 'NO_MARKETS', detail: 'no basket symbols found in market map' });
      return result;
    }

    // Process each candidate market.
    let ordersThisCycle = 0;
    for (const market of candidates) {
      if (ordersThisCycle >= maxOrdersPerCycle) break;
      if (market.hoursToClose !== null && market.hoursToClose < 2) {
        result.rejected.push({ reason: 'EXPIRING', detail: `${market.symbol}: closes in ${market.hoursToClose?.toFixed(1)}h` });
        continue;
      }

      // 1) Read current market-implied probability.
      let quote;
      try {
        quote = await broker.getLatestQuote(market.symbol);
      } catch (error) {
        result.rejected.push({ reason: 'QUOTE_ERROR', detail: `${market.symbol}: ${String(error?.message ?? error).slice(0, 80)}` });
        continue;
      }
      if (quote.priceUsd === null || quote.priceUsd === undefined || !Number.isFinite(quote.priceUsd)) {
        result.rejected.push({ reason: 'NO_PRICE', detail: `${market.symbol}: no live midpoint` });
        continue;
      }
      const marketPrice = quote.priceUsd;

      // 2) Ask LLM to estimate true probability.
      result.llmCalls += 1;
      let llmReply;
      try {
        const scout = scoutSignals[market.symbol] ?? null;
        const user = buildQuestionPrompt(market.question, market.category, marketPrice, scout);
        const generated = await generate({
          system: SYSTEM_PROMPT,
          user,
          maxTokens: maxOutputTokens,
          temperature: 0.2,
        });
        const text = typeof generated === 'string' ? generated : generated?.text;
        const usage = generated?.usage ?? null;
        llmReply = parseProbabilityReply(text);
        if (usage) {
          result.spentUsd += num(usage.costUsd, 0);
        }
      } catch (error) {
        result.rejected.push({ reason: 'LLM_ERROR', detail: `${market.symbol}: ${String(error?.message ?? error).slice(0, 80)}` });
        continue;
      }
      if (!llmReply) {
        result.rejected.push({ reason: 'LLM_PARSE', detail: `${market.symbol}: could not parse LLM JSON reply` });
        continue;
      }

      const ourProbability = llmReply.probability;
      const confidence = llmReply.confidence;
      const edge = ourProbability - marketPrice; // positive = undervalued YES, negative = overvalued YES

      const scout = scoutSignals[market.symbol] ?? null;
      result.actions.push({
        type: 'evaluate',
        symbol: market.symbol,
        question: market.question.slice(0, 100),
        marketPrice: Number(marketPrice.toFixed(4)),
        ourProbability: Number(ourProbability.toFixed(4)),
        confidence: Number(confidence.toFixed(3)),
        edge: Number(edge.toFixed(4)),
        reasoning: llmReply.reasoning ?? '',
        // Track whether this estimate was conditioned on a Scout Bot headline.
        scoutUsed: Boolean(scout?.headline),
        scoutSentiment: scout ? Number(scout.sentiment) : null,
      });

      // 3) Filter by edge and confidence.
      if (Math.abs(edge) < edgeThreshold) {
        result.rejected.push({ reason: 'NO_EDGE', detail: `${market.symbol}: edge ${(edge * 100).toFixed(1)}% < ${(edgeThreshold * 100).toFixed(1)}%` });
        continue;
      }
      if (confidence < minConfidence) {
        result.rejected.push({ reason: 'LOW_CONFIDENCE', detail: `${market.symbol}: confidence ${(confidence * 100).toFixed(0)}% < ${(minConfidence * 100).toFixed(0)}%` });
        continue;
      }

      // 4) Polymarket has no shorting: bullish → buy YES, bearish → buy NO.
      //    Both are cash-funded spot purchases of one side of the same binary market.
      //    sell YES without holding it would be a naked short and is no longer allowed.
      const bearish = edge < 0;
      const side = 'buy';
      const tradeSymbol = bearish ? `${market.symbol}.NO` : market.symbol;
      const tradedPrice = bearish ? 1 - marketPrice : marketPrice;
      if (bearish && !marketMap.some((entry) => entry.symbol === tradeSymbol)) {
        result.rejected.push({ reason: 'NO_MARKET_MISSING', detail: `${tradeSymbol}: no NO token bound in broker` });
        continue;
      }

      // 5) Size with Kelly criterion.
      const equityUsd = num(agent.equityUsd, num(book?.cashUsd, 0));
      const sizing = sizeJudgment(genome, {
        ourProbability,
        marketPrice,
        confidence,
      });
      let notionalUsd = Math.round(sizing.sizedFractionOfEquity * equityUsd * 100) / 100;
      notionalUsd = Math.min(notionalUsd, maxOrderNotionalUsd, mandate?.maxOrderNotionalUsd ?? maxOrderNotionalUsd);
      // Kelly floors small edges to near-zero; apply a sensible minimum bet so we can still
      // act when there is a real edge. This is the paper-sim minimum, not a real-money risk.
      const minBetFloor = Math.max(minOrderNotionalUsd, Math.min(50, equityUsd * 0.01));
      if (notionalUsd < minBetFloor) {
        notionalUsd = minBetFloor;
      }

      // 6) Convert notional to qty (shares = notional / price).
      const fillPrice = Math.min(1, tradedPrice * (1 + slippageBps / 10000));
      const qty = Math.floor((notionalUsd / fillPrice) * 10000) / 10000; // 4dp shares
      if (qty <= 0) {
        result.rejected.push({ reason: 'QTY_ZERO', detail: `${market.symbol}: qty rounds to 0` });
        continue;
      }

      // 7) Pre-trade brakes check.
      const at = systemClock.iso();
      const brakeInput = {
        agentId,
        equityUsd,
        marketOpen: true,
        dayStats: dayStats ?? {},
        positions: book?.positions ?? {},
        mandate,
        order: {
          symbol: tradeSymbol,
          side,
          price: fillPrice,
          qty,
          notionalUsd: Math.round(notionalUsd),
        },
      };
      const brakeResult = brakes.checkOrder(brakeInput);
      if (brakeResult.decision === 'DENY') {
        result.rejected.push({ reason: brakeResult.brakeId ?? 'BRAKE_DENY', detail: `${market.symbol}: ${brakeResult.reason}` });
        continue;
      }

      // 8) Submit order.
      let order;
      try {
        order = await broker.submitOrder({
          symbol: tradeSymbol,
          side,
          qty,
          type: 'market',
        });
      } catch (error) {
        result.rejected.push({ reason: 'ORDER_ERROR', detail: `${market.symbol}: ${String(error?.message ?? error).slice(0, 80)}` });
        continue;
      }

      // 9) Book the fill.
      const filledQty = num(order.filledQty, qty);
      const fillPrice2 = num(order.avgFillPriceUsd, fillPrice);
      if (filledQty > 0) {
        await ledger.applyFill(agentId, {
          symbol: tradeSymbol,
          assetClass: 'polymarket_outcome',
          side,
          qty: filledQty,
          priceUsd: fillPrice2,
          multiplier: 1,
          at,
          orderId: order.id,
        });
      }

      ordersThisCycle += 1;
      result.actions.push({
        type: 'order',
        symbol: tradeSymbol,
        outcome: bearish ? 'NO' : 'YES',
        side,
        qty: filledQty,
        priceUsd: Number(fillPrice2.toFixed(6)),
        notionalUsd: Math.round(filledQty * fillPrice2 * 100) / 100,
        orderId: order.id,
        question: market.question.slice(0, 80),
        category: market.category,
        ourProb: Number(ourProbability.toFixed(4)),
        marketProb: Number(marketPrice.toFixed(4)),
        edge: Number(edge.toFixed(4)),
        confidence: Number(confidence.toFixed(3)),
      });
    }

    return result;
  }

  function buildQuestionPrompt(question, category, marketPrice, scout = null) {
    let newsBlock = '';
    if (scout && scout.headline) {
      const ageH = scout.at ? (Date.now() - new Date(scout.at).getTime()) / 3600000 : null;
      const age = ageH !== null && Number.isFinite(ageH) ? ` (${ageH < 1 ? '<1' : Math.round(ageH)}h ago)` : '';
      newsBlock = `
Recent news (Scout Bot): "${scout.headline}"
News sentiment for YES: ${scout.sentiment >= 0 ? '+' : ''}${Number(scout.sentiment).toFixed(2)} (scale -1 to +1)
${scout.summary ? `News summary: ${scout.summary}\n` : ''}
Use this news to inform your estimate. If the news is stale or irrelevant, rely on base rates instead.`;
    }
    return `Market: ${question}
Category: ${category}
Current market-implied probability: ${(marketPrice * 100).toFixed(1)}%${newsBlock}

Estimate the TRUE probability that this event happens. Consider recent news, base rates, and any relevant context you know. Reply with JSON only.`;
  }

  function parseProbabilityReply(text) {
    if (!text) return null;
    // Strip thinking-model wrappers: , <reasoning>...</reasoning>, markdown fences.
    let cleaned = text
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '')
      .replace(/```json\s*/gi, '')
      .replace(/```/g, '')
      .trim();
    // Attempt 1: parse entire cleaned text as JSON.
    let parsed = null;
    try { parsed = JSON.parse(cleaned); } catch { /* fall through */ }
    // Attempt 2: find the last complete JSON object (thinking models often put it at the end).
    if (!parsed) {
      const matches = [...cleaned.matchAll(/\{[^{}]*(?:"(?:probability|confidence|reasoning)"\s*:)[^{}]*\}/g)];
      if (matches.length > 0) {
        // Take the last match (most likely the final structured output after any preamble).
        try { parsed = JSON.parse(matches[matches.length - 1][0]); } catch { /* fall through */ }
      }
    }
    // Attempt 3: any JSON object in the text.
    if (!parsed) {
      const anyMatch = cleaned.match(/\{[^{}]+\}/);
      if (anyMatch) { try { parsed = JSON.parse(anyMatch[0]); } catch { return null; } }
    }
    if (!parsed) return null;
    const probability = num(parsed?.probability, null);
    const confidence = num(parsed?.confidence, 0.5);
    const reasoning = String(parsed?.reasoning ?? '').slice(0, 200);
    if (probability === null || probability < 0.01 || probability > 0.99) return null;
    return {
      probability: Math.max(0.01, Math.min(0.99, probability)),
      confidence: Math.max(0, Math.min(1, confidence)),
      reasoning,
    };
  }

  function describe() {
    return {
      kind: 'prob-trader',
      edgeThreshold,
      minConfidence,
      maxMarketsPerCycle,
      maxOrdersPerCycle,
    };
  }

  return { runForAgent, describe };
}

export default createProbTrader;
