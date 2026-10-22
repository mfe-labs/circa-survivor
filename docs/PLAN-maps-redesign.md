# Maps redesign: the Rule map and the Simulation map

Agreed with Jamie on 2026-10-13. This file is the record of the plan: goals, decisions, order of work, and the
checks that gate each step. Update the status section as steps land.

## Why

The maps and DILI's forfeit value a team by a plan that knows how every future line lands (one assignment per
jiggled season, hindsight inside each season). That plan never sees any value in keeping a second option open,
because it can always pick the right one. Real picks are sequential: Week 9 is chosen before the Christmas lines or
the Christmas field are known. So the current plan happily spends Philadelphia, Buffalo, Denver and Seattle before
Christmas and arrives with Chicago alone at 59% ("1 of the 8 teams that can play it").

Jeremy's framing (texts, 2026-10-13): Christmas is the most fragile slate of the season (4 games, likely close
lines, field makeup unknown, the best pick could be the least-owned team or the biggest favorite). Keep at least two
Christmas options, ideally both sides of one game, until it becomes clear. Thanksgiving is less fragile (10 teams).
Boxing in before Thanksgiving is dangerous; burning Buffalo in Week 10 would be a disservice. Jamie agrees and
wants the maps to reflect what they would actually be willing to do.

## What gets built

Two Claude maps replace the current two (Claude's DILI Map, Claude's 96 Map). Claude Locks stays as the agreement
between the two new maps.

### 1. Claude Rules Map (the policy Jamie and Jeremy have committed to)

- Hold at least 3 Christmas-eligible teams unused until after Thanksgiving. Prefer that two of them are both sides of
  one Christmas game; do not require it (holding the Packers at 31% just to pair with Chicago is not worth it).
- Nothing held for Thanksgiving. The holdback lifts on its own once Thanksgiving is played (then reassess with real
  lines).
- Implementation: the survival solver (`survivalPath`) with reserved teams blocked before the Christmas leg. With 7
  Christmas teams left (Houston is spent), enumerate the reservations, solve each, keep the cheapest. Show on the
  strip which teams are held and the price: win-out with the holdback vs without it.
- Its current-week pick is the top DILI with the rule applied to the forfeit, so it never spends a reserved team
  this week; it may therefore disagree with the Simulation map this week as well as later.
- Custom maps do not flag the rule.

### 2. Claude Simulation Map (what the model would do if it decided for itself)

- Values each candidate pick this week by playing out the rest of the season a few hundred times. In each playout,
  future lines drift week by week by the amounts measured against closing lines (about 1.7 pts of movement one week
  out, 3.5 at two, 4 at four, more beyond; random walk, seeded, deterministic). Each week the simulated planner
  re-solves with only the lines as they stand then, picks, and the game resolves at the final win chance. A
  candidate's value is the share of playouts that win out. Optionality is valued because the simulated planner gets
  to use whichever Christmas team turned out good; nothing is hard-coded about Christmas.
