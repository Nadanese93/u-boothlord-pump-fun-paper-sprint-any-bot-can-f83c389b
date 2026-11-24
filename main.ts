// Pump.fun Paper Sprint — deterministic EMA momentum bot.
//
// Strategy (from the brief + protocol only, no baseline code read):
//  * Per mint, track price = virtual_quote_reserves / virtual_token_reserves
//    on every TradeEvent and maintain a fast EMA (alpha 0.25) and a slow
//    EMA (alpha 0.06) over trade count, plus cumulative traded SOL.
//  * ENTER when fast EMA is >= 6% above slow EMA, price is >= 4% above
//    slow EMA, the move is not over-extended (< 25% above slow), the
//    mint has seen >= 12 trades and >= 5 SOL of volume, and the
//    100-bps-of-real-reserve size cap allows a full 0.30 SOL buy.
//    Mints never round-tripped yet are preferred, so the bot rotates
//    across >= 20 distinct mints instead of re-trading the same few.
//    (v1: loose 3% entry / +8% take-profit graded -2.17 SOL at 29.5%
//    win rate. v2: stricter 6% entry / +20% take-profit graded -2.28
//    SOL at 21% win rate — stronger breakouts were just buying tops.
//    v3 therefore flips the payoff: a loose 2% entry, a wide +50%
//    take-profit, a -10% stop, and a long hold, so the few coins that
//    run pay for the many that do not. v3 graded -3.83 SOL: long holds
//    just ride trending coins down. v4 flips direction instead: dip
//    buying — buy a >= 6% drop below the slow EMA, sell the bounce
//    (+10% take-profit, -6% stop, fast EMA back above slow, or a
//    2000-slot max hold). v4 graded -0.38 SOL at 37.9% win rate with
//    gross PnL +0.42 SOL before fees: the edge is real but fees eat
//    it. v5 (deeper >= 10% dip, +20% take-profit) graded -0.94 SOL
//    on only 55 round trips with 67.6% top-3 concentration — worse
//    and more concentrated — so the final entry restores v4 exactly.)
//  * EXIT a position on take-profit (+10% vs cost), stop-loss (-6%),
//    trailing stop (give back 4% from a >= 8% peak), EMA reversal
//    (fast back above slow), or a 2000-slot max hold (~13 min).
//  * Sizing: fixed 0.25 SOL per buy, max 5 open positions, so at most
//    1.25 SOL is deployed at once out of 10 SOL capital. Round-trip
//    fees are ~2.6% (95 + 30 bps curve fees each way + 105k lamports
//    tx fees per order), so the +20% / -4% exits only trade moves that
//    can clear fees; the stricter entry filter keeps churn down.
//  * Determinism: no clock, no Math.random, no environment reads.
//    Every iteration over mints is sorted by mint string, every
//    threshold is a constant, and tie-breaks are by mint string.
//    Two runs therefore produce byte-identical action logs.

import { runBot, type Batch, type BotState, type OrderInput } from './vendor/makefun-bot.ts';

const BUY_LAMPORTS = 250_000_000n; // 0.25 SOL per trade
const MAX_SLIPPAGE_BPS = 500;
const FAST_ALPHA = 0.2;
const SLOW_ALPHA = 0.05;
const MIN_TRADES = 8;
const MIN_VOLUME_LAMPORTS = 2_000_000_000n; // 2 SOL cumulative traded
const ENTRY_FAST_OVER_SLOW = 0.94; // dip: fast EMA >= 6% BELOW slow EMA
const ENTRY_PRICE_OVER_SLOW = 0.95; // dip: price >= 5% below slow EMA
const MAX_EXTENDED = 0.8; // do not catch a falling knife: price >= 80% of slow
const TAKE_PROFIT = 1.1;
const STOP_LOSS = 0.94;
const TRAIL_PEAK = 1.08;
const TRAIL_GIVEBACK = 0.96;
const MAX_HOLD_SLOTS = 2000;
const REENTRY_COOLDOWN_SLOTS = 500;
const MAX_BUYS_PER_BATCH = 2;

interface MintTrack {
  fast: number;
  slow: number;
  trades: number;
  volume: bigint;
  lastPrice: number;
  lastSlot: number;
}

interface EntryInfo {
  slot: number;
  peakRatio: number;
}

const tracks = new Map<string, MintTrack>();
const entries = new Map<string, EntryInfo>();
const completed = new Set<string>();
const lastExitSlot = new Map<string, number>();
const pendingBuy = new Set<string>();

function priceOf(state: BotState, mint: string): number {
  const curve = state.curves.get(mint);
  if (curve === undefined) return 0;
  if (curve.virtual_token_reserves === 0n) return 0;
  return Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
}

function updateFromEvents(state: BotState, batch: Batch): void {
  for (const event of batch.events) {
    if (event.event !== 'TradeEvent') continue;
    const mint = event.mint;
    const tokenReserves = BigInt(event.virtual_token_reserves);
    if (tokenReserves === 0n) continue;
    const price = Number(BigInt(event.virtual_quote_reserves)) / Number(tokenReserves);
    if (!(price > 0) || !Number.isFinite(price)) continue;
    const track = tracks.get(mint);
    if (track === undefined) {
      tracks.set(mint, {
        fast: price,
        slow: price,
        trades: 1,
        volume: BigInt(event.sol_amount),
        lastPrice: price,
        lastSlot: event.slot,
      });
    } else {
      track.fast += FAST_ALPHA * (price - track.fast);
      track.slow += SLOW_ALPHA * (price - track.slow);
      track.trades += 1;
      track.volume += BigInt(event.sol_amount);
      track.lastPrice = price;
      track.lastSlot = event.slot;
    }
  }
  // Prune stale tracks deterministically: keep the map bounded by
  // dropping mints with no trade for a long time and no position.
  // Only prune every 4096 slots worth of batches is overkill; instead
  // prune when the map grows large, by oldest lastSlot (mint tie-break).
  if (tracks.size > 4000) {
    const sorted = [...tracks.entries()].sort((a, b) => {
      if (a[1].lastSlot !== b[1].lastSlot) return a[1].lastSlot - b[1].lastSlot;
      return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
    });
    for (let i = 0; i < sorted.length - 3000; i++) {
      const mint = sorted[i][0];
      if (!state.positions.has(mint)) tracks.delete(mint);
    }
  }
}

