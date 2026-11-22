-- MEAT archive schema. The ETL service (etl.mjs) upserts engine state into these
-- tables so history survives state-volume clears (e.g. re-seeding the population)
-- and gives fast SQL queries for the operator dashboard.

-- One row per agent ever registered (alive or dead).
CREATE TABLE IF NOT EXISTS agents (
  id            TEXT PRIMARY KEY,
  name          TEXT,
  status        TEXT NOT NULL DEFAULT 'alive',
  generation    INTEGER NOT NULL DEFAULT 0,
  parent_id     TEXT,
  born_at       TIMESTAMPTZ,
  died_at       TIMESTAMPTZ,
  cause         TEXT,
  endowment_usd NUMERIC,
  equity_usd    NUMERIC,
  cash_usd      NUMERIC,
  realized_pl   NUMERIC,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Trade fills (one row per executed fill). Append-only from ledger.fills.
CREATE TABLE IF NOT EXISTS fills (
  id            BIGSERIAL PRIMARY KEY,
  agent_id      TEXT NOT NULL,
  symbol        TEXT,
  side          TEXT,
  qty           NUMERIC,
  price_usd     NUMERIC,
  notional_usd  NUMERIC,
  realized_pl   NUMERIC,
  at            TIMESTAMPTZ NOT NULL,
  order_id      TEXT,
  UNIQUE (agent_id, order_id, symbol, side, at)
);
CREATE INDEX IF NOT EXISTS fills_agent_at_idx ON fills (agent_id, at DESC);

-- Portfolio equity over time, one row per agent per tick. Append-only.
CREATE TABLE IF NOT EXISTS equity_ticks (
  id            BIGSERIAL PRIMARY KEY,
  agent_id      TEXT,
  at            TIMESTAMPTZ NOT NULL,
  tick_id       TEXT,
  equity_usd    NUMERIC,
  cash_usd      NUMERIC,
  positions_usd NUMERIC,
  realized_pl   NUMERIC,
  UNIQUE (agent_id, at)
);
CREATE INDEX IF NOT EXISTS equity_agent_at_idx ON equity_ticks (agent_id, at DESC);

-- Cash / accounting events (endowment declared, burn, replication, etc.).
CREATE TABLE IF NOT EXISTS events (
  id         BIGSERIAL PRIMARY KEY,
  agent_id   TEXT NOT NULL,
  at         TIMESTAMPTZ NOT NULL,
  kind       TEXT,
  amount_usd NUMERIC,
  UNIQUE (agent_id, at, kind, amount_usd)
);
CREATE INDEX IF NOT EXISTS events_agent_at_idx ON events (agent_id, at DESC);

-- LLM token usage per message, with real RMB billed at the operator's list price.
CREATE TABLE IF NOT EXISTS message_usage (
  id            BIGSERIAL PRIMARY KEY,
  agent_id      TEXT NOT NULL,
  kind          TEXT NOT NULL,          -- 'research' | 'brain'
  at            TIMESTAMPTZ NOT NULL,
  input_tokens  INTEGER,
  output_tokens INTEGER,
  real_rmb      NUMERIC,
  real_credits  INTEGER,
  UNIQUE (agent_id, kind, at)
);
CREATE INDEX IF NOT EXISTS usage_agent_at_idx ON message_usage (agent_id, at DESC);

-- Scout Bot sentiment signals (one row per market per scan). The Scout service
-- polls SearXNG for fresh headlines about each active Polymarket market, asks the
-- LLM to score sentiment + a probability nudge, and writes the result here so
-- prob-trader can condition its estimates on real news and the dashboard can show
-- a "latest sentiment" block. History is kept for post-hoc edge analysis.
CREATE TABLE IF NOT EXISTS scout_signals (
  id             BIGSERIAL PRIMARY KEY,
  symbol         TEXT NOT NULL,           -- short code (PC1, PP2, ...)
  question       TEXT,                    -- the real market question
  category       TEXT,
  headline       TEXT,                    -- top headline SearXNG returned
  headline_url   TEXT,
  sentiment      NUMERIC,                 -- -1.0 .. +1.0
  prob_nudge     NUMERIC,                 -- -0.10 .. +0.10, LLM's suggested shift
  summary        TEXT,                    -- one-line LLM rationale
  sources        INTEGER,                 -- how many headlines were considered
  at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (symbol, at)
);
CREATE INDEX IF NOT EXISTS scout_symbol_at_idx ON scout_signals (symbol, at DESC);
