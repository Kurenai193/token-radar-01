import { createHash } from 'node:crypto';

// The token radar's model: one snapshot of the protocol universe in, one ranked board out.
//
// The board covers every slug in the snapshot's watchlist (the floor, never a ceiling) and may add
// pre-token protocols below the watchlist floor: the early rows the radar exists to find. A protocol is
// pre-token when its index entry records no token (no market cap, no CoinGecko id, no symbol); the
// snapshot's live-token protocols are kept apart and shown as the market's own values, never mixed into
// the ranked board.
//
// Implied value follows only from the snapshot's own figures. The multiples are fitted at run time
// from the snapshot's own token-bearing protocols (the comparables), never hard-coded per protocol:
//
//   comps      = protocols with a live token, a market cap of at least $1,000,000 and an
//                mcap/TVL multiple inside [0.005, 30] (the snapshot also carries dead and
//                mispriced tokens; the cleaning rule is stated, not hidden)
//   baseMult   = category multiple x size adjustment, where the category multiple is the
//                comparables' median mcap/TVL for the protocol's category (falling back to a
//                category group, then to the global median), shrunk toward the global median
//                by n / (n + 6) in log space, and the size adjustment is (tvl / $100M) ^ -0.125,
//                clamped to [0.35, 2.5] (larger protocols trade at lower multiples; the fitted
//                slope, about -0.5, is damped to a quarter, a stated regularisation)
//   growth     = clamp(change_7d, -60, 120) per cent
//   growthMult = 1 + (growth / 100) x GROWTH_WEIGHT
//   maturity   = 0.8 + min(age_days, 1095) / 1095 x 0.2   (age_days unknown: 365)
//   implied    = max(1, round(tvl_usd x baseMult x growthMult x maturity))
//
// The model validates itself on a deterministic half of the comparables (split by slug hash) and
// reports the holdout error in the dashboard: on this snapshot the multiples are widely dispersed,
// so the board is a ranking with stated uncertainty, not a price prediction. No protocol name is
// ever special-cased: the same fitted function scores every row.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
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

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's constants, as the dashboard states them and the sandbox may change them. */
export interface ModelConstants {
  base_multiple: number;
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  maturity_floor: number;
  maturity_range: number;
  maturity_days: number;
  unknown_age_days: number;
}

export const MODEL: ModelConstants = {
  base_multiple: 0.32,
  growth_weight: 0.3,
  growth_floor: -60,
  growth_cap: 120,
  maturity_floor: 0.8,
  maturity_range: 0.2,
  maturity_days: 1095,
  unknown_age_days: 365,
};

/** The fitted model's extra constants: size elasticity, its reference size and clamps, shrinkage. */
export const SIZE_EXPONENT = -0.125;
export const SIZE_REF_USD = 100_000_000;
export const SIZE_ADJ_MIN = 0.35;
export const SIZE_ADJ_MAX = 2.5;
export const SHRINK_K = 6;
export const COMP_MIN_MCAP_USD = 1_000_000;
export const COMP_MULT_MIN = 0.005;
export const COMP_MULT_MAX = 30;

/** The model's version label: the dashboard names it and the rules quote it. */
export const MODEL_VERSION = 'radar-2';

/** How many pre-token protocols below the watchlist floor the early radar carries, by TVL. */
export const EARLY_ROWS = 400;

/** How many live-token protocols the Live token view carries, by market cap. */
export const LIVE_ROWS = 24;

