/**
 * English-only output check for Workspace Review text (TER-45 output contract).
 *
 * The prompt asks for English; this is the server-side check that the answer
 * obeyed it. Deliberately a heuristic over Unicode script blocks rather than a
 * language-detection dependency: the failure this guards against — a review
 * returned wholesale in Chinese, Russian, or Korean — is a script-level signal,
 * and a script test has no model, no data file, and no false-positive surface
 * on accented English ("café", "naïve") or on identifiers quoted from code.
 *
 * Code spans are stripped before the check because a review legitimately quotes
 * identifiers, literals and paths verbatim, and those may contain any script.
 */

/** A review string that is not written in English. Retryable — see `WorkspaceReviewLanguageError`. */
export class WorkspaceReviewNonEnglishError extends Error {
  constructor(path: string) {
    super(`${path} has non-English text`);
    this.name = "WorkspaceReviewNonEnglishError";
  }
}

/**
 * Scripts that are never incidental in English prose. A single character from
 * any of them fails the string outright — unlike the ratio rule below, there is
 * no "a few of these are fine" reading once code spans are removed.
 */
const BLOCKED_SCRIPTS =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Cyrillic}\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Thai}\p{Script=Devanagari}]/u;

/** Backtick code spans: `foo`, ``foo`bar``, and fenced blocks. Quoted code may be any script. */
const CODE_SPANS = /`{1,3}[\s\S]*?`{1,3}/g;

const LETTERS = /\p{L}/gu;
const ASCII_LETTER = /[A-Za-z]/;

/** Non-ASCII letters allowed as a share of all letters before the text reads as another language. */
const MAX_NON_ASCII_LETTER_RATIO = 0.2;

/**
 * Throw when `text` does not read as English. `path` names the offending field
 * (for example `review.findings[0].explanation`) so the error identifies the
 * field without echoing its content.
 */
export function assertEnglishReviewText(text: string, path: string): void {
  const prose = text.replace(CODE_SPANS, " ");
  if (BLOCKED_SCRIPTS.test(prose)) throw new WorkspaceReviewNonEnglishError(path);
  const letters = prose.match(LETTERS) ?? [];
  // No letters at all (empty, punctuation, digits, or nothing but code spans)
  // carries no language signal — there is nothing to judge.
  if (letters.length === 0) return;
  const nonAscii = letters.filter((letter) => !ASCII_LETTER.test(letter)).length;
  if (nonAscii / letters.length > MAX_NON_ASCII_LETTER_RATIO) throw new WorkspaceReviewNonEnglishError(path);
}
