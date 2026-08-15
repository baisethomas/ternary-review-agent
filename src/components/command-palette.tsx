"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { filterCommandItems, isCommandPaletteHotkey, type CommandPaletteItem } from "@/lib/command-palette";
import { isEditableKeyboardTarget } from "@/lib/reviews-keyboard";

export function CommandPalette({
  open,
  onOpenChange,
  commands,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  commands: CommandPaletteItem[];
}) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const filtered = useMemo(() => filterCommandItems(commands, query), [commands, query]);
  const clampedIndex = filtered.length === 0 ? 0 : Math.min(activeIndex, filtered.length - 1);

  function close() {
    setQuery("");
    setActiveIndex(0);
    onOpenChange(false);
  }

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!isCommandPaletteHotkey(event)) return;
      if (isEditableKeyboardTarget(event.target) && !open) return;
      event.preventDefault();
      if (open) {
        setQuery("");
        setActiveIndex(0);
        onOpenChange(false);
      } else {
        setQuery("");
        setActiveIndex(0);
        onOpenChange(true);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onOpenChange]);

  if (!open || typeof document === "undefined") return null;

  function runActive() {
    const item = filtered[clampedIndex];
    if (!item) return;
    close();
    item.run();
  }

  const groups = filtered.reduce<Array<{ group: string; items: Array<CommandPaletteItem & { index: number }> }>>((acc, item, index) => {
    const last = acc[acc.length - 1];
    if (last && last.group === item.group) last.items.push({ ...item, index });
    else acc.push({ group: item.group, items: [{ ...item, index }] });
    return acc;
  }, []);

  return createPortal(
    <div className="fixed inset-0 z-[80] flex items-start justify-center bg-[rgb(0_0_0_/0.55)] px-4 pt-[12vh]" role="presentation" onMouseDown={close}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command menu"
        data-command-palette=""
        className="w-full max-w-xl overflow-hidden rounded-[10px] border border-[var(--line)] bg-[var(--panel)] shadow-[var(--shadow-lg)]"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            close();
            return;
          }
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setActiveIndex((index) => Math.min(filtered.length - 1, index + 1));
            return;
          }
          if (event.key === "ArrowUp") {
            event.preventDefault();
            setActiveIndex((index) => Math.max(0, index - 1));
            return;
          }
          if (event.key === "Enter") {
            event.preventDefault();
            runActive();
          }
        }}
      >
        <div className="border-b border-[var(--line)] px-3 py-2.5">
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
            }}
            placeholder="Jump to page, repository, or pull request…"
            aria-controls={listId}
            aria-autocomplete="list"
            className="w-full bg-transparent px-1 py-1.5 text-sm text-[var(--ink)] outline-none placeholder:text-[var(--faint)]"
          />
        </div>
        <div id={listId} role="listbox" className="max-h-[360px] overflow-auto p-2">
          {filtered.length === 0 ? (
            <p className="px-2 py-6 text-center text-xs text-[var(--muted)]">No matching commands</p>
          ) : (
            groups.map((group) => (
              <div key={group.group} className="mb-2 last:mb-0">
                <p className="px-2 py-1 text-[10px] font-semibold uppercase tracking-[.08em] text-[var(--faint)]">{group.group}</p>
                <ul className="space-y-0.5">
                  {group.items.map((item) => {
                    const active = item.index === clampedIndex;
                    return (
                      <li key={item.id}>
                        <button
                          type="button"
                          role="option"
                          aria-selected={active}
                          className={`flex w-full items-center rounded-[8px] px-2.5 py-2 text-left text-[13px] ${
                            active ? "bg-[var(--accent-bg)] text-[var(--ink)]" : "text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--ink)]"
                          }`}
                          onMouseEnter={() => setActiveIndex(item.index)}
                          onClick={() => {
                            close();
                            item.run();
                          }}
                        >
                          {item.label}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))
          )}
        </div>
        <div className="flex items-center justify-between border-t border-[var(--line)] px-3 py-2 text-[10px] text-[var(--faint)]">
          <span>↑↓ navigate · ↵ run · esc close</span>
          <span className="font-mono">⌘K</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
