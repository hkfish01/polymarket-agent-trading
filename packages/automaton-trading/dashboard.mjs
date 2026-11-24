/**
 * dashboard.mjs — read-only operator dashboard server for MEAT.
 *
 * Serves a single HTML page plus a JSON API that merges the engine's durable state:
 *   - registry.json        who is alive/dead, genome, generation
 *   - ledger.json          per-agent cash, positions, trades, P&L, role costs
 *   - treasury.json        portfolio metabolism (runway, state, burn)
 *   - research/<id>.jsonl   per-agent LLM news briefings (verdict, sentiment, tokens)
 *   - agents/<id>.jsonl     per-agent brain decisions (stance, thesis, tokens)
 *   - traces.jsonl          cycle history (tick timing, market breadth)
 *
 * Read-only by construction: this server NEVER writes to the state dir and has no
 * order-entry, transfer, or control surface. It is a monitoring pane only.
 *
 * Run:  node dashboard.mjs
 *   PORT           listen port (default 8088)
 *   HOST           bind host (default 0.0.0.0)
 *   AUTOMATON_STATE_DIR  state dir to read (default ./automaton-data)
 *
 * Zero dependencies: Node built-ins only.
 *
 * @module dashboard
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8088);
const HOST = process.env.HOST ?? '0.0.0.0';
const STATE_DIR = path.resolve(process.env.AUTOMATON_STATE_DIR ?? './automaton-data');

const HTML_FILE = path.join(__dirname, 'dashboard.html');

// ---------------------------------------------------------------------------
// LLM pricing — muskspace TM·DeepSeek-V4.1 (real money spent, not sim cost)
// Price list (积分 per 1M tokens): input cache-hit 30, input cache-miss 300, output 900.
// Operator topped up RMB 80 = 100,000 积分  =>  1 积分 = RMB 80/100000 = RMB 0.0008.
// The usage rows only report inputTokens/outputTokens (no cached-token split), so we
// bill ALL input at the cache-miss rate — a conservative upper bound on real spend.
// Override any of these via env without touching code.
// ---------------------------------------------------------------------------
const PRICE_RMB_PER_TOPUP = Number(process.env.TOPUP_RMB ?? 80);
const PRICE_CREDITS_PER_TOPUP = Number(process.env.TOPUP_CREDITS ?? 100000);
// Operator's reference FX rate for converting the real RMB token bill into USD.
const USD_TO_RMB = Number(process.env.USD_TO_RMB ?? 6.5);
const RMB_PER_CREDIT = PRICE_RMB_PER_TOPUP / PRICE_CREDITS_PER_TOPUP; // 0.0008
const CREDITS_PER_MTOKEN_INPUT_CACHE_HIT = 30;
const CREDITS_PER_MTOKEN_INPUT_CACHE_MISS = 300;
const CREDITS_PER_MTOKEN_OUTPUT = 900;
const RMB_PER_INPUT_TOKEN = (CREDITS_PER_MTOKEN_INPUT_CACHE_MISS / 1e6) * RMB_PER_CREDIT; // 0.00024
const RMB_PER_OUTPUT_TOKEN = (CREDITS_PER_MTOKEN_OUTPUT / 1e6) * RMB_PER_CREDIT;          // 0.00072

/** Real RMB + 积分 spent for a block of tokens, billed at muskspace list prices. */
function computeRealCost(inputTokens, outputTokens) {
  const inputRmb = inputTokens * RMB_PER_INPUT_TOKEN;
  const outputRmb = outputTokens * RMB_PER_OUTPUT_TOKEN;
  const rmb = inputRmb + outputRmb;
  return {
    rmb: Math.round(rmb * 1e6) / 1e6,            // keep precision, round for display later
    credits: Math.round(rmb / RMB_PER_CREDIT),
    inputRmb: Math.round(inputRmb * 1e6) / 1e6,
    outputRmb: Math.round(outputRmb * 1e6) / 1e6,
  };
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function readJsonSafe(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** Read a JSONL file into an array of parsed rows (oldest first), skipping torn lines. */
function readJsonlSafe(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      /* torn line is skipped */
    }
  }
  return rows;
}

const num = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
const round2 = (value) => Math.round(num(value) * 100) / 100;

// ---------------------------------------------------------------------------
// data assembly
// ---------------------------------------------------------------------------

