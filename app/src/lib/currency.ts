/** Which currency the Usage screen shows costs in. Hermes prices usage in US dollars; pounds are converted for display. */
export type Currency = 'gbp' | 'usd';

/** Pounds by default. Kept on this device with the other preferences (prefs.currency). */
export const DEFAULT_CURRENCY: Currency = 'gbp';

/** A rate we can trust to multiply by: a finite number above zero. */
export const usableRate = (rate: unknown): rate is number => typeof rate === 'number' && Number.isFinite(rate) && rate > 0;

/**
 * The currency actually shown. Pounds need a rate; without one the numbers stay dollars, and say so with a '$',
 * so a '£' is never put on an unconverted figure.
 */
export function shownCurrency(choice: Currency, usdGbp: unknown): Currency {
  return choice === 'gbp' && usableRate(usdGbp) ? 'gbp' : 'usd';
}

/**
 * A cost given in dollars, as text in the chosen currency: £1.23, £0 for nothing, <£0.01 for less than a penny.
 * Anything that is not a sensible amount (missing, negative, not a number) reads as nothing.
 */
export function formatCost(usd: number | null | undefined, choice: Currency, usdGbp?: unknown): string {
  const shown = shownCurrency(choice, usdGbp);
  const symbol = shown === 'gbp' ? '£' : '$';
  const raw = typeof usd === 'number' && Number.isFinite(usd) && usd > 0 ? usd : 0;
  const amount = shown === 'gbp' ? raw * (usdGbp as number) : raw;
  if (amount === 0) return `${symbol}0`;
  if (amount < 0.01) return `<${symbol}0.01`;
  return `${symbol}${amount.toFixed(2)}`;
}
