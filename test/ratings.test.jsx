// Power-rating fit recovers known ratings from synthetic spreads, and shrinks with no data.
import { fitRatings, HFA } from "../src/ratings.js";
import { restEdge, nflWeek, REST_PTS } from "../src/schedule.js";
import { ALL_TEAMS, LEGS, OPP } from "../src/schedule.js";
let fails = 0; const ok = (name, cond, extra = "") => { console.log(name + ":", cond ? "OK" : "FAIL", extra); if (!cond) fails++; };

// true ratings: evenly spread −8..+8, mean 0
const truth = Object.fromEntries(ALL_TEAMS.map((t, i) => [t, Math.round(((i / 31) * 16 - 8) * 10) / 10]));
const mean = Object.values(truth).reduce((a, b) => a + b, 0) / 32;
for (const t of ALL_TEAMS) truth[t] = Math.round((truth[t] - mean) * 10) / 10;
// spreads for the first 6 legs of the real schedule, exactly consistent with truth + HFA
const games = [];
for (const leg of LEGS.slice(0, 6)) for (const [t, g] of Object.entries(OPP[leg.id])) if (g.home) games.push({ home: t, away: g.opp, neutral: g.neutral, margin: truth[t] - truth[g.opp] + (g.neutral ? 0 : HFA) });
const { ratings, games: used } = fitRatings(games, { lambda: 0.01 });
const maxErr = Math.max(...ALL_TEAMS.map((t) => Math.abs(ratings[t] - truth[t])));
ok(`recovers truth from ${used} games`, maxErr <= 0.15, `max error ${maxErr.toFixed(2)}`);
ok("ratings centered on 0", Math.abs(Object.values(ratings).reduce((a, b) => a + b, 0)) < 0.5);
const empty = fitRatings([], { lambda: 2, prior: { KC: 5 } });
ok("no games → prior", empty.games === 0 && empty.ratings.KC > 4 && empty.ratings.ARI < 0, `KC ${empty.ratings.KC}`);
const shrunk = fitRatings(games.slice(0, 16), { lambda: 3 });
ok("heavy shrinkage narrows the spread", Math.max(...Object.values(shrunk.ratings)) < Math.max(...Object.values(truth)));
// byes: a team that did not play last week gets REST_PTS over an opponent that did; week 1 and the holiday legs count by NFL week
(() => {
  const byes = [];
  for (const l of LEGS) for (const t of Object.keys(OPP[l.id])) { const e = restEdge(l.id, t); if (e) byes.push({ leg: l.id, t, e }); }
  ok("some teams come off byes during the season", byes.length > 10, `${byes.length} team-games with a rest edge`);
  ok("rest edges are ±1 and opposite for the two sides", byes.every((b) => Math.abs(b.e) === 1 && restEdge(b.leg, OPP[b.leg][b.t].opp) === -b.e));
  ok("nobody is off a bye in Week 1", Object.keys(OPP.W1).every((t) => restEdge("W1", t) === 0));
  ok("holiday legs sit in Weeks 12 and 16", nflWeek(LEGS.find((l) => l.id === "TG")) === 12 && nflWeek(LEGS.find((l) => l.id === "XM")) === 16);
  const b = byes[0], truthRest = { [b.t]: 3, [OPP[b.leg][b.t].opp]: 0 };
  const g = OPP[b.leg][b.t], home = g.home ? b.t : g.opp, away = g.home ? g.opp : b.t;
  const fit = fitRatings([{ home, away, neutral: g.neutral, rest: restEdge(b.leg, home), margin: (truthRest[home] || 0) - (truthRest[away] || 0) + (g.neutral ? 0 : HFA) + REST_PTS * restEdge(b.leg, home) }], { lambda: 0.001 });
  ok("the fit takes the bye edge out before rating the teams", Math.abs((fit.ratings[home] - fit.ratings[away]) - ((truthRest[home] || 0) - (truthRest[away] || 0))) < 0.05, `${home} − ${away} = ${(fit.ratings[home] - fit.ratings[away]).toFixed(2)}`);
})();
if (fails) { console.log(`${fails} FAILED`); process.exit(1); }
