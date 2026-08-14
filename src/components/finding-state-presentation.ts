import type { FindingState } from "@/lib/types";

export const findingStateOrder: FindingState[] = ["open", "fixed", "dismissed", "superseded", "stale"];

export const findingStatePresentation: Record<FindingState, { badgeClass: string; chartClass: string }> = {
  open: { badgeClass: "bg-[var(--fill-red)] text-[var(--red)]", chartClass: "bg-[var(--red)]" },
  fixed: { badgeClass: "bg-[var(--fill-green)] text-[var(--green)]", chartClass: "bg-[var(--green)]" },
  dismissed: { badgeClass: "bg-[var(--fill)] text-[var(--muted)]", chartClass: "bg-[var(--muted)]" },
  superseded: { badgeClass: "bg-[var(--fill-violet)] text-[var(--violet)]", chartClass: "bg-[var(--violet)]" },
  stale: { badgeClass: "bg-[var(--fill-amber)] text-[var(--amber)]", chartClass: "bg-[var(--amber)]" },
};
