// ═══════════════════════════════════════════════════════════════════════
// whale-selection.js — builds the tracked whale pool for Whale Consensus
// ═══════════════════════════════════════════════════════════════════════
// Data source: Falcon API (Polymarket Analytics).
//   POST https://retriever.falconapi.net/api/v2/semantic/retrieve/parameterized
//   Auth: Authorization: Bearer <token>
//   You address datasets by agent_id, not by URL path.
//
// Requires Node 18+ (built-in fetch). Render uses 18+ by default.
// CommonJS. If index.js uses `import`, swap module.exports for `export {}`.
//
// ─── THE ONE THING YOU MUST SET ────────────────────────────────────────
// AGENTS.leaderboard below is a placeholder. Log into the Falcon dashboard,
// find the agent_id for the "Top Polymarket Traders" / leaderboard dataset,
// and paste it in. 574 = markets and 586 = single-wallet performance are
// documented; the leaderboard id is not, so it must come from your account.
// Until it is set, run `node whale-selection.js --probe` to test connection.

const CONFIG = {
  url: "https://retriever.falconapi.net/api/v2/semantic/retrieve/parameterized",
  token: process.env.FALCON_API_KEY,   // set in Render > Environment. Never hardcode.
  poolSize: 25,
  pageLimit: 200,
  maxPages: 5,                          // safety cap: 1000 traders max
};

const AGENTS = {
  leaderboard: null,   // <<< SET THIS from your Falcon dashboard
  walletPerf: 586,     // documented: single-wallet performance
  markets: 574,        // documented: markets/outcomes (used later by Layer 2)
};

// ─── Selection criteria ────────────────────────────────────────────────
const CRITERIA = {
  minProfitFactor: 3.0,      // only enforced if gains/losses are exposed
  profitFactorCap: 20,
  minTotalTrades: 200,       // big enough sample to be skill, not luck
  maxTotalTrades: 5000,      // above this it is a bot you cannot mirror by hand
  minRoiPct: 5,              // must actually be profitable
  minTotalPnl: 50000,        // plays meaningful size
  minRecentRoiPct: 0,        // 15d/30d ROI must be green -> the recency filter
  minWinRate: 0.55,          // soft floor, only if exposed
};

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
  return n > 1 ? n / 100 : n;
}

// ─── Normalize a Falcon row -> our internal shape ──────────────────────
// Falcon returns numbers as STRINGS ("-1396944.57"), so everything goes
// through num(). Fields Falcon may not expose stay null, and any filter
// depending on them is skipped rather than failing the trader.
// >>> If a field name differs, fix it HERE and nowhere else. <<<
function normalizeTrader(raw) {
  const gainsRaw = raw.total_gains ?? raw.gains ?? raw.total_wins;
  const lossesRaw = raw.total_losses ?? raw.losses;
  return {
    address: raw.proxy_wallet ?? raw.wallet_address ?? raw.address ?? null,
    name: raw.username ?? raw.name ?? raw.proxy_wallet ?? "unknown",
    totalPnl: num(raw.total_pnl ?? raw.pnl),
    roiPct: num(raw.roi_pct ?? raw.roi),
    totalInvested: num(raw.total_invested),
    totalTrades: num(raw.total_trades ?? raw.trades ?? raw.total_positions),
    avgTradeSize: num(raw.avg_trade_size),
    avgPnlPerTrade: num(raw.avg_pnl_per_trade),
    // Recency: Falcon's leaderboard shows a 15d ROI. Accept several spellings.
    recentRoiPct: has(raw.roi_15d ?? raw.roi_15d_pct ?? raw.pnl_15d ?? raw.roi_30d)
      ? num(raw.roi_15d ?? raw.roi_15d_pct ?? raw.pnl_15d ?? raw.roi_30d)
      : null,
    fScore: has(raw.f_score ?? raw.fscore) ? num(raw.f_score ?? raw.fscore) : null,
    gains: has(gainsRaw) ? Math.abs(num(gainsRaw)) : null,
    losses: has(lossesRaw) ? Math.abs(num(lossesRaw)) : null,
    winRate: normalizeWinRate(raw.win_rate ?? raw.winRate ?? raw.win_pct),
    raw,
  };
}

// Profit factor: null when Falcon does not expose the gains/losses split.
function profitFactor(t) {
  if (t.gains === null || t.losses === null) return null;
  if (t.losses <= 0) return CRITERIA.profitFactorCap;
  return Math.min(t.gains / t.losses, CRITERIA.profitFactorCap);
}

