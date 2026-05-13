// Banker's rounding and decimal-string helpers.
//
// Money is always integer cents. Fractions are emitted as strings with
// exactly 4 decimal digits (D13) to avoid float drift on equality checks.

// Round half-to-even (banker's) on a finite number.
export function bankersRound(value: number): number {
  if (!Number.isFinite(value)) {
    throw new Error(`bankersRound: non-finite value ${value}`);
  }
  const rounded = Math.round(value);
  const diff = Math.abs(value - Math.trunc(value));
  if (Math.abs(diff - 0.5) < Number.EPSILON) {
    const floor = Math.floor(value);
    return floor % 2 === 0 ? floor : floor + 1;
  }
  return rounded;
}

// Format a fraction with exactly 4 decimal digits using banker's rounding.
export function fraction4(value: number): string {
  if (!Number.isFinite(value)) {
    throw new Error(`fraction4: non-finite value ${value}`);
  }
  const scaled = value * 10000;
  const rounded = bankersRound(scaled);
  const sign = rounded < 0 ? '-' : '';
  const abs = Math.abs(rounded);
  const whole = Math.floor(abs / 10000);
  const frac = abs % 10000;
  return `${sign}${whole}.${frac.toString().padStart(4, '0')}`;
}

// Convert a "string decimal" like "450.00" or "0.6129" to an exact integer
// "scaled" representation: returns `[mantissa, scale]` so multiplications
// stay in integers. Eg. "450.00" → [45000, 100].
export function parseDecimalString(str: string): { mantissa: bigint; scale: bigint } {
  const trimmed = str.trim();
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(trimmed);
  if (!match) {
    throw new Error(`parseDecimalString: invalid ${str}`);
  }
  const [, sign, intPart, fracPart = ''] = match;
  const digits = `${intPart}${fracPart}`;
  const mantissa = BigInt(`${sign}${digits}`);
  const scale = BigInt(10) ** BigInt(fracPart.length);
  return { mantissa, scale };
}

// Compute `unit_amount_cents` integer from a "amount" string with 2 decimals
// (eg. "450.00" → 45000). The spec stores prices in `properties.amount` as
// strings of currency units; cents = amount * 100.
export function amountStringToCents(amount: string): number {
  const { mantissa, scale } = parseDecimalString(amount);
  // cents = mantissa * 100 / scale
  const cents = (mantissa * BigInt(100)) / scale;
  return Number(cents);
}

// Compute `amount_cents = round(fraction × unit_amount_cents)` where fraction
// is the 4-digit string (already truncated). Uses banker's rounding.
export function applyFraction(fractionStr: string, unitAmountCents: number): number {
  const { mantissa, scale } = parseDecimalString(fractionStr);
  // amount * mantissa / scale
  const product = BigInt(unitAmountCents) * mantissa;
  // Round to nearest, banker's.
  const num = Number(product);
  const denom = Number(scale);
  return bankersRound(num / denom);
}

// Format a string for `units` in usage responses. Lago Cloud emits
// values like "0.5483870967741935" (full float precision) for prorated
// counts and "0.0"/"1.0" for integer counts.
export function unitsForUsage(value: number): string {
  if (Number.isInteger(value)) {
    return `${value}.0`;
  }
  return value.toString();
}
