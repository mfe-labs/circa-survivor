// DILI: EV net of what the team is worth to the rest of the entry's season (the map); and the futures-market prior.
import { buildData, computeEV, computeDili, fitParams, fvFor } from "../src/CircaSurvivorPlanner.jsx";
import { priorFromFutures } from "../src/ratings.js";
import { OPP, ALL_TEAMS, LEGS, TG_TEAMS, XM_TEAMS } from "../src/schedule.js";
import picks from "../data/picks.json"; import actuals from "../data/actuals.json"; import odds from "../data/odds.json"; import ratings from "../data/ratings.json";
let fails = 0; const ok = (name, cond, extra = "") => { console.log(name + ":", cond ? "OK" : "FAIL", extra); if (!cond) fails++; };

// synthetic world: flat ratings except a few strong teams, so future edges are known
const rat = Object.fromEntries(ALL_TEAMS.map((t) => [t, 0]));
Object.assign(rat, { KC: 9, BUF: 8, SF: 7, BAL: 3, TB: 3, PHI: 3 });
const bk = (a, h) => ({ asof: "2026-09-15T00:00:00Z", ml: { [a]: 150, [h]: -175 }, spread: {} });
const games = {}; for (const [t, g] of Object.entries(OPP.W2)) if (g.home) games[`${g.opp}@${t}`] = { kickoff: "2026-09-20T17:00:00Z", books: { draftkings: bk(g.opp, t), fanduel: bk(g.opp, t), betmgm: bk(g.opp, t) } };
const data = buildData({ picks: { entries: [] }, actuals: null, odds: { books: ["draftkings", "fanduel", "betmgm"], legs: { W2: { games } } }, ratings: { ratings: rat } });
const P = { a: 8, b: 0.15 };
const mk = (leg = "W2") => { const rows = {}; for (const t of ALL_TEAMS) { const ln = data.legs[leg]?.lines[t]; rows[t] = { win: ln?.win ?? null, pick: ln && ln.win > 0.5 ? 1 / 16 : 0, fv: fvFor(leg, t, data) }; } computeEV(leg, rows); return rows; };
const run = (burnedList = [], leg = "W2") => { const r = mk(leg); const map = computeDili(leg, r, data, new Set(burnedList), P); return { r, map }; };

let { r: rows, map } = run();
const homes = Object.keys(OPP.W2).filter((t) => OPP.W2[t].home);
ok("every home favorite gets a DILI", homes.every((t) => rows[t].dili != null));
ok("DILI never exceeds EV", homes.every((t) => rows[t].dili <= rows[t].ev + 1e-12));
ok("forfeit is at least 1", homes.every((t) => rows[t].forfeit >= 1));
ok("a flat team keeps nearly all its EV", rows.CIN.forfeit < 1.05, `CIN forfeit ${rows.CIN.forfeit.toFixed(3)}`);
ok("a stud pays a real forfeit", rows.KC.forfeit > 1.1, `KC forfeit ${rows.KC.forfeit.toFixed(3)}`);
ok("bigger stud, bigger forfeit", rows.KC.forfeit > rows.BAL.forfeit && rows.BAL.forfeit > rows.CIN.forfeit, `KC ${rows.KC.forfeit.toFixed(3)} BAL ${rows.BAL.forfeit.toFixed(3)} CIN ${rows.CIN.forfeit.toFixed(3)}`);
ok("burned teams get no DILI", (() => { const { r } = run(["KC"]); return r.KC.dili == null && r.BUF.dili != null; })());
ok("burning a stud names the week it costs", rows.KC.swaps.length >= 1 && rows.KC.swaps.some((s) => s.from === "KC") && rows.KC.swaps.every((s) => s.from && s.to), rows.KC.swaps.map((s) => `${s.leg.id} ${s.from}→${s.to}`).join(", "));
ok("deterministic", (() => { const { r } = run(); return homes.every((t) => Math.abs(r[t].dili - rows[t].dili) < 1e-12); })());

// the map: one distinct team per remaining leg, each with a game that leg, holidays filled with eligible teams
const later = LEGS.slice(LEGS.findIndex((l) => l.id === "W2") + 1);
ok("map covers every later leg", map.length === later.length && map.every((p, i) => p.leg.id === later[i].id));
ok("map uses distinct teams that play that week", new Set(map.map((p) => p.team)).size === map.length && map.every((p) => OPP[p.leg.id][p.team]));
ok("map puts eligible teams on the holidays", map.every((p) => (p.leg.id !== "TG" || TG_TEAMS.has(p.team)) && (p.leg.id !== "XM" || XM_TEAMS.has(p.team))));
ok("map spends the studs", ["KC", "BUF", "SF"].every((t) => map.some((p) => p.team === t)));
ok("nothing left to map after the last week", (() => { const r = {}; for (const t of Object.keys(OPP.W18)) r[t] = { win: 0.6, pick: 1 / 16, fv: 0 }; computeEV("W18", r); const m = computeDili("W18", r, data, new Set(), P); return m.length === 0 && Object.keys(OPP.W18).every((t) => r[t].forfeit === 1 && r[t].dili === r[t].ev); })());

