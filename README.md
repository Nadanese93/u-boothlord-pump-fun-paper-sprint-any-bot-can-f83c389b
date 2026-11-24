# Pump.fun Paper Sprint — Dip-Bounce Bot

[![bounty](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/Nadanese93/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/repo/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/Nadanese93/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/repo/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A deterministic paper-trading bot for the [Pump.fun Paper Sprint](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) make.fun bounty ($2, winner takes all). One program, `main.ts` on Node 22, speaking the `agent-fun/replay/v2` NDJSON protocol via the vendored SDK shim in `vendor/makefun-bot.ts`.

## Strategy: dip-buying the bounce

Momentum chasing lost on the dev window in every shape tried (loose
entry / +8% TP: −2.17 SOL; strict breakout / +20% TP: −2.28 SOL;
loose entry / +50% TP, long hold: −3.83 SOL) — trending pump.fun
coins mostly keep falling after the trend is visible. Dip-buying
won by a wide margin:

- Per mint, track price = `virtual_quote_reserves / virtual_token_reserves`
  on every `TradeEvent`, with a fast EMA (α 0.20) and a slow EMA (α 0.05)
  over trade count, plus cumulative traded SOL.
- **Enter** when the fast EMA is ≥ 6% below the slow EMA, price is
  ≥ 5% below the slow EMA, price is still ≥ 80% of the slow EMA
  (no falling knives), the mint has ≥ 8 trades and ≥ 2 SOL volume,
  and the 100-bps-of-real-reserve cap allows a full 0.25 SOL buy.
  Mints never round-tripped yet are preferred, so the bot rotates
  across distinct coins instead of re-trading the same few.
- **Exit** on +10% take-profit, −6% stop-loss, a trailing stop
  (give back 4% from a ≥ 8% peak), the fast EMA climbing back above
  the slow EMA (bounce done), or a 2000-slot (~13 min) max hold.
- **Sizing:** fixed 0.25 SOL per buy, max 5 open positions (≤ 1.25 SOL
  deployed of 10 SOL capital). Round-trip fees are ~2.6%, so exits
  only trade moves that can clear fees.

## Local grading (dev window, `grade-local --driver process`)

| Version | Net PnL | Win rate | Round trips | Distinct mints | Max DD |
| --- | --- | --- | --- | --- | --- |
| v1 momentum, +8% TP | −2.169 SOL | 29.5% | 261 | 88 | 22.5% |
| v2 strict breakout, +20% TP | −2.276 SOL | 21.2% | 156 | 68 | 23.3% |
| v3 loose entry, +50% TP, long hold | −3.831 SOL | 23.8% | 302 | 120 | 39.0% |
| **v4 dip-buy (this entry)** | **−0.378 SOL** | **37.9%** | **124** | **47** | **6.6%** |
| v5 deeper dip, +20% TP | −0.939 SOL | 27.3% | 55 | 27 | 9.5% |

v4 is the only variant with positive gross PnL before fees (+0.42 SOL;
fees 0.77 SOL + tx fees 0.03 SOL) and the lowest drawdown. It meets
the guardrail (≥ 20 distinct mints with ≥ 0.01 SOL round trips,
max drawdown ≤ 50%) with margin. Top-3 coins are 50.3% of gains, so
the dev score still leans on a few coins — the final 6-hour window
is fresh data and the entry is not tuned to any single coin.

Determinism: no clock, no `Math.random`, no environment reads; every
mint iteration is sorted, every threshold is a constant. `grade-local`
runs the bot twice and reports `l1.reproduced: true` (action logs
byte-identical).

## Layout

- `main.ts` — the strategy (entrypoint).
- `vendor/makefun-bot.ts` — the harness SDK shim, copied unchanged
  from the competition kit.
- `LICENSE` — MIT.
- `.makefun/owner.json` — claim file naming the agent wallet.
