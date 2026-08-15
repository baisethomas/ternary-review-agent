import { describe, expect, it } from "vitest";
import { filterCommandItems, groupCommandItems, isCommandPaletteHotkey } from "./command-palette";

describe("command palette helpers", () => {
  const items = [
    { id: "1", label: "Go to Analytics", group: "Navigate", keywords: "charts" },
    { id: "2", label: "Ternary/Agent #8 densify rows", group: "Pull requests", keywords: "pr review" },
    { id: "3", label: "Switch to Ternary/History", group: "Repositories" },
  ];

  it("filters by label, group, or keywords", () => {
    expect(filterCommandItems(items, "analytics").map((item) => item.id)).toEqual(["1"]);
    expect(filterCommandItems(items, "repositories").map((item) => item.id)).toEqual(["3"]);
    expect(filterCommandItems(items, "densify").map((item) => item.id)).toEqual(["2"]);
    expect(filterCommandItems(items, "  ").map((item) => item.id)).toEqual(["1", "2", "3"]);
  });

  it("merges noncontiguous groups while preserving item indices", () => {
    const mixed = [
      { id: "a", label: "Refresh", group: "Actions" },
      { id: "b", label: "PR", group: "Pull requests" },
      { id: "c", label: "Run review", group: "Actions" },
    ];
    expect(groupCommandItems(mixed)).toEqual([
      {
        group: "Actions",
        items: [
          { id: "a", label: "Refresh", group: "Actions", index: 0 },
          { id: "c", label: "Run review", group: "Actions", index: 2 },
        ],
      },
      {
        group: "Pull requests",
        items: [{ id: "b", label: "PR", group: "Pull requests", index: 1 }],
      },
    ]);
  });

  it("detects the command palette hotkey", () => {
    expect(isCommandPaletteHotkey({ key: "k", metaKey: true, ctrlKey: false })).toBe(true);
    expect(isCommandPaletteHotkey({ key: "K", metaKey: false, ctrlKey: true })).toBe(true);
    expect(isCommandPaletteHotkey({ key: "k", metaKey: false, ctrlKey: false })).toBe(false);
  });
});
