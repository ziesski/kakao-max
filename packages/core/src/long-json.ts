// ----------------------------------------------------------------------------
// JSON for values that may hold BSON Longs (LOCO ids, revisions, timestamps).
//
// JSON.stringify writes a BSON Long as `{low, high, unsigned}`, which is useless
// to readers and was how message `raw` used to be stored. `longReplacer` writes
// Longs (and bigints) as decimal strings instead; `longReviver` turns the old
// `{low, high, unsigned}` shape back into the same decimal string, so rows saved
// before this change read the same as new ones without rewriting the database.
// ----------------------------------------------------------------------------

/** JSON.stringify replacer: BSON Longs and bigints become decimal strings. */
export function longReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value && typeof value === 'object' && (value as { _bsontype?: unknown })._bsontype === 'Long') return String(value);
  return value;
}

/** JSON.parse reviver: a serialized `{low, high, unsigned}` Long becomes its decimal string. */
export function longReviver(_key: string, value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const v = value as Record<string, unknown>;
  const keys = Object.keys(v);
  if (
    keys.length !== 3 ||
    typeof v.low !== 'number' ||
    typeof v.high !== 'number' ||
    typeof v.unsigned !== 'boolean' ||
    !Number.isInteger(v.low) ||
    !Number.isInteger(v.high)
  ) {
    return value;
  }
  const bits = (BigInt(v.high >>> 0) << 32n) | BigInt(v.low >>> 0);
  return (v.unsigned ? BigInt.asUintN(64, bits) : BigInt.asIntN(64, bits)).toString();
}
