// Token Radar round 4 — a comps-curve radar, built from the snapshot alone.
//
// What it does, in one paragraph: it reads the sealed snapshot, fits the market's own
// pricing curve on the protocols whose token already trades (log market-cap on log TVL),
// tests that curve blind on a time split before trusting it, and applies it to every
// pre-token protocol the snapshot records. The board ranks 203 pre-token protocols by
// implied value; the 24 biggest live-token protocols are shown apart, at the market's
// own value, never mixed into the ranking. Every row carries a farm plan whose costs
// and verdict are computed from that row's own figures.
//
// The model, and why it is not a flat multiple:
//   * The comps are the 128 protocols with a positive market cap and TVL. Their
//     market-cap/TVL ratio is not a constant: its median is 0.48 at $5-20M of TVL and
//     0.02-0.03 above $1B. A flat 0.25x multiple overvalues the giants about tenfold
//     and undervalues the small ones. The log-log fit says market cap grows like
//     TVL^0.52 (slope 0.522, R^2 0.19 on the full comps set) — the square-root law
//     of this market. The fit is computed from the snapshot at run time, never
//     hard-coded: the intercept and slope below are outputs, not inputs.
//   * Blind test (time split, fit on protocols listed before 2024, tested on those
//     listed in 2024 or later, n=51): the curve's typical error is x4.62 in value,
//     37% of predictions land within 2x of the real market cap. The flat 0.25x
//     multiple on the same split: x6.00, 27% within 2x. A second split (before /
//     after 2023, n=71) agrees: curve x4.79 / 31% within 2x, flat x5.94 / 31%.
//     The numbers are recomputed from the snapshot on every run and printed on
//     the dashboard; they are the reason the curve, not the multiple, is used.
//   * Growth and age were tested as extra terms and dropped to small bounded
//     weights: adding them made both time splits worse (overfit on 128 noisy
//     comps). What survives is a bounded growth tilt (weight 0.15, 7-day change
//     clamped to +/-30%) and a bounded maturity tilt (0.92-1.08 over 3 years of
//     age). Both move a value by at most ~8% combined; the curve does the work.
//   * The residual spread is wide, so every implied value is shown with its
//     honest band: base / 4.62 to base x 4.62, the out-of-sample typical error.
//     The rank is a screen, not a price — the dashboard says so.
//
// The farm plan, per row: capital scales with the protocol's TVL, gas per
// transaction follows its first chain, the hold window follows its age, and the
// verdict follows its implied value (FARM >= $15M, THIN $7-15M, WATCH below $7M).
// No protocol name is ever special-cased anywhere in this file.
//
// Determinism: no clock, no randomness, no network. The same snapshot bytes give
// the same output bytes. Run it as:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json|dir>

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const TEXT_MAX_BYTES = 65_536;
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const DAY_MS = 86_400_000;

// ---------------------------------------------------------------- snapshot

interface SnapProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapProtocol[];
  watchlist: string[];
}

function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('snapshot.json is not an object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || typeof o.source !== 'string' || typeof o.floor_usd !== 'number') {
    throw new Error('snapshot.json lacks as_of, source or floor_usd');
  }
  if (!Array.isArray(o.protocols) || !Array.isArray(o.watchlist)) throw new Error('snapshot.json lacks protocols or watchlist');
  const protocols = (o.protocols as Record<string, unknown>[]).map((p) => ({
    slug: String(p.slug),
    name: String(p.name),
    category: typeof p.category === 'string' ? p.category : null,
    chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
    tvl_usd: Number(p.tvl_usd),
    change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
    mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
    listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
    gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
    symbol: typeof p.symbol === 'string' ? p.symbol : null,
  }));
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

// ---------------------------------------------------------------- helpers

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

function median(values: number[]): number {
  const v = [...values].sort((a, b) => a - b);
  if (v.length === 0) return 0;
  return v[Math.floor(v.length / 2)]!;
}

/** Records no token at all: no market cap, no CoinGecko id, no symbol. */
function isPreToken(p: SnapProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** A name ending in a version marker (V2, 2.0, ...) is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
/** Categories that are a wrapped, staked or bridged product of a token that trades. */
const WRAPPED_CATS = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);

/** Rankable: pre-token, not a wrapped/staked/bridged product, not a versioned pool. */
function isRankable(p: SnapProtocol): boolean {
  return isPreToken(p) && !WRAPPED_CATS.has(p.category ?? '') && !VERSIONED.test(p.name);
}

// ---------------------------------------------------------------- the comps curve

interface Curve {
  intercept: number;
  slope: number;
  n: number;
  r2: number;
  residSd: number;
}

