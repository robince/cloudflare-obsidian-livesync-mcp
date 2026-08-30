/** GitHub login names are case-insensitive for this allowlist. */
export function normalizeGithubLogin(login: string): string {
  return login.trim().toLowerCase();
}

/** An empty or omitted setting deliberately grants access to nobody. */
export function allowedGithubLogins(value: string | undefined): Set<string> {
  return new Set((value ?? '').split(/[\s,]+/).map(normalizeGithubLogin).filter(Boolean));
}
