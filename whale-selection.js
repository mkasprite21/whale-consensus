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
  // sort_by omitted on purpose -> Falcon defaults to H-Score, its own
  // bot/luck-filtered quality ranking. Sorting by "roi" surfaces
  // concentrated outliers (e.g. 1000% ROI across only 2 markets).
};

// Applied locally: Falcon has no server-side param for these.
const LOCAL_RULES = {
  minMarketsTraded15d: 5,   // spread across markets, not one lucky bet
  maxHScoreRank: 250,       // stay near the top of their quality ranking
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
// Confirmed against a live agent 584 response on 2026-08-18.
function normalizeTrader(raw) {
  return {
    address: raw.wallet ?? raw.proxy_wallet ?? raw.wallet_address ?? null,
    name: raw.username ?? raw.name ?? raw.wallet ?? "unknown",
    winRate15d: normalizeWinRate(raw.win_rate_pct_15d),   // comes as "83.3"
    roi15d: num(raw.roi_pct_15d),
    pnl15d: num(raw.total_pnl_15d),
    trades15d: num(raw.total_trades_15d),
    marketsTraded15d: num(raw.markets_traded_15d),        // concentration guard
    volume15d: num(raw.total_volume_15d),
    hScore: has(raw.h_score) ? num(raw.h_score) : null,
    rank: has(raw.leaderboard_rank) ? num(raw.leaderboard_rank) : null,
    sharpe15d: has(raw.sharpe_ratio_15d) ? num(raw.sharpe_ratio_15d) : null,
    tier: raw.tier ?? null,                               // e.g. "Emerging"
    trajectory: raw.trajectory ?? null,                   // e.g. "improving"
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
  if (t.marketsTraded15d && t.marketsTraded15d < LOCAL_RULES.minMarketsTraded15d)
    reasons.push(`only ${t.marketsTraded15d} markets`);
  if (t.rank !== null && t.rank > LOCAL_RULES.maxHScoreRank)
    reasons.push(`rank ${t.rank}`);
  return { ok: reasons.length === 0, reasons };
}

// ─── Score (ranking within the survivors) ──────────────────────────────
// Falcon Score first when present (it is their bot/luck-filtered ranking),
// then ROI, then a mild bonus for the 60-85% win-rate sweet spot.
function score(t) {
  let s = 0;

  // H-Score leads: Falcon's own quality ranking, already luck/bot filtered.
  if (t.hScore !== null) s += Math.min(t.hScore / 100, 1) * 40;

  // ROI capped at 100% so a 1000% outlier cannot buy its way to the top.
  s += Math.min(Math.max(t.roi15d, 0) / 100, 1) * 20;

  // Diversity: spread across markets beats one concentrated hit.
  s += Math.min(t.marketsTraded15d / 20, 1) * 15;

  s += Math.min(Math.max(t.pnl15d, 0) / 100000, 1) * 10;

  // Win-rate sweet spot: confident favorites, not thin-edge farming.
  if (t.winRate15d !== null) s += (t.winRate15d >= 0.6 && t.winRate15d <= 0.85 ? 1 : 0.4) * 10;

  if (t.trajectory === "improving") s += 5;                       // momentum
  if (t.sharpe15d !== null) s += Math.min(Math.max(t.sharpe15d, 0) / 3, 1) * 5;

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
    hScore: t.hScore,
    rank: t.rank,
    marketsTraded15d: t.marketsTraded15d,
    tier: t.tier,
    trajectory: t.trajectory,
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
  FILTERS, LOCAL_RULES, CONFIG, AGENTS,
};
