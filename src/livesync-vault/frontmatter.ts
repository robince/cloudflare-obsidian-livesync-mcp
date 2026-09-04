import { Document, isMap, parseDocument } from 'yaml';

import {
  frontmatterSchema,
  VAULT_LIMITS,
  type PatchVaultFrontmatterRequest,
} from '@cloudflare-obsidian-livesync/contracts';

type ParsedFrontmatter = {
  document: Document;
  body: string;
  newline: '\n' | '\r\n';
};

export function readFrontmatter(content: string): Record<string, unknown> {
  const parsed = parseFrontmatter(content);
  if (!parsed) return {};
  const value = normalizeYamlValue(
    parsed.document.toJS({ maxAliasCount: VAULT_LIMITS.maxFrontmatterKeys }),
  );
  if (value === null) return {};
  if (!isPlainObject(value)) throw invalidFrontmatter('YAML frontmatter must be a mapping.');
  const validated = frontmatterSchema.safeParse(value);
  if (!validated.success) throw invalidFrontmatter('YAML frontmatter must contain JSON-compatible values.');
  return validated.data;
}

export function patchFrontmatter(
  content: string,
  request: Pick<PatchVaultFrontmatterRequest, 'updates' | 'remove'>,
): { content: string; updated: string[]; removed: string[] } {
  const updateKeys = Object.keys(request.updates);
  const removeKeys = [...new Set(request.remove ?? [])];
  if (updateKeys.length + removeKeys.length > VAULT_LIMITS.maxFrontmatterKeys) {
    throw invalidFrontmatter(`A frontmatter patch may affect at most ${VAULT_LIMITS.maxFrontmatterKeys} keys.`);
  }
  const overlap = updateKeys.find((key) => removeKeys.includes(key));
  if (overlap) throw invalidFrontmatter(`Frontmatter key ${JSON.stringify(overlap)} cannot be updated and removed together.`);

  const parsed = parseFrontmatter(content) ?? {
    document: new Document({}),
    body: content,
    newline: content.includes('\r\n') ? '\r\n' as const : '\n' as const,
  };
  if (parsed.document.contents !== null && !isMap(parsed.document.contents)) {
    throw invalidFrontmatter('YAML frontmatter must be a mapping.');
  }

  const current = parsed.document.toJS({ maxAliasCount: VAULT_LIMITS.maxFrontmatterKeys });
  if (current !== null && !isPlainObject(current)) {
    throw invalidFrontmatter('YAML frontmatter must be a mapping.');
  }

  const updated = updateKeys.filter((key) => {
    const exists = current !== null && Object.prototype.hasOwnProperty.call(current, key);
    if (exists && jsonValuesEqual(normalizeYamlValue(current[key]), request.updates[key])) return false;
    parsed.document.set(key, request.updates[key]);
    return true;
  });
  const removed = removeKeys.filter((key) => parsed.document.delete(key));
  if (updated.length === 0 && removed.length === 0) return { content, updated, removed };

  const yaml = parsed.document.toString({ lineWidth: 0 }).replace(/\n/g, parsed.newline);
  return {
    content: `---${parsed.newline}${yaml}---${parsed.newline}${parsed.body}`,
    updated,
    removed,
  };
}

function parseFrontmatter(content: string): ParsedFrontmatter | undefined {
  if (!content.startsWith('---\n') && !content.startsWith('---\r\n')) return undefined;
  const match = /^---(\r?\n)([\s\S]*?)^---[ \t]*(?:\r?\n|$)/m.exec(content);
  if (!match) return undefined;
  const document = parseDocument(match[2], {
    prettyErrors: false,
    strict: true,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    throw invalidFrontmatter(`Invalid YAML frontmatter: ${document.errors[0].message}`);
  }
  return {
    document,
    body: content.slice(match[0].length),
    newline: match[1] as '\n' | '\r\n',
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeYamlValue(value: unknown, ancestors = new Set<object>()): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return '.nan';
    if (value === Number.POSITIVE_INFINITY) return '.inf';
    if (value === Number.NEGATIVE_INFINITY) return '-.inf';
    return value;
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw invalidFrontmatter('YAML frontmatter contains an invalid timestamp.');
    return value.toISOString();
  }
  if (value instanceof Uint8Array) return encodeBase64(value);
  if (!value || typeof value !== 'object') {
    throw invalidFrontmatter('YAML frontmatter contains a value that cannot be represented as JSON.');
  }
  if (ancestors.has(value)) throw invalidFrontmatter('YAML frontmatter contains a circular alias.');

  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => normalizeYamlValue(item, ancestors));
    if (!isPlainObject(value)) {
      throw invalidFrontmatter('YAML frontmatter contains a value that cannot be represented as JSON.');
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, normalizeYamlValue(item, ancestors)]),
    );
  } finally {
    ancestors.delete(value);
  }
}

function jsonValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => jsonValuesEqual(value, right[index]));
  }
  if (!isPlainObject(left) || !isPlainObject(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key) => Object.prototype.hasOwnProperty.call(right, key)
      && jsonValuesEqual(left[key], right[key]));
}

function encodeBase64(value: Uint8Array): string {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function invalidFrontmatter(message: string): Error & { code: 'invalid_input' } {
  return Object.assign(new Error(message), { code: 'invalid_input' as const });
}
