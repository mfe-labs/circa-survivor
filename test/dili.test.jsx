// DILI: EV net of what the team is worth to the rest of the entry's season (the map); and the futures-market prior.
import { buildData, computeEV, computeDili, planMap, spentTeams, customSummary, fitParams, fvFor, strengthWeight, futureFor, locksPicks, modelPick, marketLine, lineFor, seasonTable, mapLegs, expWin, survivalPath, rulesPlan, simPlan } from "../src/CircaSurvivorPlanner.jsx";
import splash from "../data/splash.json";
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
ok("weeks with Circa's picks in spend a team, even with games pending", atWeek3(() => { const sp = spentTeams(fin(3, ["X"]), { W1: "KC", W2: "BUF", W3: "SF", W4: "PHI" }); return sp.has("KC") && sp.has("BUF") && sp.has("SF") && !sp.has("PHI"); }));
ok("a week whose picks are in leaves the plan and its pick is spent", atWeek3(() => { const pl = planMap(fin(3, ["X"]), { W1: "KC", W2: "BUF", W3: "SF", W4: "PHI" }, P); return pl.plan[0].leg.id === "W4" && pl.plan.every((p) => !["KC", "BUF", "SF"].includes(p.team)) && pl.plan.some((p) => p.team === "PHI"); }));
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
  if (LEGS.every((l) => actuals.legs[l.id])) return;   // season over: nothing left to map
  const real = buildData({ picks, actuals, odds, ratings });
  const params = fitParams(real);
  const leg = LEGS.find((l) => !real.actuals[l.id])?.id || "W18";
  const burned = spentTeams(real, picks.entries[0].picks); burned.delete(picks.entries[0].picks[leg]);
  const r = {}; for (const t of ALL_TEAMS) { const ln = OPP[leg][t] ? lineFor(leg, t, real) : null; r[t] = { win: ln?.win ?? null, pick: ln && ln.win > 0.5 ? 1 / 16 : 0, fv: fvFor(leg, t, real) }; }
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

// the real entry as of its locked weeks only: whatever has been entered for open weeks is left out, so these tests
// do not change meaning when picks are entered in the app
const lockedOnly = (en) => ({ ...en, picks: Object.fromEntries(Object.entries(en.picks).filter(([id]) => actuals.legs[id])) });
// a finished season: the maps return empty plans instead of failing
(() => {
  const all = { ...actuals, legs: { ...actuals.legs } };
  for (const l of LEGS) if (!all.legs[l.id]) { const t = Object.keys(OPP[l.id])[0]; all.legs[l.id] = { asOf: "test", picks: { [t]: 1 }, won: [t], lost: [], pending: [], fv: {} }; }
  const d = buildData({ picks, actuals: all, odds, ratings, splash }), p = fitParams(d), en = picks.entries[0];
  let threw = null; let r, sm;
  try { r = rulesPlan(d, en.picks, p); sm = simPlan(d, en.picks, p); } catch (err) { threw = String(err); }
  ok("the maps handle a finished season", !threw && r.plan.length === 0 && sm.plan.length === 0, threw || "");
})();

