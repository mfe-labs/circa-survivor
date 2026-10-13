// Fit power ratings from market spreads: nflverse closing lines for every 2026 game that has one,
// plus the current DraftKings spreads in data/odds.json for games nflverse hasn't lined yet.
import { readFileSync, writeFileSync } from "node:fs";
import { fitRatings, priorFromFutures } from "../src/ratings.js";
import { loadGames } from "./nflverse.mjs";
import { fetchRetry } from "./http.mjs";
import { ABBR, restEdge } from "../src/schedule.js";

const OUT = new URL("../data/ratings.json", import.meta.url);
const ODDS = new URL("../data/odds.json", import.meta.url);

// Recent lines count more: a game's weight halves every HALF_LIFE weeks back from the current week. Backtested on 2025
// and 2026 closing spreads (predicting each week from the weeks before it): a 3-week half-life cut the miss from
// 4.2 to 3.7 points over 2025 and 2.95 to 2.85 over 2026 Weeks 3–6; equal weights were worst in every test.
const HALF_LIFE = 3;
const rows = await loadGames();
const curWeek = Math.max(0, ...rows.filter((r) => r.season === "2026" && r.result != null).map((r) => r.week)) + 1;
const games = [], last = [], seen = new Set();
// a team whose previous game was two or more weeks earlier is off a bye
const prevWeek = {}, restOf = {};
for (const r of [...rows].sort((a, b) => a.season - b.season || a.week - b.week)) for (const t of [r.home, r.away]) { const k = r.season + "|" + t; restOf[r.season + "|" + r.week + "|" + t] = prevWeek[k] == null ? 0 : r.week - prevWeek[k] > 1 ? 1 : 0; prevWeek[k] = r.week; }
for (const r of rows) {
  if (r.spread == null) continue;
  const rest = restOf[r.season + "|" + r.week + "|" + r.home] - restOf[r.season + "|" + r.week + "|" + r.away];
  const g = { home: r.home, away: r.away, margin: r.spread, neutral: r.neutral, rest, weight: Math.pow(0.5, Math.max(0, curWeek - r.week) / HALF_LIFE) };
  if (r.season === "2025") last.push(g);
  if (r.season === "2026") { games.push(g); seen.add(`${r.away}@${r.home}`); }
}
// Prior: the Super Bowl futures market (the market's view of each team THIS season), refreshed every 3 days
// (1 credit). Falls back to last season's market ratings regressed 40% toward average if futures are unavailable.
let existing = {}; try { existing = JSON.parse(readFileSync(OUT, "utf8")); } catch {}
let futures = existing.futures || null;
const KEY = process.env.ODDS_API_KEY;
if (KEY && (!futures || Date.now() - new Date(futures.fetchedAt).getTime() > 3 * 86400e3)) {
  try {
    const r = await fetchRetry(`https://api.the-odds-api.com/v4/sports/americanfootball_nfl_super_bowl_winner/odds?apiKey=${KEY}&regions=us&markets=outrights&oddsFormat=american`, {}, { label: "Super Bowl futures" });
    if (!r.ok) throw new Error(`Odds API ${r.status}`);
    const [ev] = await r.json();
    const imp = {};
    for (const bk of ev?.bookmakers || []) for (const m of bk.markets) {
      if (m.key !== "outrights") continue;
      const q = {}; let tot = 0;
      for (const o of m.outcomes) { const t = ABBR[o.name]; if (!t) continue; const p = o.price; q[t] = p > 0 ? 100 / (p + 100) : -p / (-p + 100); tot += q[t]; }
      for (const [t, v] of Object.entries(q)) (imp[t] ||= []).push(v / tot);
    }
    const probs = Object.fromEntries(Object.entries(imp).map(([t, v]) => [t, v.reduce((a, b) => a + b, 0) / v.length]));
    if (Object.keys(probs).length >= 24) { futures = { fetchedAt: new Date().toISOString(), books: (ev.bookmakers || []).map((b) => b.key), probs }; console.log(`futures: ${Object.keys(probs).length} teams from ${futures.books.join(", ")} (credits this pull ${r.headers.get("x-requests-last")})`); }
  } catch (e) { console.warn("futures fetch skipped:", e.message); }
}
let prior = futures ? priorFromFutures(futures.probs) : null, priorSource = "Super Bowl futures market";
if (!prior) { const prev = fitRatings(last, { lambda: 0.5 }).ratings; prior = Object.fromEntries(Object.entries(prev).map(([t, r]) => [t, 0.6 * r])); priorSource = "last season's market ratings"; }
const fromNflverse = games.length;
try {
  const odds = JSON.parse(readFileSync(ODDS, "utf8"));
  for (const [legId, leg] of Object.entries(odds.legs || {})) for (const [key, g] of Object.entries(leg.games || {})) {
    if (seen.has(key)) continue;
    const [away, home] = key.split("@");
    const sps = Object.values(g.books || {}).map((b) => b.spread?.[home]).filter((v) => v != null).sort((a, b) => a - b);
    if (!sps.length) continue;
    const med = sps.length % 2 ? sps[(sps.length - 1) / 2] : (sps[sps.length / 2 - 1] + sps[sps.length / 2]) / 2;
    games.push({ home, away, margin: -med, neutral: false, rest: restEdge(legId, home), weight: 1 });
  }
} catch {}
const { ratings, games: used } = fitRatings(games, { lambda: 2, prior });
const prevR = existing.ratings ? { updatedAt: existing.updatedAt, ratings: existing.ratings } : null;
writeFileSync(OUT, JSON.stringify({ updatedAt: new Date().toISOString(), prev: prevR, source: `market spreads: ${used} games this season (nflverse closing lines + current book, recent games weighted more: ${HALF_LIFE}-week half-life), anchored to the ${priorSource}`, games: used, priorSource, prior, futures, ratings }, null, 1) + "\n");
const top = Object.entries(ratings).sort((a, b) => b[1] - a[1]);
console.log(`ratings from ${used} games (${fromNflverse} nflverse), prior = ${priorSource}`, "top:", top.slice(0, 5).map(([t, r]) => `${t} ${r}`).join(", "), "bottom:", top.slice(-3).map(([t, r]) => `${t} ${r}`).join(", "));
console.log("prior top:", Object.entries(prior).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([t, r]) => `${t} ${r}`).join(", "), "| SF", ratings.SF, "(prior", prior.SF + ")", "BAL", ratings.BAL, "(prior", prior.BAL + ")", "TB", ratings.TB);
