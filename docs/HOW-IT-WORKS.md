# How the planner works (v2.0)

## Legs
20 legs per Circa rules: NFL Weeks 1–18 plus a Thanksgiving leg (Wed–Fri games) and a Christmas leg (Dec 24–25),
each with its own pick. Each team once per entry. Tie = loss. Schedule is hard-coded in `src/schedule.js`.

## Data (all files in `data/`, all in the repo)
- **Lines** (`odds.json`): a GitHub Action calls The Odds API twice a day (2 credits per pull) for moneylines and
  spreads from Pinnacle, BetMGM, DraftKings, FanDuel and Caesars on every upcoming game, and files each book's raw
  quotes under the game's Circa leg. A game is never overwritten once it has kicked off, so it keeps the last
  pre-kickoff quotes seen. Games that kicked off before they were ever captured are backfilled with nflverse's
  closing moneyline, for history and model fitting only; the backfill never touches an upcoming game.
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
  descent against every leg with actuals. Click the "P% = …" button for the per-team audit table.

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
`DILI = EV ÷ forfeit^k`, per entry.
- **Forfeit**: for each later week, how much this team beats a *realistic* pick — the average of this entry's
  top-3 other available teams that week — as a survival multiplier, weighted by the chance the entry is still
  alive then (80%/week compounding). A team with no edge over a realistic pick later keeps its full EV.
- **Holiday scarcity**: the Thanksgiving leg has only 10 eligible teams and Christmas only 8, and six (BUF, CHI,
  DEN, GB, LAR, PHI) are in both. For each holiday leg still ahead that the team plays in, DILI is multiplied by
  `((n−1)/n)^p` (p = 0.5 × style) where `n` is the eligible teams this entry still has. It depends only on eligibility, never on how
  good the team looks that day, since a holiday underdog is still a body in the pool. Mild at a full pool, sharper
  as it empties, and zero on the entry's last eligible team, which it must keep or forfeit the leg.
- **k = style × calendar**. Style: Now 0.5, Balanced 1.0, Future 1.35 (default; "save the studs, take risk
  early"). Calendar: Weeks 1–6 ×1.5, 7–11 ×1.0, Thanksgiving–15 ×0.6, Christmas–18 ×0.25.
- The entry's best five are green; the grid sorts by DILI by default. W% and EV also green their best five,
  Future greens at 2.0 or below (cheap to burn), and P% turns red above 9.9% (a crowded pick). The tooltip shows the arithmetic and
  the later weeks that contribute most. It is a per-week heuristic, not a full-season solve.

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
