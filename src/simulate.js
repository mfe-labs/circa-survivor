// The playout engine behind the Simulation map (docs/PLAN-maps-redesign.md, step 2).
//
// The question it answers: if a team is spent now, and the rest of the season is then picked one week at a time with
// only the lines as they stand each week, how often does the entry win out? That is the question a survivor player
// actually faces, and it is where keeping a second option open has value: the simulated planner gets to use
// whichever held team turned out good. Nothing here knows about Christmas; optionality is priced by the arithmetic.
//
// Lines drift. Each future game's line is a random walk toward its close. The total movement by distance is set by
// sdLead(lead) (the app passes its measured noise sizes: about 1.5 pts one leg out, 3.5 at two, 3.75 at three, 4 at
// four, growing slowly beyond). The walk is driven by team-level shocks, so a team getting better or worse moves all
// its future games together: inside a playout, if Buffalo collapses, every Buffalo week collapses.
//
// Each playout: start from today's estimates; at each remaining leg, reveal that week's shocks, re-plan the rest
// with the survival solver on the updated estimates (expected win over the uncertainty still left), take that
// week's pick, multiply in its closing win chance, spend the team, continue. Outcomes are not coin-flipped (a loss
// just ends the season), so the product of closing win chances is the exact survival chance along a path; the only
// randomness is the path of the lines. Every candidate is scored on the same paths (common random numbers), so
// comparisons between candidates are smooth rather than noisy.
import { normCdf, hungarian, seededRng, gauss } from "./solver.js";

export const SIM_PLAYOUTS = 512, SIM_SEED = 20262, FLOOR = 0.02;
// How much of the foreseen line movement a later week's pick is credited with. The simulated planner still picks on
// the moved line (it sees it), but the week's realized win chance blends the moved line with today's. At 1 the
// playouts fully exploit every drift (one of several near-even games "usually" becomes a 67% favorite, which the
// closing-line data suggests happens less often than a bell curve says); at 0 nothing moves, the old maps' view.
export const SIM_TRUST = 0.7;   // 512 antithetic playouts: forfeits move ~±0.01 between seeds

// variance of the movement that turns a `lead`-legs-out estimate into a `lead − 1` one (sdLead(0) = 0: final)
export const incrementVar = (sdLead, lead) => { const a = sdLead(lead), b = lead > 1 ? sdLead(lead - 1) : 0; return Math.max(0, a * a - b * b); };

// Survival solver: the assignment of teams to `legs` maximizing Σ log E[win] (+ ff for the first leg when given),
// where E[win] = Φ(z ÷ √(1 + sd²)) averages a cell's win chance over the movement still ahead of it.
// zRows[k], sdRows[k] are per-team arrays for leg k; blocked(k, i) forbids a cell. Returns a team index per leg, −1 = nothing playable.
export function solve(zRows, sdRows, ffRows, legs, teams, blocked = null) {
  if (!legs.length || teams.length < legs.length) return legs.map(() => -1);
  const BIG = -Math.log(FLOOR);
  const cost = legs.map((k) => teams.map((i) => { const zz = zRows[k][i]; if (Number.isNaN(zz) || blocked?.(k, i)) return BIG; const s = sdRows[k][i]; return -(Math.log(normCdf(zz / Math.sqrt(1 + s * s))) + (ffRows ? ffRows[k]?.[i] || 0 : 0)); }));
  const a = hungarian(cost);
  return legs.map((k, j) => (cost[j][a[j]] >= BIG ? -1 : teams[a[j]]));
}

