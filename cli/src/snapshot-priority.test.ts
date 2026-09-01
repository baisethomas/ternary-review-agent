import { describe, expect, it } from "vitest";
import { compareSnapshotPriority, snapshotPriorityTier } from "./snapshot-priority.js";

describe("snapshotPriorityTier (TER-43)", () => {
  it("puts application source in tier 0", () => {
    for (const p of [
      "App.swift", "Legacy.m", "Bridge.mm", "Main.kt", "build.kts", "Thing.java",
      "src/lib/review.ts", "app/page.tsx", "a.js", "a.jsx", "a.mjs", "a.cjs",
      "a.py", "a.rb", "a.go", "a.rs", "a.c", "a.h", "a.cc", "a.cpp", "a.hpp",
      "a.cs", "a.php", "a.sql", "a.sh", "a.bash", "a.zsh", "a.vue", "a.svelte",
      "a.scala", "a.dart", "a.ex", "a.exs", "a.lua", "a.pl", "a.r", "a.ps1",
    ]) {
      expect(snapshotPriorityTier(p), p).toBe(0);
    }
  });

  it("puts config and manifests in tier 1", () => {
    for (const p of [
      "tsconfig.json", "config.yaml", "config.yml", "Cargo.toml", "pom.xml",
      "app/build.gradle", "Info.plist", "setup.ini", "setup.cfg",
      "Dockerfile", "Makefile", "docker/dockerfile", "MAKEFILE",
    ]) {
      expect(snapshotPriorityTier(p), p).toBe(1);
    }
  });

  it("puts docs in tier 2", () => {
    for (const p of ["README.md", "notes.txt", "guide.rst", "book.adoc"]) {
      expect(snapshotPriorityTier(p), p).toBe(2);
    }
  });

  it("demotes lockfiles to tier 3 even when their extension is config-shaped", () => {
    for (const p of [
      "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "Podfile.lock",
      "Cargo.lock", "Gemfile.lock", "bun.lockb", "apps/web/package-lock.json",
    ]) {
      expect(snapshotPriorityTier(p), p).toBe(3);
    }
  });

  it("puts dotfiles, extensionless files, and unknown extensions in tier 3", () => {
    for (const p of [".gitignore", ".gitattributes", "LICENSE", "Procfile", "logo.svg", "data.csv"]) {
      expect(snapshotPriorityTier(p), p).toBe(3);
    }
  });

  it("classifies by extension case-insensitively", () => {
    expect(snapshotPriorityTier("App.SWIFT")).toBe(0);
    expect(snapshotPriorityTier("Config.JSON")).toBe(1);
    expect(snapshotPriorityTier("README.MD")).toBe(2);
    expect(snapshotPriorityTier("PACKAGE-LOCK.JSON")).toBe(3);
  });
});

describe("compareSnapshotPriority", () => {
  it("orders by tier before path", () => {
    const paths = ["README.md", "zzz.swift", "package-lock.json", "aaa.json"];
    expect([...paths].sort(compareSnapshotPriority)).toEqual([
      "zzz.swift", "aaa.json", "README.md", "package-lock.json",
    ]);
  });

  it("falls back to bytewise order inside a tier", () => {
    expect([...["b.ts", "a.ts", "C.ts"]].sort(compareSnapshotPriority)).toEqual([
      "C.ts", "a.ts", "b.ts",
    ]);
    expect(compareSnapshotPriority("a.ts", "a.ts")).toBe(0);
  });
});
