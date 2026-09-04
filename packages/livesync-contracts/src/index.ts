import { z } from 'zod';

/** Incremented whenever the semantic vault RPC wire contract changes. */
export const CONTRACT_VERSION = 4 as const;

export const VAULT_LIMITS = {
  maxListLimit: 100,
  defaultListLimit: 50,
  maxReadBytes: 512_000,
  maxAttachmentReadBytes: 512_000,
  maxWriteBytes: 512_000,
  maxPatchTextBytes: 64_000,
  maxFrontmatterKeys: 100,
  maxFrontmatterBytes: 512_000,
  maxFrontmatterDepth: 32,
  maxFrontmatterNodes: 10_000,
  maxPathLength: 1024,
  maxCursorLength: 2048,
  maxRevisionLength: 256,
  maxSearchQueryBytes: 256,
  maxSearchTerms: 16,
  defaultSearchLimit: 20,
  maxSearchLimit: 50,
  maxSearchSnippetBytes: 1024,
  maxSearchResponseBytes: 128 * 1024,
} as const;

export const vaultErrorCodeSchema = z.enum([
  'invalid_input',
  'not_found',
  'unsupported',
  'too_large',
  'unavailable',
  'revision_conflict',
  'conflict_reconciled',
  'livesync_conflict',
  'internal',
]);

export const vaultErrorSchema = z.discriminatedUnion('code', [
  z.object({
    code: z.enum(['invalid_input', 'not_found', 'unsupported', 'too_large', 'unavailable', 'internal']),
    message: z.string(),
  }),
  z.object({
    code: z.literal('revision_conflict'), message: z.string(), path: z.string(),
    resolution: z.literal('reread_and_reassess'),
  }),
  z.object({
    code: z.literal('conflict_reconciled'), message: z.string(), path: z.string(),
    resolution: z.literal('reread_and_reassess'), unresolvedVersions: z.number().int().nonnegative(),
  }),
  z.object({
    code: z.literal('livesync_conflict'), message: z.string(), path: z.string(),
    resolution: z.literal('obsidian'), unresolvedVersions: z.number().int().nonnegative(),
  }),
]);

export const vaultResultSchema = <T extends z.ZodType>(data: T) =>
  z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), data }),
    z.object({ ok: z.literal(false), error: vaultErrorSchema }),
  ]);

export type VaultErrorCode = z.infer<typeof vaultErrorCodeSchema>;
export type VaultError = z.infer<typeof vaultErrorSchema>;
export type VaultResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: VaultError };

export const vaultStatusDataSchema = z.object({
  contractVersion: z.literal(CONTRACT_VERSION),
  compatible: z.boolean(),
  reasons: z.array(z.string()),
});
export type VaultStatusData = z.infer<typeof vaultStatusDataSchema>;

export const listVaultFilesRequestSchema = z.object({
  prefix: z.string().max(VAULT_LIMITS.maxPathLength).optional(),
  limit: z.number().int().positive().max(VAULT_LIMITS.maxListLimit).optional(),
  cursor: z.string().max(VAULT_LIMITS.maxCursorLength).optional(),
}).strict();
export type ListVaultFilesRequest = z.infer<typeof listVaultFilesRequestSchema>;

export const vaultFileSchema = z.object({
  path: z.string(),
  revision: z.string(),
  sizeBytes: z.number().int().nonnegative().optional(),
  createdAt: z.number().int().nonnegative().optional()
    .describe('Unix epoch time in milliseconds.'),
  modifiedAt: z.number().int().nonnegative().optional()
    .describe('Unix epoch time in milliseconds.'),
  unresolvedVersions: z.number().int().min(2).optional(),
});
export type VaultFile = z.infer<typeof vaultFileSchema>;

export const listVaultFilesDataSchema = z.object({
  files: z.array(vaultFileSchema),
  cursor: z.string().optional(),
});
export type ListVaultFilesData = z.infer<typeof listVaultFilesDataSchema>;

export const searchVaultFilesRequestSchema = z.object({
  query: z.string().refine(
    (query) => query.trim().length > 0
      && new TextEncoder().encode(query).byteLength <= VAULT_LIMITS.maxSearchQueryBytes
      && query.trim().split(/\s+/u).length <= VAULT_LIMITS.maxSearchTerms,
    { message: `Query must contain 1-${VAULT_LIMITS.maxSearchTerms} terms and not exceed ${VAULT_LIMITS.maxSearchQueryBytes} UTF-8 bytes.` },
  ),
  pathPrefix: z.string().max(VAULT_LIMITS.maxPathLength).optional(),
  limit: z.number().int().positive().max(VAULT_LIMITS.maxSearchLimit).optional(),
}).strict();
export type SearchVaultFilesRequest = z.infer<typeof searchVaultFilesRequestSchema>;

export const searchVaultFilesDataSchema = z.object({
  results: z.array(z.object({
    path: z.string(),
    revision: z.string(),
    snippet: z.string(),
    unresolvedVersions: z.number().int().min(2).optional(),
  })),
  truncated: z.boolean(),
  incomplete: z.boolean(),
  unindexedFiles: z.number().int().nonnegative(),
});
export type SearchVaultFilesData = z.infer<typeof searchVaultFilesDataSchema>;