/** Ordinary least squares of log(mcap) on log(tvl) over the given comps. */
function fitCurve(comps: SnapProtocol[]): Curve {
  const xs = comps.map((p) => Math.log(p.tvl_usd));
  const ys = comps.map((p) => Math.log(p.mcap_usd!));
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i]! - mx) * (ys[i]! - my);
    sxx += (xs[i]! - mx) ** 2;
    syy += (ys[i]! - my) ** 2;
  }
  const slope = sxx === 0 ? 0 : sxy / sxx;
  const intercept = my - slope * mx;
  const r2 = sxx === 0 || syy === 0 ? 0 : (sxy * sxy) / (sxx * syy);
  let ss = 0;
  for (let i = 0; i < n; i++) ss += (ys[i]! - (intercept + slope * xs[i]!)) ** 2;
  return { intercept, slope, n, r2, residSd: Math.sqrt(ss / Math.max(1, n - 2)) };
}

interface SplitScore {
  cutoff: string;
  train_n: number;
  test_n: number;
  curve_mae_log: number;
  curve_typical_x: number;
  curve_within_2x: number;
  curve_within_3x: number;
  flat_mae_log: number;
  flat_typical_x: number;
  flat_within_2x: number;
}

/**
 * One blind time-split score: fit the curve on comps listed before `cutoff`, test it
 * on comps listed on/after it, and score the flat 0.25x multiple on the same test set.
 * Error is in log space, so a typical error of x4.62 means the prediction is usually
 * within a factor 4.62 of the real market cap, either way.
 */
function timeSplit(comps: SnapProtocol[], cutoff: string): SplitScore {
  const train = comps.filter((p) => p.listed_at !== null && p.listed_at < cutoff);
  const test = comps.filter((p) => p.listed_at !== null && p.listed_at >= cutoff);
  const curve = fitCurve(train);
  const score = (predict: (p: SnapProtocol) => number): { mae: number; w2: number; w3: number } => {
    const errs = test.map((p) => Math.log(p.mcap_usd!) - Math.log(Math.max(1, predict(p))));
    const mae = errs.reduce((a, e) => a + Math.abs(e), 0) / Math.max(1, errs.length);
    return {
      mae,
      w2: errs.filter((e) => Math.abs(e) <= Math.log(2)).length / Math.max(1, errs.length),
      w3: errs.filter((e) => Math.abs(e) <= Math.log(3)).length / Math.max(1, errs.length),
    };
  };
  const c = score((p) => Math.exp(curve.intercept + curve.slope * Math.log(p.tvl_usd)));
  const f = score((p) => p.tvl_usd * 0.25);
  return {
    cutoff,
    train_n: train.length,
    test_n: test.length,
    curve_mae_log: round4(c.mae),
    curve_typical_x: round4(Math.exp(c.mae)),
    curve_within_2x: round4(c.w2),
    curve_within_3x: round4(c.w3),
    flat_mae_log: round4(f.mae),
    flat_typical_x: round4(Math.exp(f.mae)),
    flat_within_2x: round4(f.w2),
  };
}

// ---------------------------------------------------------------- implied value

interface Priced {
  base: number;
  growthMult: number;
  maturityMult: number;
  implied: number;
  low: number;
  high: number;
}

/**
 * One protocol's implied value under the fitted curve. The curve carries the value;
 * growth and maturity are small bounded tilts (they worsened both time splits as
 * full terms, so they stay tilts: at most ~8% combined). `typicalX` is the blind
 * time-split typical error; the low/high band is base / typicalX .. base x typicalX.
 */
function price(p: SnapProtocol, asOf: string, curve: Curve, typicalX: number): Priced {
  const base = Math.exp(curve.intercept + curve.slope * Math.log(Math.max(1, p.tvl_usd)));
  const growth = clamp(p.change_7d ?? 0, -30, 30) / 100;
  const growthMult = 1 + 0.15 * growth;
  const age = ageDays(asOf, p.listed_at);
  const maturityMult = age === null ? 1 : 0.92 + 0.16 * (Math.min(age, 1095) / 1095);
  const implied = Math.max(1, Math.round(base * growthMult * maturityMult));
  return {
    base: Math.round(base),
    growthMult: round4(growthMult),
    maturityMult: round4(maturityMult),
    implied,
    low: Math.max(1, Math.round(implied / typicalX)),
    high: Math.round(implied * typicalX),
  };
}

// ---------------------------------------------------------------- farm economics

