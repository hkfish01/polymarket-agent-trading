/**
 * etl.mjs — archive the MEAT engine's file-based state into Postgres.
 *
 * Reads (read-only) from the engine's state volume:
 *   registry.json   -> agents
 *   ledger.json     -> agents (equity/cash), fills, events
 *   traces.jsonl    -> equity_ticks
 *   agents/<id>.jsonl, research/<id>.jsonl -> message_usage (with real RMB)
 *
 * Upserts are idempotent (UNIQUE constraints + ON CONFLICT) so re-running on the
 * same data is a no-op. Runs on a timer so the archive stays current; safe to
 * restart at any time.
 *
 * Env: DATABASE_URL, STATE_DIR, SYNC_INTERVAL_MS (default 60000)
 * Zero engine deps; installs `pg` in its own image.
 */

import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const STATE_DIR = path.resolve(process.env.STATE_DIR ?? '/app/state');
const INTERVAL_MS = Number(process.env.SYNC_INTERVAL_MS ?? 60000);
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('[etl] DATABASE_URL is required');
  process.exit(1);
}

const RMB_PER_CREDIT = 80 / 100000;
const RMB_PER_INPUT = (300 / 1e6) * RMB_PER_CREDIT;
const RMB_PER_OUTPUT = (900 / 1e6) * RMB_PER_CREDIT;

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function readJsonl(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip torn line */ }
  }
  return out;
}

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const iso = (v) => {
  if (!v) return null;
  const d = new Date(typeof v === 'number' ? v : v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

let pool = null;
async function getPool() {
  if (pool) return pool;
  pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });
  // Apply schema (idempotent) on first connect.
  const schemaPath = path.join(path.dirname(new URL(import.meta.url).pathname), 'schema.sql');
  try {
    const sql = fs.readFileSync(schemaPath, 'utf8');
    await pool.query(sql);
    console.log('[etl] schema ensured');
  } catch (err) {
    console.error('[etl] schema apply failed:', err.message);
  }
  return pool;
}

async function syncAgents(client, registry, ledger) {
  const records = Object.values(registry?.agents ?? {});
  for (const agent of records) {
    const led = ledger?.agents?.[agent.id] ?? {};
    await client.query(
      `INSERT INTO agents (id,name,status,generation,parent_id,born_at,died_at,cause,endowment_usd,equity_usd,cash_usd,realized_pl,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now())
       ON CONFLICT (id) DO UPDATE SET
         name=EXCLUDED.name, status=EXCLUDED.status, generation=EXCLUDED.generation,
         parent_id=EXCLUDED.parent_id, born_at=EXCLUDED.born_at, died_at=EXCLUDED.died_at,
         cause=EXCLUDED.cause, endowment_usd=EXCLUDED.endowment_usd, equity_usd=EXCLUDED.equity_usd,
         cash_usd=EXCLUDED.cash_usd, realized_pl=EXCLUDED.realized_pl, updated_at=now()`,
      [
        agent.id, agent.name ?? null, agent.status ?? 'alive', num(agent.generation, 0),
        agent.parentId ?? null, iso(agent.bornAt), iso(agent.diedAt), agent.cause ?? null,
        num(agent.endowmentUsd ?? led.declaredEndowmentUsd ?? 0),
        num(led.cashUsd) + Object.values(led.positions ?? {}).reduce((s, p) => s + num(p.qty) * num(p.avgPriceUsd) * num(p.multiplier, 1), 0),
        num(led.cashUsd),
        num(led.realizedPlUsd),
      ],
    );
  }
}

async function syncFills(client, ledger) {
  const agents = ledger?.agents ?? {};
  for (const [agentId, agent] of Object.entries(agents)) {
    for (const fill of agent.fills ?? []) {
      await client.query(
        `INSERT INTO fills (agent_id,symbol,side,qty,price_usd,notional_usd,realized_pl,at,order_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (agent_id,order_id,symbol,side,at) DO NOTHING`,
        [
          agentId, fill.symbol ?? null, fill.side ?? null, num(fill.qty),
          num(fill.priceUsd), num(fill.notionalUsd), num(fill.realizedPlUsd),
          iso(fill.at ?? fill.atMs) ?? new Date().toISOString(), fill.orderId ?? null,
        ],
      );
    }
  }
}

