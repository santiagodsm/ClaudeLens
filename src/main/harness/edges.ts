// §3.10's edge-derivation table, transcribed as four functions.
//
// ⚠️ **"Edge derivation is exact and testable — no natural-language inference"** (§3.10). Nothing
// here reads meaning out of prose. `handoff` is a whole-token string match with a stated delimiter
// class and a stated case sensitivity; the other three are literal frontmatter entries and literal
// directory containment. An edge this module draws can be checked by hand against the file.
//
// | Edge kind      | Evidence      | Rule                                                        |
// |----------------|---------------|-------------------------------------------------------------|
// | `tool_grant`   | `frontmatter` | skill → tool node, one per entry of `allowed-tools`          |
// | `reads`/`writes` | `frontmatter` | skill → file node, one per entry of `metadata.reads`/`.writes` |
// | `handoff`      | `body_mention`| skill A → skill B iff B's `name` occurs in A's body as a whole token |
// | `contains`     | `directory`   | plugin → every skill/agent/command under its directory; marketplace → plugin |

/**
 * §3.10 `handoff` — the delimiter class, verbatim: "delimited by any character outside
 * `[A-Za-z0-9_-]`".
 *
 * ⚠️ `_` and `-` are INSIDE the token class, which is the whole point. `setup-project` must not
 * match inside `setup-project-v2`, and `stack-decide` must not match inside `stack-decided` —
 * otherwise a skill whose name is a prefix of another's collects edges it never declared.
 */
function isTokenChar(char: string | undefined): boolean {
  if (char === undefined) return false; // a string boundary is a delimiter
  return /[A-Za-z0-9_-]/.test(char);
}

/**
 * §3.10 `handoff` — "B's frontmatter `name` occurs in A's body as a whole token …,
 * **case-sensitive**".
 *
 * Written as a scan rather than a `RegExp` so that a name containing a regex metacharacter is
 * matched literally. Harness names come out of a user's configuration files; a name is data
 * (STACK ADR-017), and building a pattern out of one is how data becomes code.
 */
export function occursAsWholeToken(body: string, token: string): boolean {
  if (token === '') return false;
  let from = 0;
  for (;;) {
    const at = body.indexOf(token, from);
    if (at < 0) return false;
    const before = at === 0 ? undefined : body[at - 1];
    const after = body[at + token.length];
    if (!isTokenChar(before) && !isTokenChar(after)) return true;
    from = at + 1;
  }
}

/** The minimum a skill has to be for the `handoff` rule to see it. */
export interface HandoffCandidate {
  /** The node key of this skill (`harnessNodeKey`). */
  readonly key: string;
  /** Its frontmatter `name` — the token other skills' bodies are searched for. */
  readonly name: string;
  /** Its body: everything after the frontmatter block. */
  readonly body: string;
}

export interface DerivedHandoff {
  readonly fromKey: string;
  readonly toKey: string;
}

/**
 * Every `handoff` edge among a set of skills.
 *
 * ⚠️ **Self-excluded** (§3.10), and by node key rather than by name: two skills in different
 * plugins may legitimately share a `name`, and excluding by name would drop a real edge between
 * them. A skill mentioning its own name in its own body is the case the rule names.
 *
 * The verified case (§3.10, HANDOFF §4): `setup-project` yields **8** sibling edges.
 */
export function deriveHandoffEdges(skills: readonly HandoffCandidate[]): DerivedHandoff[] {
  const edges: DerivedHandoff[] = [];
  for (const from of skills) {
    for (const to of skills) {
      if (to.key === from.key) continue;
      if (occursAsWholeToken(from.body, to.name)) {
        edges.push({ fromKey: from.key, toKey: to.key });
      }
    }
  }
  return edges;
}