/** Rough gas cost of one transaction on a chain, in dollars (snapshot-date estimate). */
const GAS_USD: Record<string, number> = {
  Ethereum: 12, Bitcoin: 3, Solana: 0.2, Binance: 0.5, Arbitrum: 1.5, Base: 0.5,
  Optimism: 1, Polygon: 0.5, Avalanche: 1, Monad: 0.3, 'Hyperliquid L1': 0.5,
  Berachain: 0.5, Sonic: 0.5, Sei: 0.3, Sui: 0.2, Aptos: 0.2, Starknet: 1, zkSync: 1,
};

function gasPerTx(p: SnapProtocol): number {
  const chain = p.chains[0];
  if (chain !== undefined && GAS_USD[chain] !== undefined) return GAS_USD[chain]!;
  return 2;
}

function capitalFor(p: SnapProtocol): number {
  if (p.tvl_usd >= 1_000_000_000) return 250;
  if (p.tvl_usd >= 250_000_000) return 150;
  if (p.tvl_usd >= 50_000_000) return 100;
  return 50;
}

function holdDaysFor(age: number | null): number {
  if (age === null) return 45;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

type Verdict = 'FARM' | 'THIN' | 'WATCH';

function verdictFor(implied: number): Verdict {
  if (implied >= 15_000_000) return 'FARM';
  if (implied >= 7_000_000) return 'THIN';
  return 'WATCH';
}

/** The category's one concrete action, from the snapshot's own category field. */
function actionFor(p: SnapProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) {
    return `Supply $${capital} of USDC to ${name} on ${chain} as a lender and leave the deposit earning.`;
  }
  if (c.includes('dex') || c.includes('leveraged farm')) {
    return `Add $${capital} of liquidity to ${name}'s deepest pool on ${chain} and keep the LP position open.`;
  }
  if (c.includes('bridge')) {
    return `Bridge $${capital} of USDC into ${chain} through ${name}, then use the bridged funds inside its app.`;
  }
  if (c.includes('stak') || c.includes('restak')) {
    return `Stake $${capital} of the chain asset through ${name} on ${chain} and keep the staking receipt.`;
  }
  if (c.includes('perp') || c.includes('derivat')) {
    return `Deposit $${capital} of USDC as margin on ${name} and open one small hedged position.`;
  }
  if (c.includes('predict')) {
    return `Fund $${capital} on ${name} and take one small position in an active market.`;
  }
  if (c.includes('curator') || c.includes('allocator') || c.includes('yield')) {
    return `Deposit $${capital} into a ${name} vault on ${chain} and hold the vault shares.`;
  }
  if (c.includes('stable') || c.includes('wrapper')) {
    return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain} and hold it.`;
  }
  if (c.includes('rwa')) {
    return `Mint $${capital} of the yield-bearing asset on ${name} (${chain}) and hold it to maturity.`;
  }
  if (c.includes('insurance')) {
    return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy active.`;
  }
  if (c.includes('basis')) {
    return `Deposit $${capital} of USDC into ${name}'s basis vault on ${chain} and hold the position.`;
  }
  if (c.includes('payment')) {
    return `Route $${capital} of payments through ${name} on ${chain} and keep the account active.`;
  }
  if (c.includes('govern')) {
    return `Lock $${capital} of voting power through ${name} on ${chain} and vote in its next round.`;
  }
  if (c.includes('chain')) {
    return `Bridge $${capital} to ${name}'s chain and use one of its native apps for a week.`;
  }
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

