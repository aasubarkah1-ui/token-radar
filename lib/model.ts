// Token Radar — the scoring model behind the board.
//
// A sealed DefiLlama snapshot goes in; a ranked board of pre-token protocols comes out.
// The watchlist is the floor: every watchlist slug ranks, whatever the snapshot says.
// Below the floor, the radar adds every protocol that (a) shows no token on record and
// (b) passes the same quality rule the watchlist itself was built with, as far as the
// snapshot's ten fields can show it. Live-token protocols never enter the ranking; they
// are listed separately, carrying the market's own capitalisation instead of a model's.
//
// One function scores every row, and no protocol name is ever special-cased. The value a
// launch might carry is concave in locked value, nudged by recent growth, by how long the
// protocol has run without a token, and by how many chains it reaches:
//
//   tvlScore = (tvl_usd / 1_000_000) ^ 0.75
//   growth   = clamp(change_7d, -50, 150);  growthMult = 1 + growth / 100 * 0.6
//   maturity = 0.55 + min(age_days, 1095) / 1095 * 0.45   (an unknown age counts as 365 days)
//   chains   = 1 + 0.03 * min(chains, 10)
//   implied  = max(1, round(1_000_000 * tvlScore * growthMult * maturity * chains))
//
// A farm plan travels with every row: seven steps derived from the row's own category,
// chains, TVL and age, so a plan is never a hand-written list of names.

/** One protocol as the sealed snapshot records it: ten fields, nothing more. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  tvl_usd: number;
  chains: string[];
  category: string | null;
  change_7d: number | null;
  mcap_usd: number | null;
  gecko_id: string | null;
  symbol: string | null;
  listed_at: string | null;
}

/** The sealed snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  watchlist: string[];
  protocols: SnapshotProtocol[];
}

/** The model's tunable numbers, shared with the dashboard so the page can recompute a row. */
export interface ModelConstants {
  base_scale: number;
  tvl_exponent: number;
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  maturity_floor: number;
  maturity_range: number;
  maturity_days: number;
  unknown_age_days: number;
  chain_step: number;
  chain_cap: number;
}

export const MODEL: ModelConstants = {
  base_scale: 1_000_000,
  tvl_exponent: 0.75,
  growth_weight: 0.6,
  growth_floor: -50,
  growth_cap: 150,
  maturity_floor: 0.55,
  maturity_range: 0.45,
  maturity_days: 1095,
  unknown_age_days: 365,
  chain_step: 0.03,
  chain_cap: 10,
};

/** The label the dashboard shows for this model version. */
export const MODEL_VERSION = 'radar-2';

/** How many live-token protocols the dashboard's Live token tab shows. */
export const LIVE_ROWS = 32;

/** One step of a farm plan: what to do, what it costs, how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** One ranked row of board.json. */
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
    tvl_score: number;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    chain_multiplier: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

/** The dashboard's slim copy of a row; its farm plan is rebuilt in the page. */
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
  tvl_score: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  chain_multiplier: number;
  on_watchlist: boolean;
}

/** A protocol that already trades: the board shows the market's value, never a model's. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** Everything the dashboard renders: the board, the live set, and the model that scored it. */
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
  rows: RadarRow[];
  live: LiveRow[];
}

