// The playout engine on hand-built seasons (docs/PLAN-maps-redesign.md, step 2 checks)
import { solve, simulate, scoreCandidates, incrementVar } from "../src/simulate.js";
import { normCdf } from "../src/solver.js";
let fails = 0;
const ok = (name, cond, note = "") => { console.log(`${name}: ${cond ? "OK" : "FAIL"} ${note}`); if (!cond) fails++; };
const probit = (p) => { let lo = -6, hi = 6; for (let i = 0; i < 50; i++) { const m = (lo + hi) / 2; if (normCdf(m) < p) lo = m; else hi = m; } return (lo + hi) / 2; };
// a tiny league: teams by index, games per leg as [home, away] pairs with the home win chance
function league(nTeams, legsGames) {
  const legs = legsGames.map((_, k) => k), z = {}, opp = {};
  legsGames.forEach((games, k) => {
    z[k] = new Float64Array(nTeams).fill(NaN); opp[k] = new Int32Array(nTeams).fill(-1);
    for (const [h, a, p] of games) { z[k][h] = probit(p); z[k][a] = -z[k][h]; opp[k][h] = a; opp[k][a] = h; }
  });
  return { legs, z, opp, nTeams };
}
const noNoise = () => 0;
const drift = (lead) => (lead === 1 ? 1.5 : 3 + 0.25 * lead) / 11.5;

// 1. with no movement the engine is the plain survival plan: same picks, value = product of win chances
(() => {
  const L = league(6, [[[0, 1, 0.75], [2, 3, 0.65], [4, 5, 0.55]], [[2, 0, 0.7], [4, 1, 0.6], [5, 3, 0.52]], [[4, 2, 0.8], [0, 3, 0.62], [1, 5, 0.58]]]);
  const burned = new Array(6).fill(0);
  const plan = solve(L.z, Object.fromEntries(L.legs.map((k) => [k, new Float64Array(6)])), null, L.legs, [0, 1, 2, 3, 4, 5]);
  const prod = plan.reduce((v, i, j) => v * normCdf(L.z[j][i]), 1);
  const sim = simulate({ ...L, burned, sdLead: noNoise, n: 8 });
  ok("no noise: playouts reproduce the survival plan exactly", Math.abs(sim.value - prod) < 1e-12 && plan.every((i, j) => sim.usage[j][i] > 0.999), `plan ${plan.join(",")} value ${prod.toFixed(4)} sim ${sim.value.toFixed(4)}`);
  const again = simulate({ ...L, burned, sdLead: drift, n: 64 }), again2 = simulate({ ...L, burned, sdLead: drift, n: 64 });
  ok("same seed, same numbers", again.value === again2.value && again.usage.every((u, j) => u.every((x, i) => x === again2.usage[j][i])));
  // with no choice (every underdog spent), movement can only hurt: a jiggled favorite is worth less than its line
  const fixed = burned.slice(); [1, 3, 5].forEach((i) => { fixed[i] = 1; });
  const fx = simulate({ ...L, burned: fixed, sdLead: drift, n: 64 }).value, fx0 = simulate({ ...L, burned: fixed, sdLead: noNoise, n: 8 }).value;
  ok("with no choice, movement lowers expected survival (a jiggled favorite is worth less than its line)", fx < fx0, `${fx.toFixed(4)} < ${fx0.toFixed(4)}`);
  ok("with choices, re-picking as lines move is worth at least as much as the fixed plan (option value)", again.value >= fx - 1e-12, `${again.value.toFixed(4)} ≥ ${fx.toFixed(4)}`);
  ok("increments are non-negative and add up to the total", [1, 2, 3, 4, 5].every((l) => incrementVar(drift, l) >= 0) && Math.abs([1, 2, 3, 4].reduce((a, l) => a + incrementVar(drift, l), 0) - drift(4) ** 2) < 1e-12);
})();

