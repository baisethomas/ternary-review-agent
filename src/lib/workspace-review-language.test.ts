import { describe, expect, it } from "vitest";
import { assertEnglishReviewText, WorkspaceReviewNonEnglishError } from "./workspace-review-language";

describe("assertEnglishReviewText", () => {
  it("accepts ordinary English review prose", () => {
    expect(() => assertEnglishReviewText(
      "The authorization check is bypassed when the actor is impersonating.",
      "review.summary",
    )).not.toThrow();
  });

  it("rejects Chinese review text", () => {
    expect(() => assertEnglishReviewText("授权检查可以被绕过。", "review.summary"))
      .toThrow("review.summary has non-English text");
  });

  it("rejects Cyrillic review text", () => {
    expect(() => assertEnglishReviewText("Проверка авторизации может быть обойдена.", "review.findings[0].title"))
      .toThrow("review.findings[0].title has non-English text");
  });

  it("rejects a mostly-English string carrying a non-English clause", () => {
    expect(() => assertEnglishReviewText(
      "The authorization check is bypassed. 授权检查可以被绕过。",
      "review.findings[0].explanation",
    )).toThrow(WorkspaceReviewNonEnglishError);
  });

  it("rejects a non-Latin-script answer whose share of non-ASCII letters is over the threshold", () => {
    // Greek is not in the blocked-script list, so only the ratio rule can catch it.
    expect(() => assertEnglishReviewText("Ο έλεγχος εξουσιοδότησης παρακάμπτεται.", "review.summary"))
      .toThrow("review.summary has non-English text");
  });

  it("accepts accented English", () => {
    expect(() => assertEnglishReviewText(
      "The café order handler is naïve about a résumé upload.",
      "review.summary",
    )).not.toThrow();
  });

  it("accepts non-ASCII inside code spans, which quote identifiers verbatim", () => {
    expect(() => assertEnglishReviewText(
      "The constant `问题 = \"授权\"` is compared with the wrong operand.",
      "review.findings[0].explanation",
    )).not.toThrow();
    expect(() => assertEnglishReviewText("`授权检查`", "review.findings[0].title")).not.toThrow();
  });

  it("accepts text with no letters at all, including the empty string", () => {
    expect(() => assertEnglishReviewText("", "review.summary")).not.toThrow();
    expect(() => assertEnglishReviewText("  42 — 7 (100%)  ", "review.summary")).not.toThrow();
  });
});
