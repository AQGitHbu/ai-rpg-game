import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sourceRoot = resolve(process.cwd(), "src");

// ---------------------------------------------------------------------------
// 架构边界守卫（Phase 1 Task 7 建立，Phase 2 Task 5 扩展持久化方向）。
// 默认只扫描生产源码：同目录 *.test.ts(x) / *.testutil.ts 允许导入内部 helper；
// 个别规则（app/api）显式连测试一起扫，见 BoundaryRule.includeTestFiles。
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

// ---------------------------------------------------------------------------
// Phase 2（Task 5）新增：application/server 持久化层的许可与禁止方向。
// ---------------------------------------------------------------------------

/** UI（components/store/app 页面）禁止进入 server-only 层（API route 仅许组合根，见下）。 */
const APPLICATION_SERVER_IMPORT = forbiddenSpecifierPrefix("@/game/application/server");

/** API route 层对 application/server 只许组合根，persistence 等 deep-import 一律禁止。 */
const APPLICATION_SERVER_DEEP_IMPORT: BoundaryPattern = {
  label: "application/server deep import (api routes may only use the composition root)",
  regex: /["']@\/game\/application\/server\/(?!compositionRoot["'])/
};

/** UI/API/store 禁止直连 domain：运行时与类型一律经 "@/game/application" 门面中转。 */
const DOMAIN_IMPORT = forbiddenSpecifierPrefix("@/game/domain");

/** 别名被绕过时的兜底：UI/API/store 相对路径进入 game/domain 一律禁止。 */
const RELATIVE_DOMAIN_IMPORT: BoundaryPattern = {
  label: "relative import into game/domain from ui/api/store layer",
  regex: /["'](?:\.\.\/)+game\/domain\//
};

/** server-only 持久化目录的相对路径逃逸兜底：../…/game/application/server/** 一律禁止。 */
const RELATIVE_APPLICATION_SERVER_IMPORT: BoundaryPattern = {
  label: "relative import into game/application/server from ui/api/store layer",
  regex: /["'](?:\.\.\/)+game\/application\/server\//
};

/** 全库只有 sqliteClient.ts 允许 @libsql/client（该文件本身由下方静态守卫单独盯防）。 */
const LIBSQL_IMPORT: BoundaryPattern = {
  label: "@libsql/client import (only sqliteClient.ts may import it)",
  regex: /["']@libsql\//
};

/** SQLite 适配器模块名兜底：无论别名还是相对路径都不得指向 sqliteClient/sqliteGameRepository。 */
const SQLITE_MODULE_IMPORT: BoundaryPattern = {
  label: "sqlite persistence module import",
  regex: /["'][^"']*sqlite(?:Client|GameRepository)["']/
};

/** application 内相对路径逃逸到 UI 层目录的兜底（../createGame 等层内导入不受影响）。 */
const RELATIVE_ESCAPE_FROM_APPLICATION: BoundaryPattern = {
  label: "relative import from application into ui layer",
  regex: /["'](?:\.\.\/)+(?:components|store|app|providers)\//
};

type BoundaryRule = {
  readonly directory: string;
  readonly patterns: readonly BoundaryPattern[];
  /** 命中该正则的文件路径不参与本条规则（如 app 页面规则排除 api 子目录）。 */
  readonly excludePath?: RegExp;
  /** true 时连 *.test.ts(x) / *.testutil.ts 一起扫（默认沿用 Phase 1 约定跳过）。 */
  readonly includeTestFiles?: boolean;
};

// UI 层（components/store/app 页面）统一禁令：Phase 0/1 的 gameplay 禁令保留，
// Phase 2 起 domain 与 server-only 持久化也只能经 "@/game/application" 门面间接使用。
const UI_LAYER_PATTERNS: readonly BoundaryPattern[] = [
  forbiddenSpecifierPrefix("@/game/gameplay/"),
  RELATIVE_GAMEPLAY_IMPORT,
  SCENARIO_DEEP_IMPORT,
  APPLICATION_SERVER_IMPORT,
  RELATIVE_APPLICATION_SERVER_IMPORT,
  DOMAIN_IMPORT,
  RELATIVE_DOMAIN_IMPORT,
  LIBSQL_IMPORT,
  SQLITE_MODULE_IMPORT
];

const rules: readonly BoundaryRule[] = [
  {
    directory: "game/domain",
    patterns: [
      forbiddenSpecifierPrefix("@/game/gameplay/"),
      // Phase 2 收紧：连 "@/game/application" 门面本身也禁止（原规则只拦 deep-import）。
      forbiddenSpecifierPrefix("@/game/application"),
      forbiddenSpecifierPrefix("@/components/"),
      forbiddenSpecifierPrefix("@/store/"),
      forbiddenSpecifierPrefix("@/app/"),
      forbiddenSpecifierPrefix("@/providers/"),
      RELATIVE_ESCAPE_FROM_DOMAIN,
      JSON_IMPORT,
      SERVER_ONLY_IMPORT,
      LIBSQL_IMPORT
    ]
  },
  {
    directory: "game/gameplay",
    patterns: [
      forbiddenSpecifierPrefix("@/game/application"),
      forbiddenSpecifierPrefix("@/components/"),
      forbiddenSpecifierPrefix("@/store/"),
      forbiddenSpecifierPrefix("@/app/"),
      forbiddenSpecifierPrefix("@/providers/"),
      RELATIVE_ESCAPE_FROM_GAMEPLAY,
      SERVER_ONLY_IMPORT,
      LIBSQL_IMPORT
    ]
  },
  // application 本体（server 子目录除外）：允许 domain / scenario 门面，禁止 UI、
  // libsql 与 sqlite adapter——对 server 目录唯一合法入口是纯端口 gameRepository
  //（精确许可清单见下方 server-only 静态守卫）。
  {
    directory: "game/application",
    excludePath: /[\\/]server[\\/]/,
    patterns: [
      forbiddenSpecifierPrefix("@/components/"),
      forbiddenSpecifierPrefix("@/store/"),
      forbiddenSpecifierPrefix("@/app/"),
      forbiddenSpecifierPrefix("@/providers/"),
      SCENARIO_DEEP_IMPORT,
      RELATIVE_ESCAPE_FROM_APPLICATION,
      SERVER_ONLY_IMPORT,
      LIBSQL_IMPORT,
      SQLITE_MODULE_IMPORT
    ]
  },
  // server-only 装配层：可向下触达 persistence 与 application 本体，但不得反向进入 UI。
  {
    directory: "game/application/server",
    patterns: [
      forbiddenSpecifierPrefix("@/components/"),
      forbiddenSpecifierPrefix("@/store/"),
      forbiddenSpecifierPrefix("@/app/"),
      forbiddenSpecifierPrefix("@/providers/"),
      SCENARIO_DEEP_IMPORT,
      RELATIVE_ESCAPE_FROM_APPLICATION
    ]
  },
  // deep-import 规则单列：即便未来放开门面，内部文件依旧禁止。
  ...["components", "store"].map((directory) => ({ directory, patterns: UI_LAYER_PATTERNS })),
  // app 页面（api 除外）与 components/store 同级：属于可能进入 client bundle 的 UI。
  { directory: "app", excludePath: /[\\/]api[\\/]/, patterns: UI_LAYER_PATTERNS },
  // API route 层跑在 server：允许且仅允许 composition root 一个 server 入口；
  // 连测试文件也必须经 "@/game/application" 门面取类型，避免固化 domain 直连。
  {
    directory: "app/api",
    includeTestFiles: true,
    patterns: [
      forbiddenSpecifierPrefix("@/game/gameplay/"),
      RELATIVE_GAMEPLAY_IMPORT,
      SCENARIO_DEEP_IMPORT,
      APPLICATION_SERVER_DEEP_IMPORT,
      RELATIVE_APPLICATION_SERVER_IMPORT,
      DOMAIN_IMPORT,
      RELATIVE_DOMAIN_IMPORT,
      LIBSQL_IMPORT,
      SQLITE_MODULE_IMPORT
    ]
  },
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

describe("architecture boundaries (phase 1 + phase 2 persistence)", () => {
  for (const rule of rules) {
    it(`${rule.directory === "." ? "src (all)" : rule.directory} does not import forbidden layers`, () => {
      const dir = resolve(sourceRoot, rule.directory);
      const files = exists(dir, rule.includeTestFiles === true).filter(
        (file) => !(rule.excludePath?.test(file) ?? false)
      );
      const violations = files.flatMap((file) => {
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
      pattern: forbiddenSpecifierPrefix("@/game/application"),
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
    },
    {
      pattern: APPLICATION_SERVER_IMPORT,
      snippet: `import { getServerGameEntryPoints } from "@/game/application/server/compositionRoot";`
    },
    {
      pattern: APPLICATION_SERVER_DEEP_IMPORT,
      snippet: `import { adapter } from "@/game/application/server/persistence/sqliteGameRepository";`
    },
    {
      pattern: DOMAIN_IMPORT,
      snippet: `import { validateNewGameInput } from "@/game/domain";`
    },
    {
      pattern: RELATIVE_DOMAIN_IMPORT,
      snippet: `import { rules } from "../game/domain/newGame";`
    },
    {
      pattern: RELATIVE_APPLICATION_SERVER_IMPORT,
      snippet: `import { save } from "../../game/application/server/persistence/sqliteClient";`
    },
    { pattern: LIBSQL_IMPORT, snippet: `import { createClient } from "@libsql/client";` },
    {
      pattern: SQLITE_MODULE_IMPORT,
      snippet: `import { open } from "./server/persistence/sqliteClient";`
    },
    {
      pattern: RELATIVE_ESCAPE_FROM_APPLICATION,
      snippet: `import { Screen } from "../../components/CurrentGameScreen";`
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

  it("composition root import does not trip the application/server deep-import rule", () => {
    const snippet = `import { getServerGameEntryPoints } from "@/game/application/server/compositionRoot";`;
    expect(findBoundaryViolations(snippet, [APPLICATION_SERVER_DEEP_IMPORT])).toEqual([]);
  });

  it("application facade import does not trip domain/server/sqlite rules", () => {
    const snippet = `import { validateNewGameInput, type NewGameInput } from "@/game/application";`;
    expect(
      findBoundaryViolations(snippet, [
        DOMAIN_IMPORT,
        APPLICATION_SERVER_IMPORT,
        SQLITE_MODULE_IMPORT,
        LIBSQL_IMPORT
      ])
    ).toEqual([]);
  });

  it("pure gameRepository port import does not trip the sqlite module rule", () => {
    const snippet = `import { asGameId } from "./server/persistence/gameRepository";`;
    expect(findBoundaryViolations(snippet, [SQLITE_MODULE_IMPORT, LIBSQL_IMPORT])).toEqual([]);
  });
});

function exists(dir: string, includeTestFiles: boolean): string[] {
  try {
    return walk(dir, includeTestFiles);
  } catch {
    return [];
  }
}

function walk(dir: string, includeTestFiles: boolean): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = resolve(dir, entry);
    if (statSync(full).isDirectory()) return walk(full, includeTestFiles);
    if (!/\.(ts|tsx)$/.test(entry)) return [];
    // 测试与测试工具文件默认允许导入同目录内部 helper，不参与边界扫描；
    // app/api 规则与下方 server-only 静态守卫显式要求连测试一起扫。
    if (!includeTestFiles && (/\.test\.tsx?$/.test(entry) || entry.endsWith(".testutil.ts"))) {
      return [];
    }
    return [full];
  });
}

// ---------------------------------------------------------------------------
// server-only 静态守卫（Task 5）：防止 client import 持久化层。
// 别名规则之外的精确许可清单：application/server/** 只能被
//   1) 它自己（含测试）；
//   2) application 本体对纯端口 gameRepository 的导入（无 libsql/env/路径感知）；
//   3) app/api/** 对 compositionRoot 的导入
// 触达；@libsql/client 与 process.env 永不离开 server 层。
// ---------------------------------------------------------------------------

const SERVER_DIR = "game/application/server/";
/** 纯端口文件：只有类型与 asGameId，application 本体唯一合法的 server 入口。 */
const PURE_PORT_SPECIFIER = "./server/persistence/gameRepository";
/** API route 层唯一许可的 server 入口。 */
const COMPOSITION_ROOT_SPECIFIER = "@/game/application/server/compositionRoot";

/** src 相对路径（POSIX 分隔符），便于断言与报告。 */
function toPosixRelative(file: string): string {
  return file.slice(sourceRoot.length + 1).replaceAll("\\", "/");
}

/** 提取引号内 import/require/export-from 说明符（含动态 import）。 */
function extractSpecifiers(source: string): string[] {
  return [...source.matchAll(/(?:from\s*|import\s*\(?\s*|require\(\s*)["']([^"']+)["']/g)].map(
    (match) => match[1]
  );
}

/** 说明符是否触达 application/server（别名、相对路径或层内 ./server/ 前缀）。 */
function reachesServerLayer(specifier: string): boolean {
  return (
    /@\/game\/application\/server(?:\/|$)/.test(specifier) ||
    /(?:\.\.\/)+game\/application\/server\//.test(specifier) ||
    /^\.\.?\/server\//.test(specifier)
  );
}

/** 剔除注释后再扫描（仅供 process.env 检查：注释里提及 process.env 不算读取）。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

describe("server-only modules stay out of client-importable code", () => {
  // 本文件自身含合成违例片段，不参与全文本扫描。
  const allFiles = walk(sourceRoot, true).filter(
    (file) => toPosixRelative(file) !== "dependencyBoundaries.test.ts"
  );
  const productionFiles = walk(sourceRoot, false).filter(
    (file) => toPosixRelative(file) !== "dependencyBoundaries.test.ts"
  );

  it("only sqliteClient.ts imports @libsql/client (all files incl. tests)", () => {
    const offenders = allFiles
      .filter((file) => toPosixRelative(file) !== `${SERVER_DIR}persistence/sqliteClient.ts`)
      .filter((file) => /["']@libsql\//.test(readFileSync(file, "utf8")))
      .map(toPosixRelative);
    expect(offenders).toEqual([]);
  });

  it("sqliteClient.ts itself still imports @libsql/client (guard is not vacuous)", () => {
    const source = readFileSync(
      resolve(sourceRoot, "game/application/server/persistence/sqliteClient.ts"),
      "utf8"
    );
    expect(/["']@libsql\/client["']/.test(source)).toBe(true);
  });

  it("application/server is only reachable via the sanctioned entry points", () => {
    const violations: string[] = [];
    for (const file of productionFiles) {
      const key = toPosixRelative(file);
      if (key.startsWith(SERVER_DIR)) continue; // 层内自由。
      const reaching = extractSpecifiers(readFileSync(file, "utf8")).filter(reachesServerLayer);
      if (reaching.length === 0) continue;
      // application 本体只能用纯端口；api route 只能用组合根；其余一律禁止。
      const allowed = key.startsWith("game/application/")
        ? PURE_PORT_SPECIFIER
        : key.startsWith("app/api/")
          ? COMPOSITION_ROOT_SPECIFIER
          : null;
      for (const specifier of reaching) {
        if (specifier !== allowed) violations.push(`${key}: ${specifier}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("sanctioned entry points are actually exercised (guard is not vacuous)", () => {
    const facade = readFileSync(resolve(sourceRoot, "game/application/index.ts"), "utf8");
    expect(extractSpecifiers(facade)).toContain(PURE_PORT_SPECIFIER);
    const routes = productionFiles
      .filter((file) => toPosixRelative(file).startsWith("app/api/"))
      .filter((file) =>
        extractSpecifiers(readFileSync(file, "utf8")).includes(COMPOSITION_ROOT_SPECIFIER)
      );
    expect(routes.length).toBeGreaterThanOrEqual(2);
  });

  it('"use client" files never touch domain/gameplay/server-only layers', () => {
    const clientFiles = allFiles.filter((file) =>
      /^["']use client["']/.test(readFileSync(file, "utf8").trimStart())
    );
    // NewGameSetupForm 与 CurrentGameScreen 必须被扫到，防止守卫空转。
    expect(clientFiles.length).toBeGreaterThanOrEqual(2);
    const violations = clientFiles.flatMap((file) =>
      extractSpecifiers(readFileSync(file, "utf8"))
        .filter(
          (specifier) =>
            reachesServerLayer(specifier) ||
            /@\/game\/(?:domain|gameplay)/.test(specifier) ||
            /@libsql\//.test(specifier) ||
            /sqlite(?:Client|GameRepository)/.test(specifier)
        )
        .map((specifier) => `${toPosixRelative(file)}: ${specifier}`)
    );
    expect(violations).toEqual([]);
  });

  it("process.env is only read inside application/server", () => {
    const offenders = productionFiles
      .filter((file) => !toPosixRelative(file).startsWith(SERVER_DIR))
      .filter((file) => /process\.env/.test(stripComments(readFileSync(file, "utf8"))))
      .map(toPosixRelative);
    expect(offenders).toEqual([]);
  });
});
