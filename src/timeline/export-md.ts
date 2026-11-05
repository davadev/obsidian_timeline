import YAML from "yaml";
import { DEFAULT_MIRROR_NAMES, type MirrorPropertyNames } from "./model";

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/**
 * A copy of a note that stops being a timeline event. An exported copy of an
 * event note carries the same `timeline:` block and `timeline_*` mirror
 * properties; saved next to the original it would be a second event with the
 * same id: regenerate refuses on the duplicate, and the id index may resolve
 * clicks to the copy. Everything else in the frontmatter is kept.
 */
export function withoutTimelineFrontmatter(
  raw: string,
  mirrors: MirrorPropertyNames = DEFAULT_MIRROR_NAMES
): string {
  const m = FRONTMATTER_RE.exec(raw);
  if (!m) return raw;
  let front: unknown;
  try {
    front = YAML.parse(m[1]);
  } catch {
    return raw; // not ours to repair
  }
  if (!front || typeof front !== "object" || Array.isArray(front)) return raw;
  const map = { ...(front as Record<string, unknown>) };
  let changed = false;
  const keys: string[] = ["timeline", ...(Object.values(mirrors) as string[]), "timeline_hash", "timeline_src"];
  for (const key of keys) {
    if (key in map) {
      delete map[key];
      changed = true;
    }
  }
  if (!changed) return raw;
  const rest = raw.slice(m[0].length);
  if (!Object.keys(map).length) return rest.replace(/^\r?\n/, "");
  return `---\n${YAML.stringify(map, { lineWidth: 0 })}---\n${rest.startsWith("\n") ? "" : "\n"}${rest}`;
}
