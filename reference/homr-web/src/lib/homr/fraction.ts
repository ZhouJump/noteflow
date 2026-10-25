/**
 * Exact rational numbers, the subset of Python's `fractions.Fraction` the notation
 * stages need.
 *
 * The MusicXML writer compares bar lengths and note values for equality (a bar either
 * adds up to its time signature or it does not), so the arithmetic has to stay exact:
 * a float would turn 3/8 + 1/8 + 1/4 into 0.7499999999999999 and lose the comparison.
 * Durations are ratios of small integers, so bigint keeps the cost negligible.
 */

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    const rest = x % y;
    x = y;
    y = rest;
  }
  return x;
}

export class Fraction {
  /** Signed; the sign of the whole fraction lives here, like Python's Fraction. */
  readonly numerator: bigint;
  /** Always positive. */
  readonly denominator: bigint;

  constructor(numerator: bigint | number, denominator: bigint | number = 1n) {
    let top = typeof numerator === 'bigint' ? numerator : BigInt(Math.trunc(numerator));
    let bottom = typeof denominator === 'bigint' ? denominator : BigInt(Math.trunc(denominator));
    if (bottom === 0n) throw new Error('Fraction with zero denominator');
    if (bottom < 0n) {
      top = -top;
      bottom = -bottom;
    }
    const divisor = gcd(top, bottom);
    if (divisor > 1n) {
      top /= divisor;
      bottom /= divisor;
    }
    this.numerator = top;
    this.denominator = bottom;
  }

  static readonly ZERO = new Fraction(0n);
  static readonly ONE = new Fraction(1n);

  static from(value: Fraction | number | bigint): Fraction {
    if (value instanceof Fraction) return value;
    return new Fraction(value);
  }

  add(other: Fraction | number): Fraction {
    const right = Fraction.from(other);
    return new Fraction(
      this.numerator * right.denominator + right.numerator * this.denominator,
      this.denominator * right.denominator,
    );
  }

  sub(other: Fraction | number): Fraction {
    const right = Fraction.from(other);
    return new Fraction(
      this.numerator * right.denominator - right.numerator * this.denominator,
      this.denominator * right.denominator,
    );
  }

  mul(other: Fraction | number): Fraction {
    const right = Fraction.from(other);
    return new Fraction(this.numerator * right.numerator, this.denominator * right.denominator);
  }

  div(other: Fraction | number): Fraction {
    const right = Fraction.from(other);
    if (right.numerator === 0n) throw new Error('Fraction division by zero');
    return new Fraction(this.numerator * right.denominator, this.denominator * right.numerator);
  }

  neg(): Fraction {
    return new Fraction(-this.numerator, this.denominator);
  }

  compare(other: Fraction | number): number {
    const right = Fraction.from(other);
    const left = this.numerator * right.denominator;
    const rightScaled = right.numerator * this.denominator;
    if (left < rightScaled) return -1;
    if (left > rightScaled) return 1;
    return 0;
  }

  equals(other: Fraction | number): boolean {
    return this.compare(other) === 0;
  }

  isZero(): boolean {
    return this.numerator === 0n;
  }

  /** Python's `int()`: truncation towards zero. */
  trunc(): number {
    return Number(this.numerator / this.denominator);
  }

  toNumber(): number {
    return Number(this.numerator) / Number(this.denominator);
  }

  toString(): string {
    return this.denominator === 1n
      ? this.numerator.toString()
      : `${this.numerator}/${this.denominator}`;
  }
}

export function fractionMin(values: Fraction[]): Fraction {
  let best = values[0];
  for (const value of values) if (value.compare(best) < 0) best = value;
  return best;
}

export function fractionMax(values: Fraction[]): Fraction {
  let best = values[0];
  for (const value of values) if (value.compare(best) > 0) best = value;
  return best;
}

export function fractionSum(values: Fraction[]): Fraction {
  let total = Fraction.ZERO;
  for (const value of values) total = total.add(value);
  return total;
}

/** `sorted(values)` for Fractions. */
export function sortedFractions(values: Fraction[]): Fraction[] {
  return [...values].sort((a, b) => a.compare(b));
}

/**
 * `np.median` on a list of Fractions, kept exact: the middle value, or the mean of the
 * two middle values.
 */
export function medianFraction(values: Fraction[]): Fraction {
  const ordered = sortedFractions(values);
  const middle = Math.floor(ordered.length / 2);
  if (ordered.length % 2 === 1) return ordered[middle];
  return ordered[middle - 1].add(ordered[middle]).div(2);
}

/** `math.gcd` based lcm, the divisor search in the MusicXML writer uses. */
export function lcm(a: number, b: number): number {
  const left = BigInt(Math.abs(a));
  const right = BigInt(Math.abs(b));
  return Number((left / gcd(left, right)) * right);
}
