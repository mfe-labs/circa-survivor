# Circa Survivor 2026 Planner

Live site: **https://mfe-labs.github.io/circa-survivor/** · Walkthrough: **[/guide.html](https://mfe-labs.github.io/circa-survivor/guide.html)** · The math: **[/math.html](https://mfe-labs.github.io/circa-survivor/math.html)**

Planner for three Circa Survivor entries. A 20-week pick grid with a market win chance, pick popularity, future
value, EV and a DILI ("do I love it?") score for every team, spreads in every cell, and an Actuals tab tracking the
whole contest field. Friends can view; the owner signs in to edit.

Everything runs for free on GitHub: the site is GitHub Pages, the data files are JSON in this repo, and scheduled
GitHub Actions keep the lines, ratings and Circa results fresh. There is no server and no database.

## How the pieces fit

**The app**
- `src/CircaSurvivorPlanner.jsx` — the whole UI and every model. Reads the four data files, writes picks and
  actuals back to the repo through the GitHub API when the owner is signed in.
- `src/schedule.js` — the 2026 schedule grouped into Circa's 20 legs, team names and aliases. Shared with the scripts.
- `src/ratings.js` — the ridge fit that turns market spreads into power ratings, and the Super Bowl futures prior.
- `src/github.js` — read/write the data files through the GitHub Contents API.
- `public/guide.html` — the plain-English walkthrough, served at `/guide.html`.
- `public/math.html` — every projection worked by hand, with rules of thumb, served at `/math.html`.

**The data** (all in `data/`, all written by machines, all versioned in git)
- `picks.json` — the three entries' picks. Written by the app; confirmed against Circa's file after each lock.
- `actuals.json` — contest size, plus Circa's posted picks and each team's result per leg.
- `odds.json` — raw moneylines and spreads per sportsbook, per game, plus the previous refresh's quotes.
- `ratings.json` — power ratings, the futures-market prior they are anchored to, and the previous fit.

**The jobs**
- `scripts/fetch-odds.mjs` — The Odds API, five books, 2 credits a pull. Never overwrites a game after kickoff.
- `scripts/fit-ratings.mjs` — refits ratings from market spreads; refreshes the Super Bowl futures prior every 3 days.
- `scripts/fetch-actuals.mjs` — Circa's weekly Selections PDF for every entry's pick, ESPN's scoreboard for results.
- `scripts/circa.mjs`, `scripts/nflverse.mjs` — the PDF parser and the nflverse game-data loader.

**The workflows**
- `deploy.yml` — tests, builds and publishes the site on every push to `main`.
- `update-data.yml` — twice a day: pull lines, refit ratings, commit, redeploy.
- `update-actuals.yml` — every 3 h Thu–Mon: Circa's picks and ESPN's results, commit, redeploy.

## What the columns mean
`docs/HOW-IT-WORKS.md` is the technical version; `public/guide.html` is the plain-English one.

| Column | In one line |
|---|---|
| W% | True win chance: median of each book's de-vigged moneyline. |
| P% | Share of the field on that team: Circa's real number once posted, a fitted model before. |
| Future | About how many strong-favorite weeks the team has left. |
| EV | This week's value against the field, scaled so an average pick is 1.00. |
| Map tab | Claude's Map plus your own saved maps (data/maps.json), with conflicts flagged. Claude's Map is the entry's whole season from the same map: each week's pick, win chance, how often it held up across 96 noisy seasons, the backup, and a one-line reason. |
| DILI | EV ÷ forfeit, where the forfeit is what burning the team costs the entry's map of the rest of the season (holidays included), averaged over 96 noisy seasons. Per entry. |

## Editing (owner)
1. Click **Sign in to edit** and paste a GitHub fine-grained personal access token
   (GitHub → Settings → Developer settings → Fine-grained tokens): repository `mfe-labs/circa-survivor` only,
   permissions **Contents: read & write** and **Actions: read & write**. The token stays in your browser.
2. Click cells to set picks. Each change is committed to the repo within a second.
3. Nothing to do after lock: Circa's picks and the results arrive on their own. The Actuals editor is a manual override.
4. **Update lines** runs the lines job immediately instead of waiting for the schedule. The app also runs it by
   itself when you open the site and the lines are more than ten hours old.

Every save is a git commit, so the full history of picks and results is in `git log`.

## Run locally
```
npm install
npm run dev      # http://localhost:5173 (viewer mode; sign in the same way to edit)
npm test         # 9 suites: lines, model, ratings, circa, dili, http, openleg, entries, holiday
```
Data jobs: `ODDS_API_KEY=… node scripts/fetch-odds.mjs && ODDS_API_KEY=… node scripts/fit-ratings.mjs`, and
`node scripts/fetch-actuals.mjs` (needs `pdftotext` from poppler).

## Secrets
`ODDS_API_KEY` (The Odds API, free tier) is a repository Actions secret, used for both the weekly lines and the
Super Bowl futures prior. Nothing else is needed. Budget: ~4 credits a day against a 500/month free tier.
