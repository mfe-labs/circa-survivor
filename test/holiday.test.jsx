// The holiday term in the popularity model: how hard the field should be holding a team back.
import { buildData, holidayPressure, modelPick, availability, fitParams, lineFor } from "../src/CircaSurvivorPlanner.jsx";
import { LEGS, OPP, ALL_TEAMS, TG_TEAMS, XM_TEAMS } from "../src/schedule.js";
import picks from "../data/picks.json"; import actuals from "../data/actuals.json"; import odds from "../data/odds.json"; import ratings from "../data/ratings.json";
let fails = 0; const ok = (name, cond, extra = "") => { console.log(name + ":", cond ? "OK" : "FAIL", extra); if (!cond) fails++; };
const data = buildData({ picks, actuals, odds, ratings });
const P = (leg, team) => holidayPressure(leg, team, data, availability(leg, data));

ok("a team in neither pool feels nothing", P("W3", "CIN") === 0 && P("W9", "NYG") === 0);
ok("Christmas-only is felt too", XM_TEAMS.has("SEA") && !TG_TEAMS.has("SEA") && P("W3", "SEA") > 0);
// within one pool the pressure follows how good the holiday spot looks: a Thanksgiving-only team that is a bigger
// favorite on Thanksgiving is held back harder (same pool, same distance, same denominator); a locked week reads the
// holiday lines frozen at its lock
ok("a better holiday spot is pressed harder", (() => {
  const tgOnly = [...TG_TEAMS].filter((t) => !XM_TEAMS.has(t)).map((t) => [t, actuals.legs.W3?.hs?.TG?.[t] ?? lineFor("TG", t, data, true)?.win ?? 0.5, P("W3", t)]).sort((x, y) => x[1] - y[1]);
  return tgOnly.every((x, i) => i === 0 || x[2] >= tgOnly[i - 1][2] - 1e-12);
})());
const hot = [...TG_TEAMS, ...XM_TEAMS].sort((x, y) => P("W3", y) - P("W3", x))[0];
ok("pressure grows as the holiday nears", P("W11", hot) > P("W9", hot) && P("W9", hot) > P("W3", hot), `${hot}: W3 ${P("W3", hot).toFixed(3)} → W11 ${P("W11", hot).toFixed(3)}`);
ok("a passed holiday stops counting", P("TG", "KC") === 0 && P("W12", "KC") === 0, "KC plays Thanksgiving only");
ok("nothing left to save for after Christmas", P("XM", "BUF") === 0 && P("W17", "BUF") === 0);
// each pool's pressure is shared out by how good the spots look, weighted by who still holds each team, so across
// the whole pool it adds up to the distance discount alone: 0.8^(weeks to the holiday) per holiday
ok("a pool's pressure adds up to its distance discount", (() => {
  const idx = LEGS.findIndex((l) => l.id === "W3");
  const want = ["TG", "XM"].reduce((s, h) => s + Math.pow(0.8, LEGS.findIndex((l) => l.id === h) - idx), 0);
  const av = availability("W3", data);
  const got = ALL_TEAMS.reduce((s, t) => s + (av[t] ?? 1) * P("W3", t), 0);
  return Math.abs(got - want) < 1e-9;
})());

// Effect on the model. Shares are normalised, so what decides the direction is a team's pressure
// relative to the field's average, not its raw value: a lightly pressed team can still gain.
const off = modelPick("W3", data, { a: 11, b: 0.26, c: 0 }), on = modelPick("W3", data, { a: 11, b: 0.26, c: 4 });
const live = Object.keys(OPP.W3).filter((t) => off[t] > 0.005);
const press = Object.fromEntries(live.map((t) => [t, P("W3", t)]));
ok("teams with no holiday exposure all gain share", live.filter((t) => press[t] === 0).every((t) => on[t] > off[t]));
ok("the more pressure, the worse a team does", (() => {
  const order = [...live].sort((x, y) => press[x] - press[y]).map((t) => on[t] / off[t]);
  return order.every((v, i) => i === 0 || v <= order[i - 1] + 1e-12);   // ratio falls as pressure rises
})());
ok("shares still add to 100%", Math.abs(Object.values(on).reduce((a, b) => a + b, 0) - 1) < 1e-9);
ok("c = 0 leaves the old model untouched", (() => { const a = modelPick("W2", data, { a: 11, b: 0.26 }), b = modelPick("W2", data, { a: 11, b: 0.26, c: 0 });
  return Object.keys(a).every((t) => Math.abs(a[t] - b[t]) < 1e-12); })());

const fit = fitParams(data);
ok("the fit reports all three knobs", Number.isFinite(fit.a) && Number.isFinite(fit.b) && Number.isFinite(fit.c), `a=${fit.a} b=${fit.b} c=${fit.c}`);
ok("the holiday weight is the one set from past seasons, not refitted", fit.c === 4, `c=${fit.c}`);
if (fails) { console.log(`${fails} FAILED`); process.exit(1); }
