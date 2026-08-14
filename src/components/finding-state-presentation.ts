import type { FindingState } from "@/lib/types";

export const findingStateOrder: FindingState[] = ["open", "fixed", "dismissed", "superseded", "stale"];

/** Outlined dot-badge classes: transparent fill, semantic border + text. */
export const findingStatePresentation: Record<FindingState, { badgeClass: string; chartClass: string }> = {
  open: { badgeClass: "border border-[var(--red)] bg-transparent text-[var(--red)]", chartClass: "bg-[var(--red)]" },
  fixed: { badgeClass: "border border-[var(--green)] bg-transparent text-[var(--green)]", chartClass: "bg-[var(--green)]" },
  dismissed: { badgeClass: "border border-[var(--muted)] bg-transparent text-[var(--muted)]", chartClass: "bg-[var(--muted)]" },
  superseded: { badgeClass: "border border-[var(--violet)] bg-transparent text-[var(--violet)]", chartClass: "bg-[var(--violet)]" },
  stale: { badgeClass: "border border-[var(--amber)] bg-transparent text-[var(--amber)]", chartClass: "bg-[var(--amber)]" },
};
