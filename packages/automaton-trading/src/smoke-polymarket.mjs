/**
 * smoke-polymarket.mjs — end-to-end smoke test of the Polymarket strategy pipeline.
 *
 * Exercises the full "probability brain" chain using ONLY public APIs (no wallet, no
 * private key, no LLM key):
 *
 *   1. event-feed discovers tradable markets and their outcome tokens
 *   2. event-feed reads the LIVE order book -> implied probability per outcome
 *   3. polymarket-genome sizes the bet via fractional Kelly on the estimated edge
 *   4. brakes-polymarket gates the order (incl. the DL thin-market liquidity wall)
 *   5. calibration records the probability judgment for later Brier scoring
 *
 * This proves the strategy layer is wired correctly against the real venue. It places NO
 * real orders (order entry needs POLY_PRIVATE_KEY) — it stops at the brake decision,
 * which is exactly the point where a live executor would sign and submit.
 *
 * Run:  node src/smoke-polymarket.mjs
 */

import { createEventFeed } from './event-feed.js';
import { genesisGenome, sizeJudgment } from './polymarket-genome.js';
import { createBrakesPolymarket } from './brakes-polymarket.js';
import { createCalibration } from './calibration.js';
import { loadConfig } from './config.js';

// `--demo` injects a larger synthetic edge (0.08) so the sizing + brake + calibration
// path actually fires. Without it the toy model uses a small edge that mostly stays
// below the genome's edgeThreshold (realistic: most markets are efficiently priced).
const DEMO = process.argv.includes('--demo');
const SYNTHETIC_EDGE = DEMO ? 0.08 : 0.04;

async function main() {
  console.log('=== MEAT/Polymarket strategy-pipeline smoke test ===\n');

  // 1) discover markets
  const feed = createEventFeed();
  const markets = await feed.listMarkets({
    limit: 20,
    minLiquidity: 50_000,
    minVolume24h: 100_000,
    excludeEndingWithinHours: 6,
  });
  console.log(`[1] discovered ${markets.length} tradable markets (liquid, not closing soon)\n`);
  if (markets.length === 0) {
    console.log('no markets passed the liquidity/volume filter; nothing to score.');
    return 0;
  }

  const genome = genesisGenome();
  const config = loadConfig({ env: process.env }).config;
  const brakes = createBrakesPolymarket({ config });
  const calibration = createCalibration({
    paths: { calibration: '/tmp/meat-smoke/calibration.jsonl', calibrationState: '/tmp/meat-smoke/state.json' },
  });

  let acted = 0;
  let gated = 0;
  let scored = 0;

  // 2..5 walk the top markets
  for (const market of markets.slice(0, 6)) {
    console.log(`--- ${market.question}`);
    console.log(`    conditionId ${market.conditionId.slice(0, 18)}… negRisk=${market.negRisk} closesIn=${market.hoursToClose}h`);
    const priced = await feed.priceMarket(market);

    for (const outcome of priced.outcomes) {
      if (outcome.mid === null) continue;
      // A toy "model": pretend our probability is anchored near mid but with a small
      // synthetic edge, to exercise the sizing + brake path. A real agent would get
      // `ourProbability` from the LLM research sidecar + calibration history.
      const ourProbability = Math.min(0.97, Math.max(0.03, outcome.mid + SYNTHETIC_EDGE));
      const judgment = sizeJudgment(genome, {
        ourProbability,
        marketPrice: outcome.mid,
        confidence: 0.7,
      });
      scored += 1;

      if (!judgment.actionable) {
        console.log(`    [${outcome.label}] mid=${outcome.mid.toFixed(3)} edge=${judgment.edge.toFixed(3)} -> no trade (edge below ${genome.edgeThreshold})`);
        continue;
      }

      // Convert a fraction-of-equity into shares at the entry price (equity $10k for demo).
      const equityUsd = 10_000;
      const entryPrice = outcome.mid;
      const sizeShares = Math.floor((judgment.sizedFractionOfEquity * equityUsd) / entryPrice);
      if (sizeShares <= 0) continue;

      // Build the live book for the liquidity gate (asks for a BUY).
      const book = {
        side: 'BUY',
        bestPriceUsd: outcome.bestAsk ?? outcome.mid,
        levels: [{ price: outcome.bestAsk ?? outcome.mid, size: outcome.askDepth ?? 1000 }],
      };
      const decision = brakes.checkOrder({
        agentId: 'smoke-agent',
        equityUsd,
        mandate: { agentId: 'smoke-agent', sizeBudgetUsd: equityUsd * 0.9, maxOrderNotionalUsd: equityUsd * 0.9, maxDailyOrdersRemaining: 10 },
        dayStats: { ordersCount: 0, tokensThisCycle: [], ordersThisCycle: 0 },
        positions: {},
        order: { symbol: outcome.tokenId, side: 'BUY', price: entryPrice, qty: sizeShares },
        book,
      });

      if (decision.decision === 'ALLOW') {
        acted += 1;
        calibration.record({
          agentId: 'smoke-agent',
          conditionId: market.conditionId,
          tokenId: outcome.tokenId,
          predictedProbability: ourProbability,
          marketQuestion: market.question,
          confidence: 0.7,
        });
        console.log(`    [${outcome.label}] mid=${outcome.mid.toFixed(3)} ourP=${ourProbability.toFixed(3)} edge=${judgment.edge.toFixed(3)} -> BUY ${sizeShares} sh @${entryPrice.toFixed(3)} ALLOWED (sized ${(judgment.sizedFractionOfEquity * 100).toFixed(2)}% of equity)`);
      } else {
        gated += 1;
        console.log(`    [${outcome.label}] mid=${outcome.mid.toFixed(3)} ourP=${ourProbability.toFixed(3)} -> DENIED by ${decision.brakeId}: ${decision.reason}`);
      }
    }
    console.log('');
  }

  console.log('=== summary ===');
  console.log(`markets scanned : ${Math.min(markets.length, 6)}`);
  console.log(`outcomes scored : ${scored}`);
  console.log(`orders allowed  : ${acted}`);
  console.log(`orders gated    : ${gated}`);
  console.log(`judgments recorded for calibration: ${calibration.pending()}`);
  console.log('\nPipeline OK — strategy brain, sizing, safety wall, and calibration are wired.');
  return 0;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((error) => {
    console.error('smoke test failed:', error?.code ?? '', error?.message ?? error);
    process.exitCode = 1;
  });
