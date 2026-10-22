// Runs the playout engine off the page's main thread (a full week of candidates takes about 1.5 s; the sequential
// rounds behind the later rows take several seconds more and are posted one at a time as they finish).
import { scoreCandidates, scoreRounds } from "./simulate.js";
self.onmessage = (e) => {
  const m = e.data, z = {}, ff = {}, opp = {};
  m.zKeys.forEach((k, j) => { z[k] = m.z[j]; opp[k] = m.opp[j]; }); ff[m.legs[0]] = m.ff;
  const args = { z, ff, legs: m.legs, nTeams: m.nTeams, burned: m.burned, sdLead: (L) => m.sdByLead[Math.min(L, m.sdByLead.length - 1)], opp, n: m.n, seed: m.seed, fixed: m.fixed };
  if (m.phase === "rounds") {
    scoreRounds({ ...args, lock: m.lock }, (round) => self.postMessage({ id: m.id, phase: "round", round }));
    self.postMessage({ id: m.id, phase: "done" });
    return;
  }
  const r = scoreCandidates({ ...args, candidates: m.candidates, decidedPick: m.decidedPick, decidedWin: m.decidedWin });
  self.postMessage({ id: m.id, phase: "scores", base: r.base, n: r.n, teams: r.teams });
};