// the two Claude maps on real data, and the played-Thursday block
(() => {
  if (LEGS.every((l) => actuals.legs[l.id])) return;   // season over: nothing left to map
  const real = buildData({ picks, actuals, odds, ratings, splash }), params = fitParams(real), e = lockedOnly(picks.entries[0]);
  const tab = seasonTable(real, params), spent = spentTeams(real, e.picks);
  const rp = rulesPlan(real, e.picks, params), sp = simPlan(real, e.picks, params);
  const idx = (t) => ALL_TEAMS.indexOf(t);
  const dog = (m) => m.plan.filter((q) => q.win != null && q.win < 0.5 && Object.keys(OPP[q.leg.id]).some((t) => !m.plan.some((r) => r.team === t) && !spent.has(t) && (lineFor(q.leg.id, t, real)?.win ?? 0) >= 0.6)).map((q) => `${q.leg.id} ${q.team}`);
  ok("no map takes an underdog while a 60% team is unused", dog(rp).length === 0 && dog(sp).length === 0, [...dog(rp), ...dog(sp)].join(", "));
  ok("both maps put eligible teams on the holidays", [rp, sp].every((m) => m.plan.every((p) => !p.team || ((p.leg.id !== "TG" || TG_TEAMS.has(p.team)) && (p.leg.id !== "XM" || XM_TEAMS.has(p.team))))));
  ok("both maps report a win-out on today's lines in a sane range", rp.winOut > 0.0005 && rp.winOut < 1 && sp.winOut > 0.0005 && sp.winOut < 1, `rules ${(100 * rp.winOut).toFixed(2)}% · simulation ${(100 * sp.winOut).toFixed(2)}% (expected with movement ${(100 * sp.expected).toFixed(2)}%)`);
  const lk = locksPicks(rp, sp), bySim = Object.fromEntries(sp.plan.map((p) => [p.leg.id, p.team]));
  ok("Claude Locks holds exactly the weeks both maps agree on", rp.plan.every((p) => (lk[p.leg.id] || null) === (p.team && bySim[p.leg.id] === p.team ? p.team : null)), `${Object.keys(lk).length} of ${rp.plan.length} weeks locked`);
  // a Thursday game already played can no longer be picked this week
  const now = LEGS[tab.nowIdx], thu = now && Object.keys(OPP[now.id]).find((t) => OPP[now.id][t].home === false);
  if (now && thu) {
    const opp = OPP[now.id][thu].opp, sp2 = JSON.parse(JSON.stringify(splash));
    sp2.weeks[now.id] = { thursday: { asOf: "2026-10-16T00:30:00Z", alive: 2500, picks: { [thu]: 100, [opp]: 100 }, final: { [thu]: "L", [opp]: "W" } } };
    const d2 = buildData({ picks, actuals, odds, ratings, splash: sp2 }), p2 = fitParams(d2);
    const picksNow = [rulesPlan(d2, e.picks, p2), simPlan(d2, e.picks, p2)].map((m) => m.plan[0].team);
    const tab2 = seasonTable(d2, p2), kk = tab2.nowIdx, later = LEGS.findIndex((l, i) => i > kk && OPP[l.id][thu]);
    ok("no map picks a team whose Thursday game is over", picksNow.every((t) => t !== thu && t !== opp), `${now.id}: ${thu}/${opp} played; maps pick ${picksNow.join(", ")}`);
    ok("a played Thursday game is blocked this week only", Number.isNaN(tab2.z[kk][idx(thu)]) && Number.isNaN(tab2.z[kk][idx(opp)]) && (later < 0 || !Number.isNaN(tab2.z[later][idx(thu)])) && (() => { const sp0 = JSON.parse(JSON.stringify(splash)); delete sp0.weeks[now.id]; const d0 = buildData({ picks, actuals, odds, ratings, splash: sp0 }); return !Number.isNaN(seasonTable(d0, fitParams(d0)).z[kk][idx(thu)]); })());
  }
})();