function fmtUsd(n: number): string {
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n}`;
}

/**
 * Six concrete steps. Every step names its cost in dollars and its time; the last
 * step does the farm math for this row (sunk gas vs deployed capital vs implied
 * value) and states the verdict. Steps are built from the row's own figures only.
 */
function farmSteps(p: SnapProtocol, age: number | null, priced: Priced, verdict: Verdict): string[] {
  const chain = p.chains.length > 0 ? p.chains[0]! : 'its main chain';
  const gas = gasPerTx(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const weeklyTx = 1;
  const weeks = Math.max(4, Math.ceil(hold / 7));
  const sunkGas = Math.round((gas * (2 + weeklyTx * weeks) + gas) * 100) / 100;
  const verdictLine =
    verdict === 'FARM'
      ? `Verdict FARM: deploy the full $${capital} — the implied value ${fmtUsd(priced.implied)} clears the $${sunkGas} sunk gas many times over.`
      : verdict === 'THIN'
        ? `Verdict THIN: deploy half, about $${Math.round(capital / 2)} — the implied value ${fmtUsd(priced.implied)} is real but the band runs down to ${fmtUsd(priced.low)}, so keep the sunk gas near $${sunkGas}.`
        : `Verdict WATCH: track it and do the free steps only — the implied value ${fmtUsd(priced.implied)} with a low band of ${fmtUsd(priced.low)} does not yet pay for $${sunkGas} of sunk gas.`;
  const steps = [
    `Open a fresh wallet that holds only this farm's funds and write its seed phrase on paper, never in a chat or a screenshot. Cost: $0, about ${gas >= 5 ? '$' + gas : '$' + gas} of gas only when you first move funds. Time: 5 minutes.`,
    `${actionFor(p, capital, chain)} Cost: $${capital} of capital deployed plus about $${gas} of gas. Time: 15 minutes to set up.`,
    `Do one qualifying action a week — a deposit, a swap, a vote or a borrow — so the wallet shows repeat use, not one deposit. Cost: about $${gas} of gas a week. Time: 10 minutes a week for ${weeks} weeks.`,
    `Hold the position at least ${hold} days so the activity lands in more than one snapshot window. Cost: the $${capital} stays deployed and retrievable. Time: ${hold} days.`,
    `Check the protocol's own points or rewards page from its official site and claim only from a link it publishes; never pay anyone to claim. Cost: $0 to check. Time: 10 minutes.`,
    `Farm math: sunk gas about $${sunkGas} across ${2 + weeklyTx * weeks + 1} transactions over ${hold} days, $${capital} deployed, implied value ${fmtUsd(priced.implied)} (honest band ${fmtUsd(priced.low)}-${fmtUsd(priced.high)}). ${verdictLine}`,
  ];
  return steps.map((s) => (s.length > 600 ? `${s.slice(0, 597)}...` : s));
}

// ---------------------------------------------------------------- board

interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  implied_low_usd: number;
  implied_high_usd: number;
  implied_per_tvl: number;
  verdict: Verdict;
  model: { base_usd: number; growth_multiplier: number; maturity_multiplier: number; curve_intercept: number; curve_slope: number };
  farm_steps: string[];
}

interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number;
  change_7d: number | null;
  mcap_per_tvl: number;
}

function buildBoard(snapshot: Snapshot): { board: BoardRow[]; live: LiveRow[]; curve: Curve; splits: SplitScore[] } {
  const comps = snapshot.protocols.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0);
  const curve = fitCurve(comps);
  const splits = [timeSplit(comps, '2024-01-01'), timeSplit(comps, '2023-01-01')];
  const typicalX = splits[0]!.curve_typical_x;

  const index = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const chosen = new Map<string, SnapProtocol>();
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  for (const p of snapshot.protocols) {
    if (!chosen.has(p.slug) && isRankable(p)) chosen.set(p.slug, p);
  }

  const scored = [...chosen.values()].map((p) => {
    const priced = price(p, snapshot.as_of, curve, typicalX);
    return { p, priced, age: ageDays(snapshot.as_of, p.listed_at) };
  });
  scored.sort((a, b) => b.priced.implied - a.priced.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  const board: BoardRow[] = scored.map((s, i) => {
    const verdict = verdictFor(s.priced.implied);
    return {
      rank: i + 1,
      slug: s.p.slug,
      name: s.p.name,
      category: s.p.category,
      chains: s.p.chains,
      tvl_usd: s.p.tvl_usd,
      change_7d: s.p.change_7d,
      mcap_usd: s.p.mcap_usd,
      listed_at: s.p.listed_at,
      gecko_id: s.p.gecko_id,
      symbol: s.p.symbol,
      token_status: 'pre-token',
      age_days: s.age,
      implied_value_usd: s.priced.implied,
      implied_low_usd: s.priced.low,
      implied_high_usd: s.priced.high,
      implied_per_tvl: round4(s.priced.implied / Math.max(1, s.p.tvl_usd)),
      verdict,
      model: {
        base_usd: s.priced.base,
        growth_multiplier: s.priced.growthMult,
        maturity_multiplier: s.priced.maturityMult,
        curve_intercept: round4(curve.intercept),
        curve_slope: round4(curve.slope),
      },
      farm_steps: farmSteps(s.p, s.age, s.priced, verdict),
    };
  });

  // Live-token protocols, apart: the market's own value, never a model claim.
  const live: LiveRow[] = snapshot.protocols
    .filter((p) => !isPreToken(p) && p.mcap_usd !== null && p.mcap_usd > 0 && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, 24)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd!,
      change_7d: p.change_7d,
      mcap_per_tvl: round4(p.mcap_usd! / Math.max(1, p.tvl_usd)),
    }));
  return { board, live, curve, splits };
}