/** A farm step: the action, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** One row of board.json: the ranked board's row. */
export interface BoardRow {
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
  model: {
    base_multiple: number;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

/** The dashboard's compact view of one row, with farm plans generated in the page. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  base_multiple: number;
  growth_multiplier: number;
  maturity_multiplier: number;
}

/** A live-token protocol: it already trades, so the board shows the market's own value, not a model's. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** The model's self-validation on the held-out half of the comparables. */
export interface Validation {
  comps: number;
  holdout: number;
  median_abs_pct_error: number;
  spearman: number;
  global_multiple: number;
}

/** Everything the dashboard needs: the board, the live set, and the model it runs. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  validation: Validation;
  rows: RadarRow[];
  live: LiveRow[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** A whole day count from `from` to `to`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** Category groups for the fallback when a category has too few comparables of its own. */
const CATEGORY_GROUPS: Record<string, string[]> = {
  yield: ['yield', 'risk curators', 'onchain capital allocator', 'basis trading', 'yield aggregator', 'leveraged farming'],
  lending: ['lending', 'cdp'],
  dexs: ['dexs'],
  bridge: ['bridge', 'cross chain bridge', 'canonical bridge'],
  staking: ['liquid staking', 'restaking', 'liquid restaking'],
  rwa: ['rwa'],
};

/** The group a category belongs to, or null. */
function groupOf(category: string | null): string | null {
  if (category === null) return null;
  const c = category.toLowerCase();
  for (const [group, members] of Object.entries(CATEGORY_GROUPS)) if (members.includes(c)) return group;
  return null;
}

/** The comparables: live-token protocols clean enough to fit multiples from. */
export function cleanComps(snapshot: Snapshot): SnapshotProtocol[] {
  return snapshot.protocols.filter((p) => {
    if (p.mcap_usd === null || p.mcap_usd < COMP_MIN_MCAP_USD || p.tvl_usd <= 0) return false;
    const mult = p.mcap_usd / p.tvl_usd;
    return mult >= COMP_MULT_MIN && mult <= COMP_MULT_MAX;
  });
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

/** Fitted log-space multiples: the global median and shrunk per-category and per-group effects. */
export interface FittedMultiples {
  comps: number;
  global_multiple: number;
  by_category: Map<string, number>;
  by_group: Map<string, number>;
}

/** Fit the multiples from a set of comparables, shrinking thin cells toward the global median. */
export function fitMultiples(comps: SnapshotProtocol[]): FittedMultiples {
  const globalMultiple = comps.length > 0 ? median(comps.map((p) => p.mcap_usd! / p.tvl_usd)) : MODEL.base_multiple;
  const globalLog = Math.log(globalMultiple);
  const shrink = (logs: number[]): number => {
    const w = logs.length / (logs.length + SHRINK_K);
    return w * median(logs) + (1 - w) * globalLog;
  };
  const byCategory = new Map<string, number>();
  const byGroup = new Map<string, number>();
  const catLogs = new Map<string, number[]>();
  const groupLogs = new Map<string, number[]>();
  for (const p of comps) {
    const log = Math.log(p.mcap_usd! / p.tvl_usd);
    if (p.category !== null) {
      const arr = catLogs.get(p.category) ?? [];
      arr.push(log);
      catLogs.set(p.category, arr);
    }
    const g = groupOf(p.category);
    if (g !== null) {
      const arr = groupLogs.get(g) ?? [];
      arr.push(log);
      groupLogs.set(g, arr);
    }
  }
  for (const [cat, logs] of catLogs) if (logs.length >= 3) byCategory.set(cat, shrink(logs));
  for (const [g, logs] of groupLogs) if (logs.length >= 3) byGroup.set(g, shrink(logs));
  return { comps: comps.length, global_multiple: globalMultiple, by_category: byCategory, by_group: byGroup };
}

/** The fitted base multiple for one protocol: its category (or group, or global) multiple, size-adjusted. */
export function baseMultipleFor(protocol: SnapshotProtocol, fit: FittedMultiples): number {
  let log = Math.log(fit.global_multiple);
  if (protocol.category !== null && fit.by_category.has(protocol.category)) log = fit.by_category.get(protocol.category)!;
  else {
    const g = groupOf(protocol.category);
    if (g !== null && fit.by_group.has(g)) log = fit.by_group.get(g)!;
  }
  const sizeAdj = Math.min(SIZE_ADJ_MAX, Math.max(SIZE_ADJ_MIN, Math.pow(protocol.tvl_usd / SIZE_REF_USD, SIZE_EXPONENT)));
  return Math.exp(log) * sizeAdj;
}

/** The three multipliers and the implied value one protocol gets under `model` and the fitted multiples. */
export function impliedValue(protocol: SnapshotProtocol, asOf: string, model: ModelConstants, fit: FittedMultiples): { implied: number; growthPct: number; growthMult: number; maturityMult: number; age: number | null; baseMultiple: number } {
  const age = ageDays(asOf, protocol.listed_at);
  const rawGrowth = finite(protocol.change_7d, 0);
  const growthPct = Math.min(model.growth_cap, Math.max(model.growth_floor, rawGrowth));
  const growthMult = 1 + (growthPct / 100) * model.growth_weight;
  const ageForModel = age ?? model.unknown_age_days;
  const maturityMult = model.maturity_floor + (Math.min(Math.max(ageForModel, 0), model.maturity_days) / model.maturity_days) * model.maturity_range;
  // The base multiple is rounded to the 4 decimals the board publishes before it is used, so the
  // dashboard's recompute from the published row lands on the same implied value, to the dollar.
  const baseMultiple = round4(baseMultipleFor(protocol, fit));
  const base = protocol.tvl_usd * baseMultiple;
  const implied = Math.max(1, Math.round(base * growthMult * maturityMult));
  return { implied, growthPct, growthMult, maturityMult, age, baseMultiple };
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Categories that are products of another protocol's token, never a launch of their own. */
const PRODUCT_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);

/** Names that mark an exchange's own product: the exchange's name at the start. */
const EXCHANGE_PREFIX = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/;

/** Whether a protocol is one the board may rank: pre-token, and not a wrapped, staked, bridged or
 * exchange product of a token that already trades (the watchlist's own exclusions, applied to the
 * early rows too; the parent-protocol field itself is not in the snapshot). */
export function isRankable(p: SnapshotProtocol): boolean {
  if (!isPreToken(p)) return false;
  if (p.category !== null && PRODUCT_CATEGORIES.has(p.category)) return false;
  if (VERSIONED.test(p.name)) return false;
  if (/\b(wrapped|staked|staking)\b/i.test(p.name)) return false;
  if (EXCHANGE_PREFIX.test(p.name)) return false;
  return true;
}

/** The snapshot's protocol by slug. */
function bySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  return new Map(protocols.map((p) => [p.slug, p]));
}

/** The headline sentence's figures: how many watchlist slugs, how many rows, how many live protocols. */
export interface BoardSummary {
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
}

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL, fit: FittedMultiples = fitMultiples(cleanComps(snapshot))): BoardRow[] {
  const index = bySlug(snapshot.protocols);
  const chosen = new Map<string, SnapshotProtocol>();
  // The watchlist is the floor: every slug, even one the snapshot no longer carries (it cannot, but the
  // board's coverage is the gate's row and is never gambled on a missing record).
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  // The early radar: pre-token protocols below the watchlist floor, by TVL, capped. Never a replacement
  // for a watchlist row: a chosen protocol stays chosen.
  const early = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && isRankable(p) && p.tvl_usd < snapshot.floor_usd)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .slice(0, EARLY_ROWS);
  for (const p of early) chosen.set(p.slug, p);