export const readVaultFileRequestSchema = z.object({
  path: z.string().min(1).max(VAULT_LIMITS.maxPathLength),
}).strict();
export type ReadVaultFileRequest = z.infer<typeof readVaultFileRequestSchema>;

export const readVaultFileDataSchema = z.object({
  path: z.string(),
  revision: z.string(),
  content: z.string(),
});
export type ReadVaultFileData = z.infer<typeof readVaultFileDataSchema>;

/** Markdown content bounded by its encoded wire/storage size, not UTF-16 code units. */
export const vaultContentSchema = z.string()
  .max(VAULT_LIMITS.maxWriteBytes)
  .refine(
    (content) => new TextEncoder().encode(content).byteLength <= VAULT_LIMITS.maxWriteBytes,
    { message: `Content must not exceed ${VAULT_LIMITS.maxWriteBytes} UTF-8 bytes.` },
  );

export const appendVaultFileRequestSchema = z.object({
  path: z.string().min(1).max(VAULT_LIMITS.maxPathLength),
  content: vaultContentSchema.refine((content) => content.length > 0, { message: 'Append content must not be empty.' }),
  expectedRevision: z.string().min(1).max(VAULT_LIMITS.maxRevisionLength),
}).strict();
export type AppendVaultFileRequest = z.infer<typeof appendVaultFileRequestSchema>;

const patchTextSchema = z.string().max(VAULT_LIMITS.maxPatchTextBytes).refine(
  (content) => new TextEncoder().encode(content).byteLength <= VAULT_LIMITS.maxPatchTextBytes,
  { message: `Patch text must not exceed ${VAULT_LIMITS.maxPatchTextBytes} UTF-8 bytes.` },
);

export const patchVaultFileRequestSchema = z.object({
  path: z.string().min(1).max(VAULT_LIMITS.maxPathLength),
  oldText: patchTextSchema.refine((text) => text.length > 0, { message: 'oldText must not be empty.' }),
  newText: patchTextSchema,
  replaceAll: z.boolean().optional(),
  expectedRevision: z.string().min(1).max(VAULT_LIMITS.maxRevisionLength),
}).strict();
export type PatchVaultFileRequest = z.infer<typeof patchVaultFileRequestSchema>;

export const patchVaultFileDataSchema = z.object({
  path: z.string(),
  revision: z.string(),
  replacements: z.number().int().positive(),
});
export type PatchVaultFileData = z.infer<typeof patchVaultFileDataSchema>;

export const readVaultFrontmatterRequestSchema = readVaultFileRequestSchema;
export type ReadVaultFrontmatterRequest = ReadVaultFileRequest;

export const jsonValueSchema: z.ZodType<unknown> = z.json().superRefine((value, context) => {
  const problem = boundedJsonProblem(value);
  if (problem) context.addIssue({ code: 'custom', message: problem });
});
export const frontmatterSchema: z.ZodType<Record<string, unknown>> = z.record(
  z.string().min(1).max(256),
  z.json(),
)
  .superRefine((value, context) => {
    const problem = boundedJsonProblem(value);
    if (problem) context.addIssue({ code: 'custom', message: problem });
  })
  .describe(
    `JSON-compatible mapping limited to ${VAULT_LIMITS.maxFrontmatterBytes} UTF-8 bytes, `
    + `${VAULT_LIMITS.maxFrontmatterDepth} levels, and ${VAULT_LIMITS.maxFrontmatterNodes} values.`,
  );

export const readVaultFrontmatterDataSchema = z.object({
  path: z.string(),
  revision: z.string(),
  frontmatter: frontmatterSchema,
});
export type ReadVaultFrontmatterData = z.infer<typeof readVaultFrontmatterDataSchema>;

export const patchVaultFrontmatterRequestSchema = z.object({
  path: z.string().min(1).max(VAULT_LIMITS.maxPathLength),
  updates: frontmatterSchema,
  remove: z.array(z.string().min(1).max(256)).max(VAULT_LIMITS.maxFrontmatterKeys).optional(),
  expectedRevision: z.string().min(1).max(VAULT_LIMITS.maxRevisionLength),
}).strict().refine(
  ({ updates, remove }) => Object.keys(updates).length > 0 || (remove?.length ?? 0) > 0,
  { message: 'At least one frontmatter update or removal is required.' },
).refine(
  ({ updates, remove }) => Object.keys(updates).length + new Set(remove ?? []).size <= VAULT_LIMITS.maxFrontmatterKeys,
  { message: `A frontmatter patch may affect at most ${VAULT_LIMITS.maxFrontmatterKeys} keys.` },
);
export type PatchVaultFrontmatterRequest = z.infer<typeof patchVaultFrontmatterRequestSchema>;

export const patchVaultFrontmatterDataSchema = z.object({
  path: z.string(),
  revision: z.string(),
  updated: z.array(z.string()),
  removed: z.array(z.string()),
});
export type PatchVaultFrontmatterData = z.infer<typeof patchVaultFrontmatterDataSchema>;

