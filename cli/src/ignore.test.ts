import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { isIgnored, orderRules, parseIgnoreFile } from "./ignore.js";

function rules(...lines: string[]) {
  return orderRules(parseIgnoreFile(lines.join("\n")));
}

describe("gitignore pattern semantics", () => {
  it("skips blank lines and comments, and unescapes \\# / \\!", () => {
    const parsed = parseIgnoreFile(["", "   ", "# a comment", "\\#literal", "\\!bang"].join("\n"));
    expect(parsed.map((r) => r.pattern)).toEqual(["\\#literal", "\\!bang"]);
    expect(isIgnored(parsed, "#literal")).toBe(true);
    expect(isIgnored(parsed, "!bang")).toBe(true);
  });

  it("strips trailing spaces unless escaped", () => {
    expect(isIgnored(rules("notes.txt   "), "notes.txt")).toBe(true);
    expect(isIgnored(rules("trailing\\ "), "trailing ")).toBe(true);
    expect(isIgnored(rules("trailing\\ "), "trailing")).toBe(false);
  });

  it("matches unanchored patterns at any depth and anchored ones only at the base", () => {
    expect(isIgnored(rules("build"), "build")).toBe(true);
    expect(isIgnored(rules("build"), "a/b/build")).toBe(true);
    expect(isIgnored(rules("/build"), "build")).toBe(true);
    expect(isIgnored(rules("/build"), "a/build")).toBe(false);
    expect(isIgnored(rules("doc/frotz"), "doc/frotz")).toBe(true);
    expect(isIgnored(rules("doc/frotz"), "a/doc/frotz")).toBe(false);
  });

  it("honors directory-only patterns", () => {
    const r = rules("logs/");
    expect(isIgnored(r, "logs", true)).toBe(true);
    expect(isIgnored(r, "logs", false)).toBe(false);
    // A file inside an excluded directory is excluded via its ancestor.
    expect(isIgnored(r, "logs/today.txt")).toBe(true);
  });

  it("keeps * and ? inside one path segment", () => {
    expect(isIgnored(rules("*.log"), "deep/nested/a.log")).toBe(true);
    expect(isIgnored(rules("src/*.ts"), "src/a.ts")).toBe(true);
    expect(isIgnored(rules("src/*.ts"), "src/sub/a.ts")).toBe(false);
    expect(isIgnored(rules("a?c.txt"), "abc.txt")).toBe(true);
    expect(isIgnored(rules("a?c.txt"), "a/c.txt")).toBe(false);
  });

  it("supports character classes", () => {
    expect(isIgnored(rules("file[0-9].txt"), "file7.txt")).toBe(true);
    expect(isIgnored(rules("file[0-9].txt"), "filex.txt")).toBe(false);
    expect(isIgnored(rules("file[!0-9].txt"), "filex.txt")).toBe(true);
  });

  it("supports the three ** forms", () => {
    expect(isIgnored(rules("**/foo"), "foo")).toBe(true);
    expect(isIgnored(rules("**/foo"), "a/b/foo")).toBe(true);
    expect(isIgnored(rules("abc/**"), "abc/x/y.txt")).toBe(true);
    expect(isIgnored(rules("abc/**"), "abc", true)).toBe(false);
    expect(isIgnored(rules("a/**/b"), "a/b")).toBe(true);
    expect(isIgnored(rules("a/**/b"), "a/x/y/b")).toBe(true);
    expect(isIgnored(rules("a/**/b"), "x/a/b")).toBe(false);
  });

  it("applies negation with last-match-wins, but never re-includes inside an excluded directory", () => {
    expect(isIgnored(rules("*.log", "!keep.log"), "keep.log")).toBe(false);
    expect(isIgnored(rules("!keep.log", "*.log"), "keep.log")).toBe(true);
    const nested = rules("secrets/", "!secrets/README.md");
    expect(isIgnored(nested, "secrets/README.md")).toBe(true);
  });

  it("gives deeper ignore files precedence over shallower ones", () => {
    const shallow = parseIgnoreFile("*.log", "");
    const deep = parseIgnoreFile("!important.log", "pkg/app");
    const ordered = orderRules([...deep, ...shallow]); // order of collection must not matter
    expect(isIgnored(ordered, "pkg/app/important.log")).toBe(false);
    expect(isIgnored(ordered, "pkg/other.log")).toBe(true);
    // A nested rule never applies outside its own directory.
    expect(isIgnored(ordered, "important.log")).toBe(true);
  });
});

