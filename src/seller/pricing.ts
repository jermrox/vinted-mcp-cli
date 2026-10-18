import { VintedClient } from '../client/session.js';
import { opSearchAll } from '../ops/search.js';
import type { Condition, Country, Item } from '../client/types.js';

export interface PriceStats {
  sampleSize: number;
  currency: string;
  min: number;
  p25: number;
  median: number;
  p75: number;
  max: number;
}

export interface PriceSuggestion {
  quickSale: number;   // priced to go within days
  fair: number;        // middle of the market
  ambitious: number;   // room for offers, slower to sell
}

export interface PriceResearchResult {
  query: string;
  country: Country;
  stats: PriceStats | null;
  suggestion: PriceSuggestion | null;
  comparables: Pick<Item, 'id' | 'title' | 'price' | 'currency' | 'brand' | 'size' | 'condition' | 'url' | 'favouriteCount'>[];
  note?: string;
}

/** Linear-interpolated quantile of an ascending-sorted array. */
export function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function priceStats(prices: number[], currency: string): PriceStats | null {
  const xs = prices.filter((p) => Number.isFinite(p) && p > 0).sort((a, b) => a - b);
  if (!xs.length) return null;
  return {
    sampleSize: xs.length,
    currency,
    min: round(xs[0]),
    p25: round(quantile(xs, 0.25)),
    median: round(quantile(xs, 0.5)),
    p75: round(quantile(xs, 0.75)),
    max: round(xs[xs.length - 1]),
  };
}

export function suggestPrice(s: PriceStats): PriceSuggestion {
  // Sellers on Vinted expect offers, so the asks sit just under the round numbers buyers filter by.
  return {
    quickSale: tidy(s.p25),
    fair: tidy(s.median),
    ambitious: tidy(s.p75),
  };
}

export async function opPriceResearch(
  client: VintedClient,
  input: {
    query: string;
    country?: Country;
    brandIds?: number[];
    categoryId?: number;
    sizeIds?: number[];
    condition?: Condition[];
    maxItems?: number;
  },
): Promise<PriceResearchResult> {
  if (!input.query?.trim()) throw new Error('query is required');
  const country = input.country ?? 'fr';
  const r = await opSearchAll(client, {
    query: input.query,
    country,
    brandIds: input.brandIds,
    categoryId: input.categoryId,
    sizeIds: input.sizeIds,
    condition: input.condition,
    maxItems: Math.min(Math.max(input.maxItems ?? 150, 10), 400),
  });
  const currency = r.items[0]?.currency ?? '';
  const stats = priceStats(r.items.map((i) => Number(i.price)), currency);
  const comparables = [...r.items]
    .sort((a, b) => (b.favouriteCount ?? 0) - (a.favouriteCount ?? 0))
    .slice(0, 10)
    .map(({ id, title, price, currency, brand, size, condition, url, favouriteCount }) =>
      ({ id, title, price, currency, brand, size, condition, url, favouriteCount }));
  return {
    query: input.query,
    country,
    stats,
    suggestion: stats ? suggestPrice(stats) : null,
    comparables,
    note: !stats
      ? 'No comparable listings found: broaden the query (drop size/condition) or price from retail.'
      : stats.sampleSize < 10
        ? 'Fewer than 10 comparables: treat the suggestion as rough.'
        : undefined,
  };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function tidy(n: number): number {
  if (n < 10) return Math.max(1, Math.round(n));
  return Math.max(1, Math.round(n) - (Math.round(n) % 5 === 0 ? 1 : 0));
}
