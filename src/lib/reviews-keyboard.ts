export type DetailTab = "findings" | "sandbox" | "history";

export const detailTabOrder: DetailTab[] = ["findings", "sandbox", "history"];

export function isEditableKeyboardTarget(target: EventTarget | null) {
  if (!target || typeof target !== "object") return false;
  const element = target as { tagName?: string; isContentEditable?: boolean };
  const tag = element.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return Boolean(element.isContentEditable);
}

/** Buttons/links/etc. that should keep native Enter/Space activation. */
export function isInteractiveKeyboardTarget(target: EventTarget | null) {
  if (!target || typeof target !== "object") return false;
  const element = target as {
    tagName?: string;
    closest?: (selectors: string) => unknown;
  };
  const tag = element.tagName;
  if (tag === "BUTTON" || tag === "A" || tag === "SUMMARY") return true;
  if (typeof element.closest !== "function") return false;
  return Boolean(element.closest('button, a, summary, [role="button"]'));
}

export function moveSelectionIndex(current: number, delta: number, length: number) {
  if (length <= 0) return -1;
  if (current < 0) return delta > 0 ? 0 : length - 1;
  return Math.max(0, Math.min(length - 1, current + delta));
}

export function detailTabFromDigit(key: string): DetailTab | null {
  if (key === "1") return "findings";
  if (key === "2") return "sandbox";
  if (key === "3") return "history";
  return null;
}