// --- Differential test: our matcher vs. Git itself ---
//
// Git is the specification for these patterns, so the matcher is pinned
// against `git check-ignore` (read-only) over a corpus of pattern/path pairs
// covering every implemented feature. A divergence fails here rather than
// silently changing what a payload contains.

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const GIT_ENV = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "Ternary Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
};

const ROOT_PATTERNS = [
  "# comment",
  "*.log",
  "!keep.log",
  "/rooted.txt",
  "build/",
  "doc/frotz",
  "**/anywhere.md",
  "abc/**",
  "a/**/b.txt",
  "file[0-9].txt",
  "file[!0-9].md",
  "src/*.ts",
  "space\\ name.txt",
  "\\#hash.txt",
  "tmp?.dat",
];

const NESTED_PATTERNS = ["!important.log", "local-only/", "*.tmp"];

const PATHS: Array<{ path: string; dir: boolean }> = [
  { path: "keep.log", dir: false },
  { path: "noise.log", dir: false },
  { path: "deep/nested/noise.log", dir: false },
  { path: "rooted.txt", dir: false },
  { path: "sub/rooted.txt", dir: false },
  { path: "build", dir: true },
  { path: "build/out.js", dir: false },
  { path: "src/build", dir: true },
  { path: "doc/frotz/x.txt", dir: false },
  { path: "sub/doc/frotz/x.txt", dir: false },
  { path: "anywhere.md", dir: false },
  { path: "x/y/anywhere.md", dir: false },
  { path: "abc/inner/file.txt", dir: false },
  { path: "a/b.txt", dir: false },
  { path: "a/x/y/b.txt", dir: false },
  { path: "file7.txt", dir: false },
  { path: "filex.txt", dir: false },
  { path: "filex.md", dir: false },
  { path: "file7.md", dir: false },
  { path: "src/main.ts", dir: false },
  { path: "src/sub/main.ts", dir: false },
  { path: "space name.txt", dir: false },
  { path: "#hash.txt", dir: false },
  { path: "tmp1.dat", dir: false },
  { path: "tmp12.dat", dir: false },
  { path: "pkg/app/important.log", dir: false },
  { path: "pkg/app/other.log", dir: false },
  { path: "pkg/app/local-only/x.txt", dir: false },
  { path: "pkg/app/scratch.tmp", dir: false },
  { path: "pkg/scratch.tmp", dir: false },
  { path: "src/index.ts.keep", dir: false },
];

function gitIgnoredSet(dir: string): Set<string> {
  const input = `${PATHS.map((p) => p.path).join("\0")}\0`;
  let out = "";
  try {
    out = execFileSync("git", ["check-ignore", "--stdin", "-z"], {
      cwd: dir,
      input,
      env: { ...process.env, ...GIT_ENV },
      encoding: "utf8",
    });
  } catch (error) {
    // check-ignore exits 1 when nothing matches; anything else is a real failure.
    const status = (error as { status?: number }).status;
    if (status !== 1) throw error;
    out = (error as { stdout?: string }).stdout ?? "";
  }
  return new Set(out.split("\0").filter((p) => p !== ""));
}

describe("differential: matcher vs git check-ignore", () => {
  it("agrees with Git on every pattern/path pair in the corpus", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "ternary-ignore-")));
    roots.push(dir);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir, env: { ...process.env, ...GIT_ENV } });
    writeFileSync(join(dir, ".gitignore"), `${ROOT_PATTERNS.join("\n")}\n`);
    mkdirSync(join(dir, "pkg", "app"), { recursive: true });
    writeFileSync(join(dir, "pkg", "app", ".gitignore"), `${NESTED_PATTERNS.join("\n")}\n`);
    for (const { path, dir: isDir } of PATHS) {
      const abs = join(dir, path);
      if (isDir) mkdirSync(abs, { recursive: true });
      else {
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, "x\n");
      }
    }

    const ours = orderRules([
      ...parseIgnoreFile(ROOT_PATTERNS.join("\n"), ""),
      ...parseIgnoreFile(NESTED_PATTERNS.join("\n"), "pkg/app"),
    ]);
    const gitSays = gitIgnoredSet(dir);
    const disagreements = PATHS.filter(
      ({ path, dir: isDir }) => isIgnored(ours, path, isDir) !== gitSays.has(path),
    ).map(({ path, dir: isDir }) => ({
      path,
      ours: isIgnored(ours, path, isDir),
      git: gitSays.has(path),
    }));
    expect(disagreements).toEqual([]);
    // Sanity: the corpus must actually exercise both outcomes.
    expect(gitSays.size).toBeGreaterThan(5);
    expect(gitSays.size).toBeLessThan(PATHS.length);
  });
});
