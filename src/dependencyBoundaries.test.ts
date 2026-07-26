import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sourceRoot = resolve(process.cwd(), "src");

// ---------------------------------------------------------------------------
// Phase 1 架构边界守卫（Task 7，扩展自 Phase 0 版本）。
// 只扫描生产源码：同目录 *.test.ts(x) / *.testutil.ts 允许导入内部 helper。
// 匹配统一针对引号内的 import/require 说明符，避免误伤普通注释文字。
// ---------------------------------------------------------------------------

type BoundaryPattern = { readonly label: string; readonly regex: RegExp };

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 禁止以某别名前缀开头的说明符（如 "@/game/gameplay/…"）。 */
function forbiddenSpecifierPrefix(prefix: string): BoundaryPattern {
  return { label: `import ${prefix}*`, regex: new RegExp(`["']${escapeRegExp(prefix)}`) };
}

/** domain 是纯类型/纯函数层：不得直接 import JSON（数据加载归 gameplay/application）。 */
const JSON_IMPORT: BoundaryPattern = {
  label: "json import",
  regex: /["'][^"']+\.json["']/
};

/** 纯逻辑层不得声明 server-only（那是 application/UI 边界的事）。 */
const SERVER_ONLY_IMPORT: BoundaryPattern = {
  label: "server-only import",
  regex: /["']server-only["']/
};

/** UI/API/store 只允许门面 "@/game/gameplay/rpg/scenario"，禁止 deep-import 内部文件。 */
const SCENARIO_DEEP_IMPORT: BoundaryPattern = {
  label: "scenario deep import (only the facade @/game/gameplay/rpg/scenario is allowed)",
  regex: /["']@\/game\/gameplay\/rpg\/scenario\/[^"']+["']/
};

/** Phase 1 约束：src/game/** 不引入任何 @ai-game/* 共享包（共享包仅限 UI 层）。 */
const AI_GAME_PACKAGE_IMPORT: BoundaryPattern = {
  label: "@ai-game/* package import",
  regex: /["']@ai-game\//
};

/** Phase 0 只用过 @ai-game/ui：不得新增其他 @ai-game/* 说明符。 */
const NEW_AI_GAME_PACKAGE_IMPORT: BoundaryPattern = {
  label: "new @ai-game/* package import (only @ai-game/ui was used in Phase 0)",
  regex: /["']@ai-game\/(?!ui["'])/
};

/** 禁止任何指向 SLG 项目的说明符（含相对路径 ../ai-slg-game）。 */
const SLG_IMPORT: BoundaryPattern = {
  label: "ai-slg-game import",
  regex: /["'][^"']*ai-slg-game/
};

/** 别名会被绕过时的兜底：domain 内相对路径逃逸到上层目录。 */
const RELATIVE_ESCAPE_FROM_DOMAIN: BoundaryPattern = {
  label: "relative import from domain into upper layer",
  regex: /["'](?:\.\.\/)+(?:gameplay|application|components|store|app|providers)\//
};

/** gameplay 内相对路径逃逸到上层目录（../../../../../data/** 的数据导入不受影响）。 */
const RELATIVE_ESCAPE_FROM_GAMEPLAY: BoundaryPattern = {
  label: "relative import from gameplay into upper layer",
  regex: /["'](?:\.\.\/)+(?:application|components|store|app|providers)\//
};

/** UI/API/store 用相对路径绕过别名规则时的兜底：../game/gameplay/** 一律禁止。 */
const RELATIVE_GAMEPLAY_IMPORT: BoundaryPattern = {
  label: "relative import into game/gameplay from ui/api/store layer",
  regex: /["'](?:\.\.\/)+game\/gameplay\//
};

type BoundaryRule = { readonly directory: string; readonly patterns: readonly BoundaryPattern[] };

const rules: readonly BoundaryRule[] = [
  {
    directory: "game/domain",
    patterns: [
      forbiddenSpecifierPrefix("@/game/gameplay/"),
      forbiddenSpecifierPrefix("@/game/application/"),
      forbiddenSpecifierPrefix("@/components/"),
      forbiddenSpecifierPrefix("@/store/"),
      forbiddenSpecifierPrefix("@/app/"),
      forbiddenSpecifierPrefix("@/providers/"),
      RELATIVE_ESCAPE_FROM_DOMAIN,
      JSON_IMPORT,
      SERVER_ONLY_IMPORT
    ]
  },
  {
    directory: "game/gameplay",
    patterns: [
      forbiddenSpecifierPrefix("@/game/application/"),
      forbiddenSpecifierPrefix("@/components/"),
      forbiddenSpecifierPrefix("@/store/"),
      forbiddenSpecifierPrefix("@/app/"),
      forbiddenSpecifierPrefix("@/providers/"),
      RELATIVE_ESCAPE_FROM_GAMEPLAY,
      SERVER_ONLY_IMPORT
    ]
  },
  // Phase 0 全量规则保留（当前 UI/API/store 不允许任何 gameplay 导入），
  // deep-import 规则单列：即便未来放开门面，内部文件依旧禁止。
  ...["app", "components", "store"].map((directory) => ({
    directory,
    patterns: [
      forbiddenSpecifierPrefix("@/game/gameplay/"),
      RELATIVE_GAMEPLAY_IMPORT,
      SCENARIO_DEEP_IMPORT
    ]
  })),
  { directory: "game", patterns: [AI_GAME_PACKAGE_IMPORT] },
  { directory: ".", patterns: [NEW_AI_GAME_PACKAGE_IMPORT, SLG_IMPORT] }
];

/** 纯匹配函数：单独测试其非空洞性（见下方 synthetic violations 用例）。 */
function findBoundaryViolations(
  source: string,
  patterns: readonly BoundaryPattern[]
): string[] {
  return patterns.filter((pattern) => pattern.regex.test(source)).map((pattern) => pattern.label);
}

describe("phase 1 architecture boundaries", () => {
  for (const rule of rules) {
    it(`${rule.directory === "." ? "src (all)" : rule.directory} does not import forbidden layers`, () => {
      const dir = resolve(sourceRoot, rule.directory);
      const violations = exists(dir).flatMap((file) => {
        const text = readFileSync(file, "utf8");
        return findBoundaryViolations(text, rule.patterns).map((label) => `${file}: ${label}`);
      });
      expect(violations).toEqual([]);
    });
  }
});

// ---------------------------------------------------------------------------
// 守卫非空洞性：每条规则的 regex 必须能命中一个合成违例片段。
// ---------------------------------------------------------------------------

describe("boundary patterns detect synthetic violations", () => {
  const cases: readonly { pattern: BoundaryPattern; snippet: string }[] = [
    {
      pattern: forbiddenSpecifierPrefix("@/game/gameplay/"),
      snippet: `import { x } from "@/game/gameplay/rpg/foo";`
    },
    {
      pattern: forbiddenSpecifierPrefix("@/game/application/"),
      snippet: `import { save } from "@/game/application/server/persist";`
    },
    { pattern: JSON_IMPORT, snippet: `import data from "../../data/base/gameTypeProfiles.json";` },
    { pattern: SERVER_ONLY_IMPORT, snippet: `import "server-only";` },
    {
      pattern: SCENARIO_DEEP_IMPORT,
      snippet: `import { hidden } from "@/game/gameplay/rpg/scenario/createFallbackBlueprint";`
    },
    { pattern: AI_GAME_PACKAGE_IMPORT, snippet: `import { Panel } from "@ai-game/ui";` },
    { pattern: NEW_AI_GAME_PACKAGE_IMPORT, snippet: `import { db } from "@ai-game/persistence";` },
    { pattern: SLG_IMPORT, snippet: `import { grid } from "../ai-slg-game/src/map";` },
    { pattern: SLG_IMPORT, snippet: `import { hex } from "@ai-slg-game/map";` },
    {
      pattern: RELATIVE_ESCAPE_FROM_DOMAIN,
      snippet: `import { load } from "../gameplay/rpg/scenario";`
    },
    {
      pattern: RELATIVE_ESCAPE_FROM_GAMEPLAY,
      snippet: `import { persist } from "../../application/server/persist";`
    },
    {
      pattern: RELATIVE_GAMEPLAY_IMPORT,
      snippet: `import { questGraph } from "../game/gameplay/rpg/scenario/questGraph";`
    }
  ];

  for (const { pattern, snippet } of cases) {
    it(`"${pattern.label}" catches: ${snippet}`, () => {
      expect(findBoundaryViolations(snippet, [pattern])).toEqual([pattern.label]);
    });
  }

  it("facade import does not trip the scenario deep-import rule", () => {
    const snippet = `import { createFallbackBlueprint } from "@/game/gameplay/rpg/scenario";`;
    expect(findBoundaryViolations(snippet, [SCENARIO_DEEP_IMPORT])).toEqual([]);
  });

  it("@ai-game/ui does not trip the new-package rule", () => {
    const snippet = `import { Panel } from "@ai-game/ui";`;
    expect(findBoundaryViolations(snippet, [NEW_AI_GAME_PACKAGE_IMPORT])).toEqual([]);
  });

  it("relative data import does not trip the gameplay escape rule", () => {
    const snippet = `import profiles from "../../../../../data/base/gameTypeProfiles.json";`;
    expect(findBoundaryViolations(snippet, [RELATIVE_ESCAPE_FROM_GAMEPLAY])).toEqual([]);
  });

  it("relative domain import does not trip the relative gameplay rule", () => {
    const snippet = `import { types } from "../game/domain/scenarioBlueprint";`;
    expect(findBoundaryViolations(snippet, [RELATIVE_GAMEPLAY_IMPORT])).toEqual([]);
  });
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
    if (!/\.(ts|tsx)$/.test(entry)) return [];
    // 测试与测试工具文件允许导入同目录内部 helper，不参与边界扫描。
    if (/\.test\.tsx?$/.test(entry) || entry.endsWith(".testutil.ts")) return [];
    return [full];
  });
}