  const scored = [...chosen.values()].map((p) => {
    const { implied, growthPct, growthMult, maturityMult, age, baseMultiple } = impliedValue(p, snapshot.as_of, model, fit);
    return { p, implied, growthPct, growthMult, maturityMult, age, baseMultiple };
  });
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((s, i) => ({
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
    implied_value_usd: s.implied,
    model: {
      base_multiple: round4(s.baseMultiple),
      growth_pct: s.growthPct,
      growth_multiplier: round4(s.growthMult),
      maturity_multiplier: round4(s.maturityMult),
      age_days: s.age,
    },
    farm_steps: farmSteps(s.p, s.age).map(stepText),
  }));
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** The category's one action, in the words a farmer can follow. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Supply $${capital} of USDC to ${name} on ${chain} and keep the position open.`;
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm')) return `Provide $${capital} of liquidity to ${name}'s main pool on ${chain} and keep the position open.`;
  if (c.includes('bridge')) return `Bridge $${capital} of USDC to ${chain} through ${name} and use the bridged funds in its app.`;
  if (c.includes('staking') || c.includes('restak')) return `Stake $${capital} of the chain's staking asset through ${name} and keep the receipt.`;
  if (c.includes('perpetual') || c.includes('derivative')) return `Deposit $${capital} of USDC as margin on ${name} and open one small hedge.`;
  if (c.includes('prediction')) return `Fund $${capital} and place one market position on ${name}.`;
  if (c.includes('curator') || c.includes('allocator')) return `Deposit $${capital} into a ${name} vault on ${chain} and keep the shares.`;
  if (c.includes('basis')) return `Deposit $${capital} of USDC into a ${name} basis vault on ${chain} and keep the vault shares.`;
  if (c.includes('chain')) return `Bridge $${capital} to ${name}'s chain, then make one swap and one transfer with the native app so the wallet shows real activity.`;
  if (c.includes('payment')) return `Fund a ${name} account with $${capital} on ${chain} and send one payment to a second wallet you control.`;
  if (c.includes('cedefi') || c.includes('cefi')) return `Deposit $${capital} into a ${name} earn product on ${chain} and keep the position open.`;
  if (c.includes('stable')) return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain}.`;
  if (c.includes('rwa')) return `Mint $${capital} of the protocol's yield asset on ${chain} and hold it.`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy.`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

