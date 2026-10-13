// Runs the playout engine off the page's main thread (a full week of candidates takes about 1.5 s).
import { scoreCandidates } from "./simulate.js";
self.onmessage = (e) => {
  const m = e.data, z = {}, ff = {}, opp = {};
  m.zKeys.forEach((k, j) => { z[k] = m.z[j]; opp[k] = m.opp[j]; }); ff[m.legs[0]] = m.ff;
  const r = scoreCandidates({ z, ff, legs: m.legs, nTeams: m.nTeams, burned: m.burned, sdLead: (L) => m.sdByLead[Math.min(L, m.sdByLead.length - 1)], opp, candidates: m.candidates, n: m.n, seed: m.seed });
  self.postMessage({ id: m.id, base: r.base, n: r.n, teams: r.teams });
};
