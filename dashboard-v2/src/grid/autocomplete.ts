// Shared ranking used by both the AG Grid autocomplete filter and the MoM
// filter value input, so suggestions behave the same everywhere.
export function matchSuggestions(query: string, pool: string[], limit = 8): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const starts: string[] = [];
  const includes: string[] = [];
  for (const v of pool) {
    const lower = v.toLowerCase();
    if (lower === q) continue;
    if (lower.startsWith(q)) starts.push(v);
    else if (lower.includes(q)) includes.push(v);
  }
  return [...starts, ...includes].slice(0, limit);
}
