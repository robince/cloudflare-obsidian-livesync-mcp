import xxhashNew from 'xxhash-wasm-102';
import { fallbackMixedHashEach } from 'octagonal-wheels/hash/purejs.js';

type HashString = (value: string) => string;

let digestHashString: HashString = fallbackMixedHashEach;

void xxhashNew().then(({ h32ToString }) => {
  digestHashString = h32ToString;
}).catch(() => {
  // Commonlib's xxhash manager will fail closed if the Worker module cannot
  // initialise. This synchronous legacy helper retains its upstream fallback.
});

/** Worker-compatible replacement for Octagonal Wheels' embedded-byte loader. */
export { xxhashNew };

/** Preserves the synchronous helper exported by Octagonal Wheels. */
export function digestHash(values: string[]): string {
  let hash = '';
  for (const value of values) hash = digestHashString(hash + value);
  return hash === '' ? digestHashString('**') : hash;
}
