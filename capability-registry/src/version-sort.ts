import semver from "semver";

/** Pick latest version string among registered labels (semver-aware when coercible). */
export function pickLatestVersion(versions: Iterable<string>): string | undefined {
  const list = [...versions];
  if (list.length === 0) return undefined;
  return [...list].sort(compareVersionDesc)[0];
}

function compareVersionDesc(a: string, b: string): number {
  const av = semver.coerce(a);
  const bv = semver.coerce(b);
  if (av && bv) {
    return semver.rcompare(av, bv);
  }
  if (av && !bv) return -1;
  if (!av && bv) return 1;
  return b.localeCompare(a, undefined, { numeric: true, sensitivity: "base" });
}
