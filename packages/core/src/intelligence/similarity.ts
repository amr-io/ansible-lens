/**
 * Computes the Levenshtein edit distance between two strings using O(min(m, n)) space.
 */
export function levenshteinDistance(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  if (a.length === 0) {
    return b.length;
  }
  if (b.length === 0) {
    return a.length;
  }

  let s1 = a;
  let s2 = b;
  if (s1.length > s2.length) {
    s1 = b;
    s2 = a;
  }

  const len1 = s1.length;
  const len2 = s2.length;
  let prev = new Array<number>(len1 + 1);
  let curr = new Array<number>(len1 + 1);

  for (let i = 0; i <= len1; i++) {
    prev[i] = i;
  }

  for (let j = 1; j <= len2; j++) {
    curr[0] = j;
    const ch2 = s2.charCodeAt(j - 1);
    for (let i = 1; i <= len1; i++) {
      const cost = s1.charCodeAt(i - 1) === ch2 ? 0 : 1;
      const del = (prev[i] ?? 0) + 1;
      const ins = (curr[i - 1] ?? 0) + 1;
      const sub = (prev[i - 1] ?? 0) + cost;
      curr[i] = Math.min(del, ins, sub);
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }

  return prev[len1] ?? len2;
}

/**
 * Finds the closest string in `candidates` to `target` within `maxDistance`.
 * Ties are broken deterministically by length difference then lexicographic order.
 */
export function findClosestMatch(
  target: string,
  candidates: readonly string[],
  maxDistance?: number,
): string | undefined {
  if (candidates.length === 0) {
    return undefined;
  }

  const threshold = maxDistance ?? Math.max(2, Math.ceil(target.length * 0.5));
  const lowerTarget = target.toLowerCase();

  let bestCandidate: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const candidate of candidates) {
    if (candidate.length === 0) {
      continue;
    }
    if (Math.abs(candidate.length - target.length) > threshold) {
      continue;
    }

    const dist = levenshteinDistance(lowerTarget, candidate.toLowerCase());
    if (dist > threshold) {
      continue;
    }

    if (
      dist < bestDistance ||
      (dist === bestDistance &&
        bestCandidate !== undefined &&
        (Math.abs(candidate.length - target.length) <
          Math.abs(bestCandidate.length - target.length) ||
          (Math.abs(candidate.length - target.length) ===
            Math.abs(bestCandidate.length - target.length) &&
            candidate < bestCandidate)))
    ) {
      bestDistance = dist;
      bestCandidate = candidate;
    }
  }

  return bestCandidate;
}
