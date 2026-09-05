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

/** Validate once at the protocol boundary, before scanning any documents. */
export function validateSelector(selector: unknown, depth = 0): asserts selector is Selector {
  const fail = () => { throw Object.assign(new Error('Unsupported or invalid Mango selector'), { status: 400, name: 'bad_request' }); };
  if (!selector || typeof selector !== 'object' || Array.isArray(selector) || depth > 20) return fail();
  for (const [key, value] of Object.entries(selector)) {
    if (key === '$and' || key === '$or') {
      if (!Array.isArray(value)) return fail();
      for (const part of value) validateSelector(part, depth + 1);
    } else if (key === '$not') validateSelector(value, depth + 1);
    else if (key.startsWith('$')) return fail();
    else if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [op, operand] of Object.entries(value)) {
        if (!['$eq', '$ne', '$lt', '$lte', '$gt', '$gte', '$exists', '$in', '$nin'].includes(op)) return fail();
        if ((op === '$in' || op === '$nin') && !Array.isArray(operand)) return fail();
        if (op === '$exists' && typeof operand !== 'boolean') return fail();
      }
    }
  }
}