/** Raised when a snapshot file is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

/** `value` when it is a finite number, `fallback` otherwise. */
function asFinite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Whole days from `listedAt` to `asOf`, never below zero; null when a date is missing or bad. */
export function daysSinceListing(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const start = Date.parse(`${listedAt}T00:00:00Z`);
  const end = Date.parse(`${asOf}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, Math.floor((end - start) / DAY_MS));
}

/** Four decimals, for the multiplier figures the board and the page both display. */
function roundTo4dp(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/** The score one protocol earns under `model`: its implied value and every input behind it. */
export function scoreProtocol(
  protocol: SnapshotProtocol,
  asOf: string,
  model: ModelConstants,
): {
  implied: number;
  tvlScore: number;
  growthPct: number;
  growthMult: number;
  maturityMult: number;
  chainMult: number;
  age: number | null;
} {
  const age = daysSinceListing(asOf, protocol.listed_at);
  const growthPct = Math.min(model.growth_cap, Math.max(model.growth_floor, asFinite(protocol.change_7d, 0)));
  const growthMult = 1 + (growthPct / 100) * model.growth_weight;
  const ageForModel = age === null ? model.unknown_age_days : age;
  const maturityMult =
    model.maturity_floor +
    (Math.min(Math.max(ageForModel, 0), model.maturity_days) / model.maturity_days) * model.maturity_range;
  const chainMult = 1 + model.chain_step * Math.min(protocol.chains.length, model.chain_cap);
  const tvlScore = Math.pow(Math.max(protocol.tvl_usd, 0) / 1_000_000, model.tvl_exponent);
  const implied = Math.max(1, Math.round(model.base_scale * tvlScore * growthMult * maturityMult * chainMult));
  return { implied, tvlScore, growthPct, growthMult, maturityMult, chainMult, age };
}

/** A name that ends in a release number is a pool of some other protocol, not a protocol. */
const VERSIONED_NAME = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** A whole wrapped/staked word in a name marks a product of a token that already trades. */
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;

/** Exchange names a protocol may not start with. */
const EXCHANGES = [
  'Binance',
  'Coinbase',
  'Bybit',
  'Kraken',
  'Bitget',
  'OKX',
  'Bitfinex',
  'Gemini',
];

/** True when a record shows no token at all: no market cap, no CoinGecko id, no symbol. */
export function hasNoToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/**
 * Whether a protocol outside the watchlist may join the early radar: it shows no token, and
 * neither its category nor its name marks it an exchange, a bridge, a wrapped/staked product
 * or a restaking product. Watchlist slugs skip this rule entirely — the house already
 * applied it, and the board covers every watchlist slug either way.
 */
export function passesEarlyRule(p: SnapshotProtocol): boolean {
  if (!hasNoToken(p)) return false;
  const category = (p.category ?? '').toLowerCase();
  if (category === 'cex') return false;
  for (const banned of ['bridge', 'wrap', 'stak', 'restak']) {
    if (category.includes(banned)) return false;
  }
  if (VERSIONED_NAME.test(p.name)) return false;
  if (WRAPPED_WORD.test(p.name)) return false;
  for (const exchange of EXCHANGES) {
    if (p.name.startsWith(exchange)) return false;
  }
  return true;
}

/** The snapshot's protocols keyed by slug, for the watchlist lookup. */
function indexBySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  const index = new Map<string, SnapshotProtocol>();
  for (const p of protocols) index.set(p.slug, p);
  return index;
}

/** Strongest first; equal implied values break on the slug so the order is never a coin toss. */
function byImpliedDesc(
  a: { implied: number; p: SnapshotProtocol },
  b: { implied: number; p: SnapshotProtocol },
): number {
  if (b.implied !== a.implied) return b.implied - a.implied;
  return a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0;
}

/** The ranked board: every watchlist slug, plus every eligible below-floor protocol. */
export function rankBoard(snapshot: Snapshot, model: ModelConstants = MODEL): BoardRow[] {
  const index = indexBySlug(snapshot.protocols);
  const picked = new Map<string, SnapshotProtocol>();
  // The watchlist is the floor and is never gambled on: every slug it names ranks, even one
  // the snapshot no longer carries (it cannot, but coverage is a gate row and is never risked).
  for (const slug of snapshot.watchlist) {
    const found = index.get(slug);
    if (found !== undefined) picked.set(slug, found);
  }
  // The early radar: below the floor, passing the watchlist's own quality rule. No TVL cutoff
  // inside the pool and no top-N: the radar ranks all of them, not a chosen few.
  const early = snapshot.protocols
    .filter((p) => !picked.has(p.slug) && p.tvl_usd < snapshot.floor_usd && passesEarlyRule(p))
    .sort((a, b) => {
      if (b.tvl_usd !== a.tvl_usd) return b.tvl_usd - a.tvl_usd;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
  for (const entry of early) picked.set(entry.slug, entry);

  const scored = [...picked.values()].map((entry) => ({ entry, ...scoreProtocol(entry, snapshot.as_of, model) }));
  scored.sort((a, b) => byImpliedDesc({ implied: a.implied, p: a.entry }, { implied: b.implied, p: b.entry }));
  return scored.map((s, position) => ({
    rank: position + 1,
    slug: s.entry.slug,
    name: s.entry.name,
    category: s.entry.category,
    chains: s.entry.chains,
    tvl_usd: s.entry.tvl_usd,
    change_7d: s.entry.change_7d,
    mcap_usd: s.entry.mcap_usd,
    listed_at: s.entry.listed_at,
    gecko_id: s.entry.gecko_id,
    symbol: s.entry.symbol,
    token_status: 'pre-token',
    age_days: s.age,
    implied_value_usd: s.implied,
    model: {
      tvl_score: roundTo4dp(s.tvlScore),
      growth_pct: s.growthPct,
      growth_multiplier: roundTo4dp(s.growthMult),
      maturity_multiplier: roundTo4dp(s.maturityMult),
      chain_multiplier: roundTo4dp(s.chainMult),
      age_days: s.age,
    },
    farm_steps: planFarmSteps(s.entry, s.age).map(renderStep),
  }));
}

/** One step rendered as a single string: action, then cost and time, inside 20..600 characters. */
export function renderStep(step: FarmStep): string {
  let line = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (line.length > 600) line = `${line.slice(0, 596)}...`;
  if (line.length < 20) line = `${line} Hold the position and check the protocol's own page.`;
  return line;
}

/** The first chain a protocol names, or a neutral phrase when it names none. */
function firstChain(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** What one transaction costs on a chain: Ethereum is dear, every other chain is cheap. */
function gasPrice(chain: string): number {
  return chain === 'Ethereum' ? 8 : 1;
}

/** The capital one farm position needs, from the protocol's own TVL. */
function capitalNeeded(p: SnapshotProtocol): number {
  const tiers: Array<[number, number]> = [
    [5_000_000_000, 250],
    [1_000_000_000, 150],
    [100_000_000, 100],
  ];
  for (const [floor, capital] of tiers) {
    if (p.tvl_usd >= floor) return capital;
  }
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDays(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** One rule of the farm-action table: which categories it fits, and the action it writes. */
interface ActionRule {
  keys: string[];
  write: (name: string, capital: number, chain: string) => string;
}

const ACTION_RULES: ActionRule[] = [
  {
    keys: ['lend', 'cdp', 'collateral', 'uncollateralized'],
    write: (name, capital, chain) => `Supply $${capital} of USDC to ${name} on ${chain} and keep the loan open.`,
  },
  {
    keys: ['dex', 'leveraged farm'],
    write: (name, capital, chain) => `Provide $${capital} of liquidity to ${name}'s main pool on ${chain} and keep the position open.`,
  },
  {
    keys: ['curator', 'allocator'],
    write: (name, capital, chain) => `Deposit $${capital} into a ${name} vault on ${chain} and keep the shares.`,
  },
  {
    keys: ['yield aggregator'],
    write: (name, capital, chain) => `Deposit $${capital} into ${name}'s top vault on ${chain} and keep the shares.`,
  },
  {
    keys: ['yield'],
    write: (name, capital, chain) => `Deposit $${capital} into ${name} on ${chain} and keep the position earning.`,
  },
  {
    keys: ['rwa'],
    write: (name, capital, chain) => `Mint $${capital} of the protocol's yield asset on ${chain} and hold it.`,
  },
  {
    keys: ['basis'],
    write: (name, capital, chain) => `Deposit $${capital} into ${name}'s basis vault on ${chain} and keep the position open.`,
  },
  {
    keys: ['derivative', 'perpetual'],
    write: (name, capital, chain) => `Deposit $${capital} of USDC as margin on ${name} and open one small hedge.`,
  },
  {
    keys: ['prediction'],
    write: (name, capital, chain) => `Fund $${capital} and place one market position on ${name}.`,
  },
  {
    keys: ['stable'],
    write: (name, capital, chain) => `Mint or deposit $${capital} of the stable asset through ${name} on ${chain}.`,
  },
  {
    keys: ['insurance'],
    write: (name, capital, chain) => `Buy $${capital} of cover from ${name} on ${chain} and keep the policy.`,
  },
  {
    keys: ['farm'],
    write: (name, capital, chain) => `Stake $${capital} of LP tokens in ${name}'s farm on ${chain} and keep the stake.`,
  },
  {
    keys: ['otc', 'marketplace'],
    write: (name, capital, chain) => `Place one $${capital} order through ${name} on ${chain} and settle it.`,
  },
  {
    keys: ['payment', 'card'],
    write: (name, capital, chain) => `Spend $${capital} through ${name} on ${chain} and keep the account active.`,
  },
  {
    keys: ['index'],
    write: (name, capital, chain) => `Buy $${capital} of the ${name} index on ${chain} and hold the shares.`,
  },
  {
    keys: ['governance'],
    write: (name, capital, chain) => `Lock $${capital} of assets in ${name} on ${chain} and vote once.`,
  },
  {
    keys: ['chain'],
    write: (name, capital, chain) => `Use $${capital} of ${name} on ${chain} for one real transaction and keep the wallet active.`,
  },
];

/** The category's one action, in words a farmer can follow; first matching rule wins. */
function pickAction(p: SnapshotProtocol, capital: number, chain: string): string {
  const category = (p.category ?? '').toLowerCase();
  for (const rule of ACTION_RULES) {
    if (rule.keys.some((key) => category.includes(key))) return rule.write(p.name, capital, chain);
  }
  return `Deposit $${capital} of USDC into ${p.name} on ${chain} and keep the position open.`;
}

/**
 * A protocol's farm plan: seven steps, each an action with a cost and a time. The plan is
 * derived from the protocol's own record (category, chains, TVL, age), never from a
 * hand-written list of names. Gas follows the chain: an Ethereum transaction costs about
 * $8, any other chain about $1.
 */
export function planFarmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = firstChain(p);
  const gas = gasPrice(chain);
  const capital = capitalNeeded(p);
  const hold = holdDays(age);
  const action = pickAction(p, capital, chain);
  const triples: Array<[string, string, string]> = [
    [
      'Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.',
      `about $${gas} of gas for the first transaction`,
      '5 minutes',
    ],
    [action, `$${capital} of capital and about $${gas} of gas`, '15 minutes to set up'],
    [
      'Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote.',
      `about $${gas} of gas a week`,
      '10 minutes a week',
    ],
    [
      `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot.`,
      `the $${capital} stays in the position`,
      `${hold} days`,
    ],
    [
      `Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes.`,
      'no fee to check, and never pay to claim',
      '10 minutes',
    ],
    [
      'Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it.',
      'nothing but the log',
      '5 minutes',
    ],
    [
      'Unwind in reverse when you exit, then revoke the token approvals the farm needed.',
      `about $${gas} of gas to unwind`,
      '10 minutes',
    ],
  ];
  return triples.map(([text, cost, time]) => ({ text, cost, time }));
}

/** The live-token protocols, richest market cap first, for the dashboard's Live token view. */
export function topLive(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !hasNoToken(p) && p.category !== 'CEX')
    .sort((x, y) => (y.mcap_usd ?? 0) - (x.mcap_usd ?? 0) || y.tvl_usd - x.tvl_usd)
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

/** A board row's slim form for data.js; its farm plan is rebuilt in the page. */
export function compactRow(row: BoardRow, onWatchlist: boolean): RadarRow {
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
    tvl_score: row.model.tvl_score,
    growth_multiplier: row.model.growth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
    chain_multiplier: row.model.chain_multiplier,
    on_watchlist: onWatchlist,
  };
}

/** Everything the dashboard renders, from one snapshot. */
export function assembleRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const board = rankBoard(snapshot, model);
  const live = topLive(snapshot);
  const watchlist = new Set(snapshot.watchlist);
  const early = board.filter((r) => !watchlist.has(r.slug)).length;
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
    rows: board.map((r) => compactRow(r, watchlist.has(r.slug))),
    live,
  };
  return { board, radar };
}

