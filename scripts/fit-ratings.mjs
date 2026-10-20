// Fit power ratings from market spreads: nflverse closing lines for every 2026 game that has one,
// plus the current DraftKings spreads in data/odds.json for games nflverse hasn't lined yet.
import { readFileSync, writeFileSync } from "node:fs";
import { fitRatings, priorFromFutures, blendRatings } from "../src/ratings.js";
import { loadGames } from "./nflverse.mjs";
import { fetchRetry, fetchOrNull } from "./http.mjs";
import { ABBR, ALL_TEAMS, norm, restEdge } from "../src/schedule.js";

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
const { ratings: market, games: used } = fitRatings(games, { lambda: 2, prior });

// Outside views, blended with the market fit (weights in src/ratings.js). Every pull stores each source, so this
// file's git history is the forward record the weights get refit from. A source that cannot be fetched keeps its
// last copy for up to STALE, then drops out of the blend until it is back.
const STALE = 4 * 86400e3, now = new Date().toISOString();
async function fpi() {
  const r = await fetchOrNull("https://site.web.api.espn.com/apis/fitt/v3/sports/football/nfl/powerindex?region=us&lang=en&season=2026", {}, { label: "ESPN FPI" });
  if (!r?.ok) throw new Error(`ESPN FPI ${r?.status ?? "unreachable"}`);
  const j = await r.json(), out = {};
  for (const t of j.teams || []) { const k = norm(t.team?.abbreviation), v = t.categories?.find((c) => c.name === "fpi")?.values?.[0]; if (k && Number.isFinite(v)) out[k] = v; }
  return { asOf: j.lastUpdated || null, ratings: out };
}
async function nfelo() {
  const r = await fetchOrNull("https://raw.githubusercontent.com/greerreNFL/nfelo/main/output_data/elo_snapshot.csv", {}, { label: "nfelo" });
  if (!r?.ok) throw new Error(`nfelo ${r?.status ?? "unreachable"}`);
  const lines = (await r.text()).trim().split("\n"), H = lines[0].split(",");
  const is = H.indexOf("season"), iw = H.indexOf("week"), it = H.indexOf("team"), ip = H.indexOf("pts_vs_avg");
  if (it < 0 || ip < 0) throw new Error("nfelo: columns changed");
  const out = {}, wk = {}; let latest = 0;
  for (const l of lines.slice(1)) {   // one row per team per rated week; a team on its bye keeps its last row
    const c = l.split(","), k = norm(c[it]), w = +c[iw], v = +c[ip];
    if (!k || (is >= 0 && c[is] !== "2026") || !Number.isFinite(v)) continue;
    if (wk[k] == null || w > wk[k]) { wk[k] = w; out[k] = v; }
    latest = Math.max(latest, w);
  }
  return { asOf: `after Week ${latest}`, ratings: out };
}
const sources = {};
for (const [name, get] of [["fpi", fpi], ["nfelo", nfelo]]) {
  try {
    const s = await get();
    const missing = ALL_TEAMS.filter((t) => !Number.isFinite(s.ratings[t]));
    if (missing.length) throw new Error(`${name}: no rating for ${missing.join(", ")}`);
    sources[name] = { ...s, fetchedAt: now };
  } catch (e) {
    const old = existing.sources?.[name];
    if (old?.fetchedAt && Date.now() - new Date(old.fetchedAt).getTime() < STALE) { sources[name] = old; console.warn(`${name}: ${e.message}; keeping the copy from ${old.fetchedAt}`); }
    else console.warn(`${name}: ${e.message}; left out of the blend`);
  }
}
const blend = blendRatings({ market, ...Object.fromEntries(Object.entries(sources).map(([k, s]) => [k, s.ratings])) });
const ratings = blend.ratings, weights = blend.used;
const NAMES = { market: "market spreads", fpi: "ESPN FPI", nfelo: "nfelo" };
const mix = Object.entries(weights).map(([k, w]) => `${NAMES[k]} ${Math.round(100 * w)}%`).join(", ");
const prevR = existing.ratings ? { updatedAt: existing.updatedAt, ratings: existing.ratings } : null;
writeFileSync(OUT, JSON.stringify({ updatedAt: now, prev: prevR, source: `blend of ${mix}; the market fit uses ${used} games this season (nflverse closing lines + current book, recent games weighted more: ${HALF_LIFE}-week half-life), anchored to the ${priorSource}`, games: used, priorSource, prior, futures, weights, market, sources, ratings }, null, 1) + "\n");
const show = (r) => { const top = Object.entries(r).sort((a, b) => b[1] - a[1]); return `top ${top.slice(0, 4).map(([t, v]) => `${t} ${v}`).join(", ")} | bottom ${top.slice(-3).map(([t, v]) => `${t} ${v}`).join(", ")}`; };
console.log(`market fit from ${used} games (${fromNflverse} nflverse), prior = ${priorSource}:`, show(market));
for (const [k, s] of Object.entries(sources)) console.log(`${NAMES[k]} (${s.asOf}):`, show(Object.fromEntries(Object.entries(s.ratings).map(([t, v]) => [t, Math.round(v * 10) / 10]))));
console.log(`blend (${mix}):`, show(ratings));