- Map rows: this week = best candidate with each candidate's win-out beside it; later weeks = sequential rounds
  (since 2026-10-21): lock this week's pick, run a full round of playouts for next week with it spent and lock the top
  win ÷ forfeit, repeat to the end of the season. One coherent path, each step chosen the way this week's pick is.
  (The first version showed the team used most often in each week across playouts, a vote no single playout
  followed; it put PIT in Week 17 while LAR sat unused because LAR's uses were split across several weeks.)
  Each row still notes what today's playouts did in that week; Christmas shows the spread of options kept
  (e.g. BUF 34%, DEN 29%, CHI 22%).
- Optional, judgment-set: a small per-team-per-week chance of a sudden multi-point drop (injury jump, Jeremy's
  Mahomes example). Cannot be measured well; off unless Jamie wants it.
- Cost: ~50,000 small assignment solves for a dozen candidates; expected 1–3 s in the browser. If too slow for the
  Planner, precompute in the results job and store to JSON.

### 3. The Planner's forfeit

- Unchanged through the build. The Planner keeps today's forfeit (map forfeit blended with the strength half).
- Once the comparison phase shows the simulation's numbers are sane, the forfeit source switches to the
  simulation (EV for this week × survival of the rest, with optionality). The strength blend was an unverifiable
  hedge for the hindsight flaw; the simulation is its principled replacement, so it likely shrinks or goes.
- Until the switch, Model details shows both forfeits side by side.
- Jamie's standing worry: the simulation could produce wonky forfeits or artifacts, and it will power the whole
  app. Treat every surprising number as a bug until explained.

## Order of work

1. Rule map (hours). Tests: holds ≥3 Christmas teams before XM; lifts after TG; price shown equals the win-out
   difference; swap-optimality of every planned week given the reservation; never reuses a spent team.
2. Drift model + playout engine (seeded). Tests: with noise off it reproduces today's survival plan exactly; a
   hand-built scenario with one Christmas option vs two values the second option; a candidate that strands
   Christmas scores below one that does not; same seed, same numbers; runtime budget.
3. Simulation map alongside the old maps; compare for at least one week of real data before replacing anything.
4. Replace the two old Claude maps; Claude Locks = agreement of Rules and Simulation.
5. Forfeit switch in the Planner, only after step 3's comparison is sane. Then re-examine the strength blend.

## Sanity checks for the simulation (the "no wonky results" list)

- Every forfeit ≥ 1 and finite for teams with a game; "used"/"no game" unchanged.
- Ordering agrees with the current forfeit on the obvious cases (a team with no later value ≈ 1.0; the only
  strong Christmas team clearly > 1).
- Win-out numbers in the same range as the current maps (fractions of a percent), never above the single-solve
  plan's win-out under zero noise.
- Same inputs → identical outputs (seeded); small input changes → small output changes (no cliff from one
  playout flipping).
- Compare DILI rankings old vs new for the current week; any top-5 reshuffle must be explainable in words.

## Status

- 2026-10-14: PULL eased to ×0.9 at every lead beyond next week (was 0.9 / 0.8), after re-measuring with the current
  ratings method (slope 0.90 on 2026; 2025 with a weaker prior wanted >1). Recheck at Week 9.

- 2026-10-13 (later): steps 4–5 done. Old DILI and 96 maps removed; tabs are Rules, Simulation, Locks (= Rules ∩
  Simulation), customs. The Planner's forfeit is the playouts' (provisional old blend until the worker returns;
  cached in localStorage so reloads are instant). Conservatism: PULL (far-out projections ×0.9/×0.8 toward even,
  measured) and SIM_TRUST 0.7 (judgment). Retrospective on the Week 2–5 states: playout forfeits 1.00–1.27, all
  finite, log-correlation 0.94–0.98 with the old forfeit, same top pick in every past week; Week 6 top reorders
  (LAR 0.87, NE 0.84, IND 0.83 vs old NE 0.88, LAR 0.87, IND 0.87). Watch Thursday's Splash reading flow through.

- 2026-10-13: plan agreed. Rule map built as a fourth Claude tab alongside the old maps (step 1 done); today the
  holdback (PHI, CHI, BUF) costs 0% of win-out because the survival plan does not spend them early anyway; holding a
  fourth would cost 20%. In the plan, held teams stay unused until Christmas; the rule stops constraining decisions
  once Thanksgiving is played (the maps then re-plan on real lines). Steps 2–3 done the same day: engine in src/simulate.js (+ solver.js, sim.worker.js), 12 engine tests on hand-built
  seasons, Claude Simulation Map as a fifth Claude tab alongside the old maps, playout forfeit beside the current one
  in the Planner's DILI tooltips and Model details. First comparison (Week 6, 2026-10-13): playout forfeits correlate
  0.92 with the current forfeits over 25 teams; the top of the board moves a little (LAR 0.89 over NE 0.82 by the
  playouts vs NE 0.88 over LAR 0.87 today: the playouts value NE and IND more later, and give LAR's Week 6 line its
  due). Seed wobble at 128 playouts was ±0.04, too much; antithetic pairs + 512 playouts bring it to ±0.01. The
  Simulation map's win-out (3.4%) is an expectation with the lines moving and each week re-picked, so it is not
  comparable to the other maps' 1.4% product of today's lines; labeled as such. Next: compare through Week 7 before
  step 4 (replace the old maps) and step 5 (forfeit switch).
