"use client";

const STORAGE_KEY = "ternary-theme";

export function ThemeToggle() {
  function toggle() {
    const root = document.documentElement;
    const next = root.getAttribute("data-theme") === "light" ? "dark" : "light";
    if (next === "light") root.setAttribute("data-theme", "light");
    else root.removeAttribute("data-theme");
    try { localStorage.setItem(STORAGE_KEY, next); } catch { /* private mode */ }
  }

  return (
    <button type="button" onClick={toggle} className="rounded-[10px] border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-xs font-semibold" aria-label="Toggle color theme">
      <span className="theme-dark-only">Light</span>
      <span className="theme-light-only">Dark</span>
    </button>
  );
}
