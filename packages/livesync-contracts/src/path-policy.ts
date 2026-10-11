import { z } from 'zod';

export const PATH_POLICY_LIMITS = { maxRules: 64, maxPathLength: 1024, maxConfigBytes: 128 * 1024 } as const;

/** Comparison only: never use this key as a LiveSync path or document ID. */
export function policyPathKey(path: string): string | undefined {
  if (!path || path.startsWith('/') || /[\\\0:]/u.test(path)) return undefined;
  const segments = path.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..'
    || segment === '_local' || segment === '_design')) return undefined;
  const keys = segments.map((segment) => segment.normalize('NFC').toLowerCase().normalize('NFC').replace(/[ .]+$/u, ''));
  return keys.every((key) => key && key !== '_local' && key !== '_design') ? keys.join('/') : undefined;
}

function ruleKey(path: string): string | undefined {
  // Strip only leading decorations; never resolve traversal segments.
  const relative = path.replace(/^(?:\/|\.\/)+/u, '').replace(/\/$/u, '');
  const key = policyPathKey(relative);
  return key ? `${key}/` : undefined;
}

export const vaultPathRuleSchema = z.object({
  path: z.string().min(1).max(PATH_POLICY_LIMITS.maxPathLength)
    .transform((path, ctx) => {
      const key = ruleKey(path);
      if (!key || key.length > PATH_POLICY_LIMITS.maxPathLength) {
        ctx.addIssue({ code: 'custom', message: 'Invalid folder rule.' });
        return z.NEVER;
      }
      return key;
    }),
  access: z.enum(['none', 'read']),
}).strict();

export const vaultPathPolicySchema = z.object({
  rules: z.array(vaultPathRuleSchema).max(PATH_POLICY_LIMITS.maxRules),
  hideDotFolders: z.boolean(),
}).strict().transform((policy) => ({
  ...policy,
  rules: [...new Map(policy.rules.map((rule) => [`${rule.path}\0${rule.access}`, rule])).values()]
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : a.access < b.access ? -1 : a.access > b.access ? 1 : 0),
}));

export type VaultPathPolicy = z.output<typeof vaultPathPolicySchema>;
export type VaultRpcRequest<T> = { request: T; pathPolicy: VaultPathPolicy };

const envelopeSchema = z.object({ request: z.unknown(), pathPolicy: vaultPathPolicySchema }).strict();

/** The operation still validates its public request with its own strict schema. */
export function parseVaultRpcRequest<T>(value: VaultRpcRequest<T>) {
  const parsed = envelopeSchema.safeParse(value);
  if (!parsed.success) return {
    ok: false as const,
    error: { code: 'invalid_input' as const, message: 'Invalid vault RPC request or path policy.' },
  };
  return { ok: true as const, data: { request: value.request, pathPolicy: parsed.data.pathPolicy } };
}

export function pathAccess(policy: VaultPathPolicy, path: string): 'none' | 'read' | 'write' {
  const key = policyPathKey(path);
  if (!key) return 'none';
  if (policy.hideDotFolders && key.split('/').slice(0, -1).some((segment) => segment.startsWith('.'))) return 'none';
  let access: 'read' | 'write' = 'write';
  for (const rule of policy.rules) {
    if (!key.startsWith(rule.path)) continue;
    if (rule.access === 'none') return 'none';
    access = 'read';
  }
  return access;
}
