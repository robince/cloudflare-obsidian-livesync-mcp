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
  const value = parsed.document.toJS({ maxAliasCount: VAULT_LIMITS.maxFrontmatterKeys });
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

  for (const key of updateKeys) parsed.document.set(key, request.updates[key]);
  const removed = removeKeys.filter((key) => parsed.document.delete(key));
  const yaml = parsed.document.toString({ lineWidth: 0 }).replace(/\n/g, parsed.newline);
  return {
    content: `---${parsed.newline}${yaml}---${parsed.newline}${parsed.body}`,
    updated: updateKeys,
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
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function invalidFrontmatter(message: string): Error & { code: 'invalid_input' } {
  return Object.assign(new Error(message), { code: 'invalid_input' as const });
}
