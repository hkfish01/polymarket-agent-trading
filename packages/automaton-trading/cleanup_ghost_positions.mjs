/**
 * One-time cleanup: force-close phantom positions left on DEAD agents.
 *
 * Root cause: in sim mode the in-process Reaper liquidated a dead agent's book with
 * bookOnFailure=false. Buying back a short (qty<0) needs cash, but the estate's cash
 * had already been swept to treasury, so ledger.applyFill's margin guard rejected the
 * close and the position was left behind. The negative mark-to-market of those orphan
 * shorts (-$24k) dragged the population's headline equity below zero.
 *
 * This script closes each such position at the LIVE gamma-backed mark, books the
 * realized loss, then absorbs the resulting negative cash from treasury (exactly the
 * same death_debt_absorb path the Reaper uses). Only agents already marked dead are
 * touched. Live agents are never modified.
 *
 * Run with the engine STOPPED (otherwise the engine flushes its in-memory ledger over
 * these edits on the next tick):
 *   node cleanup_ghost_positions.mjs --state-dir /app/state [--apply]
 * Without --apply it runs a dry-run report only.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createLedger } from './src/ledger.js';
import { TREASURY_ID } from './src/ledger.js';
import { statePaths } from './src/config.js';

const argv = process.argv.slice(2);
const stateIdx = argv.indexOf('--state-dir');
const STATE_DIR = stateIdx >= 0 ? argv[stateIdx + 1] : (process.env.AUTOMATON_STATE_DIR ?? './automaton-data');
const APPLY = argv.includes('--apply');

const config = JSON.parse(fs.readFileSync(path.join(STATE_DIR, '..', 'polymarket.config.json'), 'utf8')
  .replace(/^\s*\/\/.*$/gm, ''));
config.paths = { ...(config.paths ?? {}), stateDir: STATE_DIR, envFile: path.join(STATE_DIR, '..', '.env') };
const paths = { ...statePaths(config), stateDir: STATE_DIR };
const ledger = createLedger({ paths, config });
ledger.load();

const registryRaw = JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'registry.json'), 'utf8'));
const registry = Array.isArray(registryRaw) ? registryRaw : Object.values(registryRaw.agents ?? {});
const deadIds = new Set(registry.filter((a) => a.status === 'dead').map((a) => a.id));

const num = (x, d = 0) => (Number.isFinite(Number(x)) ? Number(x) : d);
const round2 = (v) => Math.round(num(v) * 100) / 100;
const now = new Date().toISOString();

const report = [];
let totalRealized = 0;
let totalAbsorbed = 0;

for (const agentId of deadIds) {
  if (!ledger.has(agentId)) continue;
  const book = ledger.book(agentId);
  const positions = Object.entries(book?.positions ?? {}).filter(([s, p]) => Math.abs(num(p.qty)) > 1e-9);
  if (positions.length === 0) continue;

  const before = ledger.equity(agentId, {});
  const entry = { agentId, before: before.equityUsd, positions: [] };

  for (const [symbol, position] of positions) {
    const qtySigned = num(position.qty);
    const mark = num(ledger.get(agentId)?.markPrices?.[symbol] ?? position.avgPriceUsd, 0);
    const side = qtySigned > 0 ? 'sell' : 'buy';
    const quantity = Math.abs(qtySigned);
    const avg = num(position.avgPriceUsd);
    const realized = (mark - avg) * qtySigned; // buy-back realizes (mark-avg)*qty for a short

    entry.positions.push({
      symbol, qty: qtySigned, side, quantity, avg, mark,
      notional: round2(quantity * mark), realized: round2(realized),
    });
    totalRealized += realized;

    if (APPLY) {
      ledger.applyFill(agentId, {
        symbol,
        assetClass: position.assetClass ?? 'polymarket_outcome',
        side,
        qty: quantity,
        priceUsd: mark > 0 ? mark : avg,
        groupId: position.groupId ?? null,
        at: now,
        orderId: null,
        skipMarginCheck: true,
      });
    }
  }

  if (APPLY) {
    const exactCash = num(ledger.get(agentId)?.cashUsd);
    if (exactCash < 0) {
      ledger.transfer(TREASURY_ID, agentId, -exactCash, { reason: 'ghost_position_debt_absorb', at: now });
      totalAbsorbed += -exactCash;
    } else if (exactCash > 0) {
      ledger.transfer(agentId, TREASURY_ID, exactCash, { reason: 'ghost_position_sweep', at: now });
      totalAbsorbed -= exactCash;
    }
    entry.after = ledger.equity(agentId, {}).equityUsd;
  }
  report.push(entry);
}

console.log(JSON.stringify({
  mode: APPLY ? 'APPLY' : 'DRY-RUN',
  stateDir: STATE_DIR,
  deadAgentsWithGhosts: report.length,
  totalRealizedPl: round2(totalRealized),
  netTreasuryImpact: round2(totalAbsorbed),
  report,
}, null, 2));

if (APPLY) {
  await ledger.save();
  console.log('[cleanup] ledger saved');
}