// fixed: { legIndex: teamIndex } for weeks the entry has already filled (those teams must be in `burned`)
function playout(z0, ff, legs, nTeams, burned, sdLead, opp, rng, blocked, sign = 1, trust = SIM_TRUST, fixed = null) {
  const z = {}; for (const k of legs) z[k] = Float64Array.from(z0[k]);
  const spent = burned.slice(), path = new Array(legs.length).fill(-1);
  let value = 1;
  for (let s = 0; s < legs.length; s++) {
    // reveal one week: every team draws a quality shock; a game's line moves by (own − opponent) × inc, where
    // inc² = half the increment variance for that lead, so the game's movement has exactly the increment variance
    const delta = new Float64Array(nTeams);
    for (let i = 0; i < nTeams; i++) delta[i] = sign * gauss(rng);
    for (let j = s; j < legs.length; j++) {
      const k = legs[j], inc = Math.sqrt(incrementVar(sdLead, j - s + 1) / 2);
      if (!inc) continue;
      const row = z[k];
      for (let i = 0; i < nTeams; i++) { if (Number.isNaN(row[i])) continue; const o = opp[k][i]; if (o < 0) continue; row[i] += inc * (delta[i] - delta[o]); }
    }
    // re-plan the rest on what is known now: this week's line is final, later weeks keep their remaining movement
    const k = legs[s];
    let i;
    if (fixed && fixed[k] != null) i = fixed[k];   // a week the entry has filled: its pick is taken as given
    else {
      const rest = legs.slice(s).filter((kk) => !fixed || fixed[kk] == null), teams = []; for (let t = 0; t < nTeams; t++) if (!spent[t]) teams.push(t);
      const sdRows = {}; rest.forEach((kk) => { const lead = legs.indexOf(kk) - s; sdRows[kk] = new Float64Array(nTeams).fill(lead === 0 ? 0 : sdLead(lead)); });
      i = solve(z, sdRows, s === 0 ? ff : null, rest, teams, blocked)[0];
    }
    if (i < 0) return { value: value * FLOOR, path };
    const zi = trust * z[k][i] + (1 - trust) * z0[k][i];
    path[s] = i; spent[i] = 1; value *= Number.isNaN(zi) ? 1 : normCdf(zi);   // a fixed pick whose game is already decided counts as through
  }
  return { value, path };
}

// Expected survival over `legs` (ascending leg indices) with `burned` (array of 0/1 per team) spent, under the
// rolling policy, averaged over n playouts. usage[j][i] = share of playouts that used team i in legs[j].
export function simulate({ z, ff = null, legs, nTeams, burned, sdLead, opp, blocked = null, n = SIM_PLAYOUTS, seed = SIM_SEED, trust = SIM_TRUST, fixed = null }) {
  if (!legs.length) return { value: 1, usage: [], n: 0 };
  // antithetic pairs: every path is run with its shocks and with them negated, which cancels most of the sampling
  // noise for the smooth part of the answer (half the playouts for the same precision)
  const usage = legs.map(() => new Float64Array(nTeams)), m = Math.max(1, Math.round(n / 2));
  let total = 0;
  for (let p = 0; p < m; p++) for (const sign of [1, -1]) {
    const r = playout(z, ff, legs, nTeams, burned, sdLead, opp, seededRng(seed + 7919 * p), blocked, sign, trust, fixed);
    total += r.value;
    r.path.forEach((i, j) => { if (i >= 0) usage[j][i] += 1 / (2 * m); });
  }
  return { value: total / (2 * m), usage, n: 2 * m };
}

// Score candidates for the current leg (legs[0]): win = closing win chance now, rest = expected survival of every
// later leg with the team spent, forfeit = rest with nothing extra spent ÷ rest with the team spent (≥ 1 means the
// team is worth something later). Every candidate is scored on the same playout paths.
export function scoreCandidates({ z, ff = null, legs, nTeams, burned, sdLead, opp, candidates, n = SIM_PLAYOUTS, seed = SIM_SEED, blocked = null, trust = SIM_TRUST, fixed = null }) {
  const [now, ...later] = legs;
  const base = simulate({ z, legs: later, nTeams, burned, sdLead, opp, blocked, n, seed, trust, fixed });
  const teams = {};
  for (const i of candidates) {
    if (Number.isNaN(z[now][i]) || burned[i]) continue;
    const b = burned.slice(); b[i] = 1;
    const rest = simulate({ z, legs: later, nTeams, burned: b, sdLead, opp, blocked, n, seed, trust, fixed });
    teams[i] = { win: normCdf(z[now][i]), rest: rest.value, forfeit: base.value / Math.max(rest.value, 1e-12), usage: rest.usage };
  }
  return { base: base.value, teams, n };
}
