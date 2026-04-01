// ═══════════════════════════════════════════════════════════════════════
// WHALE CONSENSUS BACKEND — Polymarket Intelligence → Kalshi Execution
// ═══════════════════════════════════════════════════════════════════════
// This server:
// 1. Fetches top traders from Polymarket's public leaderboard API
// 2. Fetches each whale's current positions
// 3. Fetches active Kalshi markets
// 4. Cross-references to find consensus signals with Kalshi matches
// 5. Serves everything as JSON to your dashboard
//
// HOW TO RUN:
//   npm install express node-fetch cors
//   node server.js
//   Dashboard will connect to http://localhost:3001
// ═══════════════════════════════════════════════════════════════════════

const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3001;

// Allow dashboard to connect from any origin
app.use(cors());
app.use(express.json());

// ─── Config ──────────────────────────────────────────────────────────
const POLYMARKET_DATA_API = "https://data-api.polymarket.com";
const POLYMARKET_GAMMA_API = "https://gamma-api.polymarket.com";
const KALSHI_API = "https://api.elections.kalshi.com/trade-api/v2";

const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes
let cache = {
  leaderboard: null,
  whalePositions: null,
  kalshiMarkets: null,
  consensus: null,
  lastUpdated: 0,
};

// ─── Fetch Helpers ───────────────────────────────────────────────────
async function safeFetch(url, options = {}) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        "Accept": "application/json",
        "User-Agent": "WhaleConsensus/1.0",
        ...options.headers,
      },
    });

    clearTimeout(timeout);

    if (!res.ok) {
      console.error(`[FETCH ERROR] ${url} → ${res.status} ${res.statusText}`);
      return null;
    }

    return await res.json();
  } catch (err) {
    console.error(`[FETCH ERROR] ${url} → ${err.message}`);
    return null;
  }
}

// ─── Polymarket: Get Leaderboard ─────────────────────────────────────
async function getLeaderboard() {
  console.log("[PM] Fetching leaderboard...");

  // Try the official leaderboard endpoint
  const data = await safeFetch(
    `${POLYMARKET_DATA_API}/leaderboard?period=month&limit=25&orderBy=pnl`
  );

  if (data && Array.isArray(data) && data.length > 0) {
    return data.map((w, i) => ({
      rank: i + 1,
      name: w.pseudonym || w.name || w.username || `Wallet ${(w.proxyWallet || w.address || "").slice(0, 8)}`,
      address: w.proxyWallet || w.address || "",
      pnl: w.pnl || w.cashPnl || 0,
      volume: w.volume || w.totalVolume || 0,
      winRate: w.winRate || null,
      marketsTraded: w.marketsTraded || w.markets || 0,
    }));
  }

  console.log("[PM] Leaderboard endpoint returned empty, trying profiles...");
  return null;
}

// ─── Polymarket: Get User Positions ──────────────────────────────────
async function getUserPositions(address) {
  const data = await safeFetch(
    `${POLYMARKET_DATA_API}/positions?user=${address}&sizeThreshold=0.5&limit=30&sortBy=CURRENT&sortDirection=DESC`
  );

  if (!data || !Array.isArray(data)) return [];

  return data.map((p) => ({
    title: p.title || "Unknown Market",
    slug: p.slug || p.eventSlug || "",
    outcome: p.outcome || "Unknown",
    size: p.size || 0,
    avgPrice: p.avgPrice || 0,
    currentPrice: p.curPrice || 0,
    currentValue: p.currentValue || 0,
    pnl: p.cashPnl || 0,
    endDate: p.endDate || null,
    conditionId: p.conditionId || "",
  }));
}

// ─── Kalshi: Get Active Markets ──────────────────────────────────────
async function getKalshiMarkets() {
  console.log("[KALSHI] Fetching active markets...");

  // Kalshi public endpoint — no auth needed for market data
  const data = await safeFetch(
    `${KALSHI_API}/markets?limit=200&status=open`
  );

  if (!data || !data.markets) {
    console.log("[KALSHI] Markets endpoint returned empty");
    return [];
  }

  return data.markets.map((m) => ({
    ticker: m.ticker,
    title: m.title || m.subtitle || "",
    question: m.title || "",
    yesPrice: m.yes_ask || m.last_price || null,
    noPrice: m.no_ask || null,
    volume: m.volume || 0,
    volume24h: m.volume_24h || 0,
    openInterest: m.open_interest || 0,
    category: m.category || "",
    seriesTicker: m.series_ticker || "",
    expirationDate: m.expiration_time || m.close_time || "",
    status: m.status || "open",
  }));
}

