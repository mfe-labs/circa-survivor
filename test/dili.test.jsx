// DILI: EV net of what the team is worth to the rest of the entry's season (the map); and the futures-market prior.
import { buildData, computeEV, computeDili, planMap, spentTeams, customSummary, fitParams, fvFor, strengthWeight, futureFor } from "../src/CircaSurvivorPlanner.jsx";
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

// the forfeit blends the map forfeit with a strength forfeit that grows with future value
ok("forfeit records both parts and lies between them", homes.every((t) => { const r = rows[t]; const lo = Math.min(r.forfeitMap, r.forfeitStr), hi = Math.max(r.forfeitMap, r.forfeitStr); return r.forfeitMap >= 1 && r.forfeitStr >= 1 && r.forfeit >= lo - 1e-9 && r.forfeit <= hi + 1e-9; }));
ok("strength part is calibrated to the map part's average", (() => { const sc = Object.keys(OPP.W2).filter((t) => rows[t].forfeitMap != null); const a = sc.reduce((x, t) => x + Math.log(rows[t].forfeitMap), 0), b = sc.reduce((x, t) => x + Math.log(rows[t].forfeitStr), 0); return Math.abs(a - b) < 1e-6; })());
ok("more future value, bigger strength forfeit", rows.KC.forfeitStr > rows.BAL.forfeitStr && rows.BAL.forfeitStr > rows.CIN.forfeitStr);
ok("strength weight is half early and zero at the end", Math.abs(strengthWeight("W2") - 0.5) < 1e-9 && strengthWeight("W18") === 0 && strengthWeight("W16") > 0 && strengthWeight("W16") < 0.5, `W2 ${strengthWeight("W2")} W16 ${strengthWeight("W16").toFixed(2)} W18 ${strengthWeight("W18")}`);
// the Future column: raw count, entry-aware count, and the blend between them
(() => {
  const none = new Set(), f = futureFor("W2", "KC", data, none), c = futureFor("W2", "CIN", data, none);
  ok("entry-aware count never exceeds the raw count", f.entry <= f.raw + 1e-9 && c.entry <= c.raw + 1e-9, `KC ${f.raw.toFixed(1)}/${f.entry.toFixed(1)} CIN ${c.raw.toFixed(1)}/${c.entry.toFixed(1)}`);
  ok("blend sits between the two at DILI's weight", Math.abs(f.blend - (f.w * f.raw + (1 - f.w) * f.entry)) < 1e-12 && f.w === strengthWeight("W2"));
  ok("a stud keeps most of its count, a flat team keeps little", f.entry / f.raw > 0.6 && (c.raw === 0 || c.entry / c.raw < 0.5));
  const spentStuds = futureFor("W2", "BAL", data, new Set(["KC", "BUF", "SF"]));
  ok("spending your studs makes the next team's weeks count for more", spentStuds.entry > futureFor("W2", "BAL", data, none).entry);
  ok("last week is pure entry-aware", (() => { const x = futureFor("W18", "KC", data, none); return x.w === 0 && x.blend === x.entry; })());
})();
// the map: one distinct team per remaining leg, each with a game that leg, holidays filled with eligible teams
const later = LEGS.filter((l) => l.id !== "W2");     // nothing is locked in the synthetic world, so W1 is still open too
ok("map covers every open leg but the one being scored", map.length === later.length && map.every((p, i) => p.leg.id === later[i].id));
ok("map uses distinct teams that play that week", new Set(map.map((p) => p.team)).size === map.length && map.every((p) => OPP[p.leg.id][p.team]));
ok("map puts eligible teams on the holidays", map.every((p) => (p.leg.id !== "TG" || TG_TEAMS.has(p.team)) && (p.leg.id !== "XM" || XM_TEAMS.has(p.team))));
ok("map spends the studs", ["KC", "BUF", "SF"].every((t) => map.some((p) => p.team === t)));
const lockedTo = (n) => ({ ...data, actuals: Object.fromEntries(LEGS.slice(0, n).map((l) => [l.id, { picks: {}, won: [], lost: [], pending: [] }])) });
ok("nothing left to map in the last week", (() => { const late = lockedTo(LEGS.length - 1); const r = {}; for (const t of Object.keys(OPP.W18)) r[t] = { win: 0.6, pick: 1 / 16, fv: 0 }; computeEV("W18", r); const m = computeDili("W18", r, late, new Set(), P); return m.length === 0 && Object.keys(OPP.W18).every((t) => r[t].forfeit === 1 && r[t].forfeitMap === 1 && r[t].dili === r[t].ev); })());
ok("locked weeks are not mapped", (() => { const d = lockedTo(3); const r = mk("W5"); const m = computeDili("W5", r, d, new Set(), P); return m.every((p) => !["W1", "W2", "W3", "W5"].includes(p.leg.id)) && m.some((p) => p.leg.id === "W4"); })());
// picks in weeks not completely over are soft: they neither spend a team nor fix a week
const fin = (n, pend = []) => ({ ...data, actuals: Object.fromEntries(LEGS.slice(0, n).map((l, i) => [l.id, { picks: {}, won: [], lost: [], pending: i === n - 1 ? pend : [] }])) });
// a week with games pending counts as current only until the next week starts, so pin the clock to Week 3
const atWeek3 = (fn) => { const real = Date.now; Date.now = () => new Date("2026-09-26T12:00:00Z").getTime(); try { return fn(); } finally { Date.now = real; } };
ok("only finished weeks spend a team", atWeek3(() => { const sp = spentTeams(fin(3, ["X"]), { W1: "KC", W2: "BUF", W3: "SF", W4: "PHI" }); return sp.has("KC") && sp.has("BUF") && !sp.has("SF") && !sp.has("PHI"); }));
ok("a week still being played stays in the plan", atWeek3(() => { const pl = planMap(fin(3, ["X"]), { W1: "KC", W2: "BUF", W3: "SF", W4: "PHI" }, P); return pl.plan[0].leg.id === "W3" && pl.plan.every((p) => p.team !== "KC" && p.team !== "BUF") && pl.plan.some((p) => p.team === "SF"); }));
ok("viewing a later week still covers the open weeks before it", (() => { const m = computeDili("W6", mk("W6"), data, new Set(), P); return m.some((p) => p.leg.id === "W5") && !m.some((p) => p.leg.id === "W6"); })());
// the Map tab's plan
(() => {
  const pl = planMap(data, { W1: "KC" }, P);
  ok("plan fills every week not over, soft picks ignored", pl.plan.length === LEGS.length && pl.plan.every((p) => p.team) && pl.plan.some((p) => p.team === "KC"));
  ok("plan counts are out of the sample size", pl.plan.every((p) => p.held >= 0 && p.held <= pl.samples));
  ok("every week has a backup that differs from the pick", pl.plan.every((p) => p.backup && p.backup !== p.team && p.cost >= 1 - 1e-9));
  ok("chance of winning out is the product along the map", Math.abs(pl.winOut - pl.plan.reduce((x, p) => x * p.win, 1)) < 1e-12 && pl.winOut > 0 && pl.winOut < 1);
  ok("weakest weeks are the lowest win chances", pl.weakest.length === 3 && pl.weakest[0].win <= pl.weakest[2].win && pl.weakest[0].win === Math.min(...pl.plan.map((p) => p.win)));
  ok("holiday rows know their pool", pl.plan.find((p) => p.leg.id === "TG").pool === 10 && pl.plan.find((p) => p.leg.id === "XM").pool === 8);
})();

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
  const burned = spentTeams(real, picks.entries[0].picks); burned.delete(picks.entries[0].picks[leg]);
  const r = {}; for (const t of ALL_TEAMS) { const ln = real.legs[leg]?.lines[t]; r[t] = { win: ln?.win ?? null, pick: ln && ln.win > 0.5 ? 1 / 16 : 0, fv: fvFor(leg, t, real) }; }
  computeEV(leg, r);
  const t0 = Date.now(); const m = computeDili(leg, r, real, burned, params); const ms = Date.now() - t0;
  const scored = Object.keys(OPP[leg]).filter((t) => r[t].dili != null);
  ok(`real ${leg}: every scored team is finite and ≤ EV`, scored.length > 0 && scored.every((t) => Number.isFinite(r[t].dili) && r[t].dili <= r[t].ev + 1e-12), `${scored.length} teams`);
  ok("real map skips spent teams", m.every((p) => !burned.has(p.team)));
  ok("fast enough for the browser", ms < 600, `${ms} ms`);
  const t1 = Date.now(); const pl = planMap(real, picks.entries[0].picks, params); const ms2 = Date.now() - t1;
  ok("real plan skips every spent team and is quick", pl.plan.every((p) => !spentTeams(real, picks.entries[0].picks).has(p.team)) && ms2 < 1500, `${ms2} ms, ${pl.plan.length} weeks`);
})();

