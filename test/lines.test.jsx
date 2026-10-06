// Consensus True Win % from data/odds.json: each book de-vigged on its own, median of home probabilities,
// away = complement; status tiers; exclusions (one-sided, in-game, stale); EV coverage handling.
import { linesFromOdds, consensusForGame, computeEV, EV_MIN_COVERAGE, devig, buildData } from "../src/CircaSurvivorPlanner.jsx";
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;
let fails = 0; const ok = (name, cond, extra = "") => { console.log(name + ":", cond ? "OK" : "FAIL", extra); if (!cond) fails++; };
const p = (ml, opp) => devig(ml, opp).a;
const K = "2026-09-18T00:15:00Z";
const bk = (ml, spread, asof = "2026-09-15T00:20:00Z") => ({ asof, ml, spread });

// 0. a look-ahead spread with no moneyline gives a planning line, never a True Win %
(() => {
  const la = { kickoff: "2026-11-01T17:00:00Z", books: { nflverse: { asof: "2026-10-06T20:00:00Z", spread: { PIT: -6, CLE: 6 }, lookahead: true } } };
  const r = linesFromOdds({ games: { "CLE@PIT": la } });
  ok("look-ahead line has a win chance from the spread", r.lines.PIT?.win > 0.66 && r.lines.PIT.win < 0.68 && near(r.lines.CLE.win, 1 - r.lines.PIT.win), `PIT ${r.lines.PIT?.win?.toFixed(3)}`);
  ok("look-ahead line is not market and not counted as priced", r.lines.PIT.market === false && r.lines.PIT.lookahead === true && r.lines.PIT.status === "lookahead" && r.games === 0 && r.counts.lookahead === 1);
  ok("look-ahead row is excluded from the consensus with a reason", /look-ahead/.test(consensusForGame("CLE@PIT", la).rows[0].excluded));
  const d = buildData({ picks: { entries: [] }, actuals: null, odds: { books: [], legs: { W8: { games: { "CLE@PIT": la } } } }, ratings: null });
  ok("the app carries it as a line without a True Win %", d.legs.W8.lines.PIT.spread === -6 && d.legs.W8.lines.PIT.market === false);
  const mixed = { ...la, books: { ...la.books, draftkings: bk({ PIT: -240, CLE: 195 }, { PIT: -6, CLE: 6 }, "2026-10-29T00:00:00Z") } };
  ok("a real moneyline wins over the look-ahead", linesFromOdds({ games: { "CLE@PIT": mixed } }).lines.PIT.market === true);
})();
// 1. four books → median of the two middle home probabilities, away is the complement
const g4 = { kickoff: K, books: {
  draftkings: bk({ BUF: -205, DET: 170 }, { BUF: -4.5, DET: 4.5 }),
  fanduel: bk({ BUF: -215, DET: 180 }, { BUF: -4.5, DET: 4.5 }),
  betmgm: bk({ BUF: -210, DET: 175 }, { BUF: -4.5, DET: 4.5 }),
  pinnacle: bk({ BUF: -206, DET: 179 }, { BUF: -4, DET: 4 }),
} };
const c = consensusForGame("DET@BUF", g4);
const homes = [p(-205, 170), p(-215, 180), p(-210, 175), p(-206, 179)].sort((a, b) => a - b);
ok("median of 4 books", near(c.pHome, (homes[1] + homes[2]) / 2), c.pHome.toFixed(4));
ok("status consensus (4)", c.status === "consensus" && c.valid === 4);
ok("spread = median rounded to half", c.spreadHome === -4.5, String(c.spreadHome));
ok("ref book is closest to consensus", c.ref && Math.abs(c.ref.pHome - c.pHome) <= Math.min(...c.rows.map((r) => Math.abs(r.pHome - c.pHome))));
const Lc = linesFromOdds({ games: { "DET@BUF": g4 } });
ok("away = 1 − home", near(Lc.lines.BUF.win + Lc.lines.DET.win, 1) && near(Lc.lines.DET.win, 1 - c.pHome));

