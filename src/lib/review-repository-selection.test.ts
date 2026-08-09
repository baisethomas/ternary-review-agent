import { describe, expect, it } from "vitest";
import { selectReviewRepositories } from "./review-repository-selection";

const watched = { fullName: "ternary/watched", watched: true };
const anotherWatched = { fullName: "ternary/another", watched: true };
const paused = { fullName: "ternary/paused", watched: false };

describe("review repository selection", () => {
  it("keeps watched repositories and honors a watched selection", () => {
    expect(selectReviewRepositories([watched, paused, anotherWatched], anotherWatched.fullName)).toEqual({
      repositories: [watched, anotherWatched],
      selectedRepository: anotherWatched,
    });
  });

  it("does not select a requested paused repository", () => {
    expect(selectReviewRepositories([paused, watched], paused.fullName)).toEqual({
      repositories: [watched],
      selectedRepository: watched,
    });
  });

  it("returns an empty review catalog when every repository is paused", () => {
    expect(selectReviewRepositories([paused], paused.fullName)).toEqual({ repositories: [], selectedRepository: null });
  });

  it("returns an empty review catalog when no repositories are installed", () => {
    expect(selectReviewRepositories([])).toEqual({ repositories: [], selectedRepository: null });
  });
});
