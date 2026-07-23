// §6.7 / §1a — Harness Map label disambiguation.
//
// Node identity is `(kind, name, source, rel_path, project_id)` (§3.10 `uq_harness_nodes`,
// ADR-039), so two on-disk entities that legitimately share a `name:` are two DISTINCT nodes. The
// concrete case: a plugin cache holds two VERSIONS of one plugin side by side, each shipping a skill
// with the same frontmatter `name`. Both must survive — this is NOT a dedup, and dropping one would
// be wrong (two DIFFERENT plugins may also ship a same-named skill, and that must keep working).
//
// But the Harness Map (§4.5 `harnessGraph`) draws each node with `label = name`, so a shared name
// renders as two IDENTICAL labels the user cannot tell apart. This module qualifies ONLY the labels
// that actually collide, and does so with a PLAIN distinguisher: the natural one for a plugin's
// nodes is the plugin's own version — `setup-project (0.4.0)` vs `setup-project (0.5.0)`.
//
// ⚠️ CLAUDE.md §1a — no jargon reaches the screen. A qualifier is a plain version string, a plugin
// name, a project name, or plain words for where the node came from. It is NEVER an internal
// identifier, a raw `source` enum value, a `rel_path` or a database key. And a node whose label is
// unique in its scope keeps its BARE name: suffixing every node would trade ambiguity for clutter.

/** §3.10 `harness_nodes.source`, mapped to plain words — never the raw enum value (§1a). */
export function plainSourcePhrase(source: string): string {
  switch (source) {
    case 'user':
      return 'your configuration';
    case 'plugin':
      return 'from a plugin';
    case 'builtin':
      return 'built in';
    case 'transcript':
      return 'seen in your history';
    default:
      // Never expected — the CHECK constraint (§3.10) admits only the four above — but a plain
      // fallback is still honest rather than leaking an unknown token to the screen.
      return 'another source';
  }
}

/** One node reduced to the plain attributes a label may be qualified by. */
export interface LabelableNode {
  readonly id: number;
  readonly name: string;
  /** The plugin's own declared version, plain (e.g. `"0.5.0"`), or `null` when there is none. */
  readonly pluginVersion: string | null;
  /** The containing plugin's display name, or `null` for a node that is not inside a plugin. */
  readonly pluginName: string | null;
  /** §3.3 display name of the declaring project, or `null` for a Claude-data-directory node. */
  readonly projectName: string | null;
  /** Plain-words rendering of where the node came from (see `plainSourcePhrase`). */
  readonly sourcePhrase: string;
}

/**
 * The ordered, plain distinguishers for one node, most-natural first.
 *
 * Version leads because it is the always-available, jargon-free answer to "which of these two is
 * which" for a plugin's nodes. Plugin name follows (it distinguishes two DIFFERENT plugins that
 * ship a same-named skill), then the project, then a plain source phrase as a total last resort.
 * Nulls and empties are dropped; `sourcePhrase` is always present, so the chain is never empty.
 */
function distinguisherChain(node: LabelableNode): string[] {
  const parts: string[] = [];
  const add = (value: string | null): void => {
    if (value !== null && value !== '') parts.push(value);
  };
  add(node.pluginVersion);
  add(node.pluginName);
  add(node.projectName);
  parts.push(node.sourcePhrase);
  return parts;
}

/**
 * Builds the on-screen label for every node, keyed by id.
 *
 * A name unique across `nodes` keeps its bare form. For a colliding set, every member is qualified
 * with the SHORTEST prefix of its distinguisher chain that is unique within the set — so the common
 * case (two plugin versions) shows just `name (version)`, and more is added only when a version
 * alone does not separate them.
 *
 * ⚠️ A group whose members are identical on every plain attribute (same version, plugin, project
 * and source) cannot arise from DISTINCT nodes in practice — distinctness would require differing
 * `rel_path`s under the SAME plugin+version+project, i.e. one plugin shipping the same-named skill
 * twice — so no fake distinguisher (an index, a counter) is ever invented (CLAUDE.md §1a: never
 * invent a distinguisher). In that impossible-in-practice case the labels coincide; the nodes stay
 * separate vertices regardless, because their ids differ.
 */
export function disambiguatedLabels(nodes: readonly LabelableNode[]): Map<number, string> {
  const byName = new Map<string, LabelableNode[]>();
  for (const node of nodes) {
    const group = byName.get(node.name);
    if (group === undefined) byName.set(node.name, [node]);
    else group.push(node);
  }

  const labels = new Map<number, string>();
  for (const [name, group] of byName) {
    if (group.length === 1) {
      labels.set(group[0]!.id, name);
      continue;
    }

    const chains = new Map<number, string[]>(
      group.map((node) => [node.id, distinguisherChain(node)]),
    );
    const maxLen = Math.max(...[...chains.values()].map((chain) => chain.length));

    // Smallest prefix length at which every member's qualifier is unique. Falls through to the
    // full chain if nothing shorter separates them (the pathological case above).
    let qualifiers = new Map<number, string>();
    for (let k = 1; k <= maxLen; k += 1) {
      const candidate = new Map<number, string>();
      const counts = new Map<string, number>();
      for (const node of group) {
        const chain = chains.get(node.id)!;
        const qualifier = chain.slice(0, Math.min(k, chain.length)).join(', ');
        candidate.set(node.id, qualifier);
        counts.set(qualifier, (counts.get(qualifier) ?? 0) + 1);
      }
      qualifiers = candidate;
      if ([...counts.values()].every((count) => count === 1)) break;
    }

    for (const node of group) labels.set(node.id, `${name} (${qualifiers.get(node.id)!})`);
  }
  return labels;
}
