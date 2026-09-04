import { z } from 'zod';

/** Incremented whenever the semantic vault RPC wire contract changes. */
export const CONTRACT_VERSION = 2 as const;

export const VAULT_LIMITS = {
  maxListLimit: 100,
  defaultListLimit: 50,
  maxReadBytes: 512_000,
  maxAttachmentReadBytes: 512_000,
  maxWriteBytes: 512_000,
  maxPatchTextBytes: 64_000,
  maxFrontmatterKeys: 100,
  maxPathLength: 1024,
  maxCursorLength: 2048,
  maxRevisionLength: 256,
} as const;

export const vaultErrorCodeSchema = z.enum([
  'invalid_input',
  'not_found',
  'unsupported',
  'too_large',
  'unavailable',
  'conflict',
  'internal',
]);

export const vaultErrorSchema = z.object({
  code: vaultErrorCodeSchema,
  message: z.string(),
});

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
  createdAt: z.number().int().nonnegative().optional(),
  modifiedAt: z.number().int().nonnegative().optional(),
});
export type VaultFile = z.infer<typeof vaultFileSchema>;

export const listVaultFilesDataSchema = z.object({
  files: z.array(vaultFileSchema),
  cursor: z.string().optional(),
});
export type ListVaultFilesData = z.infer<typeof listVaultFilesDataSchema>;

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

export const jsonValueSchema: z.ZodType<unknown> = z.json();
export const frontmatterSchema = z.record(z.string().min(1).max(256), jsonValueSchema);

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
