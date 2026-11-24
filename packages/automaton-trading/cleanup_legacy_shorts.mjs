/**
 * One-time cleanup: buy back every legacy short position at its current mark.
 *
 * These negatives predate the cash-only Polymarket enforcement. New shorts are now
 * blocked at both broker and ledger level, but existing ones can only be reduced.
 * This script closes them all with skipMarginCheck (liquidation path), books the
 * realized PnL, and absorbs any resulting cash deficit from treasury.
 *
 * Run with the engine STOPPED. Without --apply it only reports.
 *   node cleanup_legacy_shorts.mjs --state-dir /app/state [--apply]
 */
import fs from 'node:fs';
import path from 'node:path';
import { createLedger, TREASURY_ID } from './src/ledger.js';
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

const num = (x, d = 0) => (Number.isFinite(Number(x)) ? Number(x) : d);
const round2 = (v) => Math.round(num(v) * 100) / 100;
const now = new Date().toISOString();
const report = [];
let totalRealized = 0;
let totalAbsorbed = 0;

const ledgerFile = JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'ledger.json'), 'utf8'));
for (const agentId of Object.keys(ledgerFile.agents ?? {})) {
  if (!ledger.has(agentId)) continue;
  const book = ledger.book(agentId);
  const shorts = Object.entries(book?.positions ?? {}).filter(([, p]) => num(p.qty) < -1e-9);
  if (shorts.length === 0) continue;

  const entry = { agentId, positions: [] };
  for (const [symbol, position] of shorts) {
    const qtySigned = num(position.qty);
    const qty = Math.abs(qtySigned);
    const avg = num(position.avgPriceUsd);
    const mark = num(ledger.get(agentId)?.markPrices?.[symbol] ?? avg, avg);
    const price = mark > 0 ? mark : avg;
    const realized = (price - avg) * qtySigned;
    entry.positions.push({
      symbol, qty: qtySigned, avg, price,
      buybackCost: round2(qty * price), realized: round2(realized),
    });
    totalRealized += realized;

    if (APPLY) {
      ledger.applyFill(agentId, {
        symbol,
        assetClass: position.assetClass ?? 'polymarket_outcome',
        side: 'buy',
        qty,
        priceUsd: price,
        groupId: position.groupId ?? null,
        at: now,
        orderId: null,
        skipMarginCheck: true,
      });
    }
  }

  if (APPLY) {
    const cash = num(ledger.get(agentId)?.cashUsd);
    if (cash < 0) {
      ledger.transfer(TREASURY_ID, agentId, -cash, { reason: 'legacy_short_debt_absorb', at: now });
      totalAbsorbed += -cash;
    }
    entry.cashAfter = num(ledger.get(agentId)?.cashUsd).toFixed(2);
  }
  report.push(entry);
}

console.log(JSON.stringify({
  mode: APPLY ? 'APPLY' : 'DRY-RUN',
  stateDir: STATE_DIR,
  agentsWithShorts: report.length,
  totalRealizedPl: round2(totalRealized),
  netTreasuryAbsorb: round2(totalAbsorbed),
  report,
}, null, 2));

if (APPLY) {
  await ledger.save();
  console.log('[cleanup] ledger saved');
}