function computeEquity(agentLedger) {
  if (!agentLedger) return { equityUsd: 0, cashUsd: 0, positionsValueUsd: 0, positionsCostUsd: 0, unrealizedPlUsd: 0 };
  const cash = num(agentLedger.cashUsd);
  let positionsValue = 0;
  let positionsCost = 0;
  for (const position of Object.values(agentLedger.positions ?? {})) {
    const mark = num(agentLedger.markPrices?.[position.symbol] ?? position.avgPriceUsd, 0);
    const qty = num(position.qty);
    positionsValue += qty * mark * num(position.multiplier, 1);
    positionsCost += qty * num(position.avgPriceUsd, 0) * num(position.multiplier, 1);
  }
  return {
    equityUsd: round2(cash + positionsValue),
    cashUsd: round2(cash),
    positionsValueUsd: round2(positionsValue),
    positionsCostUsd: round2(positionsCost),
    unrealizedPlUsd: round2(positionsValue - positionsCost),
  };
}

/** Aggregate token usage + cost across both message streams for one agent. */
function aggregateUsage(rows) {
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  let calls = 0;
  for (const row of rows) {
    const usage = row?.usage;
    if (usage) {
      inputTokens += num(usage.inputTokens);
      outputTokens += num(usage.outputTokens);
      calls += 1;
    }
    costUsd += num(row?.costUsd);
  }
  // Real money billed at the operator's muskspace list price (independent of sim costUsd).
  const real = computeRealCost(inputTokens, outputTokens);
  return {
    calls,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    costUsd: Math.round(costUsd * 10000) / 10000,
    realRmb: real.rmb,
    realCredits: real.credits,
    inputRmb: real.inputRmb,
    outputRmb: real.outputRmb,
  };
}

