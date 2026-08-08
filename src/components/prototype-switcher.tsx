"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect } from "react";

const variants = [
  { key: "A", label: "Review cockpit" },
  { key: "B", label: "Queue first" },
  { key: "C", label: "Terminal view" },
];

export function PrototypeSwitcher() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const current = searchParams.get("variant")?.toUpperCase() ?? "A";
  const index = Math.max(0, variants.findIndex((variant) => variant.key === current));

  function move(delta: number) {
    const next = variants[(index + delta + variants.length) % variants.length];
    router.replace(`/prototype/dashboard?variant=${next.key}`);
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement;
      if (["INPUT", "TEXTAREA"].includes(target.tagName) || target.isContentEditable) return;
      if (event.key === "ArrowLeft") move(-1);
      if (event.key === "ArrowRight") move(1);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  if (process.env.NODE_ENV === "production") return null;
  return <div className="fixed bottom-5 left-1/2 z-50 flex -translate-x-1/2 items-center gap-1 rounded-full bg-[#171a18] p-1.5 text-xs text-white shadow-2xl"><button onClick={() => move(-1)} className="grid size-8 place-items-center rounded-full hover:bg-white/10">←</button><span className="min-w-40 px-3 text-center font-semibold">{variants[index].key} — {variants[index].label}</span><button onClick={() => move(1)} className="grid size-8 place-items-center rounded-full hover:bg-white/10">→</button></div>;
}