// ─── Filter ────────────────────────────────────────────────────────────
function passesFilters(t) {
  const reasons = [];
  const pf = profitFactor(t);

  if (pf !== null && pf < CRITERIA.minProfitFactor) reasons.push(`profit factor ${pf.toFixed(2)}`);
  if (t.totalTrades && t.totalTrades < CRITERIA.minTotalTrades) reasons.push(`only ${t.totalTrades} trades`);
  if (t.totalTrades && t.totalTrades > CRITERIA.maxTotalTrades) reasons.push(`high-freq ${t.totalTrades}`);
  if (t.roiPct < CRITERIA.minRoiPct) reasons.push(`roi ${t.roiPct}%`);
  if (t.totalPnl < CRITERIA.minTotalPnl) reasons.push(`pnl $${Math.round(t.totalPnl)}`);
  if (t.recentRoiPct !== null && t.recentRoiPct <= CRITERIA.minRecentRoiPct)
    reasons.push(`recent roi ${t.recentRoiPct}%`);
  if (t.winRate !== null && t.winRate < CRITERIA.minWinRate)
    reasons.push(`winrate ${(t.winRate * 100).toFixed(0)}%`);

  return { ok: reasons.length === 0, reasons };
}

// ─── Score ─────────────────────────────────────────────────────────────
// Weights shift depending on which fields exist. Discipline first when we
// can measure it (profit factor), otherwise lean on ROI and Falcon F-Score.
function score(t) {
  let s = 0;
  const pf = profitFactor(t);

  if (pf !== null) s += (pf / CRITERIA.profitFactorCap) * 40;
  else if (t.fScore !== null) s += Math.min(t.fScore / 100, 1) * 40;
  else s += Math.min(Math.max(t.roiPct, 0) / 50, 1) * 40;

  if (t.recentRoiPct !== null) s += Math.min(Math.max(t.recentRoiPct, 0) / 20, 1) * 30; // recency
  s += Math.min(Math.max(t.roiPct, 0) / 50, 1) * 20;                                     // overall ROI
  if (t.winRate !== null) s += t.winRate * 10;
  else s += Math.min(t.totalTrades / CRITERIA.maxTotalTrades, 1) * 10;                   // sample depth

  return s;
}

// ─── Falcon request ────────────────────────────────────────────────────
async function falconQuery(agentId, params = {}, limit = CONFIG.pageLimit, offset = 0) {
  if (!CONFIG.token) throw new Error("FALCON_API_KEY is not set. Add it in Render > Environment.");
  if (!agentId) throw new Error("agent_id is not set. Fill AGENTS.leaderboard from your Falcon dashboard.");

  const res = await fetch(CONFIG.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${CONFIG.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      agent_id: agentId,
      params,
      pagination: { limit, offset },
      formatter_config: { format_type: "raw" },
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Falcon returned ${res.status} ${res.statusText}. ${body.slice(0, 300)}`);
  }

  const json = await res.json();
  return {
    rows: json?.data?.results ?? [],
    hasMore: json?.pagination?.has_more ?? false,
  };
}

// ─── Public entry point ────────────────────────────────────────────────
async function selectWhalePool() {
  const all = [];
  for (let page = 0; page < CONFIG.maxPages; page++) {
    const { rows, hasMore } = await falconQuery(
      AGENTS.leaderboard, {}, CONFIG.pageLimit, page * CONFIG.pageLimit
    );
    all.push(...rows);
    if (!hasMore || rows.length === 0) break;
  }

  const traders = all.map(normalizeTrader);
  const passed = traders.filter((t) => passesFilters(t).ok);
  passed.sort((a, b) => score(b) - score(a));

  const pool = passed.slice(0, CONFIG.poolSize).map((t) => ({
    name: t.name,
    address: t.address,
    profitFactor: profitFactor(t),
    roiPct: t.roiPct,
    recentRoiPct: t.recentRoiPct,
    totalTrades: t.totalTrades,
    totalPnl: t.totalPnl,
    score: +score(t).toFixed(1),
  }));

  console.log(`[whale-selection] fetched ${traders.length}, passed ${passed.length}, keeping ${pool.length}`);
  pool.forEach((t, i) =>
    console.log(`  ${String(i + 1).padStart(2)}. ${String(t.name).slice(0, 22).padEnd(22)} ROI ${t.roiPct}%  recent ${t.recentRoiPct ?? "n/a"}  trades ${t.totalTrades}  score ${t.score}`)
  );
  return pool;
}

// ─── Probe: run `node whale-selection.js --probe` ──────────────────────
// Confirms the key works and PRINTS ONE RAW ROW so you can see the real
// field names. Paste that row to me and I will lock normalizeTrader().
async function probe() {
  const agentId = AGENTS.leaderboard || AGENTS.walletPerf;
  console.log(`Probing Falcon with agent_id ${agentId}...`);
  try {
    const { rows } = await falconQuery(
      agentId,
      AGENTS.leaderboard ? {} : { wallet_address: "0x6ac5bb06a9eb05641fd5e82640268b92f3ab4b6e" },
      3, 0
    );
    console.log(`Connection OK. ${rows.length} row(s) returned.\nFirst raw row:`);
    console.log(JSON.stringify(rows[0], null, 2));
  } catch (e) {
    console.error("Probe failed:", e.message);
  }
}

if (require.main === module && process.argv.includes("--probe")) probe();

module.exports = { selectWhalePool, passesFilters, score, profitFactor, normalizeTrader, falconQuery, CRITERIA, CONFIG, AGENTS };
