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
//   npm install express cors
//   node index.js
// ═══════════════════════════════════════════════════════════════════════

const express = require("express");
const cors = require("cors");
const { selectWhalePool } = require("./whale-selection");
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

// ─── Sports team dictionary (used by the matcher) ────────────────────
// Lowercase team names that appear in market titles across MLB, NBA,
// NFL, NHL, EPL, and major international soccer leagues.
const SPORTS_TEAMS = [
  // MLB
  "yankees", "orioles", "rays", "red sox", "blue jays",
  "astros", "mariners", "rangers", "athletics", "angels",
  "twins", "tigers", "white sox", "royals", "guardians",
  "braves", "mets", "phillies", "marlins", "nationals",
  "cubs", "brewers", "reds", "pirates", "cardinals",
  "dodgers", "padres", "giants", "diamondbacks", "rockies",
  // NBA
  "lakers", "celtics", "warriors", "bucks", "bulls", "heat",
  "nets", "knicks", "76ers", "sixers", "raptors", "pacers",
  "cavaliers", "cavs", "pistons", "hornets", "magic", "hawks",
  "wizards", "mavericks", "mavs", "rockets", "spurs", "pelicans",
  "grizzlies", "nuggets", "jazz", "thunder", "timberwolves",
  "trail blazers", "blazers", "suns", "kings", "clippers",
  // NFL
  "chiefs", "bills", "patriots", "dolphins", "jets", "ravens",
  "bengals", "browns", "steelers", "texans", "colts", "jaguars",
  "titans", "broncos", "chargers", "raiders", "cowboys", "eagles",
  "commanders", "bears", "lions", "packers", "vikings", "falcons",
  "panthers", "saints", "buccaneers", "rams", "49ers", "seahawks",
  // NHL
  "bruins", "sabres", "red wings", "canadiens", "senators",
  "lightning", "maple leafs", "hurricanes", "blue jackets",
  "devils", "islanders", "flyers", "penguins", "capitals",
  "blackhawks", "avalanche", "stars", "wild", "predators",
  "blues", "ducks", "flames", "oilers", "sharks", "kraken",
  "canucks", "golden knights",
  // EPL & major European soccer
  "arsenal", "chelsea", "liverpool", "tottenham", "newcastle",
  "aston villa", "brighton", "west ham", "crystal palace",
  "brentford", "fulham", "wolves", "everton", "bournemouth",
  "nottingham forest", "leicester", "southampton", "burnley",
  "man city", "manchester city", "man united", "manchester united",
  "napoli", "juventus", "milan", "inter", "roma", "lazio",
  "real madrid", "barcelona", "atletico", "psg", "bayern",
  "dortmund", "leipzig", "ajax", "porto", "benfica",
  "millwall", "hull city", "leeds", "sunderland",
  // MLS / international
  "lafc", "galaxy", "atlanta united", "seattle sounders",
  "inter miami", "messi"
];

// Generic sport keywords that signal "this is a sports market"
const SPORTS_KEYWORDS = [
  "mlb", "nba", "nfl", "nhl", "mls", "epl", "ncaa", "ufc",
  "baseball", "basketball", "soccer", "hockey", "moneyline",
  "playoffs", "championship", "world cup", "champions league"
];

// Non-sports topical keywords that get a small boost when matched
const TOPIC_KEYWORDS = [
  "fed", "rate", "cut", "bitcoin", "btc", "ethereum", "eth",
  "trump", "election", "gdp", "inflation", "shutdown", "spacex",
  "starship", "biden", "fomc", "recession", "cpi", "powell",
  "tariff", "supreme court", "putin", "ukraine", "israel"
];

