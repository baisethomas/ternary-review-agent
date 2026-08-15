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

/** Merge items that share a group name so React keys stay unique. */
export function groupCommandItems<T extends { group: string }>(items: readonly T[]) {
  const order: string[] = [];
  const map = new Map<string, Array<T & { index: number }>>();
  for (const [index, item] of items.entries()) {
    let bucket = map.get(item.group);
    if (!bucket) {
      order.push(item.group);
      bucket = [];
      map.set(item.group, bucket);
    }
    bucket.push({ ...item, index });
  }
  return order.map((group) => ({ group, items: map.get(group) ?? [] }));
}

export function isCommandPaletteHotkey(event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey">) {
  return (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k";
}
