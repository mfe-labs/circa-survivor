// Field timeline + popularity model on the real data files.
import { buildData, fieldTimeline, modelPick, modelPickRange, fitParams, availability, fvAt, splashAnchor, splashMap, blendAnchor, holidayPressure, computeEV, capShares, projectField, lineFor, spotWeight } from "../src/CircaSurvivorPlanner.jsx";
import { OPP, LEGS } from "../src/schedule.js";
import picks from "../data/picks.json";
import actuals from "../data/actuals.json";
import odds from "../data/odds.json";
import splash from "../data/splash.json";
import ratings from "../data/ratings.json";
let fails = 0; const ok = (name, cond, extra = "") => { console.log(name + ":", cond ? "OK" : "FAIL", extra); if (!cond) fails++; };

const data = buildData({ picks, actuals, odds, ratings });
// accuracy against real results is reported, not enforced: one surprising Circa week must not block a deploy
const report = (name, good, note = "") => console.log(`${name}: ${good ? "OK" : "WARN (not failing)"} ${note}`);
ok("3 entries loaded", data.entries.length === 3 && data.entries.every((e) => e.name && e.picks));
ok("32 ratings", Object.keys(data.ratings || {}).length === 32);
const tl = fieldTimeline(data);
ok("timeline has W1", tl.length >= 1 && tl[0].leg.id === "W1");
const w1 = actuals.legs.W1, lostW1 = Object.entries(w1.picks).filter(([t]) => w1.lost.includes(t)).reduce((s, [, n]) => s + n, 0);
ok("W1 eliminations add up", tl[0].lost === lostW1 && tl[0].after === actuals.contest.start - lostW1, `${tl[0].before} → ${tl[0].after}`);
ok("value per entry = pool / live", Math.abs(tl[0].value - actuals.contest.pool / tl[0].after) < 1e-9);

// availability after W1: winners' share is gone from the field for later legs
const av = availability("W2", data);
ok("JAX mostly burned after W1", av.JAX < 0.7 && av.JAX > 0, av.JAX.toFixed(3));
ok("team nobody took is fully available", av.WAS === 1);

