/**
 * Locale-tolerant decimal parsing for user-typed money/rate values.
 *
 * `<input type="number">` hands the page an EMPTY string whenever the typed
 * value is invalid for the browser locale (e.g. "104,5" on an en-US system,
 * or "5.000" used as grouping in pt-BR), which made the wizard report
 * missing fields on visibly-filled inputs. Plain parseFloat is worse in
 * mixed-separator cases: parseFloat("1.045,32") === 1, silently wrong math.
 *
 * Normalization rule: the LAST separator in the string is the decimal one
 * ("1.045,32" -> 1045.32, "1,045.32" -> 1045.32, "104,5" -> 104.5). A lone
 * dot stays a decimal separator ("104.5" -> 104.5); "5.000" therefore reads
 * as 5, not 5000 — grouping without a decimal part stays ambiguous and is
 * not guessed.
 */
export function parseDecimal(raw: string): number {
  const s = raw.trim().replace(/\s+/g, '');
  if (!s) return NaN;
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma > lastDot) return Number(s.replace(/\./g, '').replace(',', '.'));
  if (lastComma !== -1) return Number(s.replace(/,/g, ''));
  return Number(s);
}
