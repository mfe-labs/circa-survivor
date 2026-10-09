import { useState, useEffect, useMemo, useRef } from "react";
import { LEGS, ALL_TEAMS, OPP, TG_TEAMS, XM_TEAMS, legLabel } from "./schedule.js";
import { HFA } from "./ratings.js";
import { REPO, readFile, writeFile, whoAmI, dispatchWorkflow } from "./github.js";
// Bundled copies of the data files (built into the site on every deploy). The page also re-reads the
// live files from the repo on load so viewers see saves made since the last deploy.
import picksBundled from "../data/picks.json";
import actualsBundled from "../data/actuals.json";
import oddsBundled from "../data/odds.json";
import ratingsBundled from "../data/ratings.json";
import mapsBundled from "../data/maps.json";
import splashBundled from "../data/splash.json";

const VERSION = "2.0";
const TOKEN_KEY = "csp-github-token";
const PATHS = { picks: "data/picks.json", actuals: "data/actuals.json", odds: "data/odds.json", ratings: "data/ratings.json", maps: "data/maps.json", splash: "data/splash.json" };
const BUNDLED = { picks: picksBundled, actuals: actualsBundled, odds: oddsBundled, ratings: ratingsBundled, maps: mapsBundled, splash: splashBundled };

// team cell colors: [background, text]
const COLORS = {
  ARI: ["#97233F", "#FFFFFF"], ATL: ["#A71930", "#FFFFFF"], BAL: ["#241773", "#9E7C0C"], BUF: ["#00338D", "#C60C30"],
  CAR: ["#0085CA", "#101820"], CHI: ["#0B162A", "#C83803"], CIN: ["#FB4F14", "#000000"], CLE: ["#311D00", "#FF3C00"],
  DAL: ["#003594", "#B0B7BC"], DEN: ["#FB4F14", "#002244"], DET: ["#0076B6", "#B0B7BC"], GB: ["#203731", "#FFB612"],
  HOU: ["#03202F", "#A71930"], IND: ["#002C5F", "#FFFFFF"], JAX: ["#006778", "#D7A22A"], KC: ["#E31837", "#FFB81C"],
  LAC: ["#0080C6", "#FFC20E"], LV: ["#000000", "#A5ACAF"], LAR: ["#003594", "#FFA300"], MIA: ["#008E97", "#FC4C02"],
  MIN: ["#4F2683", "#FFC62F"], NE: ["#002244", "#B0B7BC"], NO: ["#D3BC8D", "#101820"], NYG: ["#0B2265", "#FFFFFF"],
  NYJ: ["#125740", "#FFFFFF"], PHI: ["#004C54", "#A5ACAF"], PIT: ["#FFB612", "#101820"], SF: ["#AA0000", "#B3995D"],
  SEA: ["#002244", "#69BE28"], TB: ["#D50A0A", "#FFFFFF"], TEN: ["#0C2340", "#4B92DB"], WAS: ["#5A1414", "#FFB612"],
};

// ---------- math ----------
const normCdf = (x) => 0.5 * (1 + erf(x / Math.SQRT2));
function erf(x) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x < 0 ? -y : y;
}
const winFromMargin = (m) => normCdf(m / 13.5);
// spread from this team's perspective (negative = favorite), and win prob, projected from power ratings
function projected(legId, team, ratings) {
  const g = OPP[legId][team];
  if (!g || !ratings || ratings[team] == null || ratings[g.opp] == null) return null;
  const margin = ratings[team] - ratings[g.opp] + (g.neutral ? 0 : g.home ? HFA : -HFA);
  return { spread: Math.round(-margin * 10) / 10, win: winFromMargin(margin), proj: true };
}

// ---------- True Win %: two-sided no-vig moneyline ----------
const impliedProb = (ml) => (ml > 0 ? 100 / (ml + 100) : -ml / (-ml + 100));
const validML = (ml) => Number.isFinite(ml) && Math.abs(ml) >= 100;
function devig(mlA, mlB) {
  if (!validML(mlA) || !validML(mlB)) return null;
  const qA = impliedProb(mlA), qB = impliedProb(mlB);
  return { a: qA / (qA + qB), b: qB / (qA + qB) };
}
// ---------- consensus True Win % across sportsbooks ----------
// Each book is de-vigged on its own two prices; the consensus is the MEDIAN of the books' home-win
// probabilities, and the away side is its complement (medians of the two sides need not sum to 1).
const STALE_MS = 48 * 3600 * 1000;   // a book whose quote is this much older than the freshest book's is left out
const BOOK_NAME = { pinnacle: "Pinnacle", betmgm: "BetMGM", draftkings: "DraftKings", fanduel: "FanDuel", williamhill_us: "Caesars", nflverse: "closing line (nflverse)" };
const median = (xs) => { const s = [...xs].sort((a, b) => a - b), n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null; };
const roundHalf = (v) => Math.round(v * 2) / 2;
// status by number of contributing books
const STATUS = { 0: "none", 1: "single", 2: "degraded" };
const statusFor = (n, closing) => (closing ? "closing" : STATUS[n] || "consensus");
const STATUS_TEXT = { consensus: "consensus of 3+ books", degraded: "2 books only (degraded)", single: "single book (provisional)", closing: "closing line from nflverse (game already played)", lookahead: "look-ahead spread from nflverse (no moneyline posted yet)", final: "Thursday game is final", none: "no valid two-sided moneyline" };

// One game's books → per-book de-vigged probabilities with exclusion reasons, plus the consensus.
function consensusForGame(key, g) {
  const [away, home] = key.split("@");
  const kickoff = g.kickoff ? new Date(g.kickoff).getTime() : null;
  const books = g.books || (g.ml ? { [/nflverse/.test(g.source || "") ? "nflverse" : "draftkings"]: { asof: g.asof, ml: g.ml, spread: g.spread || {} } } : {});
  const rows = Object.entries(books).map(([bk, b]) => {
    const row = { book: bk, name: b.lookahead ? "look-ahead line (nflverse)" : BOOK_NAME[bk] || bk, ml: b.ml?.[home] ?? null, oppMl: b.ml?.[away] ?? null, asof: b.asof || null, spread: b.spread?.[home] ?? null, pHome: null, excluded: null };
    const d = b.lookahead ? null : devig(row.ml, row.oppMl);
    if (b.lookahead) row.excluded = "look-ahead spread only, no moneyline yet";
    else if (!d) row.excluded = "no valid two-sided moneyline";
    else if (bk !== "nflverse" && kickoff && row.asof && new Date(row.asof).getTime() >= kickoff) row.excluded = "quoted after kickoff (in-game price)";
    else row.pHome = d.a;
    return row;
  });
  const fresh = rows.filter((r) => !r.excluded && r.asof).map((r) => new Date(r.asof).getTime());
  const newest = fresh.length ? Math.max(...fresh) : null;
  for (const r of rows) if (!r.excluded && r.asof && newest && newest - new Date(r.asof).getTime() > STALE_MS) { r.excluded = `stale (${Math.round((newest - new Date(r.asof).getTime()) / 3600000)} h older than the freshest book)`; r.pHome = null; }
  const valid = rows.filter((r) => !r.excluded);
  const closing = valid.length > 0 && valid.every((r) => r.book === "nflverse");
  const pHome = valid.length ? median(valid.map((r) => r.pHome)) : null;
  // reference book for the displayed raw prices: the contributing book closest to the consensus
  const ref = valid.length ? valid.reduce((a, r) => (Math.abs(r.pHome - pHome) < Math.abs(a.pHome - pHome) ? r : a)) : null;
  const sp = valid.map((r) => r.spread).filter((v) => v != null);
  const asof = valid.length ? valid.map((r) => r.asof).filter(Boolean).sort().pop() || null : null;
  // a look-ahead spread (nflverse, days before any book posts a moneyline) is kept apart: it can give a projected
  // win chance for planning, never a True Win %
  const lookaheadHome = valid.length ? null : Object.values(books).find((b) => b.lookahead && b.spread?.[home] != null)?.spread?.[home] ?? null;
  return { key, away, home, kickoff: g.kickoff || null, rows, valid: valid.length, status: statusFor(valid.length, closing), pHome, ref, spreadHome: sp.length ? roundHalf(median(sp)) : null, asof, lookaheadHome };
}
// Turn one leg of data/odds.json ({ games: { "AWY@HOM": { kickoff, books: { <book>: { asof, ml, spread } } } } })
// into per-team lines. Only games with at least one valid two-sided moneyline get a Win %; a spread alone never does.
function linesFromOdds(legOdds) {
  const lines = {}, games = {}; let asof = null, n = 0; const counts = {};
  for (const [key, g] of Object.entries(legOdds?.games || {})) {
    const c = consensusForGame(key, g);
    games[key] = c;
    if (c.pHome == null) {
      if (c.lookaheadHome == null) continue;
      const w = winFromMargin(-c.lookaheadHome), base = { market: false, lookahead: true, status: "lookahead", n: 0, game: key, refBook: "nflverse" };
      lines[c.home] = { ...base, win: w, spread: c.lookaheadHome };
      lines[c.away] = { ...base, win: 1 - w, spread: -c.lookaheadHome };
      counts.lookahead = (counts.lookahead || 0) + 1;
      continue;
    }
    const base = { market: true, status: c.status, n: c.valid, game: key };
    lines[c.home] = { ...base, win: c.pHome, ml: c.ref.ml, oppMl: c.ref.oppMl, refBook: c.ref.name, spread: c.spreadHome };
    lines[c.away] = { ...base, win: 1 - c.pHome, ml: c.ref.oppMl, oppMl: c.ref.ml, refBook: c.ref.name, spread: c.spreadHome == null ? null : -c.spreadHome };
    n++; counts[c.status] = (counts[c.status] || 0) + 1;
    if (!asof || (c.asof && c.asof > asof)) asof = c.asof;
  }
  return { lines, detail: games, asof, games: n, counts };
}
// EV_i = w_i / (p_i + sum over other games of p_j w_j), scaled so the field's pick-weighted average = 1.00
// (the scale Atlas / SurvivorGrid use). Games without a Win % are left out of the denominator, which flatters
// everyone else, so the caller gets the coverage and blanks EV when it is too low to trust.
const EV_MIN_COVERAGE = 0.75;
function computeEV(legId, rows) {
  const teams = Object.keys(OPP[legId]);
  const gamesTotal = teams.length / 2;
  const covered = teams.filter((t) => rows[t].win != null).length / 2;
  const coverage = gamesTotal ? covered / gamesTotal : 0;
  for (const t of teams) { rows[t].raw = null; rows[t].ev = null; }
  if (coverage < EV_MIN_COVERAGE) return { coverage, covered, gamesTotal, blanked: true };
  const S = teams.reduce((a, t) => a + (rows[t].pick || 0) * (rows[t].win || 0), 0);
  let wsum = 0, psum = 0;
  for (const t of teams) {
    const r = rows[t]; if (r.win == null) continue;
    const opp = OPP[legId][t].opp;
    const own = (r.pick || 0) * r.win, oppc = (rows[opp].pick || 0) * (rows[opp].win || 0);
    const Si = (r.pick || 0) + (S - own - oppc);
    r.raw = Si > 0 ? r.win / Si : null;
    if (r.raw != null && r.pick && r.win > 0 && r.win < 1) { wsum += r.pick * r.raw; psum += r.pick; }   // decided games (Thursday finals) stay in the denominator but not in the average
  }
  const mean = psum > 0 ? wsum / psum : 1;
  for (const t of teams) { const r = rows[t]; r.ev = r.raw == null ? null : r.raw / mean; }
  return { coverage, covered, gamesTotal, blanked: false };
}
// Everything the model needs, assembled from the four data files. `prev` is the same view built from the quotes
// and ratings of the refresh before the latest one (games without a stored previous quote reuse the current one).
function buildData({ picks, actuals, odds, ratings, splash = null }, withPrev = true) {
  const legs = {};
  for (const l of LEGS) {
    const r = linesFromOdds(odds?.legs?.[l.id]);
    if (r.games || r.counts.lookahead) legs[l.id] = { ...r, gamesTotal: Object.keys(OPP[l.id]).length / 2, books: odds.books || [] };
  }
  const data = {
    entries: Array.isArray(picks?.entries) ? picks.entries : [],
    legs, ratings: ratings?.ratings || null, ratingsAt: ratings?.updatedAt || null, ratingsSrc: ratings?.source || "", oddsAt: odds?.updatedAt || null,
    actuals: actuals?.legs || {}, contest: actuals?.contest || { start: 0, pool: 0, share: 0 }, prev: null, splash: splash || null,
  };
  if (withPrev && odds?.legs) {
    let any = false; const pl = {};
    for (const [id, leg] of Object.entries(odds.legs)) {
      const games = {};
      for (const [k, g] of Object.entries(leg.games || {})) { if (g.prev?.books) { any = true; games[k] = { ...g, books: g.prev.books }; } else games[k] = g; }
      pl[id] = { ...leg, games };
    }
    if (any) data.prev = buildData({ picks, actuals, odds: { ...odds, legs: pl, updatedAt: odds.prevUpdatedAt || null }, ratings: ratings?.prev?.ratings ? { ...ratings, ...ratings.prev, prev: null } : ratings, splash }, false);
  }
  return data;
}
// lineFor: any line for display / future-value projection. Live market line if captured, else a projection
// from power ratings (proj: true). NEVER use this for the selected leg's True Win % — use marketLine().
function lineFor(legId, team, data) {
  const live = data?.legs?.[legId]?.lines?.[team];
  if (live) return { ...live, proj: false };
  return projected(legId, team, data?.ratings);
}
function marketLine(legId, team, data) {
  const ln = data?.legs?.[legId]?.lines?.[team];
  return ln && ln.market && ln.win != null ? { ...ln, proj: false } : null;
}
// The week to open on. A week stays current while its games are still being played, so Saturday's lock
// (which is when Circa posts picks, and therefore when a week first gets an actuals entry) does not jump
// you forward before a single game has kicked off. `pending` empties as ESPN reports finals, so the switch
// happens after the last game of the week. If a result never lands, the next week's start unsticks it.
export function openLeg(actualLegs, now = Date.now()) {
  for (let i = 0; i < LEGS.length; i++) {
    const l = LEGS[i], a = actualLegs?.[l.id];
    if (!a) return l.id;                                  // not locked yet: this is the week being planned
    if (!a.pending?.length) continue;                     // week is final, move on
    const next = LEGS[i + 1];
    if (!next || new Date(next.start + "T00:00:00-04:00").getTime() > now) return l.id;   // games still running
  }
  return LEGS[LEGS.length - 1].id;
}
function defaultLeg() {
  const now = Date.now();
  for (let i = 0; i < LEGS.length; i++) {
    const nxt = LEGS[i + 1];
    if (!nxt || new Date(nxt.start + "T12:00:00").getTime() > now) return LEGS[i].id;
  }
  return "W18";
}

// ---------- Circa field: actuals timeline ----------
// derived per-leg field math, in leg order
function fieldTimeline(data) {
  const { contest, actuals } = data;
  let live = contest.start;
  const out = [];
  for (const l of LEGS) {
    const a = actuals[l.id]; if (!a) break;
    const lost = Object.entries(a.picks).filter(([t]) => a.lost.includes(t)).reduce((s, [, n]) => s + n, 0);
    const pend = Object.entries(a.picks).filter(([t]) => a.pending.includes(t)).reduce((s, [, n]) => s + n, 0);
    const before = live; live = before - lost;
    out.push({ leg: l, before, lost, pending: pend, after: live, value: contest.pool / live });
  }
  return out;
}

// ---------- Circa field model ----------
// P(team) ∝ win^a · exp(-b · futureValue) · availability, over teams with a game that leg.
// a = how hard the field chases the biggest favorite, b = how much it saves high-future-value teams.
// Future value: expected number of strong-favorite spots the team has left. Each later week counts by how much
// it looks like a strong spot: ~75% projected win counts nearly fully, 65% counts half, 55% a little, 45% nothing.
// Reads as "about N good weeks left" and separates a team with two usable weeks from one with none.
const FV_MID = 0.65, FV_WIDTH = 0.05;
const spotWeight = (win) => 1 / (1 + Math.exp(-(win - FV_MID) / FV_WIDTH));
// Both of these are fixed for a given data snapshot but get asked for thousands of times while fitting,
// so they are memoised per snapshot.
const memo = new WeakMap();
const cached = (data, bucket, key, make) => {
  if (!data) return make();
  let m = memo.get(data); if (!m) { m = {}; memo.set(data, m); }
  const b = (m[bucket] ||= new Map());
  if (!b.has(key)) b.set(key, make());
  return b.get(key);
};
// Future value as the field saw it. Once a week locks, the results job freezes every team's future value in
// data/actuals.json (legs[id].fv), computed from the ratings and lines of that Saturday. The popularity fit and
// the past-week board use that, so a team's later rise or fall in the ratings cannot rewrite what the field was
// looking at when it picked. Open weeks use the live projection.
function fvAt(legId, team, data) {
  const v = data?.actuals?.[legId]?.fv?.[team];
  return v != null ? v : fvFor(legId, team, data);
}
function fvFor(legId, team, data) {
  return cached(data, "fv", legId + "|" + team, () => {
    const idx = LEGS.findIndex((l) => l.id === legId);
    let fv = 0;
    for (const l of LEGS.slice(idx + 1)) { const ln = lineFor(l.id, team, data); if (ln && ln.win != null) fv += spotWeight(ln.win); }
    return data?.ratings ? fv : 0;
  });
}

const HOLIDAY_LEGS = [{ id: "TG", teams: TG_TEAMS }, { id: "XM", teams: XM_TEAMS }];
const FIELD_SURVIVE = 0.8;                 // typical week-to-week survival of the field, for discounting far-off holidays
// How much the field should be holding a team back for a holiday week it has not reached. Two parts:
// how scarce that week's pool is (1 ÷ the teams still broadly available to the field) and how close the
// week is, because nobody is saving teams for Thanksgiving in September.
function holidayPressure(legId, team, data, av) {
  return cached(data, "hp", legId + "|" + team, () => {
    const idx = LEGS.findIndex((l) => l.id === legId);
    let p = 0;
    for (const h of HOLIDAY_LEGS) {
      const hi = LEGS.findIndex((l) => l.id === h.id);
      if (hi <= idx || !h.teams.has(team)) continue;
      const n = [...h.teams].reduce((sum, t) => sum + (av[t] ?? 1), 0);
      if (n > 0) p += Math.pow(FIELD_SURVIVE, hi - idx) / n;
    }
    return p;
  });
}