/** The weekly qualifying action, matched to what the protocol actually does all week. */
function weeklyActionFor(p: SnapshotProtocol): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Top up the supply by a small amount, or repay part of a borrow, so ${name} sees a fresh action each week.`;
  if (c.includes('dex')) return `Make one small swap in ${name}'s main pool each week, in the pair you already farm.`;
  if (c.includes('curator') || c.includes('allocator')) return `Open ${name}'s vault page each week, claim any points it shows and leave the shares untouched.`;
  if (c.includes('bridge')) return `Bridge one small amount through ${name} each week, alternating direction.`;
  if (c.includes('staking') || c.includes('restak')) return `Claim any staking rewards each week and restake them through ${name}.`;
  if (c.includes('basis')) return `Check the ${name} basis vault each week and claim any points or yield it shows.`;
  if (c.includes('chain')) return `Make one transfer and one app interaction on ${name}'s chain each week.`;
  if (c.includes('payment')) return `Send one small payment through ${name} each week, to the second wallet you control.`;
  if (c.includes('rwa')) return `Check the yield accrual on your ${name} position each week and claim what it shows.`;
  if (c.includes('yield')) return `Harvest or compound the yield on your ${name} position once each week.`;
  return `Make one qualifying action each week on ${name}, such as a deposit, a swap or a claim.`;
}

/**
 * A protocol's farm plan: six steps, each an action with a cost and a time. The plan is derived from
 * the protocol's own record (category, chains, TVL, age), never from a hand-written list of names.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const action = actionFor(p, capital, chain);
  return [
    {
      text: `Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.`,
      cost: 'under $3 of gas for the first transaction',
      time: '5 minutes',
    },
    {
      text: action,
      cost: `$${capital} of capital and about $${capital >= 150 ? 8 : 4} of gas`,
      time: '15 minutes to set up',
    },
    {
      text: weeklyActionFor(p),
      cost: 'about $2 of gas a week',
      time: '10 minutes a week',
    },
    {
      text: `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot.`,
      cost: `the $${capital} stays in the position`,
      time: `${hold} days`,
    },
    {
      text: `Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes.`,
      cost: 'no fee to check, and never pay to claim',
      time: '10 minutes',
    },
    {
      text: `Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it.`,
      cost: 'nothing but the log',
      time: '5 minutes',
    },
  ];
}

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

/** A board row's compact form for data.js, with the farm plan generated in the page. */
export function radarRow(row: BoardRow): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    mcap_usd: row.mcap_usd,
    listed_at: row.listed_at,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    base_multiple: row.model.base_multiple,
    growth_multiplier: row.model.growth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
  };
}

/** Spearman's rank correlation between two equal-length series. */
function spearman(xs: number[], ys: number[]): number {
  const ranks = (vs: number[]): number[] => {
    const order = vs.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
    const r = new Array<number>(vs.length);
    order.forEach(([, i], rank) => (r[i] = rank));
    return r;
  };
  const rx = ranks(xs);
  const ry = ranks(ys);
  const n = xs.length;
  if (n < 3) return 0;
  let d2 = 0;
  for (let i = 0; i < n; i++) d2 += (rx[i]! - ry[i]!) ** 2;
  return Math.round((1 - (6 * d2) / (n * (n * n - 1))) * 1000) / 1000;
}

/** Validate the fitted model on the held-out half of the comparables (split by slug hash). */
export function validateModel(snapshot: Snapshot, model: ModelConstants = MODEL): Validation {
  const comps = cleanComps(snapshot);
  const inA = (slug: string): boolean => createHash('md5').update(slug).digest()[0]! % 2 === 0;
  const train = comps.filter((p) => inA(p.slug));
  const test = comps.filter((p) => !inA(p.slug));
  const fit = fitMultiples(train);
  const errors: number[] = [];
  const predicted: number[] = [];
  const actual: number[] = [];
  for (const p of test) {
    const { implied } = impliedValue(p, snapshot.as_of, model, fit);
    errors.push(Math.abs(implied - p.mcap_usd!) / p.mcap_usd!);
    predicted.push(implied);
    actual.push(p.mcap_usd!);
  }
  const full = fitMultiples(comps);
  return {
    comps: comps.length,
    holdout: test.length,
    median_abs_pct_error: Math.round(median(errors) * 1000) / 1000,
    spearman: spearman(predicted, actual),
    global_multiple: Math.round(full.global_multiple * 1000) / 1000,
  };
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot, model);
  const live = liveRows(snapshot);
  const early = board.filter((r) => !snapshot.watchlist.includes(r.slug)).length;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    validation: validateModel(snapshot, model),
    rows: board.map(radarRow),
    live,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