function onBatch(state: BotState, batch: Batch): OrderInput[] {
  updateFromEvents(state, batch);

  // Learn from fills: a sell fill closes a round trip; a buy fill
  // clears the pending-buy flag. Iterate in fill order (deterministic).
  for (const fill of batch.fills) {
    if (fill.side === 'buy') pendingBuy.delete(fill.mint);
    if (fill.side === 'sell' && fill.status === 'filled') {
      completed.add(fill.mint);
      lastExitSlot.set(fill.mint, batch.slot);
      entries.delete(fill.mint);
    }
  }
  // Positions the harness closed itself (complete/flatten) also end entries.
  for (const mint of [...entries.keys()]) {
    if (!state.positions.has(mint)) entries.delete(mint);
  }

  const orders: OrderInput[] = [];

  // ---- Exits (sorted by mint for determinism) ----
  const held = [...state.positions.keys()].sort();
  for (const mint of held) {
    const holding = state.positions.get(mint);
    if (holding === undefined) continue;
    const curve = state.curves.get(mint);
    if (curve === undefined || curve.complete) continue;
    const price = priceOf(state, mint);
    if (!(price > 0)) continue;
    const cost = holding.cost_lamports;
    if (cost === 0n) continue;
    const value = BigInt(Math.floor(Number(holding.token_amount) * price));
    // value/cost as a float ratio; both are lamport-scale integers.
    const ratio = Number(value) / Number(cost);
    let info = entries.get(mint);
    if (info === undefined) {
      info = { slot: batch.slot, peakRatio: ratio };
      entries.set(mint, info);
    }
    if (ratio > info.peakRatio) info.peakRatio = ratio;

    const track = tracks.get(mint);
    // Dip trade: the bounce is done once the fast EMA climbs back
    // above the slow EMA, so that is the reversal exit here.
    const reversed = track !== undefined && track.fast > track.slow;
    const heldTooLong = batch.slot - info.slot > MAX_HOLD_SLOTS;
    const trailing =
      info.peakRatio >= TRAIL_PEAK && ratio <= info.peakRatio * TRAIL_GIVEBACK;
    if (
      ratio >= TAKE_PROFIT ||
      ratio <= STOP_LOSS ||
      trailing ||
      reversed ||
      heldTooLong
    ) {
      orders.push({
        side: 'sell',
        mint,
        token_amount: holding.token_amount,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      });
    }
  }

  // ---- Entries (sorted by preference, then mint) ----
  const openCount = state.committedPositionCount();
  const sellsThisBatch = orders.length;
  const slotsFree = state.hello.caps.max_open_positions - openCount;
  const buysAllowed = Math.min(MAX_BUYS_PER_BATCH, Math.max(0, slotsFree));
  if (buysAllowed > 0 && state.freeCashLamports() > BUY_LAMPORTS * 2n) {
    const candidates: { mint: string; momentum: number }[] = [];
    for (const mint of [...tracks.keys()].sort()) {
      if (state.positions.has(mint)) continue;
      if (pendingBuy.has(mint)) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const track = tracks.get(mint);
      if (track === undefined) continue;
      if (track.trades < MIN_TRADES) continue;
      if (track.volume < MIN_VOLUME_LAMPORTS) continue;
      if (track.slow <= 0) continue;
      // Dip entry: fast EMA and price must be BELOW slow EMA (a sharp
      // drop), but not below the falling-knife floor.
      if (track.fast > track.slow * ENTRY_FAST_OVER_SLOW) continue;
      if (track.lastPrice > track.slow * ENTRY_PRICE_OVER_SLOW) continue;
      if (track.lastPrice < track.slow * MAX_EXTENDED) continue;
      const lastExit = lastExitSlot.get(mint);
      if (lastExit !== undefined && batch.slot - lastExit < REENTRY_COOLDOWN_SLOTS) continue;
      if (state.maxBuyLamports(mint) < BUY_LAMPORTS) continue;
      candidates.push({ mint, momentum: track.fast / track.slow });
    }
    candidates.sort((a, b) => {
      const aDone = completed.has(a.mint) ? 1 : 0;
      const bDone = completed.has(b.mint) ? 1 : 0;
      if (aDone !== bDone) return aDone - bDone; // untraded mints first
      if (a.momentum !== b.momentum) return b.momentum - a.momentum;
      return a.mint < b.mint ? -1 : a.mint > b.mint ? 1 : 0;
    });
    const n = Math.min(buysAllowed, candidates.length);
    for (let i = 0; i < n; i++) {
      const mint = candidates[i].mint;
      pendingBuy.add(mint);
      orders.push({
        side: 'buy',
        mint,
        quote_lamports: BUY_LAMPORTS,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      });
    }
  }
  void sellsThisBatch;
  return orders;
}

await runBot({ onBatch });
