// The holiday term in the popularity model: how hard the field should be holding a team back.
import { buildData, holidayPressure, modelPick, availability, fitParams } from "../src/CircaSurvivorPlanner.jsx";
import { LEGS, OPP, ALL_TEAMS, TG_TEAMS, XM_TEAMS } from "../src/schedule.js";
import picks from "../data/picks.json"; import actuals from "../data/actuals.json"; import odds from "../data/odds.json"; import ratings from "../data/ratings.json";
let fails = 0; const ok = (name, cond, extra = "") => { console.log(name + ":", cond ? "OK" : "FAIL", extra); if (!cond) fails++; };
const data = buildData({ picks, actuals, odds, ratings });
const P = (leg, team) => holidayPressure(leg, team, data, availability(leg, data));

ok("a team in neither pool feels nothing", P("W3", "CIN") === 0 && P("W9", "NYG") === 0);
ok("both pools beats one", P("W3", "BUF") > P("W3", "KC") && P("W3", "KC") > 0, `BUF ${P("W3","BUF").toFixed(3)} vs KC ${P("W3","KC").toFixed(3)}`);
ok("Christmas-only is felt too", P("W3", "SEA") > 0 && !TG_TEAMS.has("SEA") && XM_TEAMS.has("SEA"));
ok("pressure grows as the holiday nears", P("W11", "BUF") > P("W9", "BUF") && P("W9", "BUF") > P("W3", "BUF"), `W3 ${P("W3","BUF").toFixed(3)} → W11 ${P("W11","BUF").toFixed(3)}`);
ok("a passed holiday stops counting", P("TG", "KC") === 0 && P("W12", "KC") === 0, "KC plays Thanksgiving only");
ok("nothing left to save for after Christmas", P("XM", "BUF") === 0 && P("W17", "BUF") === 0);
ok("Christmas presses harder than Thanksgiving at the same distance", (() => {
  const av = availability("W3", data);
  const tg = [...TG_TEAMS].reduce((s, t) => s + (av[t] ?? 1), 0), xm = [...XM_TEAMS].reduce((s, t) => s + (av[t] ?? 1), 0);
  return xm < tg;   // 8 eligible vs 10, so each Christmas team is a bigger slice of its pool
})());

// Effect on the model. Shares are normalised, so what decides the direction is a team's pressure
// relative to the field's average, not its raw value: a lightly pressed team can still gain.
const off = modelPick("W3", data, { a: 11, b: 0.26, c: 0 }), on = modelPick("W3", data, { a: 11, b: 0.26, c: 4 });
const live = Object.keys(OPP.W3).filter((t) => off[t] > 0.005);
const press = Object.fromEntries(live.map((t) => [t, P("W3", t)]));
ok("teams with no holiday exposure all gain share", live.filter((t) => press[t] === 0).every((t) => on[t] > off[t]));
ok("teams in both pools all lose share", live.filter((t) => TG_TEAMS.has(t) && XM_TEAMS.has(t)).every((t) => on[t] < off[t]));
ok("the more pressure, the worse a team does", (() => {
  const order = [...live].sort((x, y) => press[x] - press[y]).map((t) => on[t] / off[t]);
  return order.every((v, i) => i === 0 || v <= order[i - 1] + 1e-12);   // ratio falls as pressure rises
})());
ok("shares still add to 100%", Math.abs(Object.values(on).reduce((a, b) => a + b, 0) - 1) < 1e-9);
ok("c = 0 leaves the old model untouched", (() => { const a = modelPick("W2", data, { a: 11, b: 0.26 }), b = modelPick("W2", data, { a: 11, b: 0.26, c: 0 });
  return Object.keys(a).every((t) => Math.abs(a[t] - b[t]) < 1e-12); })());

const fit = fitParams(data);
ok("the fit reports all three knobs", Number.isFinite(fit.a) && Number.isFinite(fit.b) && Number.isFinite(fit.c), `a=${fit.a} b=${fit.b} c=${fit.c}`);
ok("with no holiday signal yet, the fit leaves it at zero", fit.c === 0, "September data cannot see the field saving November teams");
if (fails) { console.log(`${fails} FAILED`); process.exit(1); }