async function syncEvents(client, ledger) {
  const agents = ledger?.agents ?? {};
  for (const [agentId, agent] of Object.entries(agents)) {
    for (const event of agent.events ?? []) {
      await client.query(
        `INSERT INTO events (agent_id,at,kind,amount_usd)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (agent_id,at,kind,amount_usd) DO NOTHING`,
        [agentId, iso(event.at ?? event.atMs) ?? new Date().toISOString(), event.kind ?? null, num(event.amountUsd)],
      );
    }
  }
}

async function syncEquityTicks(client, traces, ledger) {
  // Account-level equity per tick (agent_id NULL = whole portfolio).
  for (const trace of traces) {
    const at = iso(trace.at);
    if (!at) continue;
    await client.query(
      `INSERT INTO equity_ticks (agent_id,at,tick_id,equity_usd,cash_usd,positions_usd,realized_pl)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (agent_id,at) DO NOTHING`,
      [null, at, trace.tickId ?? null, num(trace.account?.equityUsd), num(trace.account?.cashUsd), null, num(trace.treasury?.surplus7dUsd)],
    );
  }
  // Latest per-agent snapshot (ledger is current-state; tagged with the newest tick).
  const lastTrace = traces.length > 0 ? traces[traces.length - 1] : null;
  const tickAt = iso(lastTrace?.at);
  if (!tickAt) return;
  for (const [agentId, agent] of Object.entries(ledger?.agents ?? {})) {
    const cash = num(agent.cashUsd);
    const positionsUsd = Object.values(agent.positions ?? {})
      .reduce((sum, p) => sum + num(p.qty) * num(p.avgPriceUsd) * num(p.multiplier, 1), 0);
    await client.query(
      `INSERT INTO equity_ticks (agent_id,at,tick_id,equity_usd,cash_usd,positions_usd,realized_pl)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (agent_id,at) DO NOTHING`,
      [agentId, tickAt, lastTrace?.tickId ?? null, cash + positionsUsd, cash, positionsUsd, num(agent.realizedPlUsd)],
    );
  }
}

async function syncMessageUsage(client, registry) {
  const records = Object.values(registry?.agents ?? {});
  for (const agent of records) {
    for (const [kind, subdir] of [['research', 'research'], ['brain', 'agents']]) {
      const rows = readJsonl(path.join(STATE_DIR, subdir, `${agent.id}.jsonl`));
      for (const row of rows) {
        const at = iso(row.at);
        const usage = row?.usage;
        if (!at) continue;
        const inputTokens = num(usage?.inputTokens);
        const outputTokens = num(usage?.outputTokens);
        const realRmb = inputTokens * RMB_PER_INPUT + outputTokens * RMB_PER_OUTPUT;
        await client.query(
          `INSERT INTO message_usage (agent_id,kind,at,input_tokens,output_tokens,real_rmb,real_credits)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (agent_id,kind,at) DO NOTHING`,
          [agent.id, kind, at, inputTokens, outputTokens, realRmb.toFixed(6), Math.round(realRmb / RMB_PER_CREDIT)],
        );
      }
    }
  }
}

async function syncOnce() {
  const client = await getPool();
  const registry = readJson(path.join(STATE_DIR, 'registry.json'), { agents: {} });
  const ledger = readJson(path.join(STATE_DIR, 'ledger.json'), { agents: {} });
  const traces = readJsonl(path.join(STATE_DIR, 'traces.jsonl'));

  const conn = await client.connect();
  try {
    await conn.query('BEGIN');
    await syncAgents(conn, registry, ledger);
    await syncFills(conn, ledger);
    await syncEvents(conn, ledger);
    await syncEquityTicks(conn, traces, ledger);
    await syncMessageUsage(conn, registry);
    await conn.query('COMMIT');
    console.log(`[etl] synced at ${new Date().toISOString()}: ${Object.keys(registry?.agents ?? {}).length} agents, ${traces.length} ticks`);
  } catch (err) {
    await conn.query('ROLLBACK').catch(() => {});
    console.error('[etl] sync failed:', err.message);
  } finally {
    conn.release();
  }
}

async function main() {
  await getPool();
  await syncOnce();
  setInterval(syncOnce, INTERVAL_MS);
  console.log(`[etl] watching ${STATE_DIR} every ${INTERVAL_MS}ms`);
}

main().catch((err) => { console.error('[etl] fatal:', err); process.exit(1); });
