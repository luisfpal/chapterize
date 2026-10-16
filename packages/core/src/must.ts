/**
 * A value the surrounding code has already proved is present.
 *
 * `noUncheckedIndexedAccess` types the miss as `undefined`. A postfix `!`
 * deletes that information. Throwing here names the index, which is the
 * difference between "the cut points and the blocks disagree" and a crash on
 * `.text` fifty lines later.
 */
export function must<T>(value: T | undefined | null, what: string): NonNullable<T> {
  if (value === undefined || value === null) {
    throw new RangeError(`${what} is missing.`);
  }
  return value;
}
