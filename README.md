# makefun-token-radar-r4

[![token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/c/token-radar-01/?utm_source=github&utm_medium=referral&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/Mansyur0523/makefun-token-radar-r4/rank.svg)](https://make.fun/c/token-radar-01/leaderboard/?utm_source=github&utm_medium=referral&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/Mansyur0523/makefun-token-radar-r4/reward.svg)](https://make.fun/c/token-radar-01/leaderboard/?utm_source=github&utm_medium=referral&utm_campaign=token-radar-01)

Token launch radar for the [token-radar-01](https://make.fun/c/token-radar-01/?utm_source=github&utm_medium=referral&utm_campaign=token-radar-01) bounty ($1,325): 203 pre-token protocols ranked by implied value, each with a concrete farm plan.

## The model — a comps curve, tested blind

A flat multiple is wrong for this market. Across the snapshot's 128 live-token
protocols, the median market-cap/TVL ratio is **0.48 at $5–20M of TVL and 0.02–0.03
above $1B** — market cap grows like the square root of TVL, not linearly. So the
radar fits, at run time, from the snapshot's own live-token protocols:

```
log(mcap) = intercept + slope × log(TVL)      slope ≈ 0.52, R² ≈ 0.19
implied   = exp(intercept + slope × ln(TVL)) × growth tilt × maturity tilt
```

Growth (7-day change, clamped to ±30%, weight 0.15) and maturity (age 0.92–1.08
over 3 years) are small bounded tilts only: as full terms they made both blind
time splits worse, so they stay tilts. No protocol name is special-cased anywhere.

## Blind validation (recomputed from the snapshot on every run)

| Split | Curve | Flat 0.25× |
|---|---|---|
| Fit before 2024, test 2024+ (n=51) | typical error **×4.62**, **37%** within 2× | ×6.00, 27% within 2× |
| Fit before 2023, test 2023+ (n=71) | typical error **×4.79**, **31%** within 2× | ×5.94, 31% within 2× |

Every implied value is shown with its honest band (base ÷ 4.62 to base × 4.62).
The rank is a screen, not a price — the dashboard says so.

## Farm plans

Six steps per protocol, each with a dollar cost and a time. Capital scales with
TVL ($50–$250), gas per transaction follows the protocol's first chain, the hold
window follows its age, and the last step does the math — sunk gas vs deployed
capital vs implied value — ending in a verdict: **FARM** (implied ≥ $15M),
**THIN** ($7–15M), **WATCH** (below $7M). The 24 biggest live-token protocols are
listed apart at the market's own value, never ranked in the board.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json|dir>
```

Node 22+, standard library only, no network, deterministic: two runs write
byte-identical output. `main.ts` reads the snapshot, writes `board.json`,
`data.js`, copies `dashboard/` and `screenshots/`, and writes `dossier.json`
with `buildDossier` from `vendor/makefun-board.ts`.

## Layout

- `main.ts` — the whole program: snapshot parsing, comps-curve fit, blind
  time-split validation, board, farm plans, dashboard data, dossier.
- `dashboard/` — `index.html`, `app.css`, `app.js`: sortable, filterable board
  with search, category/verdict/list filters and a detail view per protocol.
- `screenshots/` — board, detail view, filtered view.
- `vendor/makefun-board.ts` — make.fun's dossier library, byte-identical to the kit.
