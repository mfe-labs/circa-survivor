// Market-based power ratings: fit one number per team (points vs. an average team on a neutral field)
// so that home rating − away rating + home-field ≈ the market spread, across every game with a line.
// Ridge shrinkage toward 0 keeps early-season estimates sane; the fit sharpens every week.
import { ALL_TEAMS, REST_PTS } from "./schedule.js";

export const HFA = 1.5;   // backtested on 2025–26 closing spreads: 1.5 beat 2 (3.92 vs 3.94 pts rms in 2025, 2.73 vs 2.85 in 2026)

// games: [{ home, away, margin, neutral, weight, rest }] where margin = expected home margin (spread from home view, positive = home favored)
// and rest = (home off a bye) − (away off a bye), worth REST_PTS each, taken out of the margin before fitting
// prior: optional {team: rating} the fit is shrunk toward (e.g. last season's market ratings); default 0
export function fitRatings(games, { lambda = 2, prior = {} } = {}) {
  const idx = Object.fromEntries(ALL_TEAMS.map((t, i) => [t, i]));
  const n = ALL_TEAMS.length;
  const A = Array.from({ length: n }, () => new Float64Array(n));
  const b = new Float64Array(n);
  let used = 0;
  for (const g of games) {
    const h = idx[g.home], a = idx[g.away];
    if (h == null || a == null || !Number.isFinite(g.margin)) continue;
    const w = g.weight ?? 1, y = g.margin - (g.neutral ? 0 : HFA) - REST_PTS * (g.rest || 0);
    // residual = r_h − r_a − y ; accumulate normal equations
    A[h][h] += w; A[a][a] += w; A[h][a] -= w; A[a][h] -= w;
    b[h] += w * y; b[a] -= w * y;
    used++;
  }
  for (let i = 0; i < n; i++) { A[i][i] += lambda; b[i] += lambda * (prior[ALL_TEAMS[i]] || 0); }
  // Gaussian elimination
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) { if (r === c || M[r][c] === 0) continue; const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  const ratings = {};
  let mean = 0;
  for (let i = 0; i < n; i++) { ratings[ALL_TEAMS[i]] = M[i][n] / M[i][i]; mean += ratings[ALL_TEAMS[i]]; }
  mean /= n;
  for (const t of ALL_TEAMS) ratings[t] = Math.round((ratings[t] - mean) * 10) / 10;
  return { ratings, games: used };
}

// Prior from the Super Bowl futures market: the market's own view of how good each team is THIS season.
// probs: { ABBR: implied title probability }. Mapped to the points scale by standardizing log-odds.
export const PRIOR_SCALE = 3.5;
export function priorFromFutures(probs) {
  const teams = ALL_TEAMS.filter((t) => probs[t] > 0);
  if (teams.length < 24) return null;
  const lo = Object.fromEntries(teams.map((t) => [t, Math.log(probs[t] / (1 - probs[t]))]));
  const mean = teams.reduce((s, t) => s + lo[t], 0) / teams.length;
  const sd = Math.sqrt(teams.reduce((s, t) => s + (lo[t] - mean) ** 2, 0) / teams.length) || 1;
  const out = {};
  for (const t of ALL_TEAMS) out[t] = teams.includes(t) ? Math.round(((lo[t] - mean) / sd) * PRIOR_SCALE * 10) / 10 : 0;
  return out;
}
