type Selector = Record<string, unknown>;

function compare(value: unknown, condition: unknown): boolean {
  if (typeof condition !== 'object' || condition === null || Array.isArray(condition)) {
    return value === condition;
  }
  for (const [operator, expected] of Object.entries(condition)) {
    if (operator === '$eq' && value !== expected) return false;
    if (operator === '$ne' && value === expected) return false;
    if (operator === '$lt' && !((value as never) < (expected as never))) return false;
    if (operator === '$lte' && !((value as never) <= (expected as never))) return false;
    if (operator === '$gt' && !((value as never) > (expected as never))) return false;
    if (operator === '$gte' && !((value as never) >= (expected as never))) return false;
    if (operator === '$exists' && (value !== undefined) !== Boolean(expected)) return false;
    if (operator === '$in' && (!Array.isArray(expected) || !expected.includes(value))) return false;
    if (operator === '$nin' && Array.isArray(expected) && expected.includes(value)) return false;
  }
  return true;
}

function field(doc: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((value, part) => {
    return typeof value === 'object' && value !== null
      ? (value as Record<string, unknown>)[part]
      : undefined;
  }, doc);
}

export function matchesSelector(doc: Record<string, unknown>, selector: Selector): boolean {
  for (const [key, condition] of Object.entries(selector)) {
    if (key === '$and') {
      if (!Array.isArray(condition) || !condition.every((part) => matchesSelector(doc, part as Selector))) {
        return false;
      }
    } else if (key === '$or') {
      if (!Array.isArray(condition) || !condition.some((part) => matchesSelector(doc, part as Selector))) {
        return false;
      }
    } else if (key === '$not') {
      if (matchesSelector(doc, condition as Selector)) return false;
    } else if (!compare(field(doc, key), condition)) {
      return false;
    }
  }
  return true;
}
