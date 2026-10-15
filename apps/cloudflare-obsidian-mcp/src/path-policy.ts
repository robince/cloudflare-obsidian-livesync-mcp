import { PATH_POLICY_LIMITS, vaultPathPolicySchema, type VaultPathPolicy } from '@cloudflare-obsidian-livesync/contracts';

type PolicyEnv = { MCP_PATH_RULES?: unknown; MCP_HIDE_DOT_FOLDERS?: unknown };

export class PathPolicyConfigurationError extends Error {
  constructor(readonly variable: 'MCP_PATH_RULES' | 'MCP_HIDE_DOT_FOLDERS') {
    super('MCP path policy configuration is invalid.');
  }
}

// Only fixed variable names, at most two entries per isolate; no policy or user data.
const reportedVariables = new Set<string>();

export function pathPolicyForEnv(env: PolicyEnv): VaultPathPolicy {
  try {
    const dotFolders = env.MCP_HIDE_DOT_FOLDERS;
    if (dotFolders !== undefined && dotFolders !== 'true' && dotFolders !== 'false') {
      throw new PathPolicyConfigurationError('MCP_HIDE_DOT_FOLDERS');
    }
    let rules: unknown = env.MCP_PATH_RULES;
    if (typeof rules === 'string') {
      if (new TextEncoder().encode(rules).byteLength > PATH_POLICY_LIMITS.maxConfigBytes) {
        throw new PathPolicyConfigurationError('MCP_PATH_RULES');
      }
      try { rules = JSON.parse(rules); } catch { throw new PathPolicyConfigurationError('MCP_PATH_RULES'); }
    }
    const parsed = vaultPathPolicySchema.safeParse({ rules, hideDotFolders: dotFolders === 'true' });
    if (!parsed.success) throw new PathPolicyConfigurationError('MCP_PATH_RULES');
    return parsed.data;
  } catch (error) {
    if (error instanceof PathPolicyConfigurationError && !reportedVariables.has(error.variable)) {
      reportedVariables.add(error.variable);
      console.error({ event: 'mcp_configuration_error', variable: error.variable });
    }
    throw error;
  }
}