/** Build the per-agent view merging registry + ledger + message streams. */
function buildAgents(registry, ledger, marketMap = {}) {
  const ledgerAgents = ledger?.agents ?? {};
  const records = Array.isArray(registry) ? registry : Object.values(registry?.agents ?? {});
  return records.map((agent) => {
    const id = agent.id;
    const led = ledgerAgents[id] ?? {};
    const equity = computeEquity(led);
    const research = readJsonlSafe(path.join(STATE_DIR, 'research', `${id}.jsonl`));
    const brain = readJsonlSafe(path.join(STATE_DIR, 'agents', `${id}.jsonl`));
    const researchUsage = aggregateUsage(research);
    const brainUsage = aggregateUsage(brain);
    const tokens = {
      inputTokens: researchUsage.inputTokens + brainUsage.inputTokens,
      outputTokens: researchUsage.outputTokens + brainUsage.outputTokens,
      totalTokens: researchUsage.totalTokens + brainUsage.totalTokens,
      calls: researchUsage.calls + brainUsage.calls,
      costUsd: Math.round((researchUsage.costUsd + brainUsage.costUsd) * 10000) / 10000,
      // Real RMB billed at the operator's muskspace price across both streams.
      realRmb: Math.round((researchUsage.realRmb + brainUsage.realRmb) * 1e4) / 1e4,
      realCredits: researchUsage.realCredits + brainUsage.realCredits,
      inputRmb: Math.round((researchUsage.inputRmb + brainUsage.inputRmb) * 1e4) / 1e4,
      outputRmb: Math.round((researchUsage.outputRmb + brainUsage.outputRmb) * 1e4) / 1e4,
      research,
      brain,
    };
    const latestResearch = research.length > 0 ? research[research.length - 1] : null;
    const latestBrain = brain.length > 0 ? brain[brain.length - 1] : null;
    return {
      id,
      name: agent.name ?? null,
      status: agent.status ?? 'alive',
      generation: num(agent.generation, 0),
      parentId: agent.parentId ?? null,
      bornAt: agent.bornAt ?? null,
      diedAt: agent.diedAt ?? null,
      cause: agent.cause ?? null,
      endowmentUsd: round2(agent.endowmentUsd ?? led.declaredEndowmentUsd ?? 0),
      equityUsd: equity.equityUsd,
      cashUsd: equity.cashUsd,
      positionsValueUsd: equity.positionsValueUsd,
      unrealizedPlUsd: equity.unrealizedPlUsd,
      totalPlUsd: round2(led.realizedPlUsd + equity.unrealizedPlUsd),
      // 当前总盈亏 = 目前总额(持仓+现金) − 起始资金。这是相对于你实际投入的真实盈亏，
      // 与「帳面總盈虧」(已实现+未实现) 不同：它会反映 metabolism/LLM 等真实成本消耗。
      currentPlUsd: round2(equity.equityUsd - num(agent.endowmentUsd ?? led.declaredEndowmentUsd ?? 0)),
      positions: Object.values(led.positions ?? {}).map((position) => ({
        symbol: position.symbol,
        assetClass: position.assetClass ?? 'us_equity',
        qty: num(position.qty),
        avgPriceUsd: round2(position.avgPriceUsd),
        markUsd: round2(led.markPrices?.[position.symbol] ?? position.avgPriceUsd),
        multiplier: num(position.multiplier, 1),
      })),
      trades: num(led.trades),
      realizedPlUsd: round2(led.realizedPlUsd),
      tradingFeesUsd: round2(led.tradingFeesUsd),
      costsUsd: round2(led.costsUsd),
      costsByRole: led.costsByRole ?? {},
      grossSpendUsd: round2(led.grossSpendUsd),
      grossRevenueUsd: round2(led.grossRevenueUsd),
      researchMessageCount: research.length,
      brainMessageCount: brain.length,
      latestResearch: latestResearch
        ? {
            at: latestResearch.at,
            verdict: latestResearch.verdict ?? null,
            sentiment: num(latestResearch.sentiment),
            confidence: num(latestResearch.confidence),
            newsCount: num(latestResearch.newsCount),
            summary: latestResearch.summary ?? null,
          }
        : null,
      latestBrain: latestBrain
        ? {
            at: latestBrain.at,
            stance: latestBrain.stance ?? null,
            confidence: num(latestBrain.confidence),
            exitPressure: latestBrain.exitPressure ?? null,
            sizeMultiplier: num(latestBrain.sizeMultiplier, 1),
            riskMultiplier: num(latestBrain.riskMultiplier, 1),
            thesis: latestBrain.thesis ?? null,
          }
        : null,
      tokens,
      // --- detail-view fields (shown when the operator clicks an agent) ---
      // Read-only strategy genome (what this agent was seeded/mutated with).
      params: {
        family: agent.genome?.family ?? null,
        lookback: agent.genome?.lookback ?? null,
        entryZ: agent.genome?.entryZ ?? null,
        exitZ: agent.genome?.exitZ ?? null,
        stopPct: agent.genome?.stopPct ?? null,
        targetPct: agent.genome?.targetPct ?? null,
        maxHoldBars: agent.genome?.maxHoldBars ?? null,
        sizePct: agent.genome?.sizePct ?? null,
        sessionFilter: agent.genome?.sessionFilter ?? null,
        symbols: agent.symbols ?? agent.genome?.symbols ?? [],
        tier: agent.tier ?? null,
      },
      // Trade fills, newest first, capped so the payload stays small.
      fills: (Array.isArray(led.fills) ? led.fills : [])
        .slice()
        .sort((a, b) => num(b.atMs) - num(a.atMs))
        .slice(0, 200)
        .map((fill) => {
          // Enrich each fill with the real market question + a Polymarket link so the
          // detail view can show WHAT the agent actually bought (not just a short code).
          const market = marketMap[fill.symbol] ?? null;
          const link = market?.slug
            ? `https://polymarket.com/market/${market.slug}`
            : (market?.conditionId
              ? `https://polymarket.com/market?conditionId=${encodeURIComponent(market.conditionId)}`
              : null);
          return {
            at: fill.at ?? (fill.atMs ? new Date(fill.atMs).toISOString() : null),
            symbol: fill.symbol ?? null,
            side: fill.side ?? null,
            qty: num(fill.qty),
            priceUsd: round2(fill.priceUsd),
            notionalUsd: round2(fill.notionalUsd),
            feeUsd: round2(fill.feeUsd),
            realizedPlUsd: round2(fill.realizedPlUsd),
            orderId: fill.orderId ?? null,
            question: market?.question ?? null,
            category: market?.category ?? null,
            link,
          };
        }),
      // Cash/accounting events (endowment, burn, replication, etc.), newest first.
      events: (Array.isArray(led.events) ? led.events : [])
        .slice()
        .sort((a, b) => num(b.atMs) - num(a.atMs))
        .slice(0, 200)
        .map((event) => ({
          at: event.at ?? (event.atMs ? new Date(event.atMs).toISOString() : null),
          kind: event.kind ?? null,
          amountUsd: round2(event.amountUsd),
        })),
    };
  });
}

