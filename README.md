# Token Radar — token-radar-01 entry

Ranks every pre-token protocol in the sealed DefiLlama snapshot by implied launch
value, with a farm plan for each, a static dashboard, and a model that is fitted
from the snapshot itself.

## Run

```sh
mkdir -p out
MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>
```

Writes `board.json`, `data.js`, `dashboard/`, `screenshots/` and `dossier.json`
to the output directory. Node 22+, standard library only, no network.

## The model (radar-2)

- **Coverage.** Every watchlist protocol (TVL ≥ $50M, no token on record), plus
  every pre-token protocol below that floor that is not a wrapped, staked,
  bridged or exchange product of a token that already trades: 178 rows.
- **Base multiple.** Fitted at run time from the snapshot's own comparable
  live-token protocols (market cap ≥ $1M, mcap/TVL inside [0.005, 30]; 105 of
  them): the median mcap/TVL of the protocol's category — category group, then
  the global median (0.321) as fallbacks — shrunk toward the global median by
  n/(n+6) in log space, adjusted for size by (TVL/$100M)^-0.125 clamped to
  [0.35, 2.5].
- **Growth and maturity.** × (1 + clamp(7d TVL change, −60, +120)/100 × 0.3)
  and × (0.8 + min(age, 1095d)/1095 × 0.2).
- **Validation, stated not hidden.** The program refits on one half of the
  comparables (split by slug hash) and reports the held-out error in the
  dashboard: median absolute error 76.9%, rank correlation 0.429. Launch
  multiples are widely dispersed; the board is a ranking with wide
  uncertainty, not a set of price predictions.

## Layout

- `main.ts` — entry point: snapshot in, board + dashboard + dossier out.
- `lib/model.ts` — the fitted model, the board gate and the farm plans.
- `vendor/makefun-board.ts` — the kit's dossier library, vendored unchanged.
- `dashboard/` — static page (no network) rendering the board, a per-protocol
  detail view with the model's inputs and the farm plan, and category filters.
- `screenshots/` — the board, a detail view and a filtered view.