// Stop words to ignore when comparing market titles
const STOP_WORDS = new Set([
  "will", "the", "be", "have", "does", "before", "after",
  "above", "below", "what", "when", "where", "vs", "and",
  "with", "this", "that", "from", "into", "than", "then",
  "are", "for", "between", "during", "ends", "end"
]);

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

  const data = await safeFetch(
    `${POLYMARKET_DATA_API}/v1/leaderboard?timePeriod=MONTH&limit=25&orderBy=PNL`
  );

  if (data && Array.isArray(data) && data.length > 0) {
    return data.map((w, i) => ({
      rank: parseInt(w.rank) || (i + 1),
      name: w.userName || `Wallet ${(w.proxyWallet || "").slice(0, 8)}`,
      address: w.proxyWallet || "",
      pnl: w.pnl || 0,
      volume: w.vol || 0,
      winRate: null,
      marketsTraded: 0,
      xUsername: w.xUsername || null,
      profileImage: w.profileImage || null,
      verifiedBadge: !!w.verifiedBadge,
    }));
  }

  console.log("[PM] Leaderboard returned empty");
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

  // Pull a larger pool (1000) so sports markets deeper in the listing
  // don't get missed by the matcher.
  const data = await safeFetch(
    `${KALSHI_API}/markets?limit=1000&status=open`
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
// Sports-aware matcher:
//   1. Detects whether the Polymarket title is a sports market by looking
//      for team names or sport keywords.
//   2. For sports, heavily weights team-name matches (e.g. "yankees"
//      appearing in both titles is gold — it's a near-unique identifier).
//   3. For non-sports, falls back to topical keyword + word overlap.
function findKalshiMatch(polyTitle, kalshiMarkets) {
  if (!polyTitle || !kalshiMarkets.length) return null;

  const normalize = (s) =>
    s.toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  const polyNorm = normalize(polyTitle);

  // Which teams from our dictionary appear in this Polymarket title?
  const polyTeams = SPORTS_TEAMS.filter((t) => polyNorm.includes(t));
  const hasSportsKeyword = SPORTS_KEYWORDS.some((k) => polyNorm.includes(k));
  const isSports = polyTeams.length > 0 || hasSportsKeyword;

  // Generic content words (length > 3, not a stop word)
  const keyTerms = polyNorm
    .split(" ")
    .filter((w) => w.length > 3 && !STOP_WORDS.has(w));

  let bestMatch = null;
  let bestScore = 0;

  for (const km of kalshiMarkets) {
    const kalshiNorm = normalize(km.title || km.question || "");
    if (!kalshiNorm) continue;

    let score = 0;

    // Generic word overlap
    for (const term of keyTerms) {
      if (kalshiNorm.includes(term)) score++;
    }

    // Topical keyword boost (politics, crypto, economics, etc.)
    for (const w of TOPIC_KEYWORDS) {
      if (polyNorm.includes(w) && kalshiNorm.includes(w)) score += 2;
    }

    // SPORTS BOOST — team-name matching is highly specific
    if (isSports && polyTeams.length > 0) {
      const matchingTeams = polyTeams.filter((t) => kalshiNorm.includes(t));
      if (matchingTeams.length >= 2) {
        // Both teams from a head-to-head match present = same game
        score += 8;
      } else if (matchingTeams.length === 1 && polyTeams.length === 1) {
        // Single-team poly market and that team is in Kalshi
        score += 5;
      } else if (matchingTeams.length === 1) {
        // Only one of two teams matches — weaker but possible
        score += 2;
      }
    }

    // Threshold: sports markets need 5+ (a strong team-name match alone
    // is enough), non-sports need 3+ (existing behavior).
    const threshold = isSports ? 5 : 3;

    if (score > bestScore && score >= threshold) {
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
        pnl: whale.pnl,
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

      const totalSize = whales.reduce((s, w) => s + (w.size || 0), 0);
      const avgEntry = whales.reduce((s, w) => s + (w.avgPrice || 0), 0) / whales.length;
      const currentPrice = whales[0]?.currentPrice || 0.5;

      // Edge estimate — driven by whale count
      const edge = Math.min(0.25, whales.length * 0.04);

      // Confidence — based on how many top-PnL whales are aligned
      let confidence;
      if (whales.length >= 5) confidence = "VERY HIGH";
      else if (whales.length >= 4) confidence = "HIGH";
      else if (whales.length >= 3) confidence = "MEDIUM";
      else confidence = "LOW"; // 2 whales

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
  if (SPORTS_TEAMS.some((team) => t.includes(team))) return "Sports";
  if (/nfl|nba|mlb|nhl|game|match|score|championship|playoff|soccer/.test(t)) return "Sports";
  return "Other";
}

// ─── Master Data Refresh ─────────────────────────────────────────────
async function refreshData() {
  const now = Date.now();
  if (cache.lastUpdated && now - cache.lastUpdated < CACHE_DURATION) {
    console.log("[CACHE] Using cached data");
    return;
  }

  // Falcon-selected whale pool, cached 24h (1 credit/day)
  try {
    const pool = await selectWhalePool();
    if (pool && pool.length) cache.falconWhales = pool;
  } catch (e) {
    console.error("[whale-selection] failed, keeping existing whales:", e.message);
  }
  
  console.log("═══ REFRESHING ALL DATA ═══");
  const startTime = Date.now();

  // Step 1: Get leaderboard
  const leaderboard = await getLeaderboard();
  cache.leaderboard = leaderboard;

  // Step 2: Get positions for top whales (expanded from 10 to 15)
  const whalePositions = [];
  if (leaderboard) {
    const topWhales = leaderboard.slice(0, 15);
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

// TEMPORARY — delete once we lock the field names
app.get("/api/probe", async (req, res) => {
  try {
    const { probe } = require("./whale-selection");
    res.json(await probe());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

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
║  Running on port ${PORT}                                  ║
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
