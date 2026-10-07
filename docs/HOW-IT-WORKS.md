# How the planner works (v2.0)

## Legs
20 legs per Circa rules: NFL Weeks 1–18 plus a Thanksgiving leg (Wed–Fri games) and a Christmas leg (Dec 24–25),
each with its own pick. Each team once per entry. Tie = loss. Schedule is hard-coded in `src/schedule.js`.

## Data (all files in `data/`, all in the repo)
- **Lines** (`odds.json`): a GitHub Action calls The Odds API twice a day (2 credits per pull) for moneylines and
  spreads from Pinnacle, BetMGM, DraftKings, FanDuel and Caesars on every upcoming game, and files each book's raw
  quotes under the game's Circa leg. A game is never overwritten once it has kicked off, so it keeps the last
  pre-kickoff quotes seen. Games that kicked off before they were ever captured are backfilled with nflverse's
  closing moneyline, for history and model fitting only; the backfill never touches an upcoming game. nflverse also
  posts next week's spreads days before any book's moneyline reaches The Odds API; until a two-sided moneyline
  exists, that spread is stored as a look-ahead line (`books.nflverse.lookahead`), refreshed every run and replaced
  by real prices as they arrive. In the app it gives a win chance for planning (Future, DILI, the Map, the grid
  cell) but never a True Win %, so W% and EV wait for moneylines. The ratings fit already uses those spreads.
- **True Win %** is computed in the app, per game: each book's two prices are de-vigged on their own (implied =
  100/(ML+100) or −ML/(−ML+100), normalized to sum to 100%), the consensus is the **median** of the books' home-win
  probabilities, and the away side is 1 − home (medians of the two sides need not sum to 1). Status: 3+ books =
  normal, 2 = degraded, 1 = single-book (provisional, shown in amber), 0 = unavailable. A quote is excluded if it
  lacks both prices, was taken after kickoff (in-game), or is more than 48 h older than the freshest book's quote.
  No spread, rating or model fallback ever produces a Win %.
- **EV** needs a Win % for every game in the leg to be exact; games without one drop out of the denominator and
  flatter the rest. With partial coverage EV is still shown but the column is marked `EV*` with the coverage in its
  tooltip; below 75% coverage EV is blanked.
- **Power ratings** (`ratings.json`): fit by the same Action from market spreads. Every 2026 game with a closing
  line (nflverse) plus the current DraftKings spreads is an equation `home − away + 2 = spread`; a ridge fit solves
  for one number per team, shrunk toward last season's ratings early in the year. Ratings project spreads for every
  future cell (italic) and drive the Future column.
- **Picks** (`picks.json`) are written by the app when the owner is signed in. After a week locks they are also
  confirmed against Circa's file (below), which is the source of truth.
- **Circa actuals** (`actuals.json`): a GitHub Action runs every 3 hours from Thursday to Monday. Circa posts a text
  PDF of every entry's selection about two hours after each week's lock (`Circa-Survivor-2026-Week-N-Selections.pdf`;
  holiday legs are `12a`/`12b` and `16a`/`16b`). The job downloads it, counts picks per team, derives the no-pick
  count as entries alive minus picks listed, and takes each game's result from ESPN's public scoreboard (won, lost,
  or pending; a tie is a loss). Circa's Tuesday Team Availability PDF is the independent cross-check.

## P% (pick popularity), one number per leg
- Leg has Circa actuals → use them.
- Otherwise the **field model** `win^a · e^(−b·FV) · e^(−c·HP) · availability`, normalized over favored teams.
  `HP` (holiday pressure) is the scarcity of each upcoming holiday pool (1/teams still available to the field)
  weighted by how near that week is (0.8 per week), and zero once it passes. `a`, `b`, `c` are fit by coordinate
  descent against every leg with actuals, with a prior penalty of `PRIOR_WEIGHT / legs²` (full guardrail on one
  week, a sixteenth on four). The Model details panel has the per-team audit table.
- Each locked leg also carries `fv` (every team's future value as it stood at that Saturday's lock, 2 dp) and
  `fvAt` (the ratings timestamp used). `scripts/freeze-fv.jsx` writes it once, in the results job right after
  fetch-actuals, bundled with esbuild (`npm run freeze-fv`); fetch-actuals carries it through later rewrites of the
  leg, and the in-app editor keeps it. Weeks 1–4 were backfilled from the repo's history (Week 1 from the Sept 14
  snapshot, the earliest). `fvAt(leg, team, data)` returns the frozen value for a locked leg, else `fvFor`, and the
  popularity model and the past-week board use it, so later ratings moves cannot rewrite what the field saw.
- Before lock the P% cell shows the model's estimate and the P%, EV and DILI tooltips show a band: `modelPickRange` jiggles every posted win chance by `LINE_MOVE` =
  0.6 pts of spread (Tue→Sat movement measured across Weeks 2–4) scaled by sqrt(days to lock ÷ 4), re-runs the
  model 96 times with a fixed seed, also jiggling each team's score by the model's own error, re-measured by
  `bandError` on every fit: log SD of actual÷model for the model's top pick (`errTop`) and for every other team
  with ≥3% either way (`errOther`), shrunk toward 0.1 / 0.35 with 3 pseudo-points, clamped to [0.05, 0.6]; this
  part does not shrink at lock. Keeps the 25th–75th percentile (`BAND`) of share and EV. DILI's band is EV's ÷ forfeit.
  Lock is taken as 4 pm PT the day before the leg's `start`.

