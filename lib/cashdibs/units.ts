/**
 * Exact integer arithmetic for money. No floats anywhere.
 *  - PHP and CAD: integer centavos / cents (number, safe-integer range).
 *  - USDC: integer string in 10^-7 units ("base units") at every JSON boundary.
 */
import { CashdibsError } from './types';

export const USDC_DECIMALS = 7;
const SCALE = 10_000_000n;
const INT64_MAX = 9_223_372_036_854_775_807n;

/** Validate a positive integer base-unit string and return it as bigint. */
export function parseUnits(s: unknown, label = 'amount'): bigint {
  if (typeof s !== 'string' || !/^[1-9]\d*$/.test(s)) {
    throw new CashdibsError('INVALID_AMOUNT', `${label} must be a positive integer string of base units`);
  }
  const n = BigInt(s);
  if (n > INT64_MAX) throw new CashdibsError('INVALID_AMOUNT', `${label} exceeds the Stellar int64 limit`);
  return n;
}

/** 123400000 -> "12.3400000" (the format Horizon payment operations use). */
export function unitsToHorizonAmount(units: string | bigint): string {
  const n = typeof units === 'bigint' ? units : parseUnits(units);
  return `${n / SCALE}.${(n % SCALE).toString().padStart(USDC_DECIMALS, '0')}`;
}

/** "12.34" or "12.3400000" -> 123400000n. Rejects more than 7 decimals and anything non-numeric. */
export function horizonAmountToUnits(amount: string): bigint {
  if (!/^\d+(\.\d{1,7})?$/.test(amount)) {
    throw new CashdibsError('INVALID_AMOUNT', `'${amount}' is not a valid 7-decimal amount`);
  }
  const [whole, frac = ''] = amount.split('.');
  return BigInt(whole) * SCALE + BigInt(frac.padEnd(USDC_DECIMALS, '0'));
}

export function assertCentavos(n: unknown, label = 'amount'): number {
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n <= 0) {
    throw new CashdibsError('INVALID_AMOUNT', `${label} must be a positive integer number of centavos`);
  }
  return n;
}

/** Same rule the contract states: on-hand minus held minus buffer. */
export function availableCentavos(onHand: number, held: number, buffer: number): number {
  return onHand - held - buffer;
}

/** 1500000 -> "PHP 15,000.00" (display only). */
export function formatPhp(centavos: number): string {
  const whole = Math.trunc(centavos / 100);
  const cents = Math.abs(centavos % 100).toString().padStart(2, '0');
  return `PHP ${whole.toLocaleString('en-US')}.${cents}`;
}