// ─── Cross-Reference: Find Kalshi Matches for Poly Markets ───────────
function findKalshiMatch(polyTitle, kalshiMarkets) {
  if (!polyTitle || !kalshiMarkets.length) return null;

  const normalize = (s) =>
    s.toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .replace(/\s+/g, " ")
      .trim();

  const polyNorm = normalize(polyTitle);

  // Extract key terms from the Polymarket title
  const keyTerms = polyNorm
    .split(" ")
    .filter((w) => w.length > 3 && !["will", "the", "be", "have", "does", "before", "after", "above", "below"].includes(w));

  let bestMatch = null;
  let bestScore = 0;

  for (const km of kalshiMarkets) {
    const kalshiNorm = normalize(km.title || km.question || "");

    // Count matching key terms
    let score = 0;
    for (const term of keyTerms) {
      if (kalshiNorm.includes(term)) score++;
    }

    // Boost for matching important words
    const importantWords = ["fed", "rate", "cut", "bitcoin", "btc", "ethereum", "eth", "trump", "election", "gdp", "inflation", "shutdown", "spacex", "starship"];
    for (const w of importantWords) {
      if (polyNorm.includes(w) && kalshiNorm.includes(w)) score += 2;
    }

    // Minimum threshold: at least 3 matching terms or 2 important words
    if (score > bestScore && score >= 3) {
      bestScore = score;
      bestMatch = km;
    }
  }

  return bestMatch;
}

// ─── Build Consensus Signals ─────────────────────────────────────────
function buildConsensusSignals(whalePositions, kalshiMarkets) {
  // Group positions by market
  const marketMap = {};

  for (const { whale, positions } of whalePositions) {
    for (const pos of positions) {
      const key = pos.title.toLowerCase().trim();
      if (!marketMap[key]) {
        marketMap[key] = {
          title: pos.title,
          slug: pos.slug,
          endDate: pos.endDate,
          whales: [],
        };
      }
      marketMap[key].whales.push({
        name: whale.name,
        winRate: whale.winRate,
        outcome: pos.outcome,
        size: pos.currentValue || pos.size * pos.currentPrice,
        avgPrice: pos.avgPrice,
        currentPrice: pos.currentPrice,
      });
    }
  }

  // Find consensus (multiple whales on the same side)
  const signals = [];

  for (const [key, market] of Object.entries(marketMap)) {
    // Group by outcome
    const outcomeGroups = {};
    for (const w of market.whales) {
      const o = w.outcome || "Yes";
      if (!outcomeGroups[o]) outcomeGroups[o] = [];
      outcomeGroups[o].push(w);
    }

    // Find the dominant outcome
    for (const [outcome, whales] of Object.entries(outcomeGroups)) {
      if (whales.length < 2) continue; // Need at least 2 whales

      const avgWinRate = whales.reduce((s, w) => s + (w.winRate || 0.5), 0) / whales.length;
      const totalSize = whales.reduce((s, w) => s + (w.size || 0), 0);
      const avgEntry = whales.reduce((s, w) => s + (w.avgPrice || 0), 0) / whales.length;
      const currentPrice = whales[0]?.currentPrice || 0.5;

      // Estimate edge based on whale count, win rate, and position sizes
      const edge = Math.min(0.25, (whales.length * 0.03) + ((avgWinRate - 0.5) * 0.4));

      // Confidence level
      let confidence;
      if (whales.length >= 5 && avgWinRate >= 0.7) confidence = "VERY HIGH";
      else if (whales.length >= 3 && avgWinRate >= 0.68) confidence = "HIGH";
      else if (whales.length >= 2 && avgWinRate >= 0.6) confidence = "MEDIUM";
      else confidence = "LOW";

      // Find Kalshi match
      const kalshiMatch = findKalshiMatch(market.title, kalshiMarkets);

      signals.push({
        polyMarket: market.title,
        slug: market.slug,
        outcome,
        polyPrice: currentPrice,
        kalshiMatch: kalshiMatch?.ticker || null,
        kalshiTitle: kalshiMatch?.title || null,
        kalshiPrice: kalshiMatch?.yesPrice ? kalshiMatch.yesPrice / 100 : null,
        hasKalshi: !!kalshiMatch,
        priceDiff: kalshiMatch?.yesPrice
          ? currentPrice - kalshiMatch.yesPrice / 100
          : null,
        whalesAligned: whales.length,
        whaleNames: whales.map((w) => w.name),
        avgWinRate,
        totalWhaleSize: totalSize,
        avgEntry,
        edge,
        confidence: kalshiMatch ? confidence : "SKIP",
        endDate: market.endDate || "TBD",
        category: guessCategoryFromTitle(market.title),
        volume24h: kalshiMatch?.volume24h || 0,
        liquidity: kalshiMatch?.openInterest || 0,
      });
    }
  }

  // Sort: Kalshi-available first, then by confidence
  const confOrder = { "VERY HIGH": 5, HIGH: 4, MEDIUM: 3, LOW: 2, SKIP: 0 };
  signals.sort((a, b) => {
    if (a.hasKalshi !== b.hasKalshi) return a.hasKalshi ? -1 : 1;
    return (confOrder[b.confidence] || 0) - (confOrder[a.confidence] || 0);
  });

  return signals;
}