// the Rule map: hold three Christmas teams until Thanksgiving is played
(() => {
  if (LEGS.every((l) => actuals.legs[l.id])) return;   // season over: nothing left to map
  const real = buildData({ picks, actuals, odds, ratings, splash }), params = fitParams(real), e = lockedOnly(picks.entries[0]);
  const rp = rulesPlan(real, e.picks, params), spent = spentTeams(real, e.picks);
  const xm = LEGS.findIndex((l) => l.id === "XM"), K = (id) => LEGS.findIndex((l) => l.id === id);
  const beforeTG = LEGS.findIndex((l) => l.id === "TG") >= seasonTable(real, params).nowIdx;
  if (!beforeTG) ok("after Thanksgiving the rule holds nothing", !rp.active && rp.held.length === 0);
  else ok("rule is active before Thanksgiving and holds three Christmas teams", rp.active && rp.hold === 3 && rp.held.length === 3 && rp.held.every((t) => XM_TEAMS.has(t) && !spent.has(t)), rp.held.join(", "));
  ok("held teams are not used anywhere before Christmas", rp.plan.every((q) => !q.team || K(q.leg.id) >= xm || !rp.held.includes(q.team)));
  ok("Rule map fills every week with distinct teams, none spent", rp.plan.every((q) => q.team) && new Set(rp.plan.map((q) => q.team)).size === rp.plan.length && rp.plan.every((q) => !spent.has(q.team)));
  ok("the price is the win-out gap against the unconstrained plan", rp.freeWinOut != null && rp.freeWinOut >= rp.winOut - 1e-12, `rule ${(100 * rp.winOut).toFixed(3)}% vs free ${(100 * rp.freeWinOut).toFixed(3)}%`);
  const r0 = rulesPlan(real, e.picks, params, 0);
  ok("with nothing held the Rule map has no price", r0.held.length === 0 && Math.abs(r0.winOut - r0.freeWinOut) < 1e-12);
  const r4 = rulesPlan(real, e.picks, params, 4);
  ok("holding more never raises win-out", r4.winOut <= rp.winOut + 1e-12 && rp.winOut <= r0.winOut + 1e-12, `hold 4 ${(100 * r4.winOut).toFixed(3)}% ≤ hold 3 ${(100 * rp.winOut).toFixed(3)}% ≤ hold 0 ${(100 * r0.winOut).toFixed(3)}%`);
  // given the reservation, no legal swap improves a later week
  const tab = seasonTable(real, params), idx = (t) => ALL_TEAMS.indexOf(t), held = new Set(rp.held);
  const cost = (k, t) => { const i = idx(t), z = tab.z[k][i]; return Number.isNaN(z) || (k < xm && held.has(t)) ? Infinity : -(Math.log(expWin(tab, k, i)) + tab.ff[k][i]); };
  const rows = rp.plan.filter((q) => q.planned), used = new Set(rp.plan.map((q) => q.team)), bad = [];
  rows.forEach((q) => { const k = K(q.leg.id), c = cost(k, q.team); for (const t of Object.keys(OPP[q.leg.id])) if (!used.has(t) && !spent.has(t) && cost(k, t) < c - 1e-9) bad.push(`${q.leg.id} ${q.team}→${t}`); });
  for (let a = 0; a < rows.length; a++) for (let b = a + 1; b < rows.length; b++) { const ka = K(rows[a].leg.id), kb = K(rows[b].leg.id); if (cost(ka, rows[b].team) + cost(kb, rows[a].team) < cost(ka, rows[a].team) + cost(kb, rows[b].team) - 1e-9) bad.push(`swap ${rows[a].leg.id}/${rows[b].leg.id}`); }
  ok("Rule map: no legal swap improves any later week", bad.length === 0, bad.join(", "));
  ok("Rule map backups never offer a held team before Christmas", rp.plan.every((q) => !q.backup || K(q.leg.id) >= xm || !held.has(q.backup)));
  // the rule lifts once Thanksgiving is played: fake actuals through TG
  const tg = LEGS.findIndex((l) => l.id === "TG"), fake = { ...actuals, legs: { ...actuals.legs } }, fp = { ...e.picks };
  for (let k = 0; k <= tg; k++) { const l = LEGS[k]; if (fake.legs[l.id]) continue; const w = Object.keys(OPP[l.id]).find((t) => OPP[l.id][t].home && !Object.values(fp).includes(t)); fake.legs[l.id] = { asOf: "test", picks: { [w]: 100 }, won: [w], lost: [], pending: [], fv: {} }; fp[l.id] = w; }
  const later = buildData({ picks, actuals: fake, odds, ratings, splash }), rl = rulesPlan(later, fp, fitParams(later));
  ok("the rule lifts after Thanksgiving", !rl.active && rl.held.length === 0 && LEGS.findIndex((l) => l.id === rl.currentLeg?.id) > tg, `current ${rl.currentLeg?.id}, held ${rl.held.join(",") || "none"}`);
})();

// the Simulation map on real data: sane forfeits, a full plan, and a fair comparison with the current forfeit
(() => {
  if (LEGS.every((l) => actuals.legs[l.id])) return;   // season over: nothing left to map
  const real = buildData({ picks, actuals, odds, ratings, splash }), params = fitParams(real), e = lockedOnly(picks.entries[0]), spent = spentTeams(real, e.picks);
  const t0 = Date.now(); const sp = simPlan(real, e.picks, params); const ms = Date.now() - t0;
  ok("Simulation map finishes in a sane time (a worker runs it in the page; CI runners are slow)", ms < 20000, `${ms} ms`);
  ok("Simulation map fills every open week with distinct, unspent teams", sp.plan.length > 0 && sp.plan.every((q) => q.team) && new Set(sp.plan.map((q) => q.team)).size === sp.plan.length && sp.plan.every((q) => !spent.has(q.team)), sp.plan.map((q) => `${q.leg.id} ${q.team} ${Math.round(100 * q.held)}%`).join(" "));
  const rows = Object.values(sp.rows);
  ok("every playout forfeit is at least 1 and finite", rows.length > 0 && rows.every((r) => r.forfeit >= 1 && Number.isFinite(r.forfeit)), `${rows.length} candidates`);
  ok("this week's pick is the top EV ÷ playout forfeit", sp.plan[0].team === Object.keys(sp.rows).sort((a, b) => sp.rows[b].dili - sp.rows[a].dili)[0]);
  ok("expected win-out sits in a sane range", sp.winOut > 0.0005 && sp.winOut < 1, `${(100 * sp.winOut).toFixed(2)}%`);
  ok("later-week shares are shares", sp.plan.slice(1).every((q) => q.held > 0 && q.held <= 1 + 1e-9));
  const same = simPlan(real, e.picks, params); ok("same inputs, same simulation", same === sp || same.plan.map((q) => q.team).join() === sp.plan.map((q) => q.team).join());
  const both = rows.filter((r) => r.oldForfeit != null && Number.isFinite(r.oldForfeit));
  const corr = (() => { const n = both.length, mx = both.reduce((a, r) => a + Math.log(r.forfeit), 0) / n, my = both.reduce((a, r) => a + Math.log(r.oldForfeit), 0) / n; const sxy = both.reduce((a, r) => a + (Math.log(r.forfeit) - mx) * (Math.log(r.oldForfeit) - my), 0), sx = Math.sqrt(both.reduce((a, r) => a + (Math.log(r.forfeit) - mx) ** 2, 0)), sy = Math.sqrt(both.reduce((a, r) => a + (Math.log(r.oldForfeit) - my) ** 2, 0)); return sx && sy ? sxy / (sx * sy) : 0; })();
  ok("playout forfeits broadly agree with the current forfeits (comparison phase)", corr > 0.3 || both.every((r) => Math.abs(r.forfeit - 1) < 1e-9), `correlation ${corr.toFixed(2)} over ${both.length} teams`);
})();

