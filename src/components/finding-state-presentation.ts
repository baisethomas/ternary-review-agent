import type { FindingState } from "@/lib/types";

export const findingStateOrder: FindingState[] = ["open", "fixed", "dismissed", "superseded", "stale"];

export const findingStatePresentation: Record<FindingState, { badgeClass: string; chartClass: string }> = {
  open: { badgeClass: "bg-[#fff0ed] text-[#b64a42]", chartClass: "bg-[#b64a42]" },
  fixed: { badgeClass: "bg-[#edf8e9] text-[#477641]", chartClass: "bg-[#477641]" },
  dismissed: { badgeClass: "bg-[#f0f1ed] text-[#666c67]", chartClass: "bg-[#666c67]" },
  superseded: { badgeClass: "bg-[#f1edff] text-[#6651a8]", chartClass: "bg-[#6651a8]" },
  stale: { badgeClass: "bg-[#fff7df] text-[#8a6a1f]", chartClass: "bg-[#8a6a1f]" },
};
