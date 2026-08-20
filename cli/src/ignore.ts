// Full `.gitignore` pattern semantics, applied to `.gitignore` (non-Git
// workspaces) and `.ternaryignore` (always) — Local Policy excludes, spec 4.2
// and 8.2's EffectiveLocalPolicy.
//
// In Git capture modes Git itself is the authority for `.gitignore`: capture
// asks it via `ls-files --exclude-standard` / `status --porcelain`, so ignored
// files never become candidates. This matcher is the authority for
// `.ternaryignore`, which Git knows nothing about, and the fallback for
// non-Git workspaces. ignore.test.ts pins it against `git check-ignore`
// itself on a shared pattern corpus, so "our subset" cannot drift silently.
//
// Implemented semantics (git-scm.com/docs/gitignore):
//   * blank lines and `#` comments; `\#` and `\!` escape the leading marker
//   * trailing spaces stripped unless escaped as `\ `
//   * `!` negation, last matching rule wins
//   * trailing `/` restricts a rule to directories
//   * a `/` anywhere but the end anchors the rule to its ignore file's
//     directory; otherwise the rule matches at any depth below it
//   * `*` and `?` never cross `/`; `[a-z]` / `[!a-z]` character classes
//   * `**/x` (any depth), `x/**` (everything inside), `a/**/b` (zero or more
//     directories); other runs of `*` behave as a single `*`
//   * nested ignore files: rules from a deeper directory win over shallower
//     ones, and once a directory is excluded nothing inside it can be
//     re-included by a later negation
//
// Pure module: no filesystem, no git, no network. Callers supply file text.

export interface IgnoreRule {
  /** The original line, for EffectiveLocalPolicy.exclude. */
  pattern: string;
  /** Directory the ignore file lives in, relative to the Workspace Root ("" = root). */
  base: string;
  negated: boolean;
  dirOnly: boolean;
  regex: RegExp;
}

/** The resolved Local Policy excludes for one capture. */
export interface LoadedPolicy {
  /** Rules in evaluation order (see {@link orderRules}). */
  excludeRules: IgnoreRule[];
  /** Patterns for EffectiveLocalPolicy.exclude, sorted; nested files are prefixed `<dir>/:`. */
  excludePatterns: string[];
}

export function parseIgnoreFile(content: string, base = ""): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const rawLine of content.split("\n")) {
    const line = stripTrailingSpaces(rawLine.replace(/\r$/, ""));
    if (line === "" || line.startsWith("#")) continue;
    let body = line;
    let negated = false;
    if (body.startsWith("!")) {
      negated = true;
      body = body.slice(1);
    } else if (body.startsWith("\\#") || body.startsWith("\\!")) {
      body = body.slice(1);
    }
    let dirOnly = false;
    if (body.endsWith("/") && !body.endsWith("\\/")) {
      dirOnly = true;
      body = body.slice(0, -1);
    }
    if (body === "") continue;
    const anchored = body.includes("/");
    if (body.startsWith("/")) body = body.slice(1);
    rules.push({
      pattern: line,
      base,
      negated,
      dirOnly,
      regex: globToRegex(body, anchored),
    });
  }
  return rules;
}

// Git strips trailing whitespace unless the last space is escaped.
function stripTrailingSpaces(line: string): string {
  let end = line.length;
  while (end > 0 && line[end - 1] === " ") {
    let backslashes = 0;
    let i = end - 2;
    while (i >= 0 && line[i] === "\\") {
      backslashes++;
      i--;
    }
    if (backslashes % 2 === 1) break; // escaped space: keep it
    end--;
  }
  return line.slice(0, end);
}

function escapeLiteral(ch: string): string {
  return /[.+^${}()|[\]\\*?]/.test(ch) ? `\\${ch}` : ch;
}