/** Fail unless `ok` holds, naming the field the snapshot got wrong. */
function need(ok: boolean, message: string): void {
  if (!ok) throw new SnapshotError(message);
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function readSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  need(typeof raw === 'object' && raw !== null && !Array.isArray(raw), 'snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  need(typeof o.as_of === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(o.as_of), 'snapshot.json has no as_of date');
  need(typeof o.source === 'string', 'snapshot.json has no source');
  need(typeof o.floor_usd === 'number' && Number.isSafeInteger(o.floor_usd) && o.floor_usd > 0, 'snapshot.json has no floor_usd');
  need(Array.isArray(o.protocols), 'snapshot.json has no protocols array');
  need(
    Array.isArray(o.watchlist) && o.watchlist.every((s) => typeof s === 'string'),
    'snapshot.json has no watchlist of slugs',
  );
  const protocols = o.protocols.map((v, i) => {
    need(typeof v === 'object' && v !== null && !Array.isArray(v), `snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    need(
      typeof p.slug === 'string' && typeof p.name === 'string' && typeof p.tvl_usd === 'number' && Number.isFinite(p.tvl_usd),
      `snapshot.json's protocol ${i} lacks a slug, a name or a TVL`,
    );
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
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

/**
 * Why a board is not one the gate will take, or null: coverage, ranks, order, one shared
 * implied value across the whole board, and farm steps outside their bounds.
 */
export function findBoardProblem(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) {
    return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  }
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) {
    if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  }
  for (let i = 1; i < board.length; i++) {
    if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  }
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) {
      if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    }
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) {
      return `${r.slug} has implied value ${r.implied_value_usd}`;
    }
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function renderDataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