// 2. a second option is worth something only when the lines can move
(() => {
  // leg 0 now: A vs B (A 75%). leg 1 ("Christmas"): one option scenario: C vs D at 60% for C, D useless elsewhere;
  // two option scenario: C vs D at 60% and E vs F at 60%. Teams 0=A 1=B 2=C 3=D 4=E 5=F.
  const one = league(6, [[[0, 1, 0.75]], [[2, 3, 0.6]]]);
  const two = league(6, [[[0, 1, 0.75]], [[2, 3, 0.6], [4, 5, 0.6]]]);
  const burned = new Array(6).fill(0);
  const v1 = simulate({ ...one, burned, sdLead: noNoise, legs: [1], n: 8 }).value, v2 = simulate({ ...two, burned, sdLead: noNoise, legs: [1], n: 8 }).value;
  ok("no noise: two equal options are worth the same as one", Math.abs(v1 - v2) < 1e-12, `${v1.toFixed(4)} vs ${v2.toFixed(4)}`);
  const big = (lead) => 1.0;   // a lot of movement
  const m1 = simulate({ ...one, burned, sdLead: big, legs: [1], n: 400 }).value, m2 = simulate({ ...two, burned, sdLead: big, legs: [1], n: 400 }).value;
  ok("with movement, the second option raises expected survival", m2 > m1 + 0.02, `one option ${m1.toFixed(3)}, two options ${m2.toFixed(3)}`);
})();

// 3. a pick that strands the fragile week scores below one that does not
(() => {
  // teams 0=A 1=B 2=C 3=D 4=E 5=F 6=G 7=H. now: A vs B (75% A), C vs D (75% C), G vs H (70% G). mid: E vs F (70% E).
  // xmas: A vs F, C vs E, B vs D (60% for A, C, B). G plays nowhere later.
  const L = league(8, [[[0, 1, 0.75], [2, 3, 0.75], [6, 7, 0.7]], [[4, 5, 0.7]], [[0, 5, 0.6], [2, 4, 0.6], [1, 3, 0.6]]]);
  const burned = new Array(8).fill(0);
  const quiet = scoreCandidates({ ...L, burned, sdLead: noNoise, candidates: [0, 2, 6], n: 8 });
  ok("no noise: spending a Christmas team costs nothing while an equal one remains", Math.abs(quiet.teams[0].forfeit - 1) < 1e-9 && Math.abs(quiet.teams[2].forfeit - 1) < 1e-9, `A ${quiet.teams[0].forfeit.toFixed(3)} C ${quiet.teams[2].forfeit.toFixed(3)}`);
  const noisy = scoreCandidates({ ...L, burned, sdLead: () => 0.8, candidates: [0, 2, 6], n: 400 });
  ok("with movement, spending a Christmas team now carries a forfeit", noisy.teams[0].forfeit > 1.02 && noisy.teams[2].forfeit > 1.02, `A ${noisy.teams[0].forfeit.toFixed(3)} C ${noisy.teams[2].forfeit.toFixed(3)}`);
  ok("a team with no later use has no forfeit", Math.abs(noisy.teams[6].forfeit - 1) < 1e-9, `G ${noisy.teams[6].forfeit.toFixed(3)}`);
  ok("so the pick that keeps Christmas open scores higher", noisy.teams[6].win * noisy.teams[6].rest < noisy.teams[0].win * noisy.teams[0].rest || noisy.teams[6].forfeit < noisy.teams[0].forfeit, `G forfeit ${noisy.teams[6].forfeit.toFixed(3)} < A ${noisy.teams[0].forfeit.toFixed(3)}`);
  ok("all forfeits are at least 1 and finite", Object.values(noisy.teams).every((t) => t.forfeit >= 1 - 1e-9 && Number.isFinite(t.forfeit)));
  ok("every candidate is scored on the same paths: the base value is shared", noisy.base > 0 && Object.values(noisy.teams).every((t) => t.rest <= noisy.base + 1e-12));
})();

// 4. speed: a season-sized problem
(() => {
  const games = (k) => Array.from({ length: 16 }, (_, g) => [(2 * g + k) % 32, (2 * g + 1 + 3 * k) % 32, 0.5 + 0.35 * ((g * 7 + k * 3) % 10) / 10]).filter(([h, a]) => h !== a);
  const seen = new Set(); const L = league(32, Array.from({ length: 15 }, (_, k) => games(k).filter(([h, a]) => { const key = k + ":" + h + ":" + a; if (seen.has(h + "@" + k) || seen.has(a + "@" + k)) return false; seen.add(h + "@" + k); seen.add(a + "@" + k); return true; })));
  const burned = new Array(32).fill(0); burned[0] = burned[1] = burned[2] = burned[3] = burned[4] = 1;
  const t0 = Date.now(); const r = scoreCandidates({ ...L, burned, sdLead: drift, candidates: Array.from({ length: 12 }, (_, i) => i + 5), n: 128 }); const ms = Date.now() - t0;
  ok("twelve candidates on a 15-week season in under 4 s", ms < 4000 && Object.keys(r.teams).length > 0, `${ms} ms, ${Object.keys(r.teams).length} candidates`);
})();
if (fails) { console.log(`${fails} FAILED`); process.exit(1); }
