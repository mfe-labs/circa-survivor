// Freeze every team's future value for any week that has just locked, so the popularity fit always sees the
// numbers the field saw. Runs after fetch-actuals in the results job: a leg that has Circa's picks but no `fv`
// yet gets one, computed from the ratings and lines on disk right now (the Saturday refresh before lock).
// Never recomputes an existing freeze. Bundled with esbuild (npm run freeze-fv) because it shares the app's
// projection code.
import { readFileSync, writeFileSync } from "node:fs";
import { buildData, fvFor } from "../src/CircaSurvivorPlanner.jsx";
import { OPP, LEGS } from "../src/schedule.js";

const read = (p) => JSON.parse(readFileSync(p, "utf8"));
const picks = read("data/picks.json"), actuals = read("data/actuals.json"), odds = read("data/odds.json"), ratings = read("data/ratings.json");
const data = buildData({ picks, actuals, odds, ratings });
let changed = 0;
for (const l of LEGS) {
  const a = actuals.legs[l.id];
  if (!a || a.fv) continue;
  const fv = {};
  for (const t of Object.keys(OPP[l.id])) fv[t] = +fvFor(l.id, t, data).toFixed(2);
  a.fv = fv; a.fvAt = ratings.updatedAt || odds.updatedAt || new Date().toISOString();
  changed++;
  console.log(`${l.id}: future value frozen for ${Object.keys(fv).length} teams (ratings ${a.fvAt})`);
}
if (changed) writeFileSync("data/actuals.json", JSON.stringify(actuals, null, 1) + "\n");
else console.log("nothing to freeze");