/** Build a summary of the whole population + the latest cycle trace. */
function buildSummary(agents, treasury = {}) {
  const alive = agents.filter((agent) => agent.status === 'alive');
  const dead = agents.filter((agent) => agent.status === 'dead');
  const sum = (pick) => agents.reduce((total, agent) => total + num(pick(agent)), 0);
  const traces = readJsonlSafe(path.join(STATE_DIR, 'traces.jsonl'));
  const lastTrace = traces.length > 0 ? traces[traces.length - 1] : null;
  const aliveEquityUsd = round2(alive.reduce((total, agent) => total + num(agent.equityUsd), 0));
  const deadResidualUsd = round2(dead.reduce((total, agent) => total + num(agent.equityUsd), 0));
  const treasuryPoolUsd = round2(num(treasury.poolUsd));
  // 起始資金：原始 gen0 agent 的 endowment 總和（15 × $500 = $7,500）。
  // 用 gen0 而非全部 agent，因為繁殖子代的 endowment 不屬於初始投入。
  const initialCapitalUsd = round2(
    agents
      .filter((agent) => num(agent.generation, 0) === 0)
      .reduce((total, agent) => total + num(agent.endowmentUsd), 0),
  );
  const totalCashUsd = round2(sum((agent) => agent.cashUsd));
  const totalPositionsValueUsd = round2(sum((agent) => agent.positionsValueUsd));
  const totalUnrealizedPlUsd = round2(sum((agent) => agent.unrealizedPlUsd));
  const totalLlmCostUsd = Math.round(sum((agent) => agent.tokens.costUsd) * 10000) / 10000;
  // ledger 的 costsUsd 才是實際入帳的 inference/data/hosting 成本（tokens.costUsd 通常為 0，
  // 因為上游不回傳 cost 欄位）。用這個口徑才不會把 token 花費算成 0。
  const totalCostsUsd = round2(sum((agent) => agent.costsUsd));
  const totalTradingFeesUsd = round2(sum((agent) => agent.tradingFeesUsd));
  const totalRealRmb = Math.round(sum((agent) => agent.tokens.realRmb) * 1e4) / 1e4;
  // 真實 token 花費：按 muskspace 積分單價計的人民幣帳單，再按操作員匯率換成 USD。
  // 注意：這與 ledger 的 costsUsd（每週期包價的 inference/data/hosting/agent review）
  // 是兩套口徑，不能互換。
  const totalRealTokenCostUsd = Math.round((totalRealRmb / USD_TO_RMB) * 10000) / 10000;
  // 從總額看：treasury 餘額 − 起始投入 − 手續費 − 實際扣帳營運成本 = 留在系統的盈虧。
  const netPnlFromTreasuryUsd = round2(
    treasuryPoolUsd - initialCapitalUsd - totalTradingFeesUsd - totalCostsUsd,
  );
  return {
    totalEquityUsd: round2(sum((agent) => agent.equityUsd)),
    // 资金口径：现金都在 treasury（已死亡 agent 的遗产），已死亡 agent 的残留持仓金额
    // 单独列出，避免「总权益为负 = 亏光」的误读。系统真实资金 = 资金池 + 存活权益。
    treasuryPoolUsd,
    aliveEquityUsd,
    deadResidualUsd,
    systemFundsUsd: round2(treasuryPoolUsd + aliveEquityUsd),
    initialCapitalUsd,
    totalCashUsd,
    totalPositionsValueUsd,
    totalUnrealizedPlUsd,
    netPnlFromTreasuryUsd,
    totalTokens: sum((agent) => agent.tokens.totalTokens),
    totalInputTokens: sum((agent) => agent.tokens.inputTokens),
    totalOutputTokens: sum((agent) => agent.tokens.outputTokens),
    totalLlmCostUsd,
    // Real money the operator has burned (billed at muskspace list price, cache-miss worst case).
    totalRealRmb,
    totalRealTokenCostUsd,
    usdToRmb: USD_TO_RMB,
    totalRealCredits: sum((agent) => agent.tokens.realCredits),
    totalTrades: sum((agent) => agent.trades),
    totalCostsUsd,
    totalTradingFeesUsd,
    totalRealizedPlUsd: round2(sum((agent) => agent.realizedPlUsd)),
    researchMessageCount: sum((agent) => agent.researchMessageCount),
    brainMessageCount: sum((agent) => agent.brainMessageCount),
    aliveCount: alive.length,
    deadCount: dead.length,
    lastTickAt: lastTrace?.at ?? null,
    lastTickDurationMs: num(lastTrace?.durationMs),
    lastTickTreasuryState: lastTrace?.treasury?.state ?? null,
    lastTickMarketSymbols: num(lastTrace?.market?.symbols),
    lastTickHypotheses: num(lastTrace?.prospector?.hypotheses),
  };
}