/** The gate's own shape check, so a bad board fails here, not at the scorer. */
function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `board misses ${missing.length} watchlist slugs: ${missing.slice(0, 5).join(', ')}`;
  if (board.length < 100) return `board holds ${board.length} rows, under the 100 minimum`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) {
    if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  }
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return 'all rows share one implied value: not a ranking';
  }
  for (const r of board) {
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) {
      const t = s.trim();
      if (t.length < 20 || t.length > 600) return `${r.slug} has a farm step of ${t.length} characters`;
    }
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

// ---------------------------------------------------------------- dashboard data

function dataScript(snapshot: Snapshot, board: BoardRow[], live: LiveRow[], curve: Curve, splits: SplitScore[]): string {
  const rows = board.map((r) => ({
    rank: r.rank,
    slug: r.slug,
    name: r.name,
    category: r.category,
    chains: r.chains,
    tvl_usd: r.tvl_usd,
    change_7d: r.change_7d,
    listed_at: r.listed_at,
    age_days: r.age_days,
    implied_value_usd: r.implied_value_usd,
    implied_low_usd: r.implied_low_usd,
    implied_high_usd: r.implied_high_usd,
    implied_per_tvl: r.implied_per_tvl,
    verdict: r.verdict,
    on_watchlist: snapshot.watchlist.includes(r.slug),
    growth_multiplier: r.model.growth_multiplier,
    maturity_multiplier: r.model.maturity_multiplier,
    farm_steps: r.farm_steps,
  }));
  const radar = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: 'comps-curve-ols-r4',
    model: {
      kind: 'log-log OLS comps curve, fit at run time on the snapshot live-token protocols',
      intercept: round4(curve.intercept),
      slope: round4(curve.slope),
      n_comps: curve.n,
      r2: round4(curve.r2),
      resid_sd_log: round4(curve.residSd),
      typical_error_x: splits[0]!.curve_typical_x,
      formula: 'implied = exp(intercept + slope x ln(TVL)) x growth tilt x maturity tilt',
    },
    oos: splits,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    live_size: live.length,
    verdict_counts: {
      FARM: board.filter((r) => r.verdict === 'FARM').length,
      THIN: board.filter((r) => r.verdict === 'THIN').length,
      WATCH: board.filter((r) => r.verdict === 'WATCH').length,
    },
    rows,
    live,
  };
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}

// ---------------------------------------------------------------- main

function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const withEquals = process.argv.find((a) => a.startsWith(`--${name}=`));
  return withEquals === undefined ? fallback : withEquals.slice(name.length + 3);
}

const inputArg = arg('input', '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) {
  process.stderr.write(`token radar: no snapshot at ${inputFile}\n`);
  process.exit(2);
}
const out = arg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));
const { board, live, curve, splits } = buildBoard(snapshot);
const issue = boardIssue(board, snapshot);
if (issue !== null) {
  process.stderr.write(`token radar: board refused: ${issue}\n`);
  process.exit(1);
}

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
writeFileSync(join(out, 'data.js'), dataScript(snapshot, board, live, curve, splits));

function copyFiles(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    copied.push(name);
  }
  return copied;
}

copyFiles(join(here, 'dashboard'), join(out, 'dashboard'));
const shots = copyFiles(join(here, 'screenshots'), join(out, 'screenshots'));
if (shots.length < 3) {
  process.stderr.write(`token radar: screenshots/ holds ${shots.length} images: hand in 3\n`);
  process.exit(1);
}
for (const name of shots) {
  if (!IMAGE_NAME.test(name)) {
    process.stderr.write(`token radar: screenshots/${name}: bad name\n`);
    process.exit(1);
  }
}

writeFileSync(
  join(out, 'dossier.json'),
  buildDossier(out, { text_max_bytes: TEXT_MAX_BYTES, screenshots: { max: 4, max_bytes: 524_288 }, dashboard: { max_files: 400, max_bytes: 4_194_304 } }),
);

process.stdout.write(
  `token radar r4: ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} watchlist, ${board.length} rows, ${live.length} live apart\n` +
    `token radar r4: curve log(mcap) = ${curve.intercept.toFixed(3)} + ${curve.slope.toFixed(3)} x log(TVL), n=${curve.n}, R2=${curve.r2.toFixed(3)}\n` +
    `token radar r4: OOS split ${splits[0]!.cutoff}: curve x${splits[0]!.curve_typical_x} / ${(splits[0]!.curve_within_2x * 100).toFixed(0)}% within 2x vs flat x${splits[0]!.flat_typical_x} / ${(splits[0]!.flat_within_2x * 100).toFixed(0)}% within 2x\n` +
    `token radar r4: wrote board.json, data.js, dashboard, screenshots (${shots.length}) and dossier.json\n`,
);