// saved maps: duplicates and spent teams are conflicts, the boxes follow the map
(() => {
  const d = fin(2); const entryP = { W1: "KC", W2: "BUF" };
  const pl = planMap(d, entryP, P);
  const picks = Object.fromEntries(pl.plan.map((p) => [p.leg.id, p.team]));
  const clean = customSummary(d, { picks: entryP }, { picks }, pl);
  ok("a copy of Claude's map has no conflicts and the same chance of winning out", clean.conflicts === 0 && Math.abs(clean.winOut - pl.winOut) < 1e-12);
  const dup = customSummary(d, { picks: entryP }, { picks: { ...picks, W5: picks.W9 } }, pl);
  ok("a team in two weeks flags both", dup.rows.filter((r) => r.conflict).map((r) => r.leg.id).sort().join() === ["W5", "W9"].sort().join() && dup.winOut === null && /2 weeks/.test(dup.winNote));
  const sp = customSummary(d, { picks: entryP }, { picks: { ...picks, W6: "KC" } }, pl);
  ok("a team spent in a finished week is a conflict", sp.rows.find((r) => r.leg.id === "W6").spent?.id === "W1" && sp.usedAt("KC", "W7") === "used W1");
  const gap = customSummary(d, { picks: entryP }, { picks: { W3: picks.W3 } }, pl);
  ok("empty weeks make the map incomplete, not wrong", gap.conflicts === 0 && gap.winOut === null && /no pick/.test(gap.winNote));
})();

// futures prior: monotone in title odds, centered, on a points scale
const probs = Object.fromEntries(ALL_TEAMS.map((t, i) => [t, 0.002 + 0.006 * i]));
const prior = priorFromFutures(probs);
ok("prior follows the odds", prior[ALL_TEAMS[31]] > prior[ALL_TEAMS[15]] && prior[ALL_TEAMS[15]] > prior[ALL_TEAMS[0]]);
ok("prior centered and points-scaled", Math.abs(Object.values(prior).reduce((a, b) => a + b, 0)) < 1 && Math.max(...Object.values(prior)) < 12 && Math.max(...Object.values(prior)) > 3);
ok("prior needs most teams", priorFromFutures({ KC: 0.1, BUF: 0.1 }) === null);
if (fails) { console.log(`${fails} FAILED`); process.exit(1); }