## EV
`EV = W / (P + Σ over other games of P·W)`, then scaled so the pick-weighted average = 1.00 (Atlas / SurvivorGrid convention).

## Future value
Expected number of strong-favorite weeks left after the selected one. Each later week counts by how much it looks
like a strong spot, a logistic curve centred at 65% with a 5-point width: about 1 at 75%, ½ at 65%, a little at
55%, nothing at 45%. Reads as "about N good weeks left" and separates a team with two usable weeks from one with
none.

## Power ratings prior
The ridge fit is anchored to the Super Bowl futures market (implied title probabilities, averaged across books,
log-odds standardized onto a points scale), refreshed every 3 days for 1 credit. That is the market's view of how
good each team is *this* season, so early-season ratings do not lean on last year's results. If the futures
fetch fails, last season's market ratings regressed 40% toward average are the fallback.

## DILI ("do I love it?") — which team to actually pick this week
`DILI = EV ÷ forfeit`, per entry.
- **The map**: the best assignment of distinct teams the entry still holds to every remaining leg (Thanksgiving
  and Christmas included), maximising the product of win chances (Hungarian algorithm, `bestMap`). Its value is
  Σ log(win). The forfeit for a team is exp(map value with it kept − map value with it burned) ≥ 1. A team not on
  the map costs ~nothing; a team on it costs the swap it forces. If burning it leaves a leg with no eligible team
  (a holiday), the forfeit is ∞ and DILI 0. No separate holiday term any more.
- **Uncertainty**: the map is solved `MAP_SAMPLES` = 96 times with every future win chance jiggled in z-space by
  `noiseSd(lead)` = (3 + 0.25 × legs ahead) ÷ 13.5 (1.5 ÷ 13.5 when the game already has a market line), seeded
  so it is deterministic and the same draws are used for every candidate; the forfeit is the average. The noise
  levels come from seven seasons of nflverse closing lines vs ratings fit through Week 4 (residual SD ≈ 3 pts a
  month out, ≈ 6 pts twelve weeks out). This prices flexibility: a team that is the best option in a distant week
  only half the time is charged about half.
- **Strength**: the forfeit is a log blend of the map forfeit and exp(β × future value), β set per refresh so the
  two have the same mean log over the week's scored teams; weight `STRENGTH_W` = 0.5 × min(1, legs left ÷
  `STRENGTH_SPAN` 15), so 0.5 now and 0 in the last week. Hedges the map's assumption of foresight re-planning.
  Rows carry `forfeitMap`, `forfeitStr`, `strengthW`, `beta`; `forfeit` is the blend.
- **Near legs**: the next `NEAR_LEGS` = 4 legs score each team by projected EV instead of win chance, from
  `projectField`, which steps the popularity model forward (field picks by the model, losers drop out, survivors
  stop holding what they picked). Further out the field model drifts, so plain win chance is used.
- The map fills every leg from openLeg() on (the first week not completely over), except the leg being scored.
  Picks in those weeks are soft: they neither spend a team nor fix a week (spentTeams = picks in finished weeks).
- `planMap(data, picks, params)` feeds the Map tab: the projected map, per-leg first-choice counts across the 96
  draws, the backup (what fills the leg after burning the pick) and cost, field ownership for near legs, the
  chance of winning out, the three weakest legs, and the three favorites (55%+) in the current leg used least often in
  later legs across the draws (cheapest to burn).
- `computeDili` returns the entry's projected map (sample −1, no noise), shown in the Model details panel; each
  team's row carries `forfeit`, `swaps` (what the projected map changes if the team is burned) and `dili`.
- The entry's best five are green; the grid sorts by DILI by default. W% and EV also green their best five,
  Future greens at 2.0 or below (cheap to burn), and P% turns red above 9.9% (a crowded pick). The tooltip shows the
  arithmetic and the swap.

## Actuals tab
Contest size + Circa's posted selections per leg. `fieldTimeline()` derives live entries, implied value per entry
(pool ÷ live), and equity (share × entries alive × value).

## Which week opens
The dashboard opens on the first week whose results are not final: no Circa actuals yet, or actuals with teams
still `pending`. Circa posts picks at Saturday's lock, so a week gets its actuals entry before any game is played;
keying on `pending` keeps you on the current week until its last game ends, which also handles the holiday legs
that finish midweek. If a result never lands, the next week's start date unsticks it.

## Weekly loop
1. Lines refresh themselves; check the grid any time. 2. Set 3 picks (signed in), check dupes, enter at Circa.
3. After lock and after each game, picks and results arrive on their own. Check the Actuals tab Tuesday morning; the editor is there if Circa's file was late or wrong.