function guessCategoryFromTitle(title) {
  const t = title.toLowerCase();
  if (/fed|rate|gdp|inflation|unemployment|recession|cpi/.test(t)) return "Economics";
  if (/bitcoin|btc|ethereum|eth|crypto|token|defi/.test(t)) return "Crypto";
  if (/trump|biden|election|congress|senate|governor|president|democrat|republican/.test(t)) return "Politics";
  if (/spacex|apple|google|ai |openai|meta |microsoft/.test(t)) return "Tech";
  if (/nfl|nba|mlb|nhl|game|match|score|championship/.test(t)) return "Sports";
  return "Other";
}

// ─── Master Data Refresh ─────────────────────────────────────────────
async function refreshData() {
  const now = Date.now();
  if (cache.lastUpdated && now - cache.lastUpdated < CACHE_DURATION) {
    console.log("[CACHE] Using cached data");
    return;
  }

  console.log("═══ REFRESHING ALL DATA ═══");
  const startTime = Date.now();

  // Step 1: Get leaderboard
  const leaderboard = await getLeaderboard();
  cache.leaderboard = leaderboard;

  // Step 2: Get positions for top whales
  const whalePositions = [];
  if (leaderboard) {
    // Fetch positions for top 10 whales (rate-limit friendly)
    const topWhales = leaderboard.slice(0, 10);
    for (const whale of topWhales) {
      if (!whale.address) continue;
      console.log(`[PM] Fetching positions for ${whale.name}...`);
      const positions = await getUserPositions(whale.address);
      if (positions.length > 0) {
        whalePositions.push({ whale, positions });
      }
      // Be nice to the API
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  cache.whalePositions = whalePositions;

  // Step 3: Get Kalshi markets
  const kalshiMarkets = await getKalshiMarkets();
  cache.kalshiMarkets = kalshiMarkets;

  // Step 4: Build consensus signals
  if (whalePositions.length > 0) {
    cache.consensus = buildConsensusSignals(whalePositions, kalshiMarkets);
  }

  cache.lastUpdated = Date.now();
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`═══ REFRESH COMPLETE (${elapsed}s) — ${cache.consensus?.length || 0} signals ═══`);
}

// ─── API Routes ──────────────────────────────────────────────────────

// Health check
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    lastUpdated: cache.lastUpdated ? new Date(cache.lastUpdated).toISOString() : null,
    signalCount: cache.consensus?.length || 0,
    whaleCount: cache.leaderboard?.length || 0,
  });
});

// Get all data (main endpoint for dashboard)
app.get("/api/data", async (req, res) => {
  await refreshData();
  res.json({
    leaderboard: cache.leaderboard || [],
    signals: cache.consensus || [],
    kalshiMarkets: (cache.kalshiMarkets || []).slice(0, 30),
    lastUpdated: cache.lastUpdated,
    isLive: !!(cache.leaderboard && cache.leaderboard.length > 0),
  });
});

// Get leaderboard only
app.get("/api/leaderboard", async (req, res) => {
  await refreshData();
  res.json(cache.leaderboard || []);
});

// Get consensus signals only
app.get("/api/signals", async (req, res) => {
  await refreshData();
  const minWhales = parseInt(req.query.minWhales) || 2;
  const kalshiOnly = req.query.kalshiOnly === "true";
  let signals = cache.consensus || [];
  signals = signals.filter((s) => s.whalesAligned >= minWhales);
  if (kalshiOnly) signals = signals.filter((s) => s.hasKalshi);
  res.json(signals);
});

// Force refresh
app.post("/api/refresh", async (req, res) => {
  cache.lastUpdated = 0; // Invalidate cache
  await refreshData();
  res.json({ success: true, signalCount: cache.consensus?.length || 0 });
});

// ─── Start Server ────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════════╗
║  🐋 WHALE CONSENSUS SERVER                              ║
║  Running on http://localhost:${PORT}                       ║
║                                                          ║
║  Endpoints:                                              ║
║    GET  /api/health      — Server status                 ║
║    GET  /api/data        — All data (for dashboard)      ║
║    GET  /api/leaderboard — Whale rankings                ║
║    GET  /api/signals     — Consensus signals             ║
║    POST /api/refresh     — Force data refresh            ║
║                                                          ║
║  Data refreshes every 5 minutes automatically.           ║
╚══════════════════════════════════════════════════════════╝
  `);

  // Initial data load
  refreshData().catch(console.error);
});