// 2. tiers and exclusions
const g2 = { kickoff: K, books: { draftkings: bk({ BUF: -205, DET: 170 }), fanduel: bk({ BUF: -215, DET: 180 }) } };
ok("2 books → degraded", consensusForGame("DET@BUF", g2).status === "degraded");
const g1 = { kickoff: K, books: { draftkings: bk({ BUF: -205, DET: 170 }) } };
ok("1 book → single", consensusForGame("DET@BUF", g1).status === "single" && near(consensusForGame("DET@BUF", g1).pHome, p(-205, 170)));
const gInGame = { kickoff: K, books: { draftkings: bk({ BUF: -205, DET: 170 }), fanduel: bk({ BUF: -600, DET: 400 }, {}, "2026-09-18T01:30:00Z") } };
const ci = consensusForGame("DET@BUF", gInGame);
ok("quote after kickoff excluded", ci.valid === 1 && ci.rows.find((r) => r.book === "fanduel").excluded.includes("kickoff") && near(ci.pHome, p(-205, 170)));
const gStale = { kickoff: K, books: { draftkings: bk({ BUF: -205, DET: 170 }, {}, "2026-09-15T00:20:00Z"), betmgm: bk({ BUF: -210, DET: 175 }, {}, "2026-09-15T00:21:00Z"), fanduel: bk({ BUF: -150, DET: 130 }, {}, "2026-09-12T00:00:00Z") } };
const cs = consensusForGame("DET@BUF", gStale);
ok("stale quote (>48 h older) excluded", cs.valid === 2 && cs.rows.find((r) => r.book === "fanduel").excluded.startsWith("stale") && cs.status === "degraded");
const gBad = { kickoff: K, books: { draftkings: bk({ BUF: -205 }), fanduel: bk({ BUF: -50, DET: 40 }), betmgm: { asof: null, spread: { BUF: -3 } } } };
const cb = consensusForGame("DET@BUF", gBad);
ok("one-sided / invalid / spread-only → none", cb.status === "none" && cb.pHome == null && cb.rows.every((r) => r.excluded));
const gClose = { kickoff: "2026-09-09T20:20", books: { nflverse: bk({ NE: 140, SEA: -166 }, { SEA: -3, NE: 3 }, "2026-09-09T20:20") } };
ok("nflverse closing line → status closing", consensusForGame("NE@SEA", gClose).status === "closing");
const gLegacy = { kickoff: K, asof: "2026-09-14T23:32:16Z", ml: { DEN: 110, KC: -130 }, spread: { DEN: 2.5, KC: -2.5 } };
ok("v2.0 single-book shape still read", consensusForGame("DEN@KC", gLegacy).status === "single" && near(consensusForGame("DEN@KC", gLegacy).pHome, p(-130, 110)));

// 3. leg assembly
const leg = { games: { "DET@BUF": g4, "DEN@KC": gLegacy, "NE@SEA": gClose, "TB@CIN": gBad } };
const L = linesFromOdds(leg);
ok("lines for both sides, market flag, status carried", L.lines.BUF.market && L.lines.DET.status === "consensus" && near(L.lines.BUF.win + L.lines.DET.win, 1) && L.lines.DET.spread === 4.5);
ok("games counted / counts / asof", L.games === 3 && L.counts.consensus === 1 && L.counts.single === 1 && L.counts.closing === 1 && L.asof === "2026-09-15T00:20:00Z", JSON.stringify(L.counts));
ok("unpriced game absent from lines but in detail", !L.lines.TB && L.detail["TB@CIN"].status === "none");

// 4. EV coverage: full coverage → pick-weighted mean 1.00; partial → flagged; poor → blanked
const mk = (wins) => { const rows = {}; for (const t of Object.keys(wins)) rows[t] = { win: wins[t], pick: wins[t] != null && wins[t] > 0.5 ? 0.1 : 0.01 }; return rows; };
import { OPP } from "../src/schedule.js";
const w1 = Object.keys(OPP.W1);
const full = {}; for (const t of w1) full[t] = OPP.W1[t].home ? 0.6 : 0.4;
let rows = mk(full); let ev = computeEV("W1", rows);
const teams = w1.filter((t) => rows[t].ev != null);
const mean = teams.reduce((s, t) => s + rows[t].pick * rows[t].ev, 0) / teams.reduce((s, t) => s + rows[t].pick, 0);
ok("full coverage: EV mean = 1.00, no flag", ev.coverage === 1 && !ev.blanked && near(mean, 1, 1e-9));
const partial = { ...full }; partial.NE = null; partial.SEA = null;
rows = mk(partial); ev = computeEV("W1", rows);
ok("15/16 games: EV shown, coverage flagged", !ev.blanked && ev.covered === 15 && ev.coverage < 1 && rows.KC.ev != null && rows.NE.ev == null);
const poor = {}; for (const t of w1) poor[t] = null; for (const t of ["KC", "DEN", "DET", "NO", "SEA", "NE", "SF", "LAR", "TB", "CIN"]) poor[t] = full[t];
rows = mk(poor); ev = computeEV("W1", rows);
ok(`5/16 games (<${Math.round(EV_MIN_COVERAGE * 100)}%): EV blanked`, ev.blanked && w1.every((t) => rows[t].ev == null));

// 5. buildData carries the book list
const d = buildData({ picks: { entries: [] }, actuals: null, odds: { books: ["pinnacle", "draftkings"], legs: { W2: leg } }, ratings: null });
ok("buildData books + gamesTotal", d.legs.W2.books.length === 2 && d.legs.W2.gamesTotal === 16 && d.legs.W2.games === 3);
if (fails) { console.log(`${fails} FAILED`); process.exit(1); }
