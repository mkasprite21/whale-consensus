// ═══════════════════════════════════════════════════════════════════════
// whale-selection.js — builds the tracked whale pool for Whale Consensus
// ═══════════════════════════════════════════════════════════════════════
// Data source: Falcon API (Polymarket Analytics).
//   Agent 584 = Falcon Score Leaderboard (trader quality ranking)
//   Agent 581 = Wallet 360 (60+ metrics, optional deep vetting)
//
// Falcon's agent 584 does most of our filtering server-side, so we spend
// ONE credit per day instead of screening thousands of rows ourselves.
//
// CREDIT BUDGET (free plan = 100/day):
//   Selection runs ONCE PER DAY and is cached. 1 credit/day.
//   Optional Wallet 360 enrichment costs 1 credit per whale (25 = 25/day).
//   Never call selectWhalePool() on the 5-minute refresh loop.
//
// Requires Node 18+ (built-in fetch). CommonJS.

const CONFIG = {
  // The quickstart curl and the context file list different hosts.
  // retriever.falconapi.net is the one our probe confirmed working.
  url: "https://retriever.falconapi.net/api/v2/semantic/retrieve/parameterized",
  fallbackUrl: "https://narrative.agent.heisenberg.so/api/v2/semantic/retrieve/parameterized",
  token: process.env.FALCON_API_KEY,   // set in Render > Environment
  poolSize: 25,
  cacheHours: 24,                      // refresh the pool once per day
  enrichWithWallet360: false,          // true = +1 credit per whale
};

const AGENTS = {
  falconScore: 584,   // trader quality leaderboard  <- our selection source
  wallet360: 581,     // 60+ metrics for one wallet
  trades: 556,        // live trade feed (Layer 2 will use this)
  markets: 574,
};

// ─── Selection filters (sent to Falcon, applied server-side) ───────────
// NOTE: every metric here is a 15-DAY window, not all-time. That is what
// makes this a recency filter by default.
const FILTERS = {
  min_win_rate_15d: "0.55",      // real skill floor
  max_win_rate_15d: "0.92",      // excludes thin-edge favorite-farmers
  min_roi_15d: "5",              // must be beating flat by a real margin
  min_pnl_15d: "5000",           // plays meaningful size
  min_total_trades_15d: "30",    // enough activity to be a sample
  max_total_trades_15d: "5000",  // not a bot you cannot mirror
  sort_by: "roi",
};

// ─── Local cache ───────────────────────────────────────────────────────
let cache = { pool: null, fetchedAt: 0 };
const cacheIsFresh = () =>
  cache.pool && Date.now() - cache.fetchedAt < CONFIG.cacheHours * 3600 * 1000;

