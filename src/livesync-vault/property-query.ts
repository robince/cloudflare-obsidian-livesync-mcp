import type { FrontmatterFilter } from '@cloudflare-obsidian-livesync/contracts';

export function normalizeProperties(value: Record<string, unknown>): Record<string, unknown> {
  const tags = value.tags;
  if (typeof tags === 'string' || Array.isArray(tags)) {
    const list = typeof tags === 'string' ? tags.split(/[,\s]+/) : tags;
    return { ...value, tags: list.filter((tag): tag is string => typeof tag === 'string')
      .map((tag) => tag.replace(/^#/, '')).filter(Boolean) };
  }
  return value;
}

/** Keys and values are bindings, never interpolated JSON paths or SQL. */
export function propertyPredicate(filter: FrontmatterFilter): { sql: string; bindings: (string | number | null)[] } {
  const source = 'json_each(d.frontmatter) p';
  if (filter.operator === 'exists') return {
    sql: `${filter.value ? '' : 'NOT '}EXISTS(SELECT 1 FROM ${source} WHERE p.key=?)`, bindings: [filter.property],
  };
  const value = filter.property === 'tags' && typeof filter.value === 'string' ? filter.value.replace(/^#/, '') : filter.value;
  if ('type' in filter) {
    const op = { lt: '<', lte: '<=', gt: '>', gte: '>=' }[filter.operator];
    return filter.type === 'number' ? {
      sql: `EXISTS(SELECT 1 FROM ${source} WHERE p.key=? AND p.type IN ('integer','real') AND p.atom ${op} ?)`, bindings: [filter.property, filter.value],
    } : {
      // Only normalized ISO calendar dates or timestamps are admitted by the index.
      sql: `EXISTS(SELECT 1 FROM json_each(d.dates) p WHERE p.key=? AND p.atom ${op} ?)`,
      bindings: [filter.property, Date.parse(filter.value)],
    };
  }
  const type = value === null ? 'null' : typeof value === 'boolean' ? value ? 'true' : 'false' : typeof value === 'number' ? 'number' : 'text';
  const scalar = (alias: string) => type === 'number' ? `${alias}.type IN ('integer','real') AND ${alias}.atom IS ?` : `${alias}.type=? AND ${alias}.atom IS ?`;
  const values = type === 'number' ? [value as number] : [type, typeof value === 'boolean' ? Number(value) : value];
  if (filter.operator === 'contains') return {
    sql: `EXISTS(SELECT 1 FROM ${source}, json_each(CASE WHEN p.type='array' THEN p.value ELSE '[]' END) a WHERE p.key=? AND (${scalar('a')}))`,
    bindings: [filter.property, ...values] as (string | number | null)[],
  };
  return {
    sql: `EXISTS(SELECT 1 FROM ${source} WHERE p.key=? AND p.type IN ('null','true','false','integer','real','text') AND ${filter.operator === 'ne' ? 'NOT ' : ''}(${scalar('p')}))`,
    bindings: [filter.property, ...values] as (string | number | null)[],
  };
}