export const listVaultAttachmentsRequestSchema = listVaultFilesRequestSchema;
export type ListVaultAttachmentsRequest = ListVaultFilesRequest;

export const vaultAttachmentSchema = vaultFileSchema.extend({
  mimeType: z.string(),
});

export const listVaultAttachmentsDataSchema = z.object({
  attachments: z.array(vaultAttachmentSchema),
  cursor: z.string().optional(),
});
export type ListVaultAttachmentsData = z.infer<typeof listVaultAttachmentsDataSchema>;

export const readVaultAttachmentRequestSchema = z.object({
  path: z.string().min(1).max(VAULT_LIMITS.maxPathLength),
}).strict();
export type ReadVaultAttachmentRequest = z.infer<typeof readVaultAttachmentRequestSchema>;

export const readVaultAttachmentDataSchema = z.object({
  path: z.string(),
  revision: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  contentBase64: z.string(),
});
export type ReadVaultAttachmentData = z.infer<typeof readVaultAttachmentDataSchema>;

export const writeVaultFileDataSchema = z.object({
  path: z.string(),
  revision: z.string(),
});
export type WriteVaultFileData = z.infer<typeof writeVaultFileDataSchema>;

export const createVaultFileRequestSchema = z.object({
  path: z.string().min(1).max(VAULT_LIMITS.maxPathLength),
  content: vaultContentSchema,
}).strict();
export type CreateVaultFileRequest = z.infer<typeof createVaultFileRequestSchema>;

export const updateVaultFileRequestSchema = z.object({
  path: z.string().min(1).max(VAULT_LIMITS.maxPathLength),
  content: vaultContentSchema,
  expectedRevision: z.string().min(1).max(VAULT_LIMITS.maxRevisionLength),
}).strict();
export type UpdateVaultFileRequest = z.infer<typeof updateVaultFileRequestSchema>;

export const deleteVaultFileRequestSchema = z.object({
  path: z.string().min(1).max(VAULT_LIMITS.maxPathLength),
  expectedRevision: z.string().min(1).max(VAULT_LIMITS.maxRevisionLength),
}).strict();
export type DeleteVaultFileRequest = z.infer<typeof deleteVaultFileRequestSchema>;

function boundedJsonProblem(root: unknown): string | undefined {
  const encoder = new TextEncoder();
  const stack: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
  const seen = new WeakSet<object>();
  let nodes = 0;
  let bytes = 0;

  const addBytes = (count: number): string | undefined => {
    bytes += count;
    return bytes > VAULT_LIMITS.maxFrontmatterBytes
      ? `Frontmatter JSON must not exceed ${VAULT_LIMITS.maxFrontmatterBytes} UTF-8 bytes.`
      : undefined;
  };

  while (stack.length > 0) {
    const { value, depth } = stack.pop()!;
    nodes++;
    if (nodes > VAULT_LIMITS.maxFrontmatterNodes) {
      return `Frontmatter JSON must not exceed ${VAULT_LIMITS.maxFrontmatterNodes} values.`;
    }
    if (depth > VAULT_LIMITS.maxFrontmatterDepth) {
      return `Frontmatter JSON must not exceed ${VAULT_LIMITS.maxFrontmatterDepth} levels.`;
    }

    if (value === null) {
      const problem = addBytes(4);
      if (problem) return problem;
      continue;
    }
    if (typeof value === 'string') {
      if (encoder.encode(value).byteLength > VAULT_LIMITS.maxFrontmatterBytes) {
        return `Frontmatter JSON must not exceed ${VAULT_LIMITS.maxFrontmatterBytes} UTF-8 bytes.`;
      }
      const problem = addBytes(encoder.encode(JSON.stringify(value)).byteLength);
      if (problem) return problem;
      continue;
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return 'Frontmatter must contain JSON-compatible values.';
      const problem = addBytes(String(value).length);
      if (problem) return problem;
      continue;
    }
    if (typeof value === 'boolean') {
      const problem = addBytes(value ? 4 : 5);
      if (problem) return problem;
      continue;
    }
    if (!value || typeof value !== 'object') return 'Frontmatter must contain JSON-compatible values.';
    if (seen.has(value)) return 'Frontmatter must not contain circular or shared object references.';
    seen.add(value);

    if (Array.isArray(value)) {
      const problem = addBytes(2 + Math.max(0, value.length - 1));
      if (problem) return problem;
      for (const item of value) stack.push({ value: item, depth: depth + 1 });
      continue;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return 'Frontmatter must contain JSON-compatible values.';
    }
    const entries = Object.entries(value);
    let problem = addBytes(2 + Math.max(0, entries.length - 1));
    if (problem) return problem;
    for (const [key, item] of entries) {
      problem = addBytes(encoder.encode(JSON.stringify(key)).byteLength + 1);
      if (problem) return problem;
      stack.push({ value: item, depth: depth + 1 });
    }
  }
  return undefined;
}
