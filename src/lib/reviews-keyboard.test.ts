import { describe, expect, it } from "vitest";
import { detailTabFromDigit, isEditableKeyboardTarget, moveSelectionIndex } from "./reviews-keyboard";

describe("reviews keyboard helpers", () => {
  it("moves selection within bounds", () => {
    expect(moveSelectionIndex(0, 1, 3)).toBe(1);
    expect(moveSelectionIndex(2, 1, 3)).toBe(2);
    expect(moveSelectionIndex(0, -1, 3)).toBe(0);
    expect(moveSelectionIndex(-1, 1, 3)).toBe(0);
    expect(moveSelectionIndex(-1, -1, 3)).toBe(2);
    expect(moveSelectionIndex(0, 1, 0)).toBe(-1);
  });

  it("maps digit keys to detail tabs", () => {
    expect(detailTabFromDigit("1")).toBe("findings");
    expect(detailTabFromDigit("2")).toBe("sandbox");
    expect(detailTabFromDigit("3")).toBe("history");
    expect(detailTabFromDigit("4")).toBeNull();
  });

  it("detects editable keyboard targets", () => {
    expect(isEditableKeyboardTarget(null)).toBe(false);
    expect(isEditableKeyboardTarget({ tagName: "INPUT", isContentEditable: false } as EventTarget)).toBe(true);
    expect(isEditableKeyboardTarget({ tagName: "DIV", isContentEditable: false } as EventTarget)).toBe(false);
    expect(isEditableKeyboardTarget({ tagName: "DIV", isContentEditable: true } as EventTarget)).toBe(true);
  });
});