// ---------- DILI: "do I love it?" — this week's EV net of what the team is worth to keep ----------
// The cost of spending a team is what it does to this entry's best map of the rest of the season: the best
// way to fill every remaining leg with distinct teams the entry still holds (an assignment problem), scored
// by the product of win chances along it. Burn the team, re-solve, and the drop in that product is the forfeit.
// Thanksgiving and Christmas need no separate term: the map has to put an eligible team on each, so burning a
// holiday team is charged exactly what it costs the map, and an entry with no eligible team left reads 0.
// Nobody knows December's lines in September, so the map is solved many times over projections jiggled by
// how wrong they typically are that far out (about 3 points of spread now, 6 by December, per seven seasons
// of nflverse closing lines) and the forfeit is the average. That prices flexibility: two decent Christmas
// options are worth more than one great one that may not be great by then, and a team that is the best
// choice in a distant week only half the time is charged about half. Same noise on every candidate.
// The next few weeks use the team's projected EV rather than its win chance, from a forward run of the field
// model, so a team most of the field is about to burn gets credit for the quiet spot it leaves you later.
const NEAR_LEGS = 4;                        // legs ahead that use field-aware EV; further out the field model drifts
const MAP_SAMPLES = 96;                     // noisy seasons averaged per forfeit; fixed seed, so numbers are stable
const MAP_FLOOR = 0.02;                     // "win chance" of a leg with nothing to pick: a forfeit, near-certain loss
const MARGIN_SD = 13.5;                     // points of margin per unit of win-chance z
const noiseSd = (lead, market) => (market ? 1.5 : 3 + 0.25 * lead) / MARGIN_SD;
const probit = (p) => { let lo = -6, hi = 6; for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (normCdf(m) < p) lo = m; else hi = m; } return (lo + hi) / 2; };
function seededRng(seed) { return () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const gauss = (r) => { let u = 0, v = 0; while (!u) u = r(); while (!v) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
// Field ownership and pick shares for legId and the next NEAR_LEGS legs, stepping the popularity model forward: each leg
// the field picks by the model (Circa's actual shares for a locked week), the losers drop out, and survivors
// who picked a team no longer hold it.
function projectField(legId, data, params) {
  return cached(data, "pf", `${legId}|${params.a}|${params.b}`, () => {
    const idx = LEGS.findIndex((l) => l.id === legId);
    let av = { ...availability(legId, data) };
    const out = {};
    for (let k = 0; k <= NEAR_LEGS; k++) {
      const l = LEGS[idx + k]; if (!l) break;
      const act = k === 0 ? data.actuals[l.id] : null;
      let p;
      if (act) { const tot = Object.values(act.picks).reduce((a, b) => a + b, 0); p = Object.fromEntries(Object.entries(act.picks).map(([t, n]) => [t, n / tot])); }
      else {
        const sc = {}; let tot = 0;
        for (const t of Object.keys(OPP[l.id])) { const w = lineFor(l.id, t, data)?.win; if (w == null || w < 0.5) continue; const v = Math.pow(w, params.a) * Math.exp(-params.b * fvFor(l.id, t, data)) * av[t]; sc[t] = v; tot += v; }
        p = {}; for (const t in sc) p[t] = tot > 0 ? sc[t] / tot : 0;
        if (k === 0) { const an = splashAnchor(l.id, data); if (an) p = applyAnchor(blendAnchor(an, p, params), p); }
      }
      out[l.id] = { p, av: { ...av } };
      const S = Object.entries(p).reduce((s, [t, x]) => s + x * (lineFor(l.id, t, data)?.win ?? 0), 0);
      const nav = {};
      for (const t of ALL_TEAMS) { const pt = p[t] || 0, w = lineFor(l.id, t, data)?.win ?? 0; nav[t] = pt >= 1 || S <= 0 ? 0 : Math.max(0, Math.min(1, ((av[t] - pt) / (1 - pt)) * (S - pt * w) / S)); }
      av = nav;
    }
    return out;
  });
}
// Everything the map solver needs, for every leg not yet locked, per team: win chance as a z-score, how much
// noise to add for how far off the leg is, the field-aware EV adjustment (log EV − log win, near legs only),
// and the shared noise draws. "Now" is the first week that is not completely over (openLeg), so a week stays in
// the plan until its last game is final. Built once per data snapshot.
function seasonTable(data, params) {
  return cached(data, "st", `${params.a}|${params.b}`, () => {
    const n = ALL_TEAMS.length, nowIdx = LEGS.findIndex((l) => l.id === openLeg(data.actuals));
    const near = nowIdx < LEGS.length ? projectField(LEGS[nowIdx].id, data, params) : {};
    const z = LEGS.map(() => new Float64Array(n).fill(NaN)), sd = LEGS.map(() => new Float64Array(n)), ff = LEGS.map(() => new Float64Array(n));
    LEGS.forEach((l, k) => {
      if (k < nowIdx) return;
      const rows = {}; for (const t of ALL_TEAMS) rows[t] = { win: lineFor(l.id, t, data)?.win ?? null, pick: near[l.id]?.p[t] || 0 };
      const useEv = !!near[l.id]; if (useEv) computeEV(l.id, rows);
      ALL_TEAMS.forEach((t, i) => { const r = rows[t]; if (r.win == null) return; z[k][i] = probit(r.win); sd[k][i] = noiseSd(k - nowIdx + 1, !!marketLine(l.id, t, data)); ff[k][i] = useEv && r.ev != null ? Math.log(r.ev / r.win) : 0; });
    });
    const r = seededRng(20261), eps = [];
    for (let s = 0; s < MAP_SAMPLES; s++) { const e = LEGS.map(() => new Float64Array(n)); for (let k = nowIdx; k < LEGS.length; k++) for (let i = 0; i < n; i++) e[k][i] = gauss(r); eps.push(e); }
    return { z, sd, ff, eps, nowIdx, near };
  });
}
// The legs an entry's map has to fill: every week not completely over, except the one being scored. Picks
// entered for those weeks are soft (Circa does not lock until Saturday and the week is not decided until its
// last game), so they neither fix a week nor spend a team; only picks in finished weeks are spent.
const mapLegs = (tab, except, skip = null) => LEGS.map((l, k) => k).filter((k) => k >= tab.nowIdx && LEGS[k].id !== except && !skip?.has(LEGS[k].id));
export function spentTeams(data, picks) {
  const nowIdx = LEGS.findIndex((l) => l.id === openLeg(data.actuals));
  return new Set(LEGS.slice(0, nowIdx).map((l) => picks?.[l.id]).filter(Boolean));
}
// Minimum-cost assignment of rows (legs) to columns (teams), rows ≤ columns. Returns the column for each row.
function hungarian(cost) {
  const n = cost.length, m = cost[0].length, INF = 1e18;
  const u = new Float64Array(n + 1), v = new Float64Array(m + 1), p = new Int32Array(m + 1), way = new Int32Array(m + 1);
  for (let i = 1; i <= n; i++) {
    p[0] = i; let j0 = 0; const minv = new Float64Array(m + 1).fill(INF), used = new Uint8Array(m + 1);
    do {
      used[j0] = 1; const i0 = p[j0], row = cost[i0 - 1]; let delta = INF, j1 = 0;
      for (let j = 1; j <= m; j++) if (!used[j]) { const cur = row[j - 1] - u[i0] - v[j]; if (cur < minv[j]) { minv[j] = cur; way[j] = j0; } if (minv[j] < delta) { delta = minv[j]; j1 = j; } }
      for (let j = 0; j <= m; j++) if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else minv[j] -= delta;
      j0 = j1;
    } while (p[j0] !== 0);
    do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
  }
  const ans = new Int32Array(n); for (let j = 1; j <= m; j++) if (p[j]) ans[p[j] - 1] = j - 1;
  return ans;
}
// Best map over the given legs for one season draw (sample −1 = the projection itself): value is
// Σ log(win × EV adjustment), and a leg with nothing eligible is filled at MAP_FLOOR.
function bestMap(tab, legIdx, burnedIdx, sample) {
  const { z, sd, ff, eps } = tab; if (!legIdx.length) return { V: 0, path: [] };
  const teams = []; for (let i = 0; i < ALL_TEAMS.length; i++) if (!burnedIdx[i]) teams.push(i);
  const BIG = -Math.log(MAP_FLOOR);
  const cost = legIdx.map((k) => teams.map((i) => { const zz = z[k][i]; if (Number.isNaN(zz)) return BIG; const w = normCdf(zz + (sample < 0 ? 0 : sd[k][i] * eps[sample][k][i])); return -(Math.log(w) + ff[k][i]); }));
  const a = teams.length ? hungarian(cost) : null; let V = 0; const path = [];
  legIdx.forEach((k, j) => {
    const c = a ? cost[j][a[j]] : BIG, dead = !a || c >= BIG;
    V -= c; path.push({ leg: LEGS[k], team: dead ? null : ALL_TEAMS[teams[a[j]]], win: dead ? null : normCdf(z[k][teams[a[j]]]) });
  });
  return { V, path };
}
const deadLeg = (tab, legIdx, bidx) => { const k = legIdx.find((k) => !ALL_TEAMS.some((t, i) => !bidx[i] && !Number.isNaN(tab.z[k][i]))); return k == null ? null : LEGS[k]; };
const withBurned = (bi, team) => { const b = bi.slice(); b[ALL_TEAMS.indexOf(team)] = true; return b; };
// Strength forfeit. The map forfeit assumes the plan survives: inside every noisy season the solver re-plans all
// remaining weeks at once knowing that season's lines, so it always finds the backup. Real picks are made one
// week at a time, injuries and form swings are bigger than the line noise, and the plan will not be followed
// exactly. Broad strength (future value, the count of strong spots anywhere later) is the hedge against that:
// strong spots are what you reach for when the plan breaks. So the forfeit is a blend, in log terms, of the map
// forfeit and exp(β × future value). β is set each refresh so the two forfeits have the same average size over
// this week's scored teams: the blend reshuffles cost toward broadly strong teams, it does not inflate it. The
// strength half weighs STRENGTH_W with STRENGTH_SPAN or more weeks still to plan and fades to zero by the end,
// when the map is the plan. Unverifiable for now; the frozen future values will let it be sized by ~Week 9.
const STRENGTH_W = 0.5, STRENGTH_SPAN = 15;
// The Future column, per entry. The raw count (fvAt) is how many strong weeks the team has anywhere later; the
// entry-aware count credits a strong week only as far as the team would be one of this entry's top options that
// week given the teams it still holds (full credit as first or second, two thirds as third, a third as fourth,
// nothing below). The column shows a blend of the two with the same weight as DILI's strength half: half and
// half with fifteen or more weeks to plan, pure entry-aware by the last week, when the map is the plan.
const RANK_CREDIT = [1, 1, 0.67, 0.33];
function futureFor(legId, team, data, burned) {
  const raw = fvAt(legId, team, data);
  const idx = LEGS.findIndex((l) => l.id === legId);
  let entry = 0;
  for (const l of LEGS.slice(idx + 1)) {
    const mine = lineFor(l.id, team, data)?.win; if (mine == null) continue;
    let rank = 0;
    for (const t of Object.keys(OPP[l.id])) { if (t === team || burned.has(t)) continue; const w = lineFor(l.id, t, data)?.win; if (w != null && w > mine) rank++; }
    entry += spotWeight(mine) * (RANK_CREDIT[rank] ?? 0);
  }
  const w = strengthWeight(legId);
  return { raw, entry, blend: w * raw + (1 - w) * entry, w };
}
function strengthWeight(legId) { const left = LEGS.length - 1 - LEGS.findIndex((l) => l.id === legId); return STRENGTH_W * Math.min(1, left / STRENGTH_SPAN); }
// DILI = EV ÷ forfeit, where forfeit = (map value with the team kept) ÷ (map value with it burned), averaged over
// the noisy seasons. Fills r.forfeit, r.swaps (what the projected map changes if the team is burned) and r.dili.
// Returns the entry's projected map for the other open legs.
export function computeDili(legId, rows, data, burned, params = PRIOR, skip = null) {
  const tab = seasonTable(data, params);
  const legIdx = mapLegs(tab, legId, skip);
  const bi = ALL_TEAMS.map((t) => burned.has(t));
  const base = bestMap(tab, legIdx, bi, -1);
  let baseV = 0; for (let s = 0; s < MAP_SAMPLES; s++) baseV += bestMap(tab, legIdx, bi, s).V; baseV /= MAP_SAMPLES;
  const baseDead = deadLeg(tab, legIdx, bi);
  for (const t of Object.keys(OPP[legId])) {
    const r = rows[t];
    if (r.ev == null || burned.has(t)) { r.dili = null; continue; }
    const bt = withBurned(bi, t);
    const dl = deadLeg(tab, legIdx, bt);
    if (dl && !baseDead) { r.forfeit = Infinity; r.dili = 0; r.deadLeg = dl; r.swaps = []; continue; }
    let V = 0; for (let s = 0; s < MAP_SAMPLES; s++) V += bestMap(tab, legIdx, bt, s).V; V /= MAP_SAMPLES;
    r.forfeitMap = 1 / Math.min(1, Math.exp(V - baseV));
    const alt = bestMap(tab, legIdx, bt, -1);
    r.swaps = base.path.map((p, k) => (p.team !== alt.path[k].team ? { leg: p.leg, from: p.team, fromWin: p.win, to: alt.path[k].team, toWin: alt.path[k].win } : null)).filter(Boolean);
  }
  // blend in the strength forfeit, calibrated to the map forfeit's average size this week
  const w = strengthWeight(legId), scored = Object.keys(OPP[legId]).filter((t) => rows[t].forfeitMap != null);
  const fv = Object.fromEntries(scored.map((t) => [t, fvAt(legId, t, data)]));
  const meanLog = scored.reduce((a, t) => a + Math.log(rows[t].forfeitMap), 0) / (scored.length || 1), meanFv = scored.reduce((a, t) => a + fv[t], 0) / (scored.length || 1);
  const beta = meanFv > 0 ? meanLog / meanFv : 0;
  for (const t of scored) {
    const r = rows[t];
    r.forfeitStr = Math.exp(beta * fv[t]); r.strengthW = w; r.beta = beta;
    r.forfeit = Math.pow(r.forfeitMap, 1 - w) * Math.pow(r.forfeitStr, w);
    r.dili = r.ev / r.forfeit;
  }
  return base.path;
}
// The whole-season plan for one entry, for the Map tab. Every open leg without a pick is filled by the map;
// for each: how often that team filled it across the noisy seasons, the backup (what fills the leg if the
// team is burned) and what burning it costs, and field ownership for the near legs. Also which of this
// week's favorites the map needs least in later weeks (cheapest to burn).
export function planMap(data, picks, params = PRIOR) {
  const tab = seasonTable(data, params);
  const legIdx = mapLegs(tab, null);
  const spent = spentTeams(data, picks), bi = ALL_TEAMS.map((t) => spent.has(t));
  const base = bestMap(tab, legIdx, bi, -1);
  const byLeg = legIdx.map(() => ({})), onMap = {};
  // onMap counts use in any week after the first one mapped, which is the week "cheapest to burn" is about
  for (let s = 0; s < MAP_SAMPLES; s++) bestMap(tab, legIdx, bi, s).path.forEach((p, j) => { if (!p.team) return; byLeg[j][p.team] = (byLeg[j][p.team] || 0) + 1; if (j > 0) onMap[p.team] = (onMap[p.team] || 0) + 1; });
  const plan = base.path.map((p, j) => {
    const l = p.leg, near = tab.near[l.id];
    const out = { ...p, held: p.team ? byLeg[j][p.team] || 0 : 0, samples: MAP_SAMPLES, others: Object.entries(byLeg[j]).filter(([t]) => t !== p.team).sort((a, b) => b[1] - a[1]).slice(0, 2) };
    if (l.holiday) { const pool = [...(l.id === "TG" ? TG_TEAMS : XM_TEAMS)]; out.pool = pool.length; out.poolLeft = pool.filter((t) => !bi[ALL_TEAMS.indexOf(t)]).length; }
    if (!p.team) return out;
    const alt = bestMap(tab, legIdx, withBurned(bi, p.team), -1);
    out.backup = alt.path[j].team; out.backupWin = alt.path[j].win; out.cost = Math.exp(base.V - alt.V);
    if (near) { out.fieldHold = near.av[p.team]; out.fieldPick = near.p[p.team] || 0; }
    return out;
  });
  const now = legIdx.length ? LEGS[legIdx[0]] : null;
  const free = !now ? [] : Object.keys(OPP[now.id]).filter((t) => !bi[ALL_TEAMS.indexOf(t)] && (lineFor(now.id, t, data)?.win ?? 0) >= 0.55 )
    .map((t) => ({ team: t, win: lineFor(now.id, t, data).win, onMap: (onMap[t] || 0) / MAP_SAMPLES })).sort((a, b) => a.onMap - b.onMap || b.win - a.win).slice(0, 3);
  const live = plan.filter((p) => p.team);
  return { plan, byLeg, nowLeg: now || null, currentLeg: LEGS[tab.nowIdx] || null, winOut: live.length === plan.length ? live.reduce((x, p) => x * p.win, 1) : 0, weakest: [...live].sort((a, b) => a.win - b.win).slice(0, 3), free, samples: MAP_SAMPLES };
}
// Claude's DILI Map: the Planner's rule applied week by week. Score the next open week exactly as the Planner
// does (EV ÷ forfeit, with the strength half), take the top DILI, spend that team, move to the next week and
// repeat to the end, as if nothing changes. The current week therefore always matches the Planner. The first
// NEAR_LEGS weeks have a field model and score on EV; further out there is none, so those weeks score on win
// chance ÷ forfeit. Weeks already planned are left out of each later forfeit's map.
export function diliPlan(data, picks, params = PRIOR) {
  const tab = seasonTable(data, params);
  const burned = spentTeams(data, picks), skip = new Set(), plan = [];
  let cheap = [];
  for (let k = tab.nowIdx; k < LEGS.length; k++) {
    const l = LEGS[k], near = tab.near[l.id], now = k === tab.nowIdx, rows = {};
    // the current week scores on True Win % like the Planner; if the books have posted nothing yet, fall back to projections
    const strict = now && Object.keys(OPP[l.id]).some((t) => marketLine(l.id, t, data));
    for (const t of ALL_TEAMS) { const ln = OPP[l.id][t] ? (strict ? marketLine(l.id, t, data) : lineFor(l.id, t, data)) : null; rows[t] = { win: ln?.win ?? null, pick: 0 }; }
    let ev = false;
    if (now) { const mp = modelPick(l.id, data, params); if (Object.keys(mp).length) { for (const t in rows) rows[t].pick = mp[t] ?? 0; ev = true; } }
    else if (near) { for (const t in rows) rows[t].pick = near.p[t] || 0; ev = true; }
    if (now) { const an = splashAnchor(l.id, data); if (an) for (const [t, f] of Object.entries(an.final)) if (rows[t]) rows[t].win = f === "W" ? 1 : 0; }
    if (ev && computeEV(l.id, rows).blanked) ev = false;
    if (!ev) for (const t in rows) rows[t].ev = rows[t].win;
    if (now) { const an = splashAnchor(l.id, data); if (an) for (const t of Object.keys(an.final)) if (rows[t]) rows[t].ev = null; }
    computeDili(l.id, rows, data, burned, params, skip);
    const cands = Object.keys(OPP[l.id]).filter((t) => rows[t].dili != null).sort((a, b) => rows[b].dili - rows[a].dili);
    const [t1, t2] = cands, r1 = t1 ? rows[t1] : null, r2 = t2 ? rows[t2] : null;
    plan.push({ leg: l, team: t1 || null, win: r1?.win ?? null, dili: r1?.dili ?? null, forfeit: r1?.forfeit ?? null, backup: t2 || null, backupWin: r2?.win ?? null, backupDili: r2?.dili ?? null, ev,
      pool: l.holiday ? [...(l.id === "TG" ? TG_TEAMS : XM_TEAMS)].length : 0, poolLeft: l.holiday ? [...(l.id === "TG" ? TG_TEAMS : XM_TEAMS)].filter((t) => !burned.has(t)).length : 0 });
    if (now) cheap = Object.keys(OPP[l.id]).filter((t) => rows[t].forfeit != null && Number.isFinite(rows[t].forfeit) && (rows[t].win ?? 0) >= 0.55).map((t) => ({ team: t, win: rows[t].win, forfeit: rows[t].forfeit })).sort((a, b) => a.forfeit - b.forfeit || b.win - a.win).slice(0, 3);
    if (t1) burned.add(t1);
    skip.add(l.id);
  }
  const live = plan.filter((p) => p.team);
  return { plan, currentLeg: LEGS[tab.nowIdx] || null, winOut: live.length === plan.length && plan.length ? live.reduce((x, p) => x * p.win, 1) : 0, weakest: [...live].sort((a, b) => a.win - b.win).slice(0, 3), cheap };
}
// Claude's 96 Map: the plan the jiggled seasons agree on. Over the 96 noisy solves, count how often each team
// filled each week, then assign in order of agreement (highest count first, one week per team) so no team is used
// twice. A week nothing agrees on falls back to the best win chance still available. Each row's count is the
// number of seasons that put that team there, and the backup is the runner-up by count not used elsewhere.
export function consensusPlan(data, picks, params = PRIOR) {
  const base = planMap(data, picks, params);
  const legs = base.plan.map((p) => p.leg), byLeg = base.byLeg, used = new Set(), pick = new Array(legs.length).fill(null);
  const pairs = []; byLeg.forEach((m, j) => { for (const [t, n] of Object.entries(m)) pairs.push({ j, t, n }); });
  pairs.sort((a, b) => b.n - a.n || a.j - b.j);
  for (const p of pairs) { if (pick[p.j] || used.has(p.t)) continue; pick[p.j] = { team: p.t, held: p.n }; used.add(p.t); }
  const spent = spentTeams(data, picks);
  legs.forEach((l, j) => {
    if (pick[j]) return;
    const best = Object.keys(OPP[l.id]).filter((t) => !used.has(t) && !spent.has(t)).map((t) => ({ t, w: lineFor(l.id, t, data)?.win ?? 0 })).sort((a, b) => b.w - a.w)[0];
    if (best) { pick[j] = { team: best.t, held: 0 }; used.add(best.t); }
  });
  const plan = legs.map((l, j) => {
    const p = pick[j], win = p ? lineFor(l.id, p.team, data)?.win ?? null : null;
    const alt = Object.entries(byLeg[j]).filter(([t]) => t !== p?.team && !used.has(t)).sort((a, b) => b[1] - a[1])[0] || null;
    return { leg: l, team: p?.team || null, win, held: p?.held ?? 0, samples: MAP_SAMPLES, backup: alt ? alt[0] : null, backupWin: alt ? lineFor(l.id, alt[0], data)?.win ?? null : null, backupHeld: alt ? alt[1] : 0,
      pool: l.holiday ? [...(l.id === "TG" ? TG_TEAMS : XM_TEAMS)].length : 0, poolLeft: l.holiday ? [...(l.id === "TG" ? TG_TEAMS : XM_TEAMS)].filter((t) => !spent.has(t)).length : 0 };
  });
  const live = plan.filter((p) => p.team);
  return { plan, currentLeg: base.currentLeg, nowLeg: base.nowLeg, winOut: live.length === plan.length && plan.length ? live.reduce((x, p) => x * p.win, 1) : 0, weakest: [...live].sort((a, b) => a.win - b.win).slice(0, 3), free: base.free, samples: MAP_SAMPLES };
}
// share of the field still holding each team going into legId, from actual picks in earlier legs
function availability(legId, data) { return cached(data, "av", legId, () => availabilityRaw(legId, data)); }
function availabilityRaw(legId, data) {
  const idx = LEGS.findIndex((l) => l.id === legId);
  const tl = fieldTimeline(data);
  const burned = {};
  for (let k = 0; k < Math.min(idx, tl.length); k++) {
    const r = tl[k], a = data.actuals[r.leg.id];
    let survive = 1;
    for (let j = k + 1; j < Math.min(idx, tl.length); j++) survive *= tl[j].after / tl[j].before;
    for (const [t, n] of Object.entries(a.picks)) if (a.won.includes(t)) burned[t] = (burned[t] || 0) + n * survive;
  }
  const live = idx < tl.length ? tl[idx].before : (tl.length ? tl[tl.length - 1].after : data.contest.start);
  const out = {};
  for (const t of ALL_TEAMS) out[t] = Math.max(0, 1 - (burned[t] || 0) / (live || 1));
  return out;
}
// ---------- Splash: the other $1,000 survivor field ----------
// Splash shows its pick counts for the Thursday game the moment it kicks off, two days before Circa locks, and
// both contests make a Thursday backer commit before kickoff, so that reading is Circa's own crowd seen early.
// Across Weeks 1–4 the two fields ranked teams identically and Circa was sharper toward the top: Circa share ≈
// Splash share^γ ÷ Z with γ = 1.2 and Z the week's Σ share^γ (about 0.7). The top pick's ratio ran 1.11–1.23
// (log SD ≈ 0.05); mid-sized teams scatter more, and Circa holds holiday-pool teams Splash spends freely.
// When the current week has a Thursday reading, each Thursday team's share is a blend of the mapped Splash value
// and the model's own value, weighted by how wrong each has been (inverse variance, in log space: the mapping's
// residuals on past weeks against the model's measured errors), and everyone else's model share is scaled to
// fill the rest. A Thursday final sets that game's win chance to 0/1.
const SPLASH_GAMMA = 1.2, SPLASH_ERR_TOP = 0.06, SPLASH_ERR_OTHER = 0.3, SPLASH_PSEUDO = 3;
// how far the mapping has missed Circa on past weeks: log SD of actual ÷ mapped, for the week's top Splash pick and
// for everyone else, shrunk toward the defaults while few weeks exist
function splashError(data) {
  return cached(data, "spe", "err", () => {
    const g = data.splash?.mapping?.gamma ?? SPLASH_GAMMA, Z = splashZ(data), top = [], other = [];
    for (const [id, w] of Object.entries(data.splash?.weeks || {})) {
      const act = data.actuals?.[id]; if (!w.picks || !w.survived || !act) continue;
      const n = w.survived + w.eliminated, tot = Object.values(act.picks).reduce((a, b) => a + b, 0);
      const best = Object.keys(w.picks).sort((a, b) => w.picks[b] - w.picks[a])[0];
      for (const [t, c] of Object.entries(w.picks)) {
        const sp = c / n, ci = (act.picks[t] || 0) / tot; if (sp < 0.01 || ci < 0.01) continue;
        (t === best ? top : other).push(Math.log(ci) - Math.log(Math.min(0.9, Math.pow(sp, g) / Z)));
      }
    }
    const sd = (xs, d0) => Math.min(0.6, Math.max(0.03, Math.sqrt((xs.reduce((a, x) => a + x * x, 0) + SPLASH_PSEUDO * d0 * d0) / (xs.length + SPLASH_PSEUDO))));
    return { top: sd(top, SPLASH_ERR_TOP), other: sd(other, SPLASH_ERR_OTHER), nTop: top.length, nOther: other.length };
  });
}
function splashZ(data) {
  return cached(data, "spz", "Z", () => {
    const g = data.splash?.mapping?.gamma ?? SPLASH_GAMMA, zs = [];
    for (const w of Object.values(data.splash?.weeks || {})) { if (!w.picks || !w.survived) continue; const n = w.survived + w.eliminated; zs.push(Object.values(w.picks).reduce((a, c) => a + Math.pow(c / n, g), 0)); }
    return zs.length ? zs.reduce((a, b) => a + b, 0) / zs.length : 0.72;
  });
}
function splashAnchor(legId, data) {
  const th = data.splash?.weeks?.[legId]?.thursday;
  if (!th?.picks || !th.alive || data.actuals?.[legId]) return null;
  const g = data.splash?.mapping?.gamma ?? SPLASH_GAMMA, Z = splashZ(data), shares = {}, raw = {};
  for (const [t, n] of Object.entries(th.picks)) { raw[t] = n / th.alive; shares[t] = Math.min(0.9, Math.pow(raw[t], g) / Z); }
  return { shares, raw, final: th.final || {}, alive: th.alive, asOf: th.asOf || null, gamma: g, Z, err: splashError(data) };
}
// blend each Thursday team's mapped share with the model's, weighted by inverse variance in log space
const blendAnchor = (anchor, model, params) => {
  const shares = {}, w = {}, sd = {};
  for (const [t, mapped] of Object.entries(anchor.shares)) {
    const chalk = mapped >= 0.15, ss = chalk ? anchor.err.top : anchor.err.other, sm = chalk ? (params?.errTop ?? MODEL_ERR_TOP) : (params?.errOther ?? MODEL_ERR);
    const pm = model[t] || 0, ps = Math.max(mapped, 0.0005);
    // a team the model gives nothing (an underdog it never scores) takes the mapped share outright: the model has no opinion to blend
    const wt = pm < 0.001 ? 1 : sm * sm / (sm * sm + ss * ss);
    shares[t] = Math.min(0.95, Math.exp(wt * Math.log(ps) + (1 - wt) * Math.log(Math.max(pm, 0.0005)))); w[t] = wt; sd[t] = pm < 0.001 ? ss : Math.sqrt(1 / (1 / (ss * ss) + 1 / (sm * sm)));
  }
  return { ...anchor, blended: shares, w, sd };
};
// pin the blended shares and scale the rest to fill what is left; with rng, draw the blend's own error
const applyAnchor = (blend, p, rng = null) => {
  if (!blend) return p;
  const out = { ...p }; let A = 0, rest = 0;
  for (const [t, v] of Object.entries(blend.blended)) { out[t] = Math.min(0.95, v * (rng ? Math.exp(blend.sd[t] * gauss(rng)) : 1)); A += out[t]; }
  for (const t of Object.keys(out)) if (!(t in blend.blended)) rest += out[t];
  const scale = rest > 0 ? Math.max(0, 1 - A) / rest : 0;
  for (const t of Object.keys(out)) if (!(t in blend.blended)) out[t] *= scale;
  return out;
};
function modelPick(legId, data, params, raw = false) {
  const { a, b, c = 0 } = params;
  const av = availability(legId, data);
  const sc = {};
  let tot = 0;
  for (const t of Object.keys(OPP[legId])) {
    const ln = marketLine(legId, t, data); if (!ln || ln.win < 0.5) continue;
    const v = Math.pow(ln.win, a) * Math.exp(-b * fvAt(legId, t, data)) * Math.exp(-c * holidayPressure(legId, t, data, av)) * av[t];
    sc[t] = v; tot += v;
  }
  const out = {};
  for (const t of Object.keys(sc)) out[t] = tot > 0 ? sc[t] / tot : 0;
  if (raw) return out;
  const an = splashAnchor(legId, data);
  return an ? applyAnchor(blendAnchor(an, out, params), out) : out;
}
// Where P% could land by Saturday's lock. Lines keep moving until then, and the model raises win chance to a
// high power, so a point of line movement swings the biggest favorites by several points of share. Every
// team's win chance is jiggled by the typical movement of a posted line between Tuesday and Saturday's lock
// (LINE_MOVE points of spread, measured across Weeks 2–4: 0.45, 0.63 and 0.60), shrinking with the square
// root of the days still to go, so the band narrows through the week. The model is re-run on each draw and
// the 10th–90th percentile of each team's share, and of its EV, is kept. Fixed seed and the same draws for
// every team, so the band is stable between renders; it is recomputed only when the data refreshes.
// Line movement alone barely moves EV or DILI (a better line raises a team's share and its win chance together,
// and the two cancel), and it is not what produced the Week 4 Ravens miss. So each draw also jiggles every
// team's score by the model's own error, measured at lock across Weeks 1–4 by where the team sat in the model's
// own ranking: its top pick has been within a factor of 1.15 every week (log SD ≈ 0.1), while the runner-up
// has been off by up to ×2.1 (Bucs) and ×1.3 (Ravens), log SD ≈ 0.4. Those parts do not shrink at lock. The
// band shown is the middle half of the draws (25th–75th percentile).
// The two error sizes are re-measured from the fitted model's own misses every time a week's picks arrive
// (bandError), shrunk toward these defaults while there are only a few weeks to measure from.
const LINE_MOVE = 0.6, MODEL_ERR_TOP = 0.1, MODEL_ERR = 0.35, RANGE_SAMPLES = 96, LOCK_DAYS = 4, BAND = [0.25, 0.75];
const ERR_PSEUDO = 3, ERR_MIN = 0.05, ERR_MAX = 0.6;
function bandError(data, params, legs) {
  const top = [], other = [];
  for (const id of legs) {
    const act = data.actuals[id], tot = Object.values(act.picks).reduce((x, y) => x + y, 0), m = modelPick(id, data, params);
    const best = Object.keys(m).sort((x, y) => m[y] - m[x])[0]; if (!best) continue;
    for (const t of Object.keys(m)) {
      const s = (act.picks[t] || 0) / tot;
      if (t === best) top.push(Math.log((s + 0.005) / (m[t] + 0.005)));
      else if (m[t] >= 0.03 || s >= 0.03) other.push(Math.log((s + 0.005) / (m[t] + 0.005)));
    }
  }
  const sd = (xs, d0) => Math.min(ERR_MAX, Math.max(ERR_MIN, Math.sqrt((xs.reduce((a, x) => a + x * x, 0) + ERR_PSEUDO * d0 * d0) / (xs.length + ERR_PSEUDO))));
  return { errTop: +sd(top, MODEL_ERR_TOP).toFixed(3), errOther: +sd(other, MODEL_ERR).toFixed(3), nTop: top.length, nOther: other.length };
}
const lockTime = (leg) => new Date(leg.start + "T16:00:00-07:00").getTime() - 24 * 3600 * 1000;   // Saturday 4 pm PT before a Sunday start
function modelPickRange(legId, data, params, now = Date.now()) {
  return cached(data, "pr", `${legId}|${params.a}|${params.b}|${params.c ?? 0}|${params.errTop ?? ""}|${params.errOther ?? ""}`, () => {
    const { a, b, c = 0, errTop = MODEL_ERR_TOP, errOther = MODEL_ERR } = params;
    const leg = LEGS.find((l) => l.id === legId);
    const days = Math.min(LOCK_DAYS, Math.max(0.25, (lockTime(leg) - now) / 864e5));
    const av = availability(legId, data);
    const teams = Object.keys(OPP[legId]).map((t) => { const ln = marketLine(legId, t, data); return ln ? { t, z: probit(ln.win), k: Math.exp(-b * fvAt(legId, t, data)) * Math.exp(-c * holidayPressure(legId, t, data, av)) * av[t] } : null; }).filter(Boolean);
    if (!teams.length) return {};
    const top = teams.reduce((m, x) => (Math.pow(normCdf(x.z), a) * x.k > Math.pow(normCdf(m.z), a) * m.k ? x : m), teams[0]).t;
    const r = seededRng(7), sd = (LINE_MOVE * Math.sqrt(days / LOCK_DAYS)) / MARGIN_SD, acc = Object.fromEntries(teams.map((x) => [x.t, { p: [], ev: [] }]));
    const anchor = splashAnchor(legId, data);
    for (let s = 0; s < RANGE_SAMPLES; s++) {
      const rows = {}; let tot = 0;
      for (const x of teams) { const win = normCdf(x.z + sd * gauss(r)); const v = win >= 0.5 ? Math.pow(win, a) * x.k * Math.exp((x.t === top ? errTop : errOther) * gauss(r)) : 0; rows[x.t] = { win, pick: v }; tot += v; }
      for (const t of Object.keys(OPP[legId])) { if (!rows[t]) rows[t] = { win: null, pick: 0 }; else rows[t].pick = tot > 0 ? rows[t].pick / tot : 0; }
      if (anchor) { const shares0 = Object.fromEntries(Object.keys(OPP[legId]).map((t) => [t, rows[t].pick])); const p = applyAnchor(blendAnchor(anchor, shares0, params), shares0, r); for (const t of Object.keys(p)) rows[t].pick = p[t]; for (const [t, f] of Object.entries(anchor.final)) if (rows[t]) rows[t].win = f === "W" ? 1 : 0; }
      computeEV(legId, rows);
      for (const x of teams) { acc[x.t].p.push(rows[x.t].pick); if (rows[x.t].ev != null) acc[x.t].ev.push(rows[x.t].ev); }
    }
    const q = (xs, f) => { const v = [...xs].sort((p, q) => p - q); return v.length ? v[Math.min(v.length - 1, Math.floor(f * v.length))] : null; };
    return Object.fromEntries(teams.map((x) => [x.t, { lo: q(acc[x.t].p, BAND[0]), hi: q(acc[x.t].p, BAND[1]), evLo: q(acc[x.t].ev, BAND[0]), evHi: q(acc[x.t].ev, BAND[1]) }]));
  });
}
// Fit a, b to every leg that has both actuals and lines (grid search).
// The miss on each team is weighted by that team's actual share (plus a small floor so ignored teams still
// count a little), because EV depends almost entirely on the few teams the field piles onto.
// A mild penalty holds the knobs near PRIOR while there are only a week or two of actuals; once several
// weeks accumulate the evidence outweighs it and the knobs go wherever Circa's numbers say.
// The prior stops an early-season fit chasing one odd week. Each knob is measured against a plausible
// SPREAD, not against its own size: dividing by the value itself made any movement in b (which starts near
// 0.15) cost hundreds of times more than the error it saved, so b was frozen rather than restrained. The
// The weight is divided by the square of the number of weeks fitted: one week keeps the full guardrail, four
// weeks leave a sixteenth of it. Backtested week by week (fit on earlier weeks, predict the next) this matched
// an unguarded fit's gains in Weeks 3 and 4 without its Week 2 damage.
const PRIOR = { a: 8, b: 0.15, c: 0 };
const PRIOR_SPREAD = { a: 6, b: 0.25, c: 1.5 };
const PRIOR_WEIGHT = 0.03;
const SHARE_FLOOR = 0.02;
function fitParams(data) {
  const legs = Object.keys(data.actuals).filter((id) => OPP[id] && Object.keys(OPP[id]).some((t) => marketLine(id, t, data)));
  if (!legs.length) return { ...PRIOR, legs: 0, err: null };
  const miss = (a, b, c) => {
    let err = 0;
    for (const id of legs) {
      const act = data.actuals[id], tot = Object.values(act.picks).reduce((x, y) => x + y, 0);
      const m = modelPick(id, data, { a, b, c });
      for (const t of Object.keys(OPP[id])) { const share = (act.picks[t] || 0) / tot; err += (share + SHARE_FLOOR) * Math.abs((m[t] || 0) - share); }
    }
    return err;
  };
  const w = PRIOR_WEIGHT / (legs.length * legs.length);
  const score = (a, b, c) => miss(a, b, c) + w * (((a - PRIOR.a) / PRIOR_SPREAD.a) ** 2 + ((b - PRIOR.b) / PRIOR_SPREAD.b) ** 2 + ((c - PRIOR.c) / PRIOR_SPREAD.c) ** 2);
  // Coordinate descent rather than a three-way grid: (a, b) together, then c, twice. Same answer on a
  // surface this smooth, without multiplying the work by the size of the c grid.
  let cur = { ...PRIOR };
  for (let pass = 0; pass < 2; pass++) {
    let best = null;
    for (let a = 2; a <= 24; a += 1) for (let b = 0; b <= 0.8; b += 0.02) { const sc = score(a, b, cur.c); if (!best || sc < best.sc) best = { a, b: +b.toFixed(2), sc }; }
    cur = { ...cur, a: best.a, b: best.b };
    let bc = null;
    for (let c = 0; c <= 6; c += 0.25) { const sc = score(cur.a, cur.b, c); if (!bc || sc < bc.sc) bc = { c, sc }; }
    cur = { ...cur, c: bc.c };
  }
  return { ...cur, err: miss(cur.a, cur.b, cur.c), legs: legs.length, ...bandError(data, cur, legs) };
}
// mean L1 error of the model vs Circa actuals on legs where both exist
function modelError(data, params) {
  let e = 0, n = 0;
  for (const id of Object.keys(data.actuals)) {
    const act = data.actuals[id], tot = Object.values(act.picks).reduce((x, y) => x + y, 0);
    const m = modelPick(id, data, params); if (!Object.keys(m).length) continue;
    e += Object.keys(OPP[id]).reduce((s, t) => s + Math.abs((m[t] || 0) - (act.picks[t] || 0) / tot), 0); n++;
  }
  return n ? { err: e / n, n } : null;
}

// An entry is out the moment one of its picks loses, or when a finished week went by with no pick at all.
// A week with games still pending cannot eliminate anyone who has not already lost.
export function entryStatus(entry, actualLegs) {
  for (const l of LEGS) {
    const a = actualLegs?.[l.id]; if (!a) break;
    const t = entry.picks?.[l.id];
    if (t && a.lost.includes(t)) return { alive: false, leg: l };
    if (!t && !a.pending?.length) return { alive: false, leg: l };
  }
  return { alive: true, leg: null };
}

export { modelPickRange, fvAt, bandError, strengthWeight, futureFor, marketLine, splashAnchor, linesFromOdds, consensusForGame, computeEV, EV_MIN_COVERAGE, buildData, devig, fieldTimeline, modelPick, fitParams, availability, fvFor, holidayPressure };

const CSS = `
/* ---- tokens: paper, ink, one green ---- */
.csp { --paper:#FBFAF7; --panel:#F4F2EC; --surface:#FFFFFF; --ink:#17181C; --ink2:#5B5E66; --ink3:#9A9DA6; --rule:#E7E5DF; --rule2:#D6D3CB;
  --green:#2F8F3E; --green-ink:#1C5E2A; --green-bg:#DDF3DC; --sand:#F3EFE3; --sand-ink:#7A5A12; --amber:#C98A1A; --red:#D64545;
  --sel:#2F63C9; --sel-line:#9DB8E6; --sel-bg:#EAF0FA; --sel-bg2:#DCE6F6; --sel-bg3:#CFDCF2;
  --th:40px; --rh:34px; --cw:52px; --gap:20px;
  display:flex; flex-direction:column; height:100vh; background:var(--paper); color:var(--ink);
  font-family:"IBM Plex Sans", -apple-system, "Helvetica Neue", Helvetica, Arial, sans-serif; font-size:13px; font-variant-numeric:tabular-nums; -webkit-font-smoothing:antialiased; }
.csp * { box-sizing:border-box; }
.csp h1 { font-size:20px; font-weight:600; letter-spacing:-0.01em; margin:0; display:flex; align-items:center; gap:14px; white-space:nowrap; }
.csp h1 .ver { font-size:11px; font-weight:400; color:var(--ink3); }

/* ---- top bar ---- */
.csp .bar { display:flex; justify-content:space-between; align-items:center; gap:16px; padding:12px 16px 10px; }
.csp .bar .left { display:flex; align-items:center; gap:18px; min-width:0; flex-wrap:wrap; }
.csp .ctl { display:flex; flex-direction:column; align-items:flex-end; gap:5px; flex-shrink:0; }
.csp .ctl .row { display:flex; gap:8px; align-items:center; min-height:32px; }
.csp .ctl .note { font-size:12px; color:var(--ink3); padding-right:6px; }
.csp .ctl .note.msg { color:var(--ink); }
.csp .ctl .note.err { color:var(--red); }
.csp .who { font-size:12px; color:var(--ink2); }
.csp .link { display:inline-block; background:none; border:none; padding:0 4px; font:inherit; font-size:12px; color:var(--ink2); cursor:pointer; text-decoration:underline; text-underline-offset:3px; }
.csp .link:hover { color:var(--ink); }

/* one control system */
.csp .btn, .csp .ghost, .csp .ctl select { height:32px; line-height:30px; padding:0 12px; font:inherit; font-size:13px; font-weight:500; border-radius:8px; border:1px solid var(--rule2); background:var(--surface); color:var(--ink); cursor:pointer; white-space:nowrap; }
.csp .btn:hover, .csp .ghost:hover, .csp .ctl select:hover { border-color:var(--ink3); }
.csp .btn:focus-visible, .csp .ghost:focus-visible, .csp .ctl select:focus-visible, .csp .seg button:focus-visible, .csp .views button:focus-visible { outline:2px solid var(--ink); outline-offset:2px; }
.csp .btn { background:var(--ink); color:#fff; border-color:var(--ink); }
.csp .btn:hover { background:#2a2c33; border-color:#2a2c33; }
.csp .btn:disabled, .csp .ghost:disabled { opacity:.45; cursor:default; }
.csp .ghost.on { background:var(--panel); border-color:var(--ink3); }
.csp .ctl select { appearance:none; -webkit-appearance:none; font-weight:600; padding-right:30px; background:var(--surface) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath d='M2.5 4.5l3.5 3.5 3.5-3.5' fill='none' stroke='%2317181C' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") no-repeat right 10px center; }
/* segmented controls: views and entries */
.csp .views, .csp .seg { display:inline-flex; padding:3px; background:var(--panel); border-radius:9px; gap:2px; }
.csp .views button, .csp .seg button { height:26px; line-height:26px; padding:0 12px; font:inherit; font-size:13px; font-weight:500; border:none; border-radius:6px; background:transparent; color:var(--ink2); cursor:pointer; white-space:nowrap; }
.csp .views button:hover, .csp .seg button:hover { color:var(--ink); }
.csp .views button.on, .csp .seg button.on { background:var(--surface); color:var(--ink); box-shadow:0 1px 2px rgba(0,0,0,.10); }
.csp .seg button .n { margin-left:6px; font-size:11px; color:var(--ink3); font-weight:400; }
.csp .seg button.on .n { color:var(--ink2); }

/* ---- the board ---- */
.csp .wrap { flex:1; min-height:0; overflow:auto; overscroll-behavior:contain; background:var(--surface); border-top:1px solid var(--rule); }
.csp table { border-collapse:separate; border-spacing:0; font-size:12px; }
.csp th, .csp td { padding:0; border-bottom:1px solid var(--rule); white-space:nowrap; }
.csp th { position:sticky; top:0; z-index:3; height:var(--th); background:var(--paper); color:var(--ink2); font-weight:500; font-size:12px; text-align:center; vertical-align:middle; line-height:1.15; cursor:pointer; user-select:none; border-bottom:1px solid var(--rule2); }
.csp th:hover { color:var(--ink); }
.csp th .lsub { display:block; font-weight:400; font-size:10px; color:var(--ink3); margin-top:1px; }
.csp th.sorted { color:var(--ink); font-weight:600; box-shadow:inset 0 -2px 0 var(--ink); }
.csp th.hol { color:var(--sand-ink); }
.csp th.hol .lsub { color:var(--sand-ink); opacity:.8; }
.csp .wrap.scrolled tr.top th { box-shadow:0 4px 10px rgba(23,24,28,.06); }
/* selected week: a blue wash down the column inside a soft blue frame (real borders, so it never breaks) */
.csp th.curcol { background:var(--sel-bg) !important; color:var(--sel); font-weight:600; border-left:2px solid var(--sel-line); border-right:2px solid var(--sel-line); }
.csp .sum tr.top th.curcol { border-top:2px solid var(--sel-line); }
.csp td.curcol { background:var(--sel-bg); border-left:2px solid var(--sel-line); border-right:2px solid var(--sel-line); }
.csp td.curcol.last { border-bottom:2px solid var(--sel-line); }
.csp .sum td.curcol { background:var(--sel-bg2); }
.csp .sum tr.gap td.curcol { background:var(--sel-bg); border-bottom-color:var(--rule); }

/* frozen left block: EV | W% | P% | Team */
.csp .L { position:sticky; z-index:2; background:var(--surface); height:var(--rh); text-align:center; }
/* frozen block: what we observe (W%, P%, Future) then what we conclude (EV, DILI); 360px total */
.csp .L.wp { left:0; width:70px; min-width:70px; }
.csp .L.pp { left:70px; width:78px; min-width:78px; }
.csp .L.fv { left:148px; width:66px; min-width:66px; }
.csp .L.ev { left:214px; width:70px; min-width:70px; }
.csp .L.dili { left:284px; width:76px; min-width:76px; }
.csp .L.team { left:360px; width:var(--teamw,100px); min-width:var(--teamw,100px); text-align:left; padding:0 8px 0 12px; font-weight:600; }
.csp .L.pctl { left:0; width:360px; min-width:360px; padding:0; }
.csp .sum td.pctl { top:0; height:calc(var(--th) + var(--n) * var(--rh)); border-bottom:1px solid var(--rule); }
/* the board's controls: a plain block pinned over the table's top-left corner, laid out on its own terms */
.csp .corner { position:sticky; top:0; left:0; height:0; z-index:7; }
.csp .controls { position:absolute; left:0; top:0; width:360px; height:calc(var(--th) + var(--n) * var(--rh)); box-sizing:border-box; padding:0 12px 0 16px; background:var(--panel); border-bottom:1px solid var(--rule); display:flex; flex-direction:column; justify-content:center; gap:10px; }
.csp .controls .row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
.csp .sum tr.top th { background:var(--panel); }

.csp .controls select { height:28px; line-height:26px; padding:0 28px 0 10px; font:inherit; font-size:13px; font-weight:600; border-radius:7px; border:1px solid var(--rule2); color:var(--ink); cursor:pointer; appearance:none; -webkit-appearance:none; background:var(--surface) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath d='M2.5 4.5l3.5 3.5 3.5-3.5' fill='none' stroke='%2317181C' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") no-repeat right 9px center; }
.csp .controls select:hover { border-color:var(--ink3); }
.csp .controls .btn, .csp .controls .ghost { height:28px; line-height:26px; padding:0 11px; border-radius:7px; }
.csp .controls .note { font-size:11px; color:var(--ink3); white-space:normal; line-height:1.3; max-width:180px; }
.csp .controls .note.msg { color:var(--ink); }
.csp .controls .note.err { color:var(--red); }
.csp .L.entry { left:360px; width:var(--teamw,116px); min-width:var(--teamw,116px); text-align:right; padding:0 10px 0 0; }
.csp td.L.dili.num { color:var(--ink); font-weight:600; }
.csp td.L.num .v { display:grid; grid-template-columns:minmax(0,1fr) auto minmax(0,1fr); align-items:center; height:100%; }
.csp td.L.num .v .n { grid-column:2; }
.csp td.L.num .d { grid-column:3; justify-self:start; width:0; overflow:visible; white-space:nowrap; padding-left:3px; font-size:9px; font-weight:500; letter-spacing:-0.01em; line-height:1; }
.csp td.L.num .d.up { color:var(--green-ink); }
.csp td.L.num .d.down { color:var(--red); }
.csp th.L { z-index:4; background:var(--paper); }
.csp th.L.team { text-align:left; padding-left:12px; }
.csp th.L.entry { cursor:default; }
.csp td.L.num { color:var(--ink2); }
.csp td.L.num.blank { color:var(--ink3); }
.csp td.L.ev.num { color:var(--ink); font-weight:600; }
/* highlights: green on the best five EV / W% / DILI and on a cheap Future; red on a crowded P% */
.csp td.L.num.hi { color:var(--green-ink); }
.csp td.L.num.warn { color:var(--red); }
.csp td.L.wp.num.fin { color:var(--ink3); font-weight:500; }
.csp td.L.num.weak .n::after { content:""; display:inline-block; width:5px; height:5px; border-radius:50%; background:var(--amber); margin-left:4px; vertical-align:2px; }
.csp .team { box-shadow:inset 3px 0 0 var(--tc); }
.csp .team .hd { display:inline-block; width:6px; height:6px; border-radius:50%; margin-left:5px; vertical-align:1px; background:var(--sand-ink); opacity:.7; }
.csp .team .hd.x { background:var(--red); }
.csp .team .used { font-weight:400; color:var(--ink3); font-size:10px; margin-left:6px; }
.csp tr.gone .team .nm { text-decoration:line-through; color:var(--ink3); }
.csp tr.gone .team { box-shadow:inset 3px 0 0 var(--rule2); }

/* week cells: one line, favorite strength as a faint tint */
.csp td.c { width:var(--cw); min-width:var(--cw); height:var(--rh); text-align:center; position:relative; cursor:pointer; user-select:none; color:var(--ink); background:rgba(47,143,62,var(--fav,0)); line-height:1.1; padding-top:1px; }
.csp.ro td.c, .csp td.c.other { cursor:default; }
.csp td.c .sp { display:block; color:var(--ink2); font-size:10px; margin-top:2px; }
.csp td.c .sp.proj { color:var(--ink3); font-style:italic; }
.csp td.c.away { color:var(--ink2); }
.csp td.c.bye { background:var(--panel); cursor:default; }
.csp td.c.dead { color:var(--ink3); text-decoration:line-through; cursor:not-allowed; }
.csp td.c.dead .sp, .csp td.c.dim .sp { color:var(--ink3); text-decoration:none; }
.csp td.c.dim { color:var(--ink3); }
.csp td.c.pick { background:var(--green-bg); color:var(--green-ink); font-weight:600; text-decoration:none; }
.csp td.c.pick .sp { color:var(--green-ink); }
.csp:not(.ro) td.c:not(.bye):not(.dead):hover { box-shadow:inset 0 0 0 2px var(--ink); }
.csp td.c .oth { position:absolute; top:2px; right:4px; font-size:9px; color:var(--ink3); letter-spacing:1px; }
.csp td.c.pick .oth { color:var(--green-ink); }


/* entries panel on top of the board */
.csp .sum td { position:sticky; top:var(--top); z-index:2; background:var(--panel); height:var(--rh); text-align:center; font-weight:500; border-bottom-color:var(--rule); }
.csp .sum td.L { z-index:5; background:var(--panel); }
.csp .sum td.entry { color:var(--ink2); font-weight:500; }
/* an eliminated entry: struck through and faded, still selectable so its history stays readable */
.csp .seg button.out .nm { text-decoration:line-through; text-decoration-thickness:1px; opacity:.6; }
.csp .seg button.out .n { color:var(--red); opacity:.85; }
.csp .sum tr.out td { color:var(--ink3); }
.csp .sum tr.out td > * { opacity:.5; }
.csp .sum tr.out td.entry .nm { text-decoration:line-through; text-decoration-thickness:1px; }
.csp .sum tr.out.sel td > * { opacity:.62; }
.csp .sum td.entry .tag { margin-left:7px; font-size:10px; font-weight:500; color:var(--red); letter-spacing:.01em; }
/* selected entry: the same wash across the row inside a soft blue frame */
.csp .sum tr.sel td { background:var(--sel-bg); border-top:2px solid var(--sel-line); border-bottom:2px solid var(--sel-line); }
.csp .sum tr.sel td.entry { color:var(--ink); font-weight:600; border-left:2px solid var(--sel-line); }
.csp .sum tr.sel td.s:last-child { border-right:2px solid var(--sel-line); }
.csp .sum tr.sel td.curcol { background:var(--sel-bg3); }
.csp .sum tr:has(+ tr.sel) td, .csp .sum tr:has(+ tr.sel) th { border-bottom-color:transparent; }
.csp .sum td.s { width:var(--cw); min-width:var(--cw); }
.csp .sum td.s .chip { display:inline-block; min-width:38px; padding:2px 5px; border-radius:5px; font-size:11px; font-weight:600; line-height:16px; }
.csp .sum td.empty { color:var(--rule2); font-weight:400; }
.csp .sum tr.gap td { height:var(--gap); background:var(--paper); cursor:default; position:sticky; top:calc(var(--th) + var(--n) * var(--rh)); z-index:4; border-bottom:1px solid var(--rule); }
.csp .sum tr.gap td:first-child { left:0; z-index:6; }
.csp .sum tr.hdr2 th { top:calc(var(--th) + var(--n) * var(--rh) + var(--gap)); }
.csp .sum tr.hdr2 th.L { z-index:5; }
.csp .sum tr.top th, .csp .sum tr.top td { border-top:none; }

/* ---- panels: sign-in, audit, editors ---- */
.csp .panel { background:var(--surface); border-top:1px solid var(--rule); border-bottom:1px solid var(--rule); padding:12px 16px; }
.csp .panel .f { font-size:12px; color:var(--ink2); margin-bottom:8px; line-height:1.5; max-width:72ch; }
.csp .panel .f b { color:var(--ink); font-weight:600; }
.csp .panel .f code, .csp .audit .f code { background:var(--panel); padding:1px 5px; border-radius:4px; font-family:inherit; }
.csp .panel input[type=text], .csp .panel input[type=password], .csp .panel input[type=number] { height:32px; font:inherit; font-size:13px; padding:0 10px; border:1px solid var(--rule2); border-radius:8px; background:var(--surface); }
.csp .panel .row { display:flex; gap:8px; margin-top:6px; align-items:center; flex-wrap:wrap; }
.csp .audit { background:var(--surface); border-top:1px solid var(--rule); border-bottom:1px solid var(--rule); padding:14px 16px 16px; max-height:52vh; overflow:auto; }
.csp .audit .secs { display:grid; grid-template-columns:repeat(auto-fit, minmax(300px, 1fr)); gap:10px 32px; margin-bottom:6px; }
.csp .audit .sec p { font-size:12px; color:var(--ink2); line-height:1.5; margin:0 0 6px; max-width:60ch; }
.csp .audit .sec p b { color:var(--ink); font-weight:600; }
.csp .audit .sec code { background:var(--panel); padding:1px 5px; border-radius:4px; font-family:inherit; }
.csp .audit h4 { font-size:12px; font-weight:600; color:var(--ink); margin:0 0 4px; }
.csp .audit h4.th { margin:14px 0 6px; }
.csp .audit .sec .row { display:flex; align-items:center; gap:10px; margin-top:4px; }
.csp .audit .sec .lbl { font-size:12px; color:var(--ink2); }
.csp .audit .map { display:flex; flex-wrap:wrap; gap:4px 6px; margin:2px 0 8px; max-width:60ch; }
.csp .audit .map span { display:inline-flex; align-items:baseline; gap:5px; padding:2px 7px; border-radius:5px; background:var(--panel); font-size:12px; font-weight:600; color:var(--ink); font-variant-numeric:tabular-nums; }
.csp .audit .map span i { font-style:normal; font-weight:500; font-size:11px; color:var(--ink3); }
.csp .audit .map span.hol i { color:var(--ink2); }
.csp .audit .map span.dead { color:var(--red); }
.csp .audit table { border-collapse:collapse; font-size:12px; }
.csp .audit th { position:static; height:auto; padding:6px 10px; background:transparent; color:var(--ink2); font-size:11px; font-weight:500; text-align:right; border:none; border-bottom:1px solid var(--rule2); cursor:default; }
.csp .audit td { padding:0 10px; height:26px; text-align:right; border:none; border-bottom:1px solid var(--rule); color:var(--ink2); }
.csp .audit th:first-child, .csp .audit td:first-child { text-align:left; font-weight:600; color:var(--ink); }
.csp .audit td.fin { font-weight:600; color:var(--ink); }
.csp .audit td.mut { color:var(--ink3); }

/* ---- actuals ---- */
.csp .act { flex:1; min-height:0; overflow:auto; overscroll-behavior:contain; padding:4px 16px 24px; border-top:1px solid var(--rule); background:var(--surface); }
.csp .strip { display:flex; align-items:stretch; gap:0; margin:10px 0 18px; flex-wrap:wrap; }
.csp .strip .fig { padding:6px 28px 6px 0; margin-right:28px; border-right:1px solid var(--rule); }
.csp .strip .fig:last-child { border-right:none; }
.csp .strip .v { font-size:24px; font-weight:600; letter-spacing:-0.01em; line-height:1.1; }
.csp .strip .v.up { color:var(--green-ink); }
.csp .strip .v.sm { font-size:15px; display:flex; gap:12px; align-items:center; flex-wrap:wrap; min-height:26px; }
.csp .strip .v.sm .mut { color:var(--ink3); font-weight:500; }
.csp .mapv .lede { font-size:12px; color:var(--ink2); line-height:1.5; max-width:84ch; margin:0 0 10px; }
.csp .maptabs { display:flex; align-items:flex-end; gap:2px; margin:12px 0 0; border-bottom:1px solid var(--rule); }
.csp .maptabs > button { height:32px; padding:0 14px; font:inherit; font-size:13px; font-weight:500; color:var(--ink2); background:none; border:none; border-bottom:2px solid transparent; margin-bottom:-1px; cursor:pointer; }
.csp .maptabs > button:hover { color:var(--ink); }
.csp .maptabs > button.on { color:var(--ink); border-bottom-color:var(--ink); font-weight:600; }
.csp .maptabs > button.add { font-size:17px; font-weight:400; padding:0 12px; color:var(--ink3); }
.csp .maptabs .tabact { margin-left:auto; display:flex; gap:6px; align-self:center; }
.csp .strip .v.bad { color:var(--red); }
.csp .maptab .pc { display:inline-flex; align-items:center; height:22px; vertical-align:middle; }
.csp .picker { position:relative; display:inline-flex; vertical-align:middle; }
.csp .picker .pk { display:inline-flex; align-items:center; gap:4px; padding:0 3px; margin:0; height:22px; box-sizing:border-box; vertical-align:middle; border:1px solid transparent; border-radius:6px; background:none; font:inherit; cursor:pointer; }
.csp .picker .pk:hover { border-color:var(--rule2); background:var(--surface); }
.csp .picker .pk.bad { border-color:var(--red); }
.csp .picker .pk { position:relative; }
.csp .picker .caret { position:absolute; left:calc(100% + 1px); top:50%; transform:translateY(-50%); font-size:10px; color:var(--ink3); }
.csp .picker .none { font-size:12px; color:var(--ink3); padding:0 6px; }
.csp .picker .pop { position:absolute; z-index:20; top:calc(100% + 4px); left:0; width:250px; max-height:320px; overflow:auto; background:var(--surface); border:1px solid var(--rule2); border-radius:8px; box-shadow:0 8px 24px rgba(0,0,0,.12); padding:4px; text-align:left; }
.csp .picker .opt { display:grid; grid-template-columns:40px 1fr 36px 58px; align-items:center; gap:6px; width:100%; padding:4px 6px; border:none; border-radius:5px; background:none; font:inherit; font-size:12px; color:var(--ink); cursor:pointer; text-align:left; }
.csp .picker .opt:hover { background:var(--panel); }
.csp .picker .opt.on { background:var(--sel-bg); }
.csp .picker .opt .g { color:var(--ink2); }
.csp .picker .opt .w { text-align:right; font-variant-numeric:tabular-nums; }
.csp .picker .opt .wh { font-size:11px; color:var(--red); text-align:right; }
.csp .picker .opt.used .g, .csp .picker .opt.used .w { text-decoration:line-through; color:var(--ink3); }
.csp .picker .opt.used .chip { opacity:.5; }
.csp .picker .opt.empty { grid-template-columns:1fr; border-top:1px solid var(--rule); border-radius:0 0 5px 5px; margin-top:3px; padding-top:7px; color:var(--ink2); }
.csp .maptab tr.conflict td:first-child { box-shadow:inset 3px 0 0 var(--red); }
.csp .maptab tr.conflict td.why { color:var(--red); }
.csp .chip.sm { display:inline-block; min-width:34px; text-align:center; padding:1px 5px; border-radius:4px; font-weight:600; font-size:10.5px; }
.csp .dist.maptab td, .csp .dist.maptab td:first-child { height:var(--mrh,40px); box-sizing:border-box; padding:0 12px; vertical-align:middle; white-space:nowrap; text-align:center; }
.csp .dist.maptab th, .csp .dist.maptab th:first-child { text-align:center; vertical-align:middle; }
.csp .maptab td:nth-child(2) { font-weight:400; }
/* one fixed grid for every map tab: seven columns with set widths (the last takes the rest) and rows of one set
   height, so columns and rows sit in exactly the same place as you switch tabs */
.csp .dist.maptab { table-layout:fixed; width:100%; }
.csp .dist.maptab th:nth-child(1) { width:140px; } .csp .dist.maptab th:nth-child(2) { width:100px; }
.csp .dist.maptab th:nth-child(3) { width:130px; } .csp .dist.maptab th:nth-child(4) { width:64px; }
.csp .dist.maptab th:nth-child(5) { width:104px; } .csp .dist.maptab th:nth-child(6) { width:112px; }
.csp .dist.maptab thead th { height:34px; box-sizing:border-box; }
.csp .dist.maptab tbody tr { height:var(--mrh,40px); }
.csp .dist.maptab td.why { text-align:left; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; color:var(--ink2); line-height:1.45; }
.csp .mapv .strip { height:84px; box-sizing:border-box; overflow:hidden; margin:10px 0 14px; }
.csp .mapv .strip .k { white-space:nowrap; }
.csp .mapv.tight { --mfs:11.5px; }
.csp .mapv.tight .dist.maptab td { font-size:var(--mfs); }
.csp .mapv.tight .chip { padding:2px 6px; font-size:10.5px; }
.csp .mapv.tight .strip .v { font-size:20px; }
.csp .maptab td.weak { color:var(--amber); font-weight:600; }
.csp .maptab td.mut { color:var(--ink3); }
.csp .maptab tr.past td { color:var(--ink3); }
.csp .maptab tr.past .chip { opacity:.55; }
.csp .maptab tr.cur td { background:var(--sel-bg); }
.csp .maptab tr.cur td:first-child { box-shadow:inset 3px 0 0 var(--sel); }
.csp .maptab tr.hol td:first-child { color:var(--sand-ink); font-weight:600; }
.csp .maptab tr.dead td { color:var(--red); }
.csp .strip .k { font-size:12px; color:var(--ink2); margin-top:3px; }
.csp .strip .actions { display:flex; flex-direction:column; gap:6px; justify-content:center; margin-left:auto; }
.csp .legcard { border:1px solid var(--rule); border-radius:10px; margin-bottom:16px; overflow:hidden; }
.csp .legcard .hd2 { display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap; padding:10px 14px; background:var(--paper); border-bottom:1px solid var(--rule); }
.csp .legcard .hd2 .legsel { height:32px; font:inherit; font-size:13px; font-weight:600; color:var(--ink); border:1px solid var(--rule2); border-radius:8px; padding:0 30px 0 12px; cursor:pointer; appearance:none; -webkit-appearance:none; background:var(--surface) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath d='M2.5 4.5l3.5 3.5 3.5-3.5' fill='none' stroke='%2317181C' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") no-repeat right 10px center; }
.csp .legcard .hd2 .legsel:hover { border-color:var(--ink3); }
.csp .legcard .hd2 .m { font-size:12px; color:var(--ink2); }
.csp .legcard .hd2 .m b { color:var(--ink); font-weight:600; }
.csp .dist { width:100%; border-collapse:collapse; font-size:12px; }
.csp .dist th { position:static; height:auto; background:transparent; color:var(--ink2); font-size:11px; font-weight:500; padding:8px 12px; text-align:right; border:none; border-bottom:1px solid var(--rule2); cursor:default; }
.csp .dist th:first-child, .csp .dist td:first-child { text-align:left; }
.csp .dist td { padding:0 12px; height:30px; text-align:right; border:none; border-bottom:1px solid var(--rule); color:var(--ink2); }
.csp .dist td:nth-child(2) { color:var(--ink); font-weight:500; }
.csp .dist .chip { display:inline-block; min-width:44px; text-align:center; padding:3px 7px; border-radius:5px; font-weight:600; font-size:11px; }
.csp .dist .bar { display:inline-block; height:6px; border-radius:3px; vertical-align:middle; background:var(--green); opacity:.55; }
.csp .dist tr.L .bar { background:var(--red); }
.csp .dist tr.P .bar { background:var(--amber); }
.csp .dist .res { font-weight:600; }
.csp .dist tr.W .res { color:var(--green-ink); }
.csp .dist tr.L .res { color:var(--red); }
.csp .dist tr.P .res { color:var(--amber); }
.csp .dist .elim { color:var(--red); }
.csp .chart { border:1px solid var(--rule); border-radius:10px; padding:12px 14px; margin-bottom:16px; flex:0 1 440px; max-width:480px; }
.csp .chart h3 { font-size:12px; color:var(--ink2); margin:0 0 4px; font-weight:500; }
.csp .editor { border:1px solid var(--rule); border-radius:10px; margin-bottom:16px; padding:12px 16px; }
.csp .editor h3 { font-size:14px; font-weight:600; margin:0 0 10px; }
.csp .editor .row { display:flex; gap:12px; align-items:center; flex-wrap:wrap; margin-bottom:10px; font-size:12px; color:var(--ink2); }
.csp .editor label { display:flex; gap:6px; align-items:center; color:var(--ink2); }
.csp .editor input, .csp .editor select { height:28px; font:inherit; font-size:12px; padding:0 8px; border:1px solid var(--rule2); border-radius:6px; background:var(--surface); color:var(--ink); }
.csp .editor input.num { width:84px; text-align:right; }
.csp .editor .grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(200px, 1fr)); gap:6px 16px; margin:8px 0 12px; }
.csp .editor .grid .g { display:flex; gap:6px; align-items:center; font-size:12px; }
.csp .editor .grid .g .chip { display:inline-block; min-width:44px; text-align:center; padding:3px 6px; border-radius:5px; font-weight:600; font-size:11px; }
@media (prefers-reduced-motion: no-preference) { .csp .btn, .csp .ghost, .csp .views button, .csp .seg button { transition:background .12s, border-color .12s, color .12s; } }
/* ---------- phones: everything below applies only under 700px wide, so the desktop layout is untouched ---------- */
@media (max-width: 700px) {
  .csp { height:100dvh; }
  /* top bar: title, views and entries wrap; links go underneath */
  .csp .bar { flex-direction:column; align-items:stretch; gap:6px; padding:10px 12px 8px; }
  .csp .bar .left { gap:8px; flex-wrap:wrap; }
  .csp h1 { font-size:17px; width:100%; }
  .csp .bar .left > .seg { max-width:100%; overflow-x:auto; scrollbar-width:none; }
  .csp .bar .left > .seg::-webkit-scrollbar { display:none; }
  .csp .views button, .csp .seg button { padding:0 10px; }
  .csp .ctl { align-items:flex-start; }
  .csp .ctl .row { min-height:0; flex-wrap:wrap; gap:2px 6px; }
  .csp .link { padding:0 6px 0 0; }

  /* Planner: the five numbers and the team stay pinned and narrower; swipe sideways for the schedule */
  .csp th { font-size:11px; }
  .csp .L.wp { left:0; width:44px; min-width:44px; }
  .csp .L.pp { left:44px; width:42px; min-width:42px; }
  .csp .L.fv { left:86px; width:42px; min-width:42px; }
  .csp .L.ev { left:128px; width:44px; min-width:44px; }
  .csp .L.dili { left:172px; width:46px; min-width:46px; }
  .csp .L.team, .csp .L.entry { left:218px; width:64px !important; min-width:64px !important; max-width:64px; overflow:hidden; text-overflow:ellipsis; }
  .csp .L.team { padding:0 4px 0 8px; }
  .csp .L.entry { padding:0 6px 0 0; font-size:10px; }
  .csp th.L.team { padding-left:8px; }
  .csp .team .used, .csp .team .hd { display:none; }
  .csp .L.pctl { width:218px; min-width:218px; }
  .csp .controls { width:218px; padding:0 8px 0 10px; }
  .csp .controls .ghost, .csp .controls .btn { padding:0 8px; }
  .csp .controls .note { max-width:200px; }
  .csp td.L.num .d { display:none; }
  .csp .audit { padding:12px; max-height:60dvh; }

  /* Map: each week is a short card; the reason wraps underneath */
  .csp .act { padding:4px 12px 20px; }
  .csp .maptabs { overflow-x:auto; flex-wrap:nowrap; scrollbar-width:none; }
  .csp .maptabs::-webkit-scrollbar { display:none; }
  .csp .maptabs > button { flex:none; padding:0 10px; }
  .csp .maptabs .tabact { margin-left:12px; flex:none; }
  .csp .strip { margin:8px 0 12px; gap:8px 0; }
  .csp .strip .fig { flex:1 1 42%; border-right:none; margin-right:0; padding:4px 12px 4px 0; }
  .csp .mapv .strip .fig { flex-basis:100%; }
  .csp .mapv .strip, .csp .mapv.tight .strip { height:auto; overflow:visible; }
  .csp .mapv .strip .k { white-space:normal; }
  .csp .strip .v { font-size:20px; }
  .csp .strip .actions { margin-left:0; flex-direction:row; flex-wrap:wrap; }
  .csp .dist.maptab, .csp .dist.maptab tbody { display:block; width:100%; }
  .csp .dist.maptab thead { display:none; }
  .csp .dist.maptab tr { display:grid; grid-template-columns:84px 76px minmax(0,1fr) 38px 46px; align-items:center; column-gap:6px; row-gap:3px; padding:7px 4px 7px 8px; border-bottom:1px solid var(--rule); }
  .csp .dist.maptab td, .csp .dist.maptab td:first-child { display:block; height:auto; padding:0; border:none; text-align:left; white-space:nowrap; font-size:12px; background:none; box-shadow:none; }
  .csp .dist.maptab td:empty { display:none; }
  .csp .dist.maptab td.bk { grid-column:1 / 3; color:var(--ink3); }
  .csp .dist.maptab td.bk::before { content:"backup "; font-size:11px; }
  .csp .dist.maptab td.why { grid-column:1 / -1; min-width:0; white-space:normal; line-height:1.4; font-size:11.5px; }
  .csp .dist.maptab td.bk + td.why { grid-column:3 / -1; }
  .csp .maptab tr.cur { background:var(--sel-bg); box-shadow:inset 3px 0 0 var(--sel); }
  .csp .maptab tr.conflict { box-shadow:inset 3px 0 0 var(--red); }
  .csp .maptab tr.cur.conflict { box-shadow:inset 3px 0 0 var(--red); }
  .csp .picker .pop { width:min(250px, calc(100vw - 120px)); }
  .csp .maptab tr.cur td:first-child, .csp .maptab tr.conflict td:first-child { box-shadow:none; }
  .csp .dist.maptab tr.past td.why { grid-column:5 / 6; white-space:normal; }
  /* the pinned entry name stays opaque when the schedule slides under it */

  /* Actuals */
  .csp .legcard .hd2 { padding:10px 12px; }
  .csp .legcard { overflow-x:auto; }
  .csp .dist:not(.maptab) th, .csp .dist:not(.maptab) td { padding-left:6px; padding-right:6px; }
  .csp .dist:not(.maptab) tr > :nth-child(4):not(:last-child) { display:none; }   /* the share bar repeats the % column */
  .csp .chart { max-width:100%; flex-basis:100%; padding:10px 12px; }
  .csp .panel input[type=password] { width:100% !important; }
}
`;

const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : null);

export default function CircaSurvivorPlanner() {
  const [files, setFiles] = useState(() => Object.fromEntries(Object.keys(PATHS).map((k) => [k, { json: BUNDLED[k], sha: null }])));
  const filesRef = useRef(files); filesRef.current = files;
  const [token, setToken] = useState(() => { try { return localStorage.getItem(TOKEN_KEY) || ""; } catch { return ""; } });
  const [user, setUser] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [status, setStatus] = useState("");
  const [statusErr, setStatusErr] = useState(false);
  const [active, setActive] = useState(0);
  const [legId, setLegId] = useState(defaultLeg());
  const [sort, setSort] = useState({ key: "dili", dir: 1 }); // key: dili|ev|wp|pp|team|fv|<legId>
  const [view, setView] = useState("planner");
  const [audit, setAudit] = useState(false);
  const [signin, setSignin] = useState(false);
  const [tokenDraft, setTokenDraft] = useState("");
  const [updating, setUpdating] = useState(false);
  const sayTimer = useRef(null);
  const say = (msg, err = false) => {
    setStatus(msg); setStatusErr(err);
    clearTimeout(sayTimer.current);
    if (msg && !err && !/…$/.test(msg)) sayTimer.current = setTimeout(() => setStatus(""), 4000);   // "Saving…"-style messages stay until replaced
  };

  // read the live data files from the repo (falls back to the copies bundled at deploy time)
  const loadAll = async (tok) => {
    const next = {}; let failed = 0;
    await Promise.all(Object.entries(PATHS).map(async ([k, p]) => {
      try { next[k] = await readFile(p, tok); } catch (e) { failed++; }
    }));
    setFiles((prev) => ({ ...prev, ...next }));
    if (failed) say(failed === Object.keys(PATHS).length ? "Showing data from the last deploy (GitHub API unavailable)" : "Some files could not be re-read from GitHub", false);
    return failed;
  };
  useEffect(() => { (async () => { await loadAll(token); setLoaded(true); })(); }, []); // eslint-disable-line
  // once data is in, open on the first week whose results are not final yet
  const jumped = useRef(false);
  useEffect(() => {
    if (!loaded || jumped.current) return; jumped.current = true;
    const open = openLeg(files.actuals.json?.legs);
    if (open !== legId) setLegId(open);
  }, [loaded]); // eslint-disable-line
  useEffect(() => {
    if (!token) { setUser(null); return; }
    let live = true;
    whoAmI(token).then((login) => { if (live) { setUser(login); say(""); } })
      .catch((e) => { if (live) { setUser(null); say("GitHub token rejected: " + e.message, true); } });
    return () => { live = false; };
  }, [token]);

  const data = useMemo(() => buildData({ picks: files.picks.json, actuals: files.actuals.json, odds: files.odds.json, ratings: files.ratings.json, splash: files.splash?.json }), [files.picks, files.actuals, files.odds, files.ratings, files.splash]);
  const entries = data.entries;
  const canEdit = !!user;

  // ---- saving to the repo ----
  const saveTimer = useRef(null);
  const save = async (kind, message) => {
    const f = filesRef.current[kind];
    say("Saving to GitHub…");
    try {
      const sha = await writeFile(PATHS[kind], f.json, f.sha, token, message);
      setFiles((prev) => ({ ...prev, [kind]: { ...prev[kind], sha } }));
      say(`Saved ${fmtTime(new Date().toISOString())}`);
    } catch (e) { say("Save failed: " + e.message, true); }
  };
  const setJson = (kind, fn) => setFiles((prev) => ({ ...prev, [kind]: { ...prev[kind], json: fn(prev[kind].json) } }));
  const setPick = (lg, team) => {
    if (!canEdit) { say("Sign in to change picks", false); return; }
    if (activeOut) { say(`${entry.name} is out — no more picks for it`, false); return; }
    setJson("picks", (p) => ({ ...p, entries: p.entries.map((e, i) => { if (i !== active) return e; const picks = { ...e.picks }; if (picks[lg] === team) delete picks[lg]; else picks[lg] = team; return { ...e, picks }; }) }));
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => save("picks", `Picks: ${entries[active]?.name} ${lg} ${team}`), 800);
  };
  // saved maps (Map tab): same auto-save as picks, on its own timer
  const mapTimer = useRef(null);
  const saveMaps = (fn, message) => {
    if (!canEdit) { say("Sign in to edit maps", false); return; }
    setJson("maps", (m) => fn(m?.maps ? m : { maps: [] }));
    clearTimeout(mapTimer.current);
    mapTimer.current = setTimeout(() => save("maps", message), 800);
  };
  const saveActuals = (json, message) => { setJson("actuals", () => json); setTimeout(() => save("actuals", message), 0); };

  const signIn = () => { const t = tokenDraft.trim(); if (!t) return; try { localStorage.setItem(TOKEN_KEY, t); } catch {} setToken(t); setTokenDraft(""); setSignin(false); };
  const signOut = () => { try { localStorage.removeItem(TOKEN_KEY); } catch {} setToken(""); setUser(null); say("Signed out"); };
  // safety net for GitHub's scheduler: when the owner opens the app and the lines are stale, refresh them (once per visit)
  const autoRan = useRef(false);
  useEffect(() => {
    if (!user || !loaded || autoRan.current || updating) return;
    const age = data.oddsAt ? Date.now() - new Date(data.oddsAt).getTime() : Infinity;
    if (age > 10 * 3600 * 1000) { autoRan.current = true; updateLines(); }
  }, [user, loaded]); // eslint-disable-line
  const updateLines = async () => {
    setUpdating(true);
    try {
      await dispatchWorkflow(token, "update-data.yml");
      say("Line update started on GitHub — reloading data in 90 s…");
      setTimeout(async () => { await loadAll(token); say("Data reloaded"); setUpdating(false); }, 90000);
    } catch (e) { say("Could not start update: " + e.message + (e.status === 403 || e.status === 404 ? " (token needs Actions: read & write)" : ""), true); setUpdating(false); }
  };

  const entry = entries[active] || { name: "", picks: {} };
  const standing = useMemo(() => entries.map((e) => entryStatus(e, data.actuals)), [entries, data.actuals]);
  const activeOut = standing[active] && !standing[active].alive;
  const canPick = canEdit && !activeOut;
  const usedBy = useMemo(() => { const m = {}; for (const [leg, team] of Object.entries(entry.picks)) m[team] = leg; return m; }, [entry]);

  const params = useMemo(() => fitParams(data), [data]);
  const merr = useMemo(() => modelError(data, params), [data, params]);
  // per-team stats for selected leg (also computed on the previous refresh's data, for the deltas)
  const burned = useMemo(() => { const b = spentTeams(data, entry.picks); b.delete(entry.picks[legId]); return b; }, [data, entry, legId]);
  const statsAll = useMemo(() => {
    const cur = computeStats(legId, data, params);
    const map = computeDili(legId, cur.rows, data, burned, params);
    for (const t of ALL_TEAMS) { const r = cur.rows[t]; if (r.dili != null && r.evLo != null && Number.isFinite(r.forfeit)) { r.diliLo = r.evLo / r.forfeit; r.diliHi = r.evHi / r.forfeit; } }
    for (const t of ALL_TEAMS) { const r = cur.rows[t]; if (r.fv == null || burned.has(t)) continue; const f = futureFor(legId, t, data, burned); r.fvRaw = f.raw; r.fvEntry = f.entry; r.fvW = f.w; r.fv = f.blend; }
    const prev = data.prev ? computeStats(legId, data.prev, params) : null;
    if (prev) {
      computeDili(legId, prev.rows, data.prev, burned, params);
      for (const t of ALL_TEAMS) {
        const a = cur.rows[t], b = prev.rows[t];
        a.dEv = a.ev != null && b.ev != null ? a.ev - b.ev : null;
        a.dWin = a.win != null && b.win != null ? a.win - b.win : null;
        a.dPick = !a.act && a.pick != null && b.pick != null ? a.pick - b.pick : null;
        a.dDili = a.dili != null && b.dili != null ? a.dili - b.dili : null;
      }
    }
    // mark the best five in each of the three ranked columns
    const TOP = 5;
    for (const [key, flag] of [["dili", "diliTop"], ["ev", "evTop"], ["win", "winTop"]])
      ALL_TEAMS.filter((t) => cur.rows[t][key] != null).sort((a, b) => cur.rows[b][key] - cur.rows[a][key]).slice(0, TOP).forEach((t) => { cur.rows[t][flag] = true; });
    return { ...cur, map };
  }, [data, legId, params, burned]);
  const { rows: stats, ev: evInfo } = statsAll;
  const prevAt = data.prev?.oddsAt || null;
  const evNote = evInfo.blanked ? `EV unavailable: only ${evInfo.covered}/${evInfo.gamesTotal} games have a Win % (need ${Math.round(EV_MIN_COVERAGE * 100)}%)`
    : evInfo.coverage < 1 ? `EV based on ${evInfo.covered}/${evInfo.gamesTotal} games — teams without a Win % are left out, which flatters the rest` : null;
  // small signed change shown next to a number; hidden when it rounds to nothing
  const Delta = ({ v, kind }) => {
    if (v == null) return null;
    const pts = kind === "ev" ? v : v * 100;
    if (Math.abs(pts) < (kind === "ev" ? 0.005 : kind === "pct1" ? 0.05 : 0.5)) return null;
    const txt = kind === "ev" ? (pts > 0 ? "+" : "−") + Math.abs(pts).toFixed(2).replace(/^0/, "") : kind === "pct1" ? (pts > 0 ? "+" : "−") + Math.abs(pts).toFixed(1) : (pts > 0 ? "+" : "−") + Math.abs(Math.round(pts));
    return <span className={"d " + (pts > 0 ? "up" : "down")}>{txt}</span>;
  };
  // number stays centered in the column; the delta sits in the space to its right
  const Num = ({ children, d, kind }) => <span className="v"><span className="n">{children}</span><Delta v={d} kind={kind} /></span>;
  const diliTip = (st) => {
    if (st.deadLeg) return `Burning this team leaves nothing eligible for ${legLabel(st.deadLeg)}: DILI 0`;
    const swaps = (st.swaps || []).map((p) => `${legLabel(p.leg)} ${p.from} ${pct(p.fromWin)} → ${p.to} ${pct(p.toWin)}`).join(", ");
    const parts = st.forfeitMap != null && st.strengthW > 0 ? ` (map ${st.forfeitMap.toFixed(2)}, strength ${st.forfeitStr.toFixed(2)} at ${Math.round(100 * st.strengthW)}%)` : "";
    return `EV ${st.ev.toFixed(2)} ÷ forfeit ${st.forfeit.toFixed(2)}${parts} = ${st.dili.toFixed(2)}${st.diliLo != null ? ` (likely ${st.diliLo.toFixed(2)}–${st.diliHi.toFixed(2)} at lock (middle half of outcomes))` : ""} · ${swaps ? `burning it changes your map: ${swaps}` : "not on your projected map, so the forfeit is only the chance it turns into a spot later"}${st.dDili != null ? dTip("was", (st.dili - st.dDili).toFixed(2)) : ""}`;
  };
  const dTip = (label, was) => (prevAt ? ` · ${label} ${was} at the previous refresh (${fmtTime(prevAt)})` : "");
  void 0;
  function computeStats(legId, data, params) {
    const act = data.actuals[legId];
    const actTot = act ? Object.values(act.picks).reduce((a, b) => a + b, 0) : 0;
    const modelP = modelPick(legId, data, params), modelRaw = modelPick(legId, data, params, true);
    const hasModel = Object.keys(modelP).length > 0;
    const pick = act ? Object.fromEntries(Object.entries(act.picks).map(([t, n]) => [t, n / actTot])) : modelP;
    const rows = {};
    for (const t of ALL_TEAMS) {
      const mk = marketLine(legId, t, data);          // True Win % (market only) — null if no valid two-sided ML
      const disp = lineFor(legId, t, data);           // spread for display; may be a projection
      rows[t] = { win: mk ? mk.win : null, ml: mk ? mk.ml : null, oppMl: mk ? mk.oppMl : null, status: mk ? mk.status : "none", n: mk ? mk.n : 0, refBook: mk ? mk.refBook : null,
        pick: (act || hasModel) ? (pick[t] ?? (disp ? 0 : null)) : null, spread: disp ? disp.spread : null, proj: disp ? disp.proj : false, pm: modelRaw[t], act: !!act };
    }
    const anchor = splashAnchor(legId, data);
    if (anchor) for (const [t, f] of Object.entries(anchor.final)) { rows[t].win = f === "W" ? 1 : 0; rows[t].final = f; rows[t].status = "final"; }
    if (anchor) { const bl = blendAnchor(anchor, modelRaw, params); for (const t of Object.keys(anchor.shares)) { rows[t].anchor = bl.blended[t]; rows[t].anchorMap = anchor.shares[t]; rows[t].anchorW = bl.w[t]; rows[t].anchorRaw = anchor.raw[t]; rows[t].anchorAlive = anchor.alive; } }
    const ev = computeEV(legId, rows);
    if (anchor) for (const t of Object.keys(anchor.final)) { rows[t].ev = null; rows[t].raw = null; }
    for (const t of ALL_TEAMS) rows[t].fv = data.ratings || act?.fv ? fvAt(legId, t, data) : null;
    if (!act && hasModel) { const rg = modelPickRange(legId, data, params); for (const t of ALL_TEAMS) if (rg[t]) Object.assign(rows[t], { pLo: rg[t].lo, pHi: rg[t].hi, evLo: rg[t].evLo, evHi: rg[t].evHi }); }
    return { rows, ev };
  }

  const sortedTeams = useMemo(() => {
    const k = sort.key, d = sort.dir;
    const val = (t) => {
      if (k === "team") return t;
      if (k === "ev" || k === "wp" || k === "pp" || k === "fv" || k === "dili") { const v = { ev: stats[t].ev, wp: stats[t].win, pp: stats[t].pick, fv: stats[t].fv, dili: stats[t].dili }[k]; return v == null ? -Infinity : v; }
      const ln = lineFor(k, t, data); return ln && ln.spread != null ? -ln.spread : -Infinity; // favorites first
    };
    return [...ALL_TEAMS].sort((a, b) => { const va = val(a), vb = val(b); if (va === vb) return a < b ? -1 : 1; return (va < vb ? 1 : -1) * d; });
  }, [sort, stats, data]);

  // stretch the week columns (and the Future column absorbs the remainder) so the board fills its container
  const wrapRef = useRef(null);
  const [fit, setFit] = useState({ cw: 48, teamw: 116 });
  useEffect(() => {
    const el = wrapRef.current; if (!el) return;
    const LEFT = 360, MIN_CW = 48, MIN_TEAM = 116;
    const measure = () => {
      const w = el.clientWidth - LEFT - MIN_TEAM;
      const cw = Math.max(MIN_CW, Math.floor(w / LEGS.length));
      setFit({ cw, teamw: Math.max(MIN_TEAM, MIN_TEAM + w - cw * LEGS.length) });
    };
    measure();
    const ro = new ResizeObserver(measure); ro.observe(el);
    return () => ro.disconnect();
  }, [view]);
  // on a phone the schedule scrolls sideways under the pinned columns; bring the selected week into view
  useEffect(() => {
    const el = wrapRef.current; if (!el || !window.matchMedia("(max-width: 700px)").matches) return;
    const i = LEGS.findIndex((l) => l.id === legId);
    el.scrollLeft = Math.max(0, (i - 0.5) * fit.cw);
  }, [legId, view, fit.cw]);
  const clickSort = (key) => setSort((s) => (s.key === key ? { key, dir: -s.dir } : { key, dir: key === "team" ? -1 : 1 }));
  const fmtSp = (v) => (v == null ? "" : v > 0 ? "+" + v : v === 0 ? "PK" : String(v));
  const pct = (v) => (v == null ? "–" : Math.round(v * 100) + "%");
  // pick share: one decimal below 10% (posted counts are exact there; model values are rough but read consistently), whole numbers above
  const pctP = (v) => (v == null ? "–" : v < 0.0005 ? "<0.1%" : v < 0.0995 ? (v * 100).toFixed(1) + "%" : Math.round(v * 100) + "%");
  const cur = LEGS.find((l) => l.id === legId);
  const legInfo = data.legs[legId];
  const flags = legInfo ? [legInfo.counts.degraded && `${legInfo.counts.degraded} at 2 books`, legInfo.counts.single && `${legInfo.counts.single} single-book`].filter(Boolean).join(", ") : "";
  const stamp = !legInfo ? "no lines yet for this leg" : !legInfo.games ? `no moneylines yet · look-ahead spreads for ${legInfo.counts.lookahead} games` : `${legInfo.counts.closing === legInfo.games ? "closing lines" : "book consensus"} · ${fmtTime(legInfo.asof)} · ${legInfo.games}/${legInfo.gamesTotal} games${flags ? ` (${flags})` : ""}`;

  const Header = ({ top }) => (
    <>
      {top ? <th className="L entry">Entry</th> : <>
        <th className={"L wp" + (sort.key === "wp" ? " sorted" : "")} onClick={() => clickSort("wp")} title={`True Win % — median of each book's no-vig moneyline probability · ${stamp}`}>W%</th>
        <th className={"L pp" + (sort.key === "pp" ? " sorted" : "")} onClick={() => clickSort("pp")} title="Circa pick popularity: actual once posted; before that the field model, the tooltip shows the middle half of where it could land at Saturday's lock, given line movement and how far the model has missed so far">P%</th>
        <th className={"L fv" + (sort.key === "fv" ? " sorted" : "")} onClick={() => clickSort("fv")} title="Future: about how many strong-favorite weeks this team has left that this entry would use. Half the team's own count and half the count against the teams you still hold, the same split as DILI's forfeit, leaning toward your own cover as the season shortens">Future</th>
        <th className={"L ev" + (sort.key === "ev" ? " sorted" : "") + (evNote ? " partial" : "")} onClick={() => clickSort("ev")} title={(evNote || `EV for ${legLabel(cur)}`) + (prevAt ? ` · small numbers = change since the previous refresh (${fmtTime(prevAt)})` : "")}>EV{evNote ? "*" : ""}</th>
        <th className={"L dili" + (sort.key === "dili" ? " sorted" : "")} onClick={() => clickSort("dili")} title={`DILI — "do I love it?": this week's EV net of what the team is worth to the rest of this entry's season${prevAt ? ` · small numbers = change since ${fmtTime(prevAt)}` : ""}`}>DILI</th>
        <th className={"L team" + (sort.key === "team" ? " sorted" : "")} onClick={() => clickSort("team")}>Team</th>
      </>}
      {LEGS.map((l) => (
        <th key={l.id} className={(l.holiday ? "hol" : "") + (sort.key === l.id ? " sorted" : "") + (l.id === legId ? " curcol" : "")} title={`${legLabel(l)}${l.sub ? ` (${l.sub})` : ""} — click to sort by spread`} onClick={() => clickSort(l.id)}>
          {l.label}
        </th>
      ))}
    </>
  );
  // books contributing to this leg's lines, for the note under the controls
  const lineNote = (() => {
    if (!legInfo) return "No lines yet for this week";
    if (!legInfo.games) return `Look-ahead spreads for ${legInfo.counts.lookahead} games · no moneylines yet`;
    const books = new Set();
    for (const g of Object.values(legInfo.detail)) for (const r of g.rows) if (!r.excluded) books.add(r.book);
    const real = [...books].filter((b) => b !== "nflverse").length;
    if (legInfo.counts.closing) return `Closing lines · ${legInfo.games}/${legInfo.gamesTotal} games`;      // week already played
    return `Lines updated ${fmtTime(legInfo.asof)} · ${real} sportsbook${real === 1 ? "" : "s"}`;
  })();

  return (
    <div className={"csp" + (canPick ? "" : " ro")} onMouseDown={(e) => { if (e.target.closest("button")) e.preventDefault(); }}>
      <style>{CSS}</style>
      <div className="bar">
        <div className="left">
          <h1>Circa Survivor 2026 <span className="ver">v{VERSION}</span></h1>
          <span className="views">
            <button className={view === "planner" ? "on" : ""} onClick={() => setView("planner")}>Planner</button>
            <button className={view === "map" ? "on" : ""} onClick={() => setView("map")} title="This entry's plan for the rest of the season, week by week, with the reasons">Map</button>
            <button className={view === "actuals" ? "on" : ""} onClick={() => setView("actuals")}>Actuals</button>
          </span>
          {view !== "actuals" && <span className="seg">
            {entries.map((e, i) => (
              <button key={i} className={(i === active ? "on" : "") + (standing[i]?.alive === false ? " out" : "")} onClick={() => setActive(i)}
                      title={standing[i]?.alive === false ? `Out in ${legLabel(standing[i].leg)} — still viewable, but no new picks` : "Plan this entry"}>
                <span className="nm">{e.name}</span><span className="n">{standing[i]?.alive === false ? "out" : Object.keys(e.picks).length + "/20"}</span>
              </button>
            ))}
          </span>}
        </div>
        <div className="ctl">
          <div className="row">
            {view !== "planner" && (status || !loaded) && <span className={"note" + (statusErr ? " err" : " msg")}>{!loaded ? "Loading…" : status}</span>}
            <a className="link" href="guide.html" title="Plain-English walkthrough of every number here">How it works</a>
            <a className="link" href="math.html" title="Every projection worked out by hand, with rules of thumb">The math</a>
            {canEdit ? <><span className="who">{user}</span><button className="link" onClick={signOut}>Sign out</button></>
              : <button className="link" onClick={() => setSignin((s) => !s)}>Sign in to edit</button>}
          </div>
        </div>
      </div>

      {signin && !canEdit && (
        <div className="panel">
          <div className="f">
            Viewers can look; only the owner edits. Paste a GitHub <b>fine-grained personal access token</b> for <code>{REPO}</code> with
            <code>Contents: read & write</code> (and <code>Actions: read & write</code> for the "Update lines now" button). It is kept only in this browser.
          </div>
          <div className="row">
            <input type="password" placeholder="github_pat_…" value={tokenDraft} onChange={(e) => setTokenDraft(e.target.value)} onKeyDown={(e) => e.key === "Enter" && signIn()} style={{ width: 320 }} />
            <button className="btn" onClick={signIn}>Sign in</button>
            <button className="ghost" onClick={() => setSignin(false)}>Cancel</button>
          </div>
        </div>
      )}
      {view === "map" && <MapView data={data} params={params} entry={entry} status={standing[active]} canEdit={canEdit} onMaps={saveMaps} maps={(files.maps.json?.maps || []).filter((m) => m.entry === entry.name)} />}
      {view === "actuals" && <Actuals data={data} params={params} canEdit={canEdit} onSave={saveActuals} />}
      {view === "planner" && audit && <AuditPanel legId={legId} data={data} params={params} merr={merr} stats={stats} evNote={evNote} map={statsAll.map} />}
      {view === "planner" && <>

      <div className="wrap" ref={wrapRef} onScroll={(e) => e.currentTarget.classList.toggle("scrolled", e.currentTarget.scrollTop > 2)} style={{ "--n": entries.length, "--cw": fit.cw + "px", "--teamw": fit.teamw + "px" }}>
        <div className="corner">
          <div className="controls">
            <div className="row">
              <select value={legId} onChange={(e) => setLegId(e.target.value)} title="Week to plan">
                {LEGS.map((l) => <option key={l.id} value={l.id}>{legLabel(l)}</option>)}
              </select>
              <button className={"ghost" + (audit ? " on" : "")} onClick={() => setAudit((a) => !a)} title="How W%, P%, EV, DILI and the ratings are calculated for this week">Model details {audit ? "▴" : "▾"}</button>
            </div>
            <div className="row">
              {canEdit && <button className="btn" onClick={updateLines} disabled={updating} title="Pull fresh moneylines from the sportsbooks now (otherwise twice a day)">{updating ? "Updating…" : "Update lines"}</button>}
              <span className={"note" + (status ? (statusErr ? " err" : " msg") : "")} title={!status ? `Lines update automatically twice a day. ${stamp}` : undefined}>{!loaded ? "Loading…" : status || lineNote}</span>
            </div>
          </div>
        </div>
        <table>
          <tbody className="sum">
            <tr className="top" style={{ "--top": "0px" }}>
              <td className="L pctl" colSpan={5} rowSpan={entries.length + 1} />
              <Header top />
            </tr>
            {entries.map((e, i) => (
              <tr key={"s" + i} className={(i === active ? "sel" : "") + (standing[i]?.alive === false ? " out" : "")} style={{ "--top": `calc(var(--th) + ${i} * var(--rh))` }}>
                <td className="L entry" title={standing[i]?.alive === false ? `Out in ${legLabel(standing[i].leg)}` : ""}>
                  <span className="nm">{e.name}</span>{standing[i]?.alive === false && <span className="tag">out {standing[i].leg.label}</span>}
                </td>
                {LEGS.map((l) => {
                  const t = e.picks[l.id];
                  return (
                    <td key={l.id} className={"s" + (t ? "" : " empty") + (l.id === legId ? " curcol" : "")}>{t ? <span className="chip" style={{ background: COLORS[t][0], color: COLORS[t][1] }}>{t}</span> : "·"}</td>
                  );
                })}
              </tr>
            ))}
            <tr className="gap"><td colSpan={6} /> {LEGS.map((l) => <td key={l.id} className={l.id === legId ? "curcol" : ""} />)}</tr>
            <tr className="hdr2"><Header /></tr>
          </tbody>
          <tbody>
            {sortedTeams.map((team) => {
              const usedLeg = usedBy[team];
              const st = stats[team];
              const inLeg = !!OPP[legId][team];
              const pr = (v) => Math.round(100 * v);
              return (
                <tr key={team} className={usedLeg && usedLeg !== legId ? "gone" : ""}>
                  <td className={"L wp num" + (st.win == null ? " blank" : st.final ? " fin" : st.winTop ? " hi" : "") + (st.status === "single" || st.status === "degraded" ? " weak" : "")} title={inLeg ? (st.win == null ? "No two-sided moneyline posted yet for this game" : `${pct(st.win)} — ${STATUS_TEXT[st.status]}${st.status !== "closing" ? ` (${st.n})` : ""} · e.g. ${st.refBook} ${fmtSp(st.ml)} / ${fmtSp(st.oppMl)}${st.dWin != null ? dTip("was", pct(st.win - st.dWin)) : ""}`) : ""}><Num d={st.final ? null : st.dWin} kind="pct">{inLeg ? (st.final ? (st.final === "W" ? "won" : "lost") : pct(st.win)) : ""}</Num></td>
                  <td className={"L pp num" + (st.pick == null ? " blank" : st.pick > 0.099 ? " warn" : "")} title={inLeg ? (st.act ? "Circa actual" : st.anchor != null ? `Splash Thursday reading: ${pctP(st.anchorRaw)} of ${st.anchorAlive.toLocaleString()} entries → ${pctP(st.anchorMap)} by the mapping (Circa ≈ Splash^1.2), blended ${Math.round(100 * st.anchorW)}/${Math.round(100 * (1 - st.anchorW))} with the model's ${pctP(st.pm)} → ${pctP(st.anchor)}` : `field model ${pctP(st.pm)}${st.pLo != null ? ` · likely ${pr(st.pLo)}–${pr(st.pHi)} at lock (middle half of outcomes, given line movement and how far the model has missed so far)` : ""}${st.dPick != null ? dTip("was", pct(st.pick - st.dPick)) : ""}`) : ""}><Num d={st.dPick} kind={st.pick != null && st.pick < 0.0995 ? "pct1" : "pct"}>{inLeg ? pctP(st.pick) : ""}</Num></td>
                  <td className={"L fv num" + (st.fv == null ? " blank" : Math.round(st.fv * 10) / 10 <= 2 ? " hi" : "")} title={st.fv == null ? "No power ratings yet" : st.fvRaw != null ? `About ${st.fv.toFixed(1)} strong-favorite weeks left that this entry would use: ${st.fvRaw.toFixed(1)} for the team on its own, ${st.fvEntry.toFixed(1)} counted against the teams you still hold, blended ${Math.round(100 * st.fvW)}/${Math.round(100 * (1 - st.fvW))}${st.forfeit != null && Number.isFinite(st.forfeit) ? ` · costs this entry ${Math.round(100 * (st.forfeit - 1))}% to spend` : ""}` : `About ${st.fv.toFixed(1)} strong-favorite weeks left after this one (a 75% spot counts ~1, 65% counts ½, 55% a little)`}>
                    <span className="v"><span className="n">{st.fv == null ? "–" : st.fv.toFixed(1)}</span></span>
                  </td>
                  <td className={"L ev num" + (st.ev == null ? " blank" : st.evTop ? " hi" : "")} title={st.ev != null ? `EV ${st.ev.toFixed(2)}${st.evLo != null ? ` · likely ${st.evLo.toFixed(2)}–${st.evHi.toFixed(2)} at lock (middle half of outcomes)` : ""}${st.dEv != null ? dTip("was", (st.ev - st.dEv).toFixed(2)) : ""}` : ""}><Num d={st.dEv} kind="ev">{st.ev == null ? (inLeg ? "–" : "") : st.ev.toFixed(2)}</Num></td>
                  <td className={"L dili num" + (st.dili == null ? " blank" : st.diliTop ? " hi" : "")} title={st.dili == null ? (inLeg ? (usedLeg ? "Already used" : "Needs an EV") : "") : diliTip(st)}>
                    <Num d={st.dDili} kind="ev">{st.dili == null ? (inLeg ? "–" : "") : st.dili.toFixed(2)}</Num>
                  </td>
                  <td className="L team" style={{ "--tc": COLORS[team][0] }}>
                    <span className="nm">{team}</span>
                    {TG_TEAMS.has(team) && <span className="hd" title="Plays in Thanksgiving leg" />}
                    {XM_TEAMS.has(team) && <span className="hd x" title="Plays in Christmas leg" />}
                    {usedLeg && usedLeg !== legId && <span className="used">{LEGS.find((l) => l.id === usedLeg).label}</span>}
                  </td>
                  {LEGS.map((l) => {
                    const g = OPP[l.id][team];
                    const ln = g ? lineFor(l.id, team, data) : null;
                    const pickHere = entry.picks[l.id] === team;
                    const legTaken = !!entry.picks[l.id] && !pickHere;
                    const dead = usedLeg && usedLeg !== l.id;
                    const others = entries.map((e, i) => (i !== active && e.picks[l.id] === team ? i + 1 : null)).filter(Boolean).join("");
                    let cls = "c";
                    if (l.holiday) cls += " hol";
                    if (l.id === legId) cls += " curcol" + (team === sortedTeams[sortedTeams.length - 1] ? " last" : ""); else cls += " other";
                    if (!g) cls += " bye"; else if (pickHere) cls += " pick"; else if (dead) cls += " dead"; else if (legTaken) cls += " dim"; else if (!g.home) cls += " away";
                    const label = !g ? "" : (g.neutral ? "n " : g.home ? "vs " : "@ ") + g.opp;
                    const fav = ln && ln.spread != null && ln.spread < 0 && !dead ? Math.min(1, -ln.spread / 14) : 0;
                    const tip = !g ? `${team} bye` : dead ? `${team} already used (${legLabel(LEGS.find((x) => x.id === usedLeg))})`
                      : `${legLabel(l)}: ${team} ${g.home || g.neutral ? "vs" : "at"} ${g.opp}${g.neutral ? " (neutral)" : ""}${ln ? ` · ${fmtSp(ln.spread)}${ln.market ? ` · ML ${fmtSp(ln.ml)} / ${fmtSp(ln.oppMl)} · True Win ${pct(ln.win)}` : ln.lookahead ? ` · look-ahead line, ${pct(ln.win)} to win (nflverse spread; no moneyline posted yet)` : ln.proj ? ` · projected ${pct(ln.win)} (ratings, not market)` : ""}` : ""}${others ? ` · also picked by entry ${others.split("").join(" and ")}` : ""}${canPick ? "" : activeOut ? " · this entry is out" : " · sign in to change picks"}`;
                    return (
                      <td key={l.id} className={cls} title={tip} style={fav > 0 && !pickHere ? { "--fav": (0.03 + 0.15 * fav).toFixed(3) } : undefined} onClick={() => g && !dead && l.id === legId && setPick(l.id, team)}>
                        {label}
                        {ln && <span className={"sp" + (ln.proj ? " proj" : "")}>{ln.spread != null ? fmtSp(ln.spread) : ln.market ? "ML " + fmtSp(ln.ml) : ""}</span>}
                        {others && <span className="oth" title={`Also picked by entry ${others.split("").join(" and ")}`}>{others}</span>}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      </>}
    </div>
  );
}

// ---------- Model details panel ----------
function AuditPanel({ legId, data, params, merr, stats, evNote, map }) {
  const act = data.actuals[legId];
  const leg = data.legs[legId] || {};
  const av = availability(legId, data);
  const mlTxt = (v) => (v == null ? "" : v > 0 ? "+" + v : String(v));
  const teams = Object.keys(OPP[legId]).filter((t) => stats[t].win != null).sort((a, b) => (stats[b].dili ?? -1) - (stats[a].dili ?? -1) || (stats[b].pick || 0) - (stats[a].pick || 0));
  const pc = (v, d = 0) => (v == null ? "–" : (100 * v).toFixed(d) + "%");
  return (
    <div className="audit">
      <div className="secs">
        <div className="sec">
          <h4>True Win %</h4>
          {leg.games ? <p>Each book's moneyline is de-vigged on its own; the consensus is the median of the books' home-win chances, away = 1 − home. {leg.games}/{leg.gamesTotal} games as of {fmtTime(leg.asof)}. Books asked: {(leg.books || []).map((b) => BOOK_NAME[b] || b).join(", ")}. 3+ books normal, 2 degraded, 1 single-book. Quotes taken after kickoff or 48 h staler than the freshest are left out.</p>
            : <p>No moneylines for this week yet. Books post them about a week out.{leg.counts?.lookahead ? ` Until then, ${leg.counts.lookahead} games carry a look-ahead spread from nflverse, which gives a win chance for planning but not a True Win %.` : ""}</p>}
          {evNote && <p><b>EV coverage.</b> {evNote}.</p>}
        </div>
        <div className="sec">
          <h4>P% — pick popularity</h4>
          {act ? <p>Locked week: P% is Circa's posted distribution.</p>
            : <p>Field model <code>win^{params.a} × e^(−{params.b} × future value) × e^(−{params.c ?? 0} × holiday pressure) × availability</code>, normalized over favored teams. Fit on {params.legs} week{params.legs === 1 ? "" : "s"} of Circa actuals, weighting each team's miss by its share{merr ? <>; average miss so far {pc(merr.err)} per team</> : null}. Holiday pressure is how scarce an upcoming holiday pool is and how close it is; with {params.c ? "the weight the data has chosen" : "the weight still at zero, since nothing in the data yet says the field is saving holiday teams"}. The fit uses each past week's future values as they stood at that week's lock, not today's.{(() => { const an = splashAnchor(legId, data); return an ? ` Splash's Thursday reading for this week: ${Object.entries(an.raw).map(([t, v]) => `${t} ${(100 * v).toFixed(1)}%`).join(", ")} of ${an.alive.toLocaleString()} entries, mapped to ${Object.entries(an.shares).map(([t, v]) => `${t} ${(100 * v).toFixed(0)}%`).join(", ")} (Circa ≈ Splash^${an.gamma}), then blended with the model by how wrong each has been so far (mapping ×${Math.exp(an.err.top).toFixed(2)} on the top pick over ${an.err.nTop} weeks, model ×${Math.exp(params.errTop ?? 0.1).toFixed(2)}), and the rest of the field is scaled to fit${Object.keys(an.final).length ? `; the Thursday game is final (${Object.entries(an.final).map(([t, f]) => `${t} ${f === "W" ? "won" : "lost"}`).join(", ")})` : ""}.` : ""; })()} The P% band re-runs the model over line movement and the model's own misses so far: a factor of about ×{Math.exp(params.errTop ?? 0.1).toFixed(2)} on its top pick and ×{Math.exp(params.errOther ?? 0.35).toFixed(2)} on everyone else, measured on {params.nTop ?? 0} weeks.</p>}
        </div>
        <div className="sec">
          <h4>DILI — do I love it?</h4>
          <p>EV divided by the forfeit. The forfeit blends two things. The map part is what spending the team does to this entry's map: the best way to fill every remaining week, holidays included, with distinct teams it still holds, scored by the chance of winning them all, re-solved without the team; the last eligible team for a holiday reads 0. It is solved {MAP_SAMPLES} times over projections jiggled by how wrong they usually are that far out, with the next {NEAR_LEGS} weeks scored by projected EV. The strength part grows with future value, because the map assumes the plan holds and strong spots are what you reach for when it does not; it is sized to the map part's average and weighs {Math.round(100 * strengthWeight(legId))}% this week, fading to nothing by the last week. Green marks this entry's best five.</p>

          <p>The Map tab shows this rule applied week by week (Claude's DILI Map) and the plan the 96 jiggled seasons agree on (Claude's 96 Map).</p>
        </div>
        <div className="sec">
          <h4>Future value and ratings</h4>
          <p>Future value is the expected number of strong-favorite weeks left: each later week counts by how much it looks like a strong spot (about 1 at 75%, ½ at 65%, a little at 55%). Ratings: {data.ratingsSrc || "none"}{data.ratingsAt ? <>, updated {fmtTime(data.ratingsAt)}</> : null}. Projections never feed W%.</p>
        </div>
      </div>
      <h4 className="th">This week, by team</h4>
      <table>
        <thead><tr><th>Team</th><th>ML</th><th>Win</th><th>Future</th><th>Field holding</th><th>Model P%</th><th>Final P%</th><th>EV</th><th>Forfeit</th><th>DILI</th></tr></thead>
        <tbody>
          {teams.map((t) => (
            <tr key={t}>
              <td>{t}</td>
              <td className="mut">{stats[t].ml != null ? `${mlTxt(stats[t].ml)} / ${mlTxt(stats[t].oppMl)}` : "–"}</td>
              <td>{pc(stats[t].win)}</td>
              <td>{stats[t].fv == null ? "–" : stats[t].fv.toFixed(1)}</td>
              <td title="share of the live field that has not used this team yet">{pc(av[t])}</td>
              <td className="mut">{pc(stats[t].pm, 1)}</td>
              <td>{pc(stats[t].pick, 1)}</td>
              <td>{stats[t].ev == null ? "–" : stats[t].ev.toFixed(2)}</td>
              <td className="mut" title={(stats[t].forfeitMap != null ? `map ${stats[t].forfeitMap.toFixed(3)} · strength ${stats[t].forfeitStr.toFixed(3)} at ${Math.round(100 * stats[t].strengthW)}%` : "") + ((stats[t].swaps || []).length ? " · " + stats[t].swaps.map((p) => `${legLabel(p.leg)} ${p.from} → ${p.to}`).join(", ") : "")}>{stats[t].forfeit == null ? "–" : stats[t].forfeit === Infinity ? "∞" : stats[t].forfeit.toFixed(3)}</td>
              <td className="fin">{stats[t].dili == null ? "–" : stats[t].dili.toFixed(2)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {leg.detail && Object.keys(leg.detail).length > 0 && <>
        <h4 className="th">Market detail by game</h4>
        <table>
          <thead><tr><th>Game</th><th>Consensus (home)</th><th>Status</th><th>Book</th><th>Home / away ML</th><th>Book no-vig (home)</th><th>Quoted</th><th>Note</th></tr></thead>
          <tbody>
            {Object.values(leg.detail).sort((a, b) => (a.kickoff || "").localeCompare(b.kickoff || "")).flatMap((g) => g.rows.map((r, i) => (
              <tr key={g.key + r.book}>
                <td>{i === 0 ? `${g.away} @ ${g.home}` : ""}</td>
                <td className={i === 0 ? "fin" : "mut"}>{i === 0 ? (g.pHome == null ? "–" : `${g.home} ${pc(g.pHome, 1)}`) : ""}</td>
                <td className="mut">{i === 0 ? `${STATUS_TEXT[g.status]}${g.status !== "closing" && g.status !== "none" ? ` (${g.valid})` : ""}` : ""}</td>
                <td className={r.excluded ? "mut" : ""}>{r.name}</td>
                <td className={r.excluded ? "mut" : ""}>{r.ml != null ? `${mlTxt(r.ml)} / ${mlTxt(r.oppMl)}` : "–"}</td>
                <td className={r.excluded ? "mut" : ""}>{r.pHome == null ? "–" : pc(r.pHome, 1)}</td>
                <td className="mut">{r.asof ? fmtTime(r.asof) : "–"}</td>
                <td className="mut">{r.excluded ? `excluded: ${r.excluded}` : ""}</td>
              </tr>
            )))}
          </tbody>
        </table>
      </>}
    </div>
  );
}

// ---------- Actuals tab ----------
// The Map tab: one entry's whole season, from the same map that prices DILI.
const pct0 = (v) => (v == null ? "–" : Math.round(100 * v) + "%");
function mapWhy(p) {
  if (!p.team) return "Nothing eligible left for this week: it would be a forfeit.";
  const parts = [];
  const gap = p.backup ? p.win - p.backupWin : 1, loss = p.cost ? 1 - 1 / p.cost : 0;
  const lossTxt = loss < 0.01 ? "under 1%" : Math.round(100 * loss) + "%";
  if (!p.backup) parts.push(`No backup: spending ${p.team} elsewhere leaves nothing for this week.`);
  else if (p.win < 0.6) parts.push(`Coin-flip week: ${pct0(p.win)} is the best left, ${p.backup} ${pct0(p.backupWin)} next.`);
  else if (gap >= 0.08) parts.push(`Best spot left for ${p.team}. Without them this week falls to ${p.backup} at ${pct0(p.backupWin)}, and the map loses ${lossTxt}.`);
  else if (loss < 0.02) parts.push(`Plenty of cover: spending ${p.team} elsewhere costs the map ${lossTxt}.`);
  else parts.push(`${p.backup} covers it at ${pct0(p.backupWin)}; spending ${p.team} elsewhere costs the map ${lossTxt}.`);
  if (p.pool) parts.push(`You still have ${p.poolLeft} of the ${p.pool} teams that can play it.`);
  if (p.fieldHold != null && p.fieldHold < 0.5) parts.push("Most of the field has already used them, so it's a quiet pick.");
  else if (p.fieldPick > 0.3) parts.push(`Crowded: about ${pct0(p.fieldPick)} of the field projected on them.`);
  return parts.join(" ");
}
const teamChip = (t, sm) => <span className={"chip" + (sm ? " sm" : "")} style={{ background: COLORS[t][0], color: COLORS[t][1] }}>{t}</span>;
const shortLeg = (l) => (l.label === l.id ? l.id : "W" + l.label);
function gameText(legId, t, data) {
  const g = OPP[legId]?.[t]; if (!g) return "";
  const ln = lineFor(legId, t, data);
  return `${g.home ? "vs" : g.neutral ? "n" : "@"} ${g.opp}${ln?.spread != null ? ` ${ln.spread > 0 ? "+" : ""}${ln.spread}` : ""}`;
}
// A saved map's picks against the weeks still open: win chances, duplicates, and the three boxes.
export function customSummary(data, entry, map, res) {
  const spentAt = {};
  for (const l of LEGS) { const t = entry.picks[l.id]; if (t && data.actuals[l.id] && !res.plan.some((p) => p.leg.id === l.id)) spentAt[t] = l; }
  const rows = res.plan.map((p) => { const team = map.picks[p.leg.id] || null; return { leg: p.leg, team, win: team ? lineFor(p.leg.id, team, data)?.win ?? null : null }; });
  const where = {}; rows.forEach((r) => { if (r.team) (where[r.team] ||= []).push(r.leg); });
  for (const r of rows) {
    if (!r.team) continue;
    r.also = where[r.team].filter((l) => l.id !== r.leg.id);
    r.spent = spentAt[r.team] || null;
    r.conflict = r.also.length > 0 || !!r.spent;
  }
  const conflicts = rows.filter((r) => r.conflict).length, empty = rows.filter((r) => !r.team).length;
  const filled = rows.filter((r) => r.team && r.win != null);
  const now = res.plan[0]?.leg || null;
  const later = new Set(rows.slice(1).map((r) => r.team).filter(Boolean));
  const cheap = !now ? [] : Object.keys(OPP[now.id]).filter((t) => !spentAt[t] && !later.has(t) && (lineFor(now.id, t, data)?.win ?? 0) >= 0.55)
    .map((t) => ({ team: t, win: lineFor(now.id, t, data).win })).sort((a, b) => b.win - a.win).slice(0, 3);
  return {
    rows, now, cheap, conflicts, empty,
    winOut: conflicts || empty ? null : filled.reduce((x, r) => x * r.win, 1),
    winNote: conflicts ? `${conflicts} week${conflicts === 1 ? "" : "s"} in conflict` : empty ? `${empty} week${empty === 1 ? "" : "s"} with no pick` : null,
    weakest: [...filled].sort((a, b) => a.win - b.win).slice(0, 3),
    usedAt: (t, legId) => { const o = (where[t] || []).filter((l) => l.id !== legId); return spentAt[t] ? `used ${shortLeg(spentAt[t])}` : o.length ? `in ${o.map(shortLeg).join(", ")}` : null; },
  };
}
// Pick control for a saved map: the team chip plus a short list of that week's teams by win %, anything already
// on the map or spent crossed out but still pickable.
function PickPicker({ legId, team, data, usedAt, onPick, canEdit, conflict }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const out = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    const esc = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", out); document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", out); document.removeEventListener("keydown", esc); };
  }, [open]);
  const opts = Object.keys(OPP[legId]).map((t) => ({ t, win: lineFor(legId, t, data)?.win ?? null })).sort((a, b) => (b.win ?? 0) - (a.win ?? 0));
  if (!canEdit) return <span className="pc">{team ? teamChip(team) : <span className="mut">–</span>}</span>;
  return (
    <span className="picker pc" ref={ref}>
      <button className={"pk" + (conflict ? " bad" : "")} onClick={() => setOpen((o) => !o)} title="Change this week's pick">
        {team ? teamChip(team) : <span className="none">pick</span>}<span className="caret">▾</span>
      </button>
      {open && <div className="pop" role="listbox">
        {opts.map((o) => { const w = usedAt(o.t, legId); return (
          <button key={o.t} className={"opt" + (w ? " used" : "") + (o.t === team ? " on" : "")} onClick={() => { onPick(o.t); setOpen(false); }}>
            {teamChip(o.t, true)}<span className="g">{gameText(legId, o.t, data)}</span><span className="w">{pct0(o.win)}</span><span className="wh">{w || ""}</span>
          </button>); })}
        <button className={"opt empty" + (team ? "" : " on")} onClick={() => { onPick(null); setOpen(false); }} title="Leave this week open for now"><span className="g">Empty</span></button>
      </div>}
    </span>
  );
}
function MapView({ data, params, entry, status, maps, canEdit, onMaps }) {
  const dili = useMemo(() => diliPlan(data, entry.picks, params), [data, entry, params]);
  const cons = useMemo(() => consensusPlan(data, entry.picks, params), [data, entry, params]);
  const [tab, setTab] = useState("dili");
  const custom = maps.find((m) => m.id === tab) || null;
  const cs = useMemo(() => (custom ? customSummary(data, entry, custom, dili) : null), [data, entry, custom, dili]);
  if (status && !status.alive) return <div className="act mapv"><p className="lede">{entry.name} is out ({legLabel(status.leg)}). Nothing left to map.</p></div>;
  const res = tab === "96" ? cons : dili;
  const planned = Object.fromEntries(res.plan.map((p) => [p.leg.id, p]));
  const planWeek = Object.fromEntries(res.plan.filter((p) => p.team).map((p) => [p.team, p.leg]));
  const nowId = dili.currentLeg?.id;
  const create = () => {
    const name = window.prompt("Name this map", `Map ${maps.length + 1}`); if (!name?.trim()) return;
    const id = Date.now().toString(36);
    const picks = Object.fromEntries(dili.plan.filter((p) => p.team).map((p) => [p.leg.id, p.team]));
    onMaps((m) => ({ maps: [...m.maps, { id, name: name.trim(), entry: entry.name, picks }] }), `Map: new "${name.trim()}" for ${entry.name}`);
    setTab(id);
  };
  const rename = () => {
    const name = window.prompt("Rename this map", custom.name); if (!name?.trim() || name.trim() === custom.name) return;
    onMaps((m) => ({ maps: m.maps.map((x) => (x.id === custom.id ? { ...x, name: name.trim() } : x)) }), `Map: rename "${custom.name}" to "${name.trim()}"`);
  };
  const remove = () => {
    if (!window.confirm(`Delete the map "${custom.name}"?`)) return;
    onMaps((m) => ({ maps: m.maps.filter((x) => x.id !== custom.id) }), `Map: delete "${custom.name}"`);
    setTab("dili");
  };
  const setMapPick = (legId, team) => onMaps((m) => ({ maps: m.maps.map((x) => { if (x.id !== custom.id) return x; const picks = { ...x.picks }; if (team) picks[legId] = team; else delete picks[legId]; return { ...x, picks }; }) }), `Map "${custom.name}": ${legId} ${team || "empty"}`);

  const box = custom
    ? { winOut: cs.winOut, winNote: cs.winNote, weakest: cs.weakest, cheapLeg: cs.now,
        cheap: cs.cheap.map((f) => <span key={f.team} title={`${f.team} is ${pct0(f.win)} to win this week and is not used later in this map`}>{teamChip(f.team, true)} <span className="mut">({pct0(f.win)})</span></span>),
        cheapCap: (lg) => `free to burn in ${lg} under this map: favorites (win %) it does not use later` }
    : tab === "96"
    ? { winOut: cons.winOut, weakest: cons.weakest, cheapLeg: cons.nowLeg,
        cheap: cons.free.map((f) => <span key={f.team} title={`${f.team} is ${pct0(f.win)} to win this week and gets used in a later week in ${Math.round(100 * f.onMap)}% of the ${cons.samples} seasons`}>{teamChip(f.team, true)} <span className="mut">({pct0(f.win)})</span> {pct0(f.onMap)}</span>),
        cheapCap: (lg) => `cheapest to burn in ${lg}: team (win %) and the chance a later week needs them` }
    : { winOut: dili.winOut, weakest: dili.weakest, cheapLeg: dili.currentLeg,
        cheap: dili.cheap.map((f) => <span key={f.team} title={`${f.team} is ${pct0(f.win)} to win this week; spending them costs this entry ${Math.round(100 * (f.forfeit - 1))}%`}>{teamChip(f.team, true)} <span className="mut">({pct0(f.win)})</span> {Math.round(100 * (f.forfeit - 1))}%</span>),
        cheapCap: (lg) => `cheapest to burn in ${lg}: team (win %) and what spending them costs this entry` };
  const pastRow = (l) => {
    const a = data.actuals[l.id], mine = entry.picks[l.id];
    const r = !mine ? "No pick" : a.won.includes(mine) ? "Won" : a.lost.includes(mine) ? "Lost" : "In progress";
    return <tr key={l.id} className="past"><td>{legLabel(l)}</td><td><span className="pc">{mine ? teamChip(mine) : "–"}</span></td><td>{mine ? gameText(l.id, mine, data) : ""}</td><td>{mine ? pct0(lineFor(l.id, mine, data)?.win) : ""}</td><td></td><td></td><td className="why">{r}</td></tr>;
  };
  const holidayNote = (p) => (p.pool ? ` You still have ${p.poolLeft} of the ${p.pool} teams that can play it.` : "");
  // every map has one row per week, so size the rows to the space left under the tabs and the boxes: no page scroll when it fits
  const boxRef = useRef(null); const [rh, setRh] = useState(40);
  useEffect(() => {
    const el = boxRef.current; if (!el) return;
    const measure = () => { const tb = el.querySelector(".maptab"); if (!tb) return; const top = tb.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop; const avail = el.clientHeight - top - (tb.tHead?.offsetHeight || 0) - LEGS.length - 28; setRh(Math.max(26, Math.min(44, Math.floor(avail / LEGS.length)))); };
    measure(); const ro = new ResizeObserver(measure); ro.observe(el); return () => ro.disconnect();
  }, [tab, maps.length]);
  return (
    <div className={"act mapv" + (rh < 34 ? " tight" : "")} ref={boxRef} style={{ "--mrh": rh + "px" }}>
      <div className="maptabs">
        <button className={tab === "dili" ? "on" : ""} onClick={() => setTab("dili")} title="The Planner's pick each week, applied forward as if nothing changes">Claude's DILI Map</button>
        <button className={tab === "96" ? "on" : ""} onClick={() => setTab("96")} title="The plan the 96 jiggled seasons agree on">Claude's 96 Map</button>
        {maps.map((m) => <button key={m.id} className={custom?.id === m.id ? "on" : ""} onClick={() => setTab(m.id)}>{m.name}</button>)}
        {canEdit && <button className="add" onClick={create} title="New map, starting from Claude's DILI Map">+</button>}
        {custom && canEdit && <span className="tabact"><button className="link" onClick={rename}>Rename</button><button className="link" onClick={remove}>Delete</button></span>}
      </div>
      <div className="strip">
        <div className="fig"><div className={"v" + (box.winOut == null && box.winNote ? " bad" : "")}>{box.winOut != null ? (100 * box.winOut).toFixed(1) + "%" : box.winNote ? "not valid" : "–"}</div><div className="k">{box.winOut == null && box.winNote ? box.winNote : "chance of winning every week on this map"}</div></div>
        <div className="fig"><div className="v sm">{box.weakest.map((p) => <span key={p.leg.id}>{shortLeg(p.leg)} {pct0(p.win)}</span>)}</div><div className="k">weakest weeks, where the entry most likely dies</div></div>
        {box.cheapLeg && <div className="fig"><div className="v sm">{box.cheap.length ? box.cheap : "none"}</div><div className="k">{box.cheapCap(legLabel(box.cheapLeg))}</div></div>}
      </div>
      <table className="dist maptab">
        <thead>{custom
          ? <tr><th>Week</th><th>Pick</th><th>Game</th><th>Win</th><th></th><th></th><th>Notes</th></tr>
          : tab === "96"
          ? <tr><th>Week</th><th>Pick</th><th>Game</th><th>Win</th><th title={`How many of ${cons.samples} jiggled seasons put this team here`}>Held</th><th title="Runner-up by count, not used elsewhere on this map">Backup</th><th>Why</th></tr>
          : <tr><th>Week</th><th>Pick</th><th>Game</th><th>Win</th><th title="DILI for that week, scored as the Planner scores it">DILI</th><th title="Second-best DILI that week">Backup</th><th>Why</th></tr>}</thead>
        <tbody>
          {LEGS.map((l) => {
            const p = planned[l.id];
            if (data.actuals[l.id] && !p) return pastRow(l);
            if (!p) return null;
            const cls = (l.holiday ? "hol" : "") + (l.id === nowId ? " cur" : "");
            if (custom) {
              const r = cs.rows.find((x) => x.leg.id === l.id);
              const note = !r.team ? "No pick yet." : r.spent ? `Conflict: already used in ${legLabel(r.spent)}.` : r.also.length ? `Conflict: also in ${r.also.map(legLabel).join(", ")}.` : r.win != null && r.win < 0.6 ? "Coin-flip week." : "";
              return (
                <tr key={l.id} className={cls + (r.conflict ? " conflict" : "")}>
                  <td>{legLabel(l)}</td>
                  <td><PickPicker legId={l.id} team={r.team} data={data} usedAt={cs.usedAt} onPick={(t) => setMapPick(l.id, t)} canEdit={canEdit} conflict={r.conflict} /></td>
                  <td>{r.team ? gameText(l.id, r.team, data) : ""}</td>
                  <td className={r.win != null && r.win < 0.6 ? "weak" : ""}>{pct0(r.win)}</td>
                  <td></td><td></td>
                  <td className="why" title={note}>{note}</td>
                </tr>
              );
            }
            const mine = entry.picks[l.id];
            const soft = mine && mine !== p.team ? ` You have ${mine} entered for this week; this map would use ${mine} ${planWeek[mine] ? "in " + legLabel(planWeek[mine]) : "nowhere"}.` : "";
            let why;
            if (!p.team) why = "Nothing eligible left for this week: it would be a forfeit.";
            else if (tab === "96") why = (p.held >= cons.samples / 2 ? "Solid." : p.held >= cons.samples / 3 ? "Leaning." : "Toss-up.") + holidayNote(p) + soft;
            else why = (p.backup == null ? "Only option." : p.dili - p.backupDili < 0.03 ? `Close call, ${p.backup} is ${(p.dili - p.backupDili).toFixed(2)} behind.` : `Clear, ${(p.dili - p.backupDili).toFixed(2)} ahead of ${p.backup}.`) + (p.ev ? "" : " Scored on win chance; no field model this far out.") + holidayNote(p) + soft;
            return (
              <tr key={l.id} className={cls + (p.team ? "" : " dead")}>
                <td>{legLabel(l)}</td>
                <td><span className="pc">{p.team ? teamChip(p.team) : "–"}</span></td>
                <td>{p.team ? gameText(l.id, p.team, data) : ""}</td>
                <td className={p.win != null && p.win < 0.6 ? "weak" : ""}>{pct0(p.win)}</td>
                <td>{tab === "96" ? (p.team ? `${p.held}/${p.samples}` : "") : (p.dili != null ? p.dili.toFixed(2) : "")}</td>
                <td className="bk">{p.backup ? <>{teamChip(p.backup, true)} {tab === "96" ? `${p.backupHeld}/${p.samples}` : p.backupDili.toFixed(2)}</> : "–"}</td>
                <td className="why" title={why}>{why}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
function Actuals({ data, params, canEdit, onSave }) {
  const { entries, contest, actuals } = data;
  const tl = fieldTimeline(data);
  const last = tl[tl.length - 1];
  const [selLeg, setSelLeg] = useState(last ? last.leg.id : null);
  const [editing, setEditing] = useState(null); // leg id being edited, or "contest"
  useEffect(() => { if (selLeg == null && last) setSelLeg(last.leg.id); }, [last, selLeg]);
  // Jamie's entries: alive unless a completed leg's pick lost (or no pick was made for a completed leg)
  const alive = entries.map((e) => tl.every((r) => { const t = e.picks[r.leg.id]; return t && !actuals[r.leg.id].lost.includes(t); }));
  const nAlive = alive.filter(Boolean).length;
  const value0 = contest.start ? contest.pool / contest.start : 0;
  const equityNow = last ? nAlive * contest.share * last.value : entries.length * contest.share * value0;
  const equity0 = entries.length * contest.share * value0;
  const money = (v) => "$" + Math.round(v).toLocaleString();
  const num = (v) => v.toLocaleString();
  const pctOf = (n, d) => (d ? (100 * n / d).toFixed(n / d < 0.01 ? 2 : 1) + "%" : "–");
  const name = (t) => (t === "NOPICK" ? "No pick" : t);
  const nextLeg = LEGS.find((l) => !actuals[l.id]);

  // series for chart: live entries per leg + equity
  const pts = [{ x: "Start", live: contest.start, eq: equity0 }, ...tl.map((r, i) => ({ x: r.leg.label, live: r.after, eq: entries.reduce((s, e) => s + (tl.slice(0, i + 1).every((q) => e.picks[q.leg.id] && !actuals[q.leg.id].lost.includes(e.picks[q.leg.id])) ? 1 : 0), 0) * contest.share * r.value }))];

  return (
    <div className="act">
      <div className="strip">
        <div className="fig"><div className="v">{num(contest.start)}</div><div className="k">entries started, {money(contest.pool)} pool</div></div>
        <div className="fig"><div className="v">{num(last ? last.after : contest.start)}</div><div className="k">still alive{last ? `, ${pctOf(contest.start - last.after, contest.start)} out` : ""}</div></div>
        <div className="fig"><div className="v">{money(last ? last.value : value0)}</div><div className="k">implied value per entry</div></div>
        <div className="fig"><div className={"v" + (equityNow > equity0 ? " up" : "")}>{money(equityNow)}</div><div className="k">your equity, {nAlive} of {entries.length} alive</div></div>
        {canEdit && <div className="actions">
          {nextLeg && <button className="btn" onClick={() => setEditing(nextLeg.id)}>Enter {legLabel(nextLeg)} results</button>}
          <div style={{ display: "flex", gap: 6 }}>
            {selLeg && <button className="ghost" onClick={() => setEditing(selLeg)}>Edit {legLabel(LEGS.find((l) => l.id === selLeg))}</button>}
            <button className="ghost" onClick={() => setEditing("contest")}>Contest size</button>
          </div>
        </div>}
      </div>

      {editing === "contest" && <ContestEditor contest={contest} onCancel={() => setEditing(null)}
        onSave={(c) => { onSave({ contest: c, legs: actuals }, "Actuals: contest size"); setEditing(null); }} />}
      {editing && editing !== "contest" && <LegEditor legId={editing} current={actuals[editing]} onCancel={() => setEditing(null)}
        onSave={(legData) => { onSave({ contest, legs: { ...actuals, [editing]: legData } }, `Actuals: ${legLabel(LEGS.find((l) => l.id === editing))}`); setSelLeg(editing); setEditing(null); }} />}

      {pts.length > 1 && <Chart pts={pts} money={money} num={num} start={contest.start} />}

      {tl.filter((r) => r.leg.id === selLeg).map((r) => {
        const a = actuals[r.leg.id];
        const tot = Object.values(a.picks).reduce((x, y) => x + y, 0);
        const rows = Object.entries(a.picks).sort((x, y) => y[1] - x[1]);
        const max = rows.length ? rows[0][1] : 1;
        const st = (t) => (a.lost.includes(t) ? "L" : a.pending.includes(t) ? "P" : a.won.includes(t) ? "W" : "");
        const mp = modelPick(r.leg.id, data, params);
        const hasM = Object.keys(mp).length > 0;
        const fp = (v) => (v == null ? "" : v < 0.005 ? "<1%" : (100 * v).toFixed(v < 0.1 ? 1 : 0) + "%");
        return (
          <div className="legcard" key={r.leg.id}>
            <div className="hd2">
              <select className="legsel" value={selLeg} onChange={(e) => setSelLeg(e.target.value)}>
                {tl.map((q) => <option key={q.leg.id} value={q.leg.id}>{legLabel(q.leg)}</option>)}
              </select>
              <span className="m"><b>{num(r.before)}</b> in → <b>{num(r.lost)}</b> out ({pctOf(r.lost, r.before)}) → <b>{num(r.after)}</b> live</span>
            </div>
            <table className="dist">
              <thead><tr><th>Team</th><th>Entries</th><th>% of field</th><th style={{ textAlign: "left" }}></th>{hasM && <th title={`win^${params.a} · e^(−${params.b}·FV) · availability`}>Model est.</th>}<th>Result</th><th>Eliminated</th></tr></thead>
              <tbody>
                {rows.map(([t, n]) => {
                  const k = st(t);
                  const col = COLORS[t] || ["#c9c6bf", "#1a1a1a"];
                  return (
                    <tr key={t} className={k}>
                      <td><span className="chip" style={{ background: col[0], color: col[1] }}>{name(t)}</span></td>
                      <td>{num(n)}</td>
                      <td>{pctOf(n, tot)}</td>
                      <td style={{ textAlign: "left", width: "26%" }}><span className="bar" style={{ width: (100 * n / max) + "%" }} /></td>
                      {hasM && <td style={{ color: "#6f6c66" }}>{fp(mp[t])}</td>}
                      <td className="res">{k === "W" ? "Won" : k === "L" ? "Lost" : k === "P" ? "Pending" : ""}</td>
                      <td className="elim">{k === "L" ? "−" + num(n) : ""}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        );
      })}
      {!tl.length && <div className="editor"><h3>No Circa results entered yet.</h3><div className="row">{canEdit ? "Use “Enter Week 1 results” above after Circa posts its selections." : "Check back after the first week locks."}</div></div>}
    </div>
  );
}

// Enter/edit one leg of Circa's posted selections: entries per team and each team's result.
function LegEditor({ legId, current, onSave, onCancel }) {
  const leg = LEGS.find((l) => l.id === legId);
  const teams = [...Object.keys(OPP[legId]).sort(), "NOPICK"];
  const init = () => {
    const rows = {};
    for (const t of teams) rows[t] = { n: current?.picks?.[t] ?? "", r: current?.lost?.includes(t) ? "lost" : current?.pending?.includes(t) ? "pending" : current?.won?.includes(t) ? "won" : "" };
    return rows;
  };
  const [rows, setRows] = useState(init);
  const set = (t, k, v) => setRows((p) => ({ ...p, [t]: { ...p[t], [k]: v } }));
  const total = teams.reduce((s, t) => s + (parseInt(rows[t].n, 10) || 0), 0);
  const submit = () => {
    const picks = {}, won = [], lost = [], pending = [];
    for (const t of teams) {
      const n = parseInt(rows[t].n, 10);
      if (n > 0) picks[t] = n;
      if (rows[t].r === "won") won.push(t); else if (rows[t].r === "lost") lost.push(t); else if (rows[t].r === "pending") pending.push(t);
    }
    onSave({ ...(current || {}), asOf: new Date().toLocaleDateString([], { month: "short", day: "numeric" }), picks, won, lost, pending });
  };
  // quick fills: mark every team with entries but no result
  const fillRest = (r) => setRows((p) => { const q = { ...p }; for (const t of teams) if (!q[t].r) q[t] = { ...q[t], r }; return q; });
  return (
    <div className="editor">
      <h3>{legLabel(leg)} — Circa's posted selections</h3>
      <div className="row">
        <span style={{ color: "#6f6c66" }}>Entries so far: <b>{total.toLocaleString()}</b></span>
        <button className="ghost" onClick={() => fillRest("pending")}>Rest = pending</button>
        <button className="ghost" onClick={() => fillRest("lost")}>Rest = lost</button>
      </div>
      <div className="grid">
        {teams.map((t) => {
          const col = COLORS[t] || ["#c9c6bf", "#1a1a1a"];
          return (
            <div className="g" key={t}>
              <span className="chip" style={{ background: col[0], color: col[1] }}>{t === "NOPICK" ? "No pick" : t}</span>
              <input className="num" type="number" min="0" placeholder="0" value={rows[t].n} onChange={(e) => set(t, "n", e.target.value)} />
              <select value={rows[t].r} onChange={(e) => set(t, "r", e.target.value)}>
                <option value="">–</option><option value="won">Won</option><option value="lost">Lost</option><option value="pending">Pending</option>
              </select>
            </div>
          );
        })}
      </div>
      <div className="row">
        <button className="btn" onClick={submit}>Save to GitHub</button>
        <button className="ghost" onClick={onCancel}>Cancel</button>
        <span style={{ color: "#6f6c66" }}>Teams with 0 entries are left out. Every team with entries needs a result before the leg's math is right.</span>
      </div>
    </div>
  );
}

function ContestEditor({ contest, onSave, onCancel }) {
  const [c, setC] = useState({ start: contest.start, pool: contest.pool, share: Math.round(contest.share * 100) });
  const f = (k) => (e) => setC((p) => ({ ...p, [k]: e.target.value }));
  return (
    <div className="editor">
      <h3>Contest size</h3>
      <div className="row">
        <label>Starting entries <input className="num" type="number" value={c.start} onChange={f("start")} /></label>
        <label>Prize pool $ <input className="num" type="number" value={c.pool} onChange={f("pool")} style={{ width: 110 }} /></label>
        <label>Your share of each entry % <input className="num" type="number" value={c.share} onChange={f("share")} /></label>
      </div>
      <div className="row">
        <button className="btn" onClick={() => onSave({ start: +c.start || 0, pool: +c.pool || 0, share: (+c.share || 0) / 100 })}>Save to GitHub</button>
        <button className="ghost" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

function Chart({ pts, money, num, start }) {
  const Mini = ({ title, k, color, fmt, top }) => {
    const W = 360, H = 140, px = 30, py = 22;
    const xs = pts.map((_, i) => px + (i * (W - 2 * px)) / Math.max(1, pts.length - 1));
    const mx = top || Math.max(...pts.map((p) => p[k])) * 1.2 || 1;
    const y = (v) => H - py - ((H - 2 * py) * v) / mx;
    const d = pts.map((p, i) => (i ? "L" : "M") + xs[i].toFixed(1) + " " + y(p[k]).toFixed(1)).join(" ");
    return (
      <div className="chart" style={{ minWidth: 280 }}>
        <h3>{title}</h3>
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: "block" }} fontFamily="inherit" fontSize="10">
          <line x1={px} x2={W - px} y1={H - py} y2={H - py} stroke="#E7E5DF" />
          <path d={d} fill="none" stroke={color} strokeWidth="2" />
          {pts.map((p, i) => (
            <g key={i}>
              <circle cx={xs[i]} cy={y(p[k])} r="3" fill={color} />
              {(i === 0 || i === pts.length - 1 || pts.length <= 4) && <text x={xs[i]} y={y(p[k]) - 8} textAnchor="middle" fill={color} fontWeight="600">{fmt(p[k])}</text>}
              <text x={xs[i]} y={H - 6} textAnchor="middle" fill="#9A9DA6">{p.x}</text>
            </g>
          ))}
        </svg>
      </div>
    );
  };
  return (
    <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
      <Mini title="Entries alive, by week" k="live" color="#5B5E66" fmt={num} top={start * 1.15} />
      <Mini title="Your equity, by week" k="eq" color="#2F8F3E" fmt={money} />
    </div>
  );
}