/**
 * Portfolio equity curve — one point per tick, from the cycle traces.
 * Uses treasury.allocatedUsd (total capital deployed to agents) as the headline line,
 * plus the broker account equity, so the operator sees capital + P&L drift over time.
 */
function buildEquityCurve(limit = 200) {
  const traces = readJsonlSafe(path.join(STATE_DIR, 'traces.jsonl'));
  const points = traces.map((trace) => ({
    t: trace.at,
    tickId: trace.tickId ?? null,
    // Total capital the engine has allocated to the living agent population.
    allocatedUsd: round2(num(trace.treasury?.allocatedUsd)),
    // Whole brokerage account equity (sim starts at 100k; shows realized/unrealized drift).
    accountEquityUsd: round2(num(trace.account?.equityUsd)),
    realizedPlUsd: round2(num(trace.treasury?.surplus7dUsd)),
    aliveAgents: num(trace.deaths) === 0 ? null : null, // not in trace; filled from registry below
    treasuryState: trace.treasury?.state ?? null,
  }));
  return points.slice(Math.max(0, points.length - limit));
}

/**
 * Agent generation tree — parent/child lineage built from registry records.
 * Returns nodes (with depth + children ids) plus edges so the UI can draw the family tree.
 */
function buildGenerationTree(registry) {
  const records = Array.isArray(registry) ? registry : Object.values(registry?.agents ?? {});
  const nodes = records.map((agent) => ({
    id: agent.id,
    name: agent.name ?? agent.id,
    parentId: agent.parentId ?? null,
    generation: num(agent.generation, 0),
    status: agent.status ?? 'alive',
    cause: agent.cause ?? null,
    bornAt: agent.bornAt ?? null,
    diedAt: agent.diedAt ?? null,
    equityUsd: round2(num(agent.equityUsd)),
  }));
  const byId = new Map(nodes.map((node) => [node.id, { ...node, children: [] }]));
  const roots = [];
  for (const node of byId.values()) {
    const parent = node.parentId ? byId.get(node.parentId) : null;
    if (parent) parent.children.push(node.id);
    else roots.push(node.id);
  }
  return { roots, nodes: [...byId.values()] };
}

/**
 * Death statistics — cause breakdown + a timeline of every death event found in traces.
 * The trace `deathsExecuted` array lists agents reaped on each tick; registry has cause labels.
 */
function buildDeathStats(registry, traces) {
  const records = Array.isArray(registry) ? registry : Object.values(registry?.agents ?? {});
  const dead = records.filter((agent) => agent.status === 'dead');
  const byCause = {};
  for (const agent of dead) {
    const cause = agent.cause ?? 'unknown';
    byCause[cause] = (byCause[cause] ?? 0) + 1;
  }
  const deaths = dead.map((agent) => ({
    id: agent.id,
    name: agent.name ?? agent.id,
    cause: agent.cause ?? 'unknown',
    generation: num(agent.generation, 0),
    diedAt: agent.diedAt ?? null,
    finalEquityUsd: round2(num(agent.equityUsd)),
  })).sort((a, b) => String(a.diedAt ?? '').localeCompare(String(b.diedAt ?? '')));
  return {
    totalDeaths: dead.length,
    byCause,
    deaths,
    // Survivors by generation, useful alongside the death tally.
    aliveByGeneration: records
      .filter((agent) => agent.status === 'alive')
      .reduce((acc, agent) => {
        const gen = num(agent.generation, 0);
        acc[gen] = (acc[gen] ?? 0) + 1;
        return acc;
      }, {}),
  };
}

