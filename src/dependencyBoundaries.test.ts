import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sourceRoot = resolve(process.cwd(), "src");

const rules = [
  {
    directory: "game/domain",
    forbidden: ["@/game/gameplay/", "@/game/application/", "@/components/", "@/store/", "@/app/"]
  },
  {
    directory: "game/gameplay",
    forbidden: ["@/game/application/", "@/components/", "@/store/", "@/app/"]
  },
  {
    directory: "components",
    forbidden: ["@/game/gameplay/"]
  },
  {
    directory: "store",
    forbidden: ["@/game/gameplay/"]
  },
  {
    directory: "app",
    forbidden: ["@/game/gameplay/"]
  }
];

describe("initial architecture boundaries", () => {
  for (const rule of rules) {
    it(`${rule.directory} does not import forbidden layers`, () => {
      const dir = resolve(sourceRoot, rule.directory);
      const violations = exists(dir)
        .flatMap((file) => {
          const text = readFileSync(file, "utf8");
          return rule.forbidden.filter((alias) => text.includes(alias)).map((alias) => `${file}: ${alias}`);
        });
      expect(violations).toEqual([]);
    });
  }
});

function exists(dir: string): string[] {
  try {
    return walk(dir);
  } catch {
    return [];
  }
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = resolve(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.(ts|tsx)$/.test(entry) && !entry.endsWith(".test.ts") && !entry.endsWith(".test.tsx") ? [full] : [];
  });
}
