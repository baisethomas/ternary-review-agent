export type CommandPaletteItem = {
  id: string;
  label: string;
  group: string;
  keywords?: string;
  run: () => void;
};

export function filterCommandItems<T extends { label: string; group: string; keywords?: string }>(items: readonly T[], query: string) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [...items];
  return items.filter((item) => {
    const haystack = `${item.label} ${item.group} ${item.keywords ?? ""}`.toLowerCase();
    return haystack.includes(normalized);
  });
}

export function isCommandPaletteHotkey(event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey">) {
  return (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k";
}
