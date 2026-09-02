import { z } from 'zod';

/** Incremented whenever the semantic vault RPC wire contract changes. */
export const CONTRACT_VERSION = 1 as const;

export const VAULT_LIMITS = {
  maxListLimit: 100,
  defaultListLimit: 50,
  maxReadBytes: 512_000,
  maxWriteBytes: 512_000,
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

export const writeVaultFileDataSchema = z.object({
  path: z.string(),
  revision: z.string(),
});
export type WriteVaultFileData = z.infer<typeof writeVaultFileDataSchema>;

/** Markdown content bounded by its encoded wire/storage size, not UTF-16 code units. */
export const vaultContentSchema = z.string()
  .max(VAULT_LIMITS.maxWriteBytes)
  .refine(
    (content) => new TextEncoder().encode(content).byteLength <= VAULT_LIMITS.maxWriteBytes,
    { message: `Content must not exceed ${VAULT_LIMITS.maxWriteBytes} UTF-8 bytes.` },
  );

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