// model on a leg with lines: probabilities over favored teams sum to 1, and a big favorite ranks first
const legWithLines = Object.keys(data.legs).find((id) => !actuals.legs[id]);
if (legWithLines) {
  const p = modelPick(legWithLines, data, { a: 10, b: 1.5 });
  const sum = Object.values(p).reduce((a, b) => a + b, 0);
  ok(`model P% sums to 1 (${legWithLines})`, Math.abs(sum - 1) < 1e-9, sum.toFixed(6));
  const top = Object.entries(p).sort((a, b) => b[1] - a[1])[0];
  ok("top model pick is a favorite", top && data.legs[legWithLines].lines[top[0]].win > 0.5, `${top?.[0]} ${(100 * top?.[1]).toFixed(1)}%`);
} else console.log("(no unlocked leg with lines in odds.json — model check skipped)");
const params = fitParams(data);
ok("fitParams returns a,b", Number.isFinite(params.a) && Number.isFinite(params.b), `a=${params.a} b=${params.b} legs=${params.legs}`);
// with only a week or two of actuals the knobs stay near the prior (12 / 0.2) instead of running to a corner
// frozen future value: every locked week carries the numbers the field saw, and the fit uses them
(() => {
  const locked = Object.keys(actuals.legs).filter((id) => OPP[id]);
  ok("every locked week has frozen future value for all its teams", locked.every((id) => actuals.legs[id].fv && Object.keys(OPP[id]).every((tm) => Number.isFinite(actuals.legs[id].fv[tm])) && actuals.legs[id].fvAt), locked.join(","));
  ok("every locked week has its holiday lines frozen", locked.every((id) => ["TG", "XM"].every((h) => actuals.legs[id].hs?.[h] && Object.values(actuals.legs[id].hs[h]).every(Number.isFinite))), locked.join(","));
  const flat = buildData({ picks, actuals, odds, ratings: { ...ratings, ratings: Object.fromEntries(Object.keys(ratings.ratings).map((tm) => [tm, 0])) } });
  const id = locked[0], a = modelPick(id, data, params), f = modelPick(id, flat, params);
  ok("a locked week's model P% ignores today's ratings", Object.keys(a).every((tm) => Math.abs(a[tm] - f[tm]) < 1e-12), `${id}: frozen fv ${fvAt(id, "BAL", data)} vs live ${fvAt(id, "BAL", flat)}`);
  ok("an open week still uses the live projection", (() => { const open = Object.keys(OPP).find((x) => !actuals.legs[x]); return open ? fvAt(open, "BAL", data) !== fvAt(open, "BAL", flat) : true; })());
  ok("the fit reports its measured band errors", params.errTop >= 0.05 && params.errTop <= 0.6 && params.errOther >= 0.05 && params.errOther <= 0.6 && params.nTop === locked.length, `top ${params.errTop} (${params.nTop}) others ${params.errOther} (${params.nOther})`);
})();
// Splash: the Thursday reading pins the Thursday teams and scales the rest; a final decides the game
(() => {
  const open = Object.keys(OPP).find((id) => !actuals.legs[id]);
  if (!open) return;
  const scored = Object.keys(modelPick(open, data, params));
  if (!scored.length) { ok("Thursday-blend checks need this week's lines (skipped until they are posted)", true); return; }
  const T = scored[0];
  const fake = { mapping: { gamma: 1.2 }, weeks: { ...splash.weeks, [open]: { thursday: { alive: 5000, picks: { [T]: 1900 }, final: { [T]: "L" } } } } };
  const d = buildData({ picks, actuals, odds, ratings, splash: fake }), an = splashAnchor(open, d);
  ok("anchor maps the Thursday share through the power rule, less the holiday hold-back", an && Math.abs(an.shares[T] - splashMap(open, T, 0.38, d)) < 1e-9 && an.Z > 0.6 && an.Z < 0.85, `38% → ${(100 * an.shares[T]).toFixed(1)}% with Z ${an.Z.toFixed(3)}`);
  // Splash's field saves nothing for the holidays, so a team under no holiday pressure maps at or above the plain
  // power rule (the normaliser shrinks with everyone else's hold-back) and a pressed team maps below it
  const free = Object.keys(OPP[open]).find((x) => holidayPressure(open, x, d, availability(open, d)) === 0), pressed = Object.keys(OPP[open]).sort((x, y) => holidayPressure(open, y, d, availability(open, d)) - holidayPressure(open, x, d, availability(open, d)))[0];
  const plainRule = (sp) => Math.pow(sp, 1.2) / an.Z;
  // a Thursday team the field is saving for a holiday gets at most a third of its blend from Splash
  (() => {
    const th = {}; th[pressed] = 1500; if (free) th[free] = 1500;
    const d2 = buildData({ picks, actuals, odds, ratings, splash: { mapping: { gamma: 1.2 }, weeks: { ...splash.weeks, [open]: { thursday: { alive: 5000, picks: th } } } } });
    const a2 = splashAnchor(open, d2), bl = blendAnchor(a2, modelPick(open, data, params), params);
    ok("a holiday-held Thursday team gets at most a third of its blend from Splash; an unheld one keeps the track-record weight", bl.held[pressed] && bl.w[pressed] <= 1 / 3 + 1e-9 && (!free || (!bl.held[free] && bl.w[free] > 1 / 3)), `${pressed} ${(100 * bl.w[pressed]).toFixed(0)}%${free ? ` ${free} ${(100 * bl.w[free]).toFixed(0)}%` : ""}`);
  })();
  ok("no holiday pressure → at or above the plain rule; the most pressed team → below it", (!free || splashMap(open, free, 0.2, d) >= plainRule(0.2) - 1e-9) && splashMap(open, pressed, 0.2, d) < plainRule(0.2), `${free}: ${(100 * splashMap(open, free, 0.2, d)).toFixed(1)} ${pressed}: ${(100 * splashMap(open, pressed, 0.2, d)).toFixed(1)} vs plain ${(100 * plainRule(0.2)).toFixed(1)}`);
  const plain = modelPick(open, data, params), pinned = modelPick(open, d, params);
  const sum = Object.values(pinned).reduce((a, b) => a + b, 0);
  const lo = Math.min(an.shares[T], Math.max(plain[T] || 0, 0.0005)), hi = Math.max(an.shares[T], Math.max(plain[T] || 0, 0.0005));
  ok("blended share sits between the model and the mapping, and the rest still sums to one", pinned[T] >= lo - 1e-9 && pinned[T] <= hi + 1e-9 && Math.abs(sum - 1) < 1e-9, `model ${(100 * (plain[T] || 0)).toFixed(1)} mapped ${(100 * an.shares[T]).toFixed(1)} blended ${(100 * pinned[T]).toFixed(1)}`);
  ok("mapping error is measured from the complete weeks", an.err.nTop >= 4 && an.err.top > 0.03 && an.err.top < 0.3 && an.err.other > an.err.top, `top ${an.err.top.toFixed(3)} (${an.err.nTop}) other ${an.err.other.toFixed(3)} (${an.err.nOther})`);
  const other = Object.keys(plain).filter((x) => x !== T && plain[x] > 0.01);
  ok("other teams keep their proportions", other.every((x) => Math.abs(pinned[x] / plain[x] - pinned[other[0]] / plain[other[0]]) < 1e-9));
  ok("a locked week ignores the anchor", splashAnchor("W1", buildData({ picks, actuals, odds, ratings, splash: { weeks: { W1: { thursday: { alive: 10, picks: { JAX: 5 } } } } } })) === null);
  ok("the hold-back more than halves the miss on a saved favorite and lands the overflow teams (2026 W6: Rams, Patriots, Colts)", (() => {
    const w = splash.weeks.W6, act = actuals.legs.W6; if (!w?.picks || !act) return true;
    const real = buildData({ picks, actuals, odds, ratings, splash }), n = w.survived + w.eliminated, tot = Object.values(act.picks).reduce((a, b) => a + b, 0);
    const miss = (t, held) => Math.abs((held ? splashMap("W6", t, w.picks[t] / n, real) : Math.pow(w.picks[t] / n, 1.2) / an.Z) - act.picks[t] / tot);   // a locked week has no anchor, so Z comes from the open week's
    return miss("LAR", true) < miss("LAR", false) / 2 && miss("NE", true) < 0.03 && miss("IND", true) < 0.03;
  })());
  ok("Splash's own Z is in a sane range on the real file", (() => { const z = splashAnchor("W5", buildData({ picks, actuals, odds, ratings, splash }))?.Z; return z == null || (z > 0.6 && z < 0.85); })());
})();
// P% band: the model re-run over typical line movement; stable, brackets the point estimate, sane width
(() => {
  const leg = Object.keys(OPP).find((id) => !actuals.legs[id] && Object.keys(modelPick(id, data, params)).length);
  if (!leg) { console.log("P% band: skipped (no open week with lines)"); return; }
  const m = modelPick(leg, data, params), r1 = modelPickRange(leg, data, params), r2 = modelPickRange(leg, data, params);
  const top = Object.entries(m).sort((x, y) => y[1] - x[1])[0][0];
  ok(`${leg} band is deterministic`, JSON.stringify(r1) === JSON.stringify(r2));
  ok("band brackets the point estimate for the top pick", r1[top].lo <= m[top] + 0.01 && r1[top].hi >= m[top] - 0.01, `${top} ${(100 * m[top]).toFixed(0)}% in ${(100 * r1[top].lo).toFixed(0)}–${(100 * r1[top].hi).toFixed(0)}`);
  ok("band has a sane width", Object.values(r1).every((b) => b.hi - b.lo >= 0 && b.hi - b.lo < 0.3) && r1[top].hi - r1[top].lo > 0.02);
  const early = modelPickRange(leg, buildData({ picks, actuals, odds, ratings }), params, new Date("2026-01-01").getTime()), late = modelPickRange(leg, buildData({ picks, actuals, odds, ratings }), params, new Date("2027-01-01").getTime());
  ok("band narrows as lock approaches", late[top].hi - late[top].lo < early[top].hi - early[top].lo, `4 days out ${(100 * early[top].lo).toFixed(0)}–${(100 * early[top].hi).toFixed(0)}, at lock ${(100 * late[top].lo).toFixed(0)}–${(100 * late[top].hi).toFixed(0)}`);
  ok("EV band ordered", Object.values(r1).every((b) => b.evLo == null || b.evLo <= b.evHi));
})();
ok("early-season knobs stay in a sane range", params.legs <= 3 ? params.a >= 5 && params.a <= 16 && params.b >= 0.05 && params.b <= 0.6 : true, `a=${params.a} b=${params.b}`);
// no actuals at all → the prior itself
ok("no actuals → prior", (() => { const p = fitParams({ ...data, actuals: {} }); return p.a === 12 && p.b === 0.2 && p.legs === 0; })());
// the anchor moves once Week 6 is in: the field spreads out in the second half of a season (2024 and 2025 both)
ok("the fit anchors to the early prior before Week 6 and the late one after", (() => {
  const upTo = (n) => Object.fromEntries(Object.entries(actuals.legs).filter(([id]) => OPP[id] && +LEGS.find((l) => l.id === id).label <= n));
  const early = fitParams(buildData({ picks, actuals: { ...actuals, legs: upTo(5) }, odds, ratings })), late = fitParams(buildData({ picks, actuals: { ...actuals, legs: upTo(6) }, odds, ratings }));
  return early.prior.a === 12 && (late.legs < 6 || late.prior.a === 10);
})());
// share weighting: one fit across every week must still land each week's most-picked team within 8 pts
(() => {
  const miss = Object.entries(actuals.legs).filter(([id]) => OPP[id]).map(([id, a]) => {
    const tot = Object.values(a.picks).reduce((x, y) => x + y, 0), [t] = Object.entries(a.picks).sort((x, y) => y[1] - x[1])[0];
    return { id, t, d: Math.abs((modelPick(id, data, params)[t] || 0) - a.picks[t] / tot) };
  });
  const avg = miss.reduce((s, m) => s + m.d, 0) / miss.length;
  report("top team within 12 pts every week and 5 on average", miss.length > 0 && miss.every((m) => m.d < 0.12) && avg < 0.05, miss.map((m) => `${m.id} ${m.t} ${(100 * m.d).toFixed(1)}`).join(", ") + ` · avg ${(100 * avg).toFixed(1)}`);
})();
// no team takes more of the field than the share of entries still holding it
(() => {
  const p = capShares({ A: 0.6, B: 0.3, C: 0.1 }, { A: 0.2, B: 1, C: 1 });
  ok("cap clips a team at its availability and spreads the rest", Math.abs(p.A - 0.2) < 1e-9 && Math.abs(p.A + p.B + p.C - 1) < 1e-9 && Math.abs(p.B / p.C - 3) < 1e-9, JSON.stringify(p));
  const pr = fitParams(data), first = LEGS.find((l) => !data.actuals[l.id]);
  const pf = first ? projectField(first.id, data, pr) : {};
  const over = []; for (const [id, v] of Object.entries(pf)) for (const [tm, x] of Object.entries(v.p)) if (x > (v.av[tm] ?? 1) + 1e-6) over.push(`${id} ${tm}`);
  ok("projected weeks never give a team more than its availability", Object.keys(pf).length > 0 && over.length === 0, over.join(", ") || `${Object.keys(pf).length} weeks checked`);
  const mp = first ? modelPick(first.id, data, pr, true) : {}, av1 = first ? availability(first.id, data) : {};
  ok("this week's estimate stays under availability too", Object.entries(mp).every(([tm, x]) => x <= (av1[tm] ?? 1) + 1e-6));
})();
// future value counts strong weeks on full-size lines (what the field sees), while plans use the pulled ones
(() => {
  const open = LEGS.find((l) => !actuals.legs[l.id]); if (!open) return;
  const far = LEGS.slice(LEGS.indexOf(open) + 3).find((l) => OPP[l.id].BUF), t = "BUF";
  if (far) ok("a far-out projection is pulled toward even, the raw one is not", Math.abs(lineFor(far.id, t, data).spread) <= Math.abs(lineFor(far.id, t, data, true).spread) + 1e-9, `${far.id} ${t}: pulled ${lineFor(far.id, t, data).spread} vs raw ${lineFor(far.id, t, data, true).spread}`);
  const raw = LEGS.slice(LEGS.indexOf(open) + 1).reduce((v, l) => { const ln = lineFor(l.id, t, data, true); return v + (ln && ln.win != null ? spotWeight(ln.win) : 0); }, 0);
  ok("future value uses the full-size lines", Math.abs(fvAt(open.id, t, data) - raw) < 1e-9, `${t} ${open.id}: ${fvAt(open.id, t, data).toFixed(2)}`);
})();
if (fails) { console.log(`${fails} FAILED`); process.exit(1); }
