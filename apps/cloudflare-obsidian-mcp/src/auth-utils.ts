/** Normalize display labels only; authorization uses immutable IDs. */
export function normalizeGithubLogin(login: string): string {
  return login.trim().toLowerCase();
}

/** Invalid configuration fails closed as a whole, rather than partially authorizing. */
export function allowedGithubUserIds(value: string | undefined): Set<string> {
  const ids = (value ?? '').trim().split(/[\s,]+/).filter(Boolean);
  if (ids.some((id) => !/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id)))) return new Set();
  return new Set(ids);
}