function buildPayload() {
  const registry = readJsonSafe(path.join(STATE_DIR, 'registry.json'), { agents: {} });
  const ledger = readJsonSafe(path.join(STATE_DIR, 'ledger.json'), { agents: {} });
  const treasury = readJsonSafe(path.join(STATE_DIR, 'treasury.json'), {});
  // Broker market snapshot (symbol -> {question, slug, category, ...}) so fills can be
  // labeled with the real Polymarket question and linked to its market page.
  const marketSnap = readJsonSafe(path.join(STATE_DIR, 'markets.json'), { markets: {} });
  const marketMap = marketSnap?.markets ?? {};
  const agents = buildAgents(registry, ledger, marketMap);
  const traces = readJsonlSafe(path.join(STATE_DIR, 'traces.jsonl'));
  return {
    generatedAt: new Date().toISOString(),
    stateDir: STATE_DIR,
    treasury,
    // Pricing block so the UI can show real money + remaining credit balance.
    pricing: {
      currency: 'RMB',
      rmbPerCredit: RMB_PER_CREDIT,
      rmbPerInputToken: RMB_PER_INPUT_TOKEN,
      rmbPerOutputToken: RMB_PER_OUTPUT_TOKEN,
      creditsPerMToken: {
        inputCacheHit: CREDITS_PER_MTOKEN_INPUT_CACHE_HIT,
        inputCacheMiss: CREDITS_PER_MTOKEN_INPUT_CACHE_MISS,
        output: CREDITS_PER_MTOKEN_OUTPUT,
      },
      topupRmb: PRICE_RMB_PER_TOPUP,
      topupCredits: PRICE_CREDITS_PER_TOPUP,
      usdToRmb: USD_TO_RMB,
      // Billing assumption: usage rows have no cached-token field, so all input is
      // billed at the cache-miss rate (conservative upper bound on real spend).
      inputBillingAssumption: 'cache-miss (worst case)',
    },
    summary: buildSummary(agents, treasury),
    agents,
    // New analytical views for the operator dashboard.
    equityCurve: buildEquityCurve(),
    generationTree: buildGenerationTree(registry),
    deathStats: buildDeathStats(registry, traces),
    // Scout Bot sentiment signals (symbol -> latest headline + sentiment + nudge).
    scoutSignals: buildScoutSignals(),
  };
}

/**
 * Scout Bot sentiment signals. Reads the scout_signals.json snapshot that the Scout
 * service rebuilds after every scan. Returns an array sorted by |sentiment| desc so
 * the most newsworthy markets float to the top of the dashboard block.
 */
function buildScoutSignals() {
  const snap = readJsonSafe(path.join(STATE_DIR, 'scout_signals.json'), { signals: {} });
  const signals = Object.values(snap?.signals ?? {}).map((s) => ({
    symbol: s.symbol,
    question: s.question,
    category: s.category,
    headline: s.headline,
    headlineUrl: s.headlineUrl,
    sentiment: Number(s.sentiment),
    probNudge: Number(s.probNudge),
    summary: s.summary,
    sources: Number(s.sources),
    at: s.at,
  }));
  signals.sort((a, b) => Math.abs(b.sentiment) - Math.abs(a.sentiment));
  return signals;
}

// ---------------------------------------------------------------------------
// server
// ---------------------------------------------------------------------------

const server = http.createServer((request, response) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  response.setHeader('Access-Control-Allow-Origin', '*');
  if (url.pathname === '/api/state') {
    const payload = buildPayload();
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(payload));
    return;
  }
  if (url.pathname === '/' || url.pathname === '/index.html') {
    try {
      const html = fs.readFileSync(HTML_FILE, 'utf8');
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(html);
    } catch (error) {
      response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      response.end(`dashboard.html missing: ${error.message}`);
    }
    return;
  }
  response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  response.end('not found');
});

server.listen(PORT, HOST, () => {
  console.log(`[dashboard] serving on http://${HOST}:${PORT}  (state: ${STATE_DIR})`);
});

export default server;
