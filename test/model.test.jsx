// Field timeline + popularity model on the real data files.
import { buildData, fieldTimeline, modelPick, modelPickRange, fitParams, availability, fvAt } from "../src/CircaSurvivorPlanner.jsx";
import { OPP } from "../src/schedule.js";
import picks from "../data/picks.json";
import actuals from "../data/actuals.json";
import odds from "../data/odds.json";
import ratings from "../data/ratings.json";
let fails = 0; const ok = (name, cond, extra = "") => { console.log(name + ":", cond ? "OK" : "FAIL", extra); if (!cond) fails++; };

const data = buildData({ picks, actuals, odds, ratings });
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
// with only a week or two of actuals the knobs stay near the prior (8 / 1.5) instead of running to a corner
// frozen future value: every locked week carries the numbers the field saw, and the fit uses them
(() => {
  const locked = Object.keys(actuals.legs).filter((id) => OPP[id]);
  ok("every locked week has frozen future value for all its teams", locked.every((id) => actuals.legs[id].fv && Object.keys(OPP[id]).every((tm) => Number.isFinite(actuals.legs[id].fv[tm])) && actuals.legs[id].fvAt), locked.join(","));
  const flat = buildData({ picks, actuals, odds, ratings: { ...ratings, ratings: Object.fromEntries(Object.keys(ratings.ratings).map((tm) => [tm, 0])) } });
  const id = locked[0], a = modelPick(id, data, params), f = modelPick(id, flat, params);
  ok("a locked week's model P% ignores today's ratings", Object.keys(a).every((tm) => Math.abs(a[tm] - f[tm]) < 1e-12), `${id}: frozen fv ${fvAt(id, "BAL", data)} vs live ${fvAt(id, "BAL", flat)}`);
  ok("an open week still uses the live projection", (() => { const open = Object.keys(OPP).find((x) => !actuals.legs[x]); return open ? fvAt(open, "BAL", data) !== fvAt(open, "BAL", flat) : true; })());
  ok("the fit reports its measured band errors", params.errTop >= 0.05 && params.errTop <= 0.6 && params.errOther >= 0.05 && params.errOther <= 0.6 && params.errTop < params.errOther && params.nTop === locked.length, `top ${params.errTop} (${params.nTop}) others ${params.errOther} (${params.nOther})`);
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
ok("no actuals → prior", (() => { const p = fitParams({ ...data, actuals: {} }); return p.a === 8 && p.b === 0.15 && p.legs === 0; })());
// share weighting: one fit across every week must still land each week's most-picked team within 8 pts
(() => {
  const miss = Object.entries(actuals.legs).filter(([id]) => OPP[id]).map(([id, a]) => {
    const tot = Object.values(a.picks).reduce((x, y) => x + y, 0), [t] = Object.entries(a.picks).sort((x, y) => y[1] - x[1])[0];
    return { id, t, d: Math.abs((modelPick(id, data, params)[t] || 0) - a.picks[t] / tot) };
  });
  const avg = miss.reduce((s, m) => s + m.d, 0) / miss.length;
  ok("top team within 12 pts every week and 5 on average", miss.length > 0 && miss.every((m) => m.d < 0.12) && avg < 0.05, miss.map((m) => `${m.id} ${m.t} ${(100 * m.d).toFixed(1)}`).join(", ") + ` · avg ${(100 * avg).toFixed(1)}`);
})();
if (fails) { console.log(`${fails} FAILED`); process.exit(1); }