function globToRegex(glob: string, anchored: boolean): RegExp {
  let re = "";
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i] as string;
    if (ch === "\\") {
      const next = glob[i + 1];
      if (next !== undefined) {
        re += escapeLiteral(next);
        i += 2;
        continue;
      }
      re += "\\\\";
      i++;
      continue;
    }
    if (ch === "*") {
      let j = i;
      while (glob[j] === "*") j++;
      const doubled = j - i >= 2;
      const before = i === 0 ? undefined : glob[i - 1];
      const after = glob[j];
      if (doubled && after === "/" && (i === 0 || before === "/")) {
        re += "(?:[^/]+/)*"; // "**/" — zero or more directories
        i = j + 1;
        continue;
      }
      if (doubled && after === undefined && (i === 0 || before === "/")) {
        re += ".*"; // trailing "/**" — everything inside
        i = j;
        continue;
      }
      re += "[^/]*"; // a single `*`, or a run git treats as one
      i = j;
      continue;
    }
    if (ch === "?") {
      re += "[^/]";
      i++;
      continue;
    }
    if (ch === "[") {
      const parsed = parseCharClass(glob, i);
      if (parsed !== null) {
        re += parsed.source;
        i = parsed.next;
        continue;
      }
      re += "\\[";
      i++;
      continue;
    }
    re += escapeLiteral(ch);
    i++;
  }
  const prefix = anchored ? "^" : "^(?:.*/)?";
  return new RegExp(`${prefix}${re}$`);
}

function parseCharClass(glob: string, start: number): { source: string; next: number } | null {
  let j = start + 1;
  let source = "[";
  if (glob[j] === "!" || glob[j] === "^") {
    source += "^";
    j++;
  }
  if (glob[j] === "]") {
    source += "\\]";
    j++;
  }
  while (j < glob.length && glob[j] !== "]") {
    const ch = glob[j] as string;
    source += ch === "\\" ? "\\\\" : ch === "[" ? "\\[" : ch;
    j++;
  }
  if (j >= glob.length) return null; // unterminated: the '[' is literal
  return { source: `${source}]`, next: j + 1 };
}

// Rules are evaluated in this order: shallower ignore files first, so a
// deeper file's rules win; within one file, later lines win.
export function orderRules(rules: readonly IgnoreRule[]): IgnoreRule[] {
  return [...rules]
    .map((rule, index) => ({ rule, index }))
    .sort((a, b) => {
      const depth = depthOf(a.rule.base) - depthOf(b.rule.base);
      return depth !== 0 ? depth : a.index - b.index;
    })
    .map((entry) => entry.rule);
}

function depthOf(base: string): number {
  return base === "" ? 0 : base.split("/").length;
}

function appliesTo(rule: IgnoreRule, relPath: string): string | null {
  if (rule.base === "") return relPath;
  if (!relPath.startsWith(`${rule.base}/`)) return null;
  return relPath.slice(rule.base.length + 1);
}

// Match one path component-set against the rules (no ancestor logic).
function matchesDirectly(rules: readonly IgnoreRule[], relPath: string, isDir: boolean): boolean {
  let ignored = false;
  for (const rule of rules) {
    if (rule.dirOnly && !isDir) continue;
    const scoped = appliesTo(rule, relPath);
    if (scoped === null) continue;
    if (rule.regex.test(scoped)) ignored = !rule.negated;
  }
  return ignored;
}

/**
 * Whether a path is excluded by the rule set. Ancestor directories are
 * evaluated first: git cannot re-include a file whose parent directory is
 * excluded, so an excluded ancestor is final.
 *
 * `rules` must already be in evaluation order (see {@link orderRules}).
 */
export function isIgnored(rules: readonly IgnoreRule[], relPath: string, isDir = false): boolean {
  const segments = relPath.split("/");
  for (let i = 0; i < segments.length - 1; i++) {
    const ancestor = segments.slice(0, i + 1).join("/");
    if (matchesDirectly(rules, ancestor, true)) return true;
  }
  return matchesDirectly(rules, relPath, isDir);
}