// picks the entry has entered for open weeks are taken as given by both Claude maps
(() => {
  if (LEGS.every((l) => actuals.legs[l.id])) return;   // season over: nothing left to map
  const real = buildData({ picks, actuals, odds, ratings, splash }), params = fitParams(real), e = lockedOnly(picks.entries[0]);
  const tab = seasonTable(real, params), now = LEGS[tab.nowIdx].id, spent = spentTeams(real, e.picks);
  const base = rulesPlan(real, e.picks, params), baseSim = simPlan(real, e.picks, params);
  const team = (m, id) => m.plan.find((q) => q.leg.id === id)?.team;
  // enter a current-week pick that is not Claude's, plus two later ones
  const nowPick = Object.keys(OPP[now]).find((t) => !spent.has(t) && t !== base.plan[0].team && (lineFor(now, t, real)?.win ?? 0) > 0.6);
  // two later open, non-holiday weeks, each with an unspent team that is not Claude's pick there
  const regular = LEGS.slice(tab.nowIdx + 1).filter((l) => !l.holiday).map((l) => l.id), laterIds = regular.length >= 3 ? [regular[0], regular[2]] : regular.slice(0, 2);
  const chosen = new Set([nowPick]), later = laterIds.map((id) => { const t = Object.keys(OPP[id]).find((t) => !spent.has(t) && !chosen.has(t) && t !== team(base, id) && (lineFor(id, t, real)?.win ?? 0) > 0.5); chosen.add(t); return [id, t]; });
  if (!nowPick || later.length < 2 || later.some(([, t]) => !t)) { ok("entered-picks checks need two later weeks (skipped late in the season)", true); return; }
  const [[L1, T1], [L2, T2]] = later;
  const mine = { ...e.picks, [now]: nowPick, [L1]: T1, [L2]: T2 };
  const rp = rulesPlan(real, mine, params), sp = simPlan(real, mine, params);
  ok("both maps keep every entered pick in its week", [rp, sp].every((m) => team(m, now) === nowPick && team(m, L1) === T1 && team(m, L2) === T2), `${now} ${nowPick}, ${L1} ${T1}, ${L2} ${T2}`);
  ok("an entered team is not used in any other week", [rp, sp].every((m) => m.plan.filter((q) => [nowPick, T1, T2].includes(q.team)).length === 3));
  ok("entered rows are marked, the rest are not", [rp, sp].every((m) => m.plan.filter((q) => q.fixed).map((q) => q.leg.id).sort().join() === [now, L1, L2].sort().join()));
  ok("both maps still fill every week with distinct teams", [rp, sp].every((m) => m.plan.every((q) => q.team) && new Set(m.plan.map((q) => q.team)).size === m.plan.length));
  ok("each entered pick reports Claude's alternative and a cost of 0 or more", [rp, sp].every((m) => [now, L1, L2].every((id) => m.notes[id] && m.notes[id].cost >= 0 && m.notes[id].cost < 1)), `rules ${now}: ${rp.notes[now]?.claude} (${(100 * rp.notes[now]?.cost).toFixed(1)}%), ${L1} ${rp.notes[L1]?.claude} (${(100 * rp.notes[L1]?.cost).toFixed(1)}%)`);
  ok("this week's alternative is Claude's own pick without the entries", rp.notes[now].claude === base.plan[0].team && sp.notes[now].claude === baseSim.plan[0].team);
  ok("entering picks can only lower the win-out at today's lines", rp.winOut <= base.winOut + 1e-12, `${(100 * rp.winOut).toFixed(3)}% ≤ ${(100 * base.winOut).toFixed(3)}%`);
  ok("no entries, no notes", Object.keys(base.notes).length === 0 && Object.keys(baseSim.notes).length === 0);
  // given the entries, no legal swap improves the Rule map's other later weeks
  const xm = LEGS.findIndex((l) => l.id === "XM"), K = (id) => LEGS.findIndex((l) => l.id === id), held = new Set(rp.held), idx = (t) => ALL_TEAMS.indexOf(t);
  const cost = (k, t) => { const i = idx(t), z = tab.z[k][i]; return Number.isNaN(z) || (k < xm && held.has(t)) ? Infinity : -(Math.log(expWin(tab, k, i)) + tab.ff[k][i]); };
  const rows = rp.plan.filter((q) => q.planned && !q.fixed), used = new Set(rp.plan.map((q) => q.team)), bad = [];
  rows.forEach((q) => { const k = K(q.leg.id), c = cost(k, q.team); for (const t of Object.keys(OPP[q.leg.id])) if (!used.has(t) && !spent.has(t) && cost(k, t) < c - 1e-9) bad.push(`${q.leg.id} ${q.team}→${t}`); });
  for (let a = 0; a < rows.length; a++) for (let b = a + 1; b < rows.length; b++) { const ka = K(rows[a].leg.id), kb = K(rows[b].leg.id); if (cost(ka, rows[b].team) + cost(kb, rows[a].team) < cost(ka, rows[a].team) + cost(kb, rows[b].team) - 1e-9) bad.push(`swap ${rows[a].leg.id}/${rows[b].leg.id}`); }
  ok("with entries, no legal swap improves the Rule map's other weeks", bad.length === 0, bad.join(", "));
  // an entered Thursday pick whose game is over stays the pick and is not planned again
  const thu = Object.keys(OPP[now]).find((t) => !OPP[now][t].home && !spent.has(t)), opp = OPP[now][thu].opp, sp2 = JSON.parse(JSON.stringify(splash));
  sp2.weeks[now] = { thursday: { asOf: "2026-10-16T00:30:00Z", alive: 2500, picks: { [thu]: 100, [opp]: 100 }, final: { [thu]: "W", [opp]: "L" } } };
  const d2 = buildData({ picks, actuals, odds, ratings, splash: sp2 }), p2 = fitParams(d2), mine2 = { ...e.picks, [now]: thu };
  const ms = simPlan(d2, mine2, p2), mr = rulesPlan(d2, mine2, p2);
  ok("an entered Thursday team whose game is over stays the pick on both maps", team(ms, now) === thu && team(mr, now) === thu && ms.plan[0].fixed && mr.plan[0].fixed, `${thu} won Thursday`);
  ok("and is not planned again later", [ms, mr].every((m) => m.plan.filter((q) => q.team === thu).length === 1));
  // a Christmas team entered before Thanksgiving is not held
  const xmTeam = rp.held[0], wk = LEGS.slice(tab.nowIdx + 1).find((l) => !l.holiday && OPP[l.id][xmTeam])?.id, early = { ...e.picks, [wk]: xmTeam };
  const re = rp.active && wk ? rulesPlan(real, early, params) : null;
  if (re) ok("a held Christmas team entered earlier is used there, and three others are held", team(re, wk) === xmTeam && !re.held.includes(xmTeam) && re.held.length === Math.min(3, re.pool.length), `${xmTeam} in W8; held ${re.held.join(", ")}`);
})();

// futures prior: monotone in title odds, centered, on a points scale
const probs = Object.fromEntries(ALL_TEAMS.map((t, i) => [t, 0.002 + 0.006 * i]));
const prior = priorFromFutures(probs);
ok("prior follows the odds", prior[ALL_TEAMS[31]] > prior[ALL_TEAMS[15]] && prior[ALL_TEAMS[15]] > prior[ALL_TEAMS[0]]);
ok("prior centered and points-scaled", Math.abs(Object.values(prior).reduce((a, b) => a + b, 0)) < 1 && Math.max(...Object.values(prior)) < 12 && Math.max(...Object.values(prior)) > 3);
ok("prior needs most teams", priorFromFutures({ KC: 0.1, BUF: 0.1 }) === null);
if (fails) { console.log(`${fails} FAILED`); process.exit(1); }