// ─── Helpers ───────────────────────────────────────────────────────────
const num = (v) => {
  if (typeof v === "number") return v;
  const n = parseFloat(String(v ?? "").replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : 0;
};
const has = (v) => v !== null && v !== undefined && v !== "";

function normalizeWinRate(v) {
  if (!has(v)) return null;
  const n = num(v);
  return n > 1 ? n / 100 : n;   // accept 96.3 or 0.963
}

// ─── Normalize a Falcon row -> our internal shape ──────────────────────
// Falcon returns numbers as STRINGS, so everything goes through num().
// Fields Falcon may not expose stay null and their logic is skipped.
// >>> If a field name differs, fix it HERE and nowhere else. <<<
function normalizeTrader(raw) {
  return {
    address: raw.proxy_wallet ?? raw.wallet_address ?? raw.wallet ?? raw.address ?? null,
    name: raw.username ?? raw.name ?? raw.proxy_wallet ?? "unknown",
    winRate15d: normalizeWinRate(raw.win_rate_15d ?? raw.win_rate ?? raw.winRate),
    roi15d: num(raw.roi_15d ?? raw.roi_pct ?? raw.roi),
    pnl15d: num(raw.pnl_15d ?? raw.total_pnl ?? raw.pnl),
    trades15d: num(raw.total_trades_15d ?? raw.total_trades ?? raw.trades),
    falconScore: has(raw.falcon_score ?? raw.h_score ?? raw.score)
      ? num(raw.falcon_score ?? raw.h_score ?? raw.score)
      : null,
    raw,
  };
}

// ─── Local sanity re-check ─────────────────────────────────────────────
// Falcon already filtered server-side. This only catches rows that slip
// through (nulls, unexpected shapes) so bad data cannot reach the pool.
function passesFilters(t) {
  const reasons = [];
  if (!t.address) reasons.push("no wallet address");
  if (t.winRate15d !== null) {
    if (t.winRate15d < num(FILTERS.min_win_rate_15d)) reasons.push(`winrate ${(t.winRate15d * 100).toFixed(0)}%`);
    if (t.winRate15d > num(FILTERS.max_win_rate_15d)) reasons.push(`favorite-farmer ${(t.winRate15d * 100).toFixed(0)}%`);
  }
  if (t.roi15d && t.roi15d < num(FILTERS.min_roi_15d)) reasons.push(`roi ${t.roi15d}%`);
  if (t.trades15d && t.trades15d < num(FILTERS.min_total_trades_15d)) reasons.push(`only ${t.trades15d} trades`);
  if (t.trades15d && t.trades15d > num(FILTERS.max_total_trades_15d)) reasons.push(`high-freq ${t.trades15d}`);
  return { ok: reasons.length === 0, reasons };
}

// ─── Score (ranking within the survivors) ──────────────────────────────
// Falcon Score first when present (it is their bot/luck-filtered ranking),
// then ROI, then a mild bonus for the 60-85% win-rate sweet spot.
function score(t) {
  let s = 0;
  if (t.falconScore !== null) s += Math.min(t.falconScore / 100, 1) * 45;
  else s += Math.min(Math.max(t.roi15d, 0) / 50, 1) * 45;

  s += Math.min(Math.max(t.roi15d, 0) / 50, 1) * 30;
  s += Math.min(Math.max(t.pnl15d, 0) / 100000, 1) * 15;

  if (t.winRate15d !== null) {
    const sweet = t.winRate15d >= 0.6 && t.winRate15d <= 0.85 ? 1 : 0.5;
    s += sweet * 10;
  }
  return s;
}

// ─── Falcon request ────────────────────────────────────────────────────
async function falconQuery(agentId, params = {}, limit = 100, offset = 0) {
  if (!CONFIG.token) throw new Error("FALCON_API_KEY is not set. Add it in Render > Environment.");

  const body = JSON.stringify({
    agent_id: agentId,
    params,
    pagination: { limit, offset },      // limit max is 200
    formatter_config: { format_type: "raw" },
  });
  const headers = {
    Authorization: `Bearer ${CONFIG.token}`,
    "Content-Type": "application/json",
  };

  let res;
  try {
    res = await fetch(CONFIG.url, { method: "POST", headers, body });
  } catch (e) {
    res = await fetch(CONFIG.fallbackUrl, { method: "POST", headers, body });
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Falcon ${res.status} ${res.statusText}. ${text.slice(0, 300)}`);
  }

  const json = await res.json();
  return {
    rows: json?.data?.results ?? [],
    hasMore: json?.pagination?.has_more ?? false,
  };
}

// ─── Optional deep vetting via Wallet 360 (costs 1 credit per whale) ───
async function enrichWallet(address) {
  const { rows } = await falconQuery(
    AGENTS.wallet360,
    { proxy_wallet: address, window_days: "15" },   // allowed: 1, 3, 7, 15
    1, 0
  );
  return rows[0] || null;
}

// ─── Public entry point ────────────────────────────────────────────────
async function selectWhalePool({ force = false } = {}) {
  if (!force && cacheIsFresh()) {
    console.log(`[whale-selection] using cached pool (${cache.pool.length} whales)`);
    return cache.pool;
  }

  const { rows } = await falconQuery(AGENTS.falconScore, FILTERS, 100, 0);
  const traders = rows.map(normalizeTrader);
  const passed = traders.filter((t) => passesFilters(t).ok);
  passed.sort((a, b) => score(b) - score(a));

  const pool = passed.slice(0, CONFIG.poolSize).map((t) => ({
    name: t.name,
    address: t.address,
    winRate: t.winRate15d !== null ? +(t.winRate15d * 100).toFixed(1) : null,
    roi15d: t.roi15d,
    pnl15d: t.pnl15d,
    trades15d: t.trades15d,
    falconScore: t.falconScore,
    score: +score(t).toFixed(1),
  }));

  if (CONFIG.enrichWithWallet360) {
    for (const w of pool) {
      try { w.wallet360 = await enrichWallet(w.address); }
      catch (e) { w.wallet360 = null; }
    }
  }

  cache = { pool, fetchedAt: Date.now() };
  console.log(`[whale-selection] fetched ${traders.length}, passed ${passed.length}, keeping ${pool.length}`);
  pool.forEach((t, i) =>
    console.log(`  ${String(i + 1).padStart(2)}. ${String(t.name).slice(0, 20).padEnd(20)} win ${t.winRate ?? "n/a"}%  roi ${t.roi15d}%  trades ${t.trades15d}  score ${t.score}`)
  );
  return pool;
}

// ─── Probe: GET /api/probe ─────────────────────────────────────────────
async function probe() {
  const { rows } = await falconQuery(AGENTS.falconScore, FILTERS, 3, 0);
  return { agentId: AGENTS.falconScore, filters: FILTERS, rowCount: rows.length, firstRow: rows[0] || null };
}

module.exports = {
  selectWhalePool, probe, falconQuery, enrichWallet,
  normalizeTrader, passesFilters, score,
  FILTERS, CONFIG, AGENTS,
};
