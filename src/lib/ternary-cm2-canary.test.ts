import { describe, it, expect } from "vitest";

describe("ternary CM2 canary", () => {
  it("deliberately fails to prove Ternary blocks a real JS test failure", () => {
    expect(1).toBe(2);
  });
});