// holidays fall out of the map: a team the map needs on Thanksgiving or Christmas is dearer than a spare
const h = run().r;
ok("a decent team in both holiday pools is dearer than an equal one in neither", h.PHI.forfeit > h.TB.forfeit && h.TB.forfeit > 1, `PHI ${h.PHI.forfeit.toFixed(3)} TB ${h.TB.forfeit.toFixed(3)}`);
const thin = run(["BUF", "CHI", "DEN", "GB", "HOU", "SEA"]).r;      // XM pool down to PHI + LAR
ok("dock sharpens as the pool empties", thin.PHI.forfeit > h.PHI.forfeit, `${h.PHI.forfeit.toFixed(3)} → ${thin.PHI.forfeit.toFixed(3)}`);
const last = run(["BUF", "CHI", "DEN", "GB", "HOU", "SEA", "LAR"]).r; // PHI is the only XM team left
ok("last eligible team is disqualified", last.PHI.forfeit === Infinity && last.PHI.dili === 0 && last.PHI.deadLeg?.id === "XM");
ok("no self-dock when picking on the holiday week", (() => { const r = {}; for (const t of Object.keys(OPP.XM)) r[t] = { win: 0.7, pick: 1 / 4, fv: 0 }; computeEV("XM", r); computeDili("XM", r, data, new Set(["BUF", "CHI", "DEN", "GB", "HOU", "SEA", "LAR"]), P); return r.PHI.dili > 0 && r.PHI.forfeit < 1.2; })());

// future value = expected strong spots: a stud has several, a flat team a few at most
ok("stud has more spots left than a flat team", fvFor("W2", "KC", data) > fvFor("W2", "CIN", data) + 3, `KC ${fvFor("W2", "KC", data).toFixed(1)} CIN ${fvFor("W2", "CIN", data).toFixed(1)}`);
ok("future value on a readable scale", fvFor("W2", "KC", data) < 18 && fvFor("W2", "KC", data) > 1);

// real data: the live entry's week, whatever week that is
(() => {
  const real = buildData({ picks, actuals, odds, ratings });
  const params = fitParams(real);
  const leg = LEGS.find((l) => !real.actuals[l.id])?.id || "W18";
  const burned = new Set(Object.values(picks.entries[0].picks).filter((t) => t !== picks.entries[0].picks[leg]));
  const r = {}; for (const t of ALL_TEAMS) { const ln = real.legs[leg]?.lines[t]; r[t] = { win: ln?.win ?? null, pick: ln && ln.win > 0.5 ? 1 / 16 : 0, fv: fvFor(leg, t, real) }; }
  computeEV(leg, r);
  const t0 = Date.now(); const m = computeDili(leg, r, real, burned, params); const ms = Date.now() - t0;
  const scored = Object.keys(OPP[leg]).filter((t) => r[t].dili != null);
  ok(`real ${leg}: every scored team is finite and ≤ EV`, scored.length > 0 && scored.every((t) => Number.isFinite(r[t].dili) && r[t].dili <= r[t].ev + 1e-12), `${scored.length} teams`);
  ok("real map skips burned teams", m.every((p) => !burned.has(p.team)));
  ok("fast enough for the browser", ms < 600, `${ms} ms`);
})();

// futures prior: monotone in title odds, centered, on a points scale
const probs = Object.fromEntries(ALL_TEAMS.map((t, i) => [t, 0.002 + 0.006 * i]));
const prior = priorFromFutures(probs);
ok("prior follows the odds", prior[ALL_TEAMS[31]] > prior[ALL_TEAMS[15]] && prior[ALL_TEAMS[15]] > prior[ALL_TEAMS[0]]);
ok("prior centered and points-scaled", Math.abs(Object.values(prior).reduce((a, b) => a + b, 0)) < 1 && Math.max(...Object.values(prior)) < 12 && Math.max(...Object.values(prior)) > 3);
ok("prior needs most teams", priorFromFutures({ KC: 0.1, BUF: 0.1 }) === null);
if (fails) { console.log(`${fails} FAILED`); process.exit(1); }
