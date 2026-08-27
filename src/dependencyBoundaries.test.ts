import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sourceRoot = resolve(process.cwd(), "src");

// ---------------------------------------------------------------------------
// 架构边界守卫（Phase 1 Task 7 建立，Phase 2 Task 5 扩展持久化方向，
// Phase 4 Task 5 补充 actions/quests 门面 deep-import 守卫，
// Phase 5 Task 5 补充 take_item 新增面的扫描覆盖自检，
// 2026-07 数据驱动化：gameplay facade 清单 FACADES → 自动生成 deep-import
// 规则、合成违例用例与负例，新加 facade 只改清单一处）。
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

/** UI/API/store 只允许门面，禁止 deep-import 内部文件——由下方 FACADES 清单自动生成。 */

/**
 * gameplay facade 数据清单：新增 facade 只改这一处——
 * deep-import 规则、合成违例用例与负例测试均由它自动生成。
 * anchors 是历史 phase 钉死的语义内部模块（见下方合成用例）。
 */
type FacadeSpec = {
  readonly name: string;
  /** facade 别名路径（无尾斜杠）。 */
  readonly path: string;
  /** 必须钉死的内部模块名（对应历史 phase 专项用例）。 */
  readonly anchors: readonly string[];
};

const FACADES: readonly FacadeSpec[] = [
  { name: "openingGeneration", path: "@/game/gameplay/rpg/openingGeneration", anchors: ["compileOpeningGenerationCandidate"] },
  { name: "ruleEngine", path: "@/game/gameplay/rpg/ruleEngine", anchors: ["resolveByType", "validateAction"] },
  { name: "worldEvolution", path: "@/game/gameplay/rpg/worldEvolution", anchors: ["deriveEvolutionNeed", "approveWorldDelta", "materializeWorldDelta"] },
  { name: "town", path: "@/game/gameplay/rpg/town", anchors: ["generateTown", "createTownRuntime", "bindNpcToTownSlot"] },
  { name: "intentParser", path: "@/game/gameplay/rpg/intentParser", anchors: ["intentContext", "intentParserSource"] },
  { name: "dialogue", path: "@/game/gameplay/rpg/dialogue", anchors: ["dialogueResolution"] },
  { name: "candidateEvents", path: "@/game/gameplay/rpg/candidateEvents", anchors: ["approveCandidateEvents", "compileCandidateEvent"] },
  { name: "narrativeExecution", path: "@/game/gameplay/rpg/narrativeExecution", anchors: ["narrativeExecutionPolicy"] },
  { name: "preparedContinuation", path: "@/game/gameplay/rpg/preparedContinuation", anchors: ["candidates"] },
  { name: "narrativeBundle", path: "@/game/gameplay/rpg/narrativeBundle", anchors: ["descriptors", "coverage"] }
] as const satisfies readonly FacadeSpec[];

/** 由 facade 清单生成 deep-import 规则：只许门面本体，禁止任何内部文件。 */
function facadeDeepImportPattern(facade: FacadeSpec): BoundaryPattern {
  return {
    label: `${facade.name} deep import (only the facade ${facade.path} is allowed)`,
    regex: new RegExp(`["']${escapeRegExp(facade.path)}\/[^"']+["']`)
  };
}

const FACADE_DEEP_IMPORTS: Readonly<Record<string, BoundaryPattern>> = Object.fromEntries(
  FACADES.map((facade) => [facade.name, facadeDeepImportPattern(facade)])
) as Readonly<Record<string, BoundaryPattern>>;

/**
 * Phase 1 约束：src/game/** 不引入 @ai-game/* 共享包（共享包仅限 UI 层）。
 * Phase 4B 例外：@ai-game/ai-transport 允许出现在 application/server/ai；
 * 日志共享化后 @ai-game/logging 只允许出现在 game/logging facade。
 */
const AI_GAME_PACKAGE_IMPORT: BoundaryPattern = {
  label: "@ai-game/* package import",
  regex: /["']@ai-game\/(?!ai-transport(?:["'\/])|logging(?:["'\/]))/
};

/** 允许的共享包仍由各自专项守卫限定目录。 */
const NEW_AI_GAME_PACKAGE_IMPORT: BoundaryPattern = {
  label: "new @ai-game/* package import (only ui, ai-transport and logging are allowed)",
  regex: /["']@ai-game\/(?!ui(?:["'\/])|ai-transport(?:["'\/])|logging(?:["'\/]))/
};

/** Phase 4B：@ai-game/ai-transport 只允许 application/server/ai 导入（其余目录一律禁止）。 */
const AI_TRANSPORT_IMPORT: BoundaryPattern = {
  label: "@ai-game/ai-transport import (only application/server/ai may import it)",
  regex: /["']@ai-game\/ai-transport/
};

const SHARED_LOGGING_IMPORT: BoundaryPattern = {
  label: "@ai-game/logging import (only game/logging may import it)",
  regex: /["']@ai-game\/logging/
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
  ...Object.values(FACADE_DEEP_IMPORTS),
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
  // application 本体（server 子目录除外）：允许 domain / scenario / actions /
  // quests 门面，禁止 deep-import、UI、libsql 与 sqlite adapter——对 server
  // 目录唯一合法入口是纯端口 gameRepository（精确许可清单见下方 server-only 静态守卫）。
  {
    directory: "game/application",
    excludePath: /[\\/]server[\\/]/,
    patterns: [
      forbiddenSpecifierPrefix("@/components/"),
      forbiddenSpecifierPrefix("@/store/"),
      forbiddenSpecifierPrefix("@/app/"),
      forbiddenSpecifierPrefix("@/providers/"),
      ...Object.values(FACADE_DEEP_IMPORTS),
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
      ...Object.values(FACADE_DEEP_IMPORTS),
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
      ...Object.values(FACADE_DEEP_IMPORTS),
      APPLICATION_SERVER_DEEP_IMPORT,
      RELATIVE_APPLICATION_SERVER_IMPORT,
      DOMAIN_IMPORT,
      RELATIVE_DOMAIN_IMPORT,
      LIBSQL_IMPORT,
      SQLITE_MODULE_IMPORT
    ]
  },
  { directory: "game", patterns: [AI_GAME_PACKAGE_IMPORT] },
  // Phase 4B：@ai-game/ai-transport 只能在 application/server/ai 内使用；其余任何目录
  // （含 composition root、domain/gameplay/UI/API）导入都视为违例。沿用默认跳过
  // *.test.ts（本守卫文件自含合成片段）；生产代码覆盖另见下方 phase 4b 专项守卫。
  {
    directory: ".",
    excludePath: /[\\/]application[\\/]server[\\/]ai[\\/]/,
    patterns: [AI_TRANSPORT_IMPORT]
  },
  {
    directory: ".",
    excludePath: /[\\/]game[\\/]logging[\\/]/,
    patterns: [SHARED_LOGGING_IMPORT]
  },
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
  // facade deep-import 用例由 FACADES 自动生成：每个语义锚点 + 通用内部模块各一条。
  const facadeCases = FACADES.flatMap((facade) => [
    ...facade.anchors.map((anchor) => ({
      pattern: facadeDeepImportPattern(facade),
      snippet: `import { hidden } from "${facade.path}/${anchor}";`
    })),
    {
      pattern: facadeDeepImportPattern(facade),
      snippet: `import { hidden } from "${facade.path}/someInternalModule";`
    }
  ]);
  const cases: readonly { pattern: BoundaryPattern; snippet: string }[] = [
    ...facadeCases,
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
    { pattern: AI_GAME_PACKAGE_IMPORT, snippet: `import { Panel } from "@ai-game/ui";` },
    { pattern: NEW_AI_GAME_PACKAGE_IMPORT, snippet: `import { db } from "@ai-game/persistence";` },
    {
      // Phase 4B：ai-transport 只许 application/server/ai；其余目录导入都被专项规则拦下。
      pattern: AI_TRANSPORT_IMPORT,
      snippet: `import { createOpenAiCompatibleTransport } from "@ai-game/ai-transport";`
    },
    {
      // UI 层不能触达 server-only opening generation source（前缀规则整段拦截）。
      pattern: APPLICATION_SERVER_IMPORT,
      snippet: `import { createOpeningGenerationSource } from "@/game/application/server/ai/openingGenerationSource";`
    },
    {
      // Phase 4B：AI 运行时配置解析是 server-only，UI 层不可达。
      pattern: APPLICATION_SERVER_IMPORT,
      snippet: `import { parseAiRuntimeConfig } from "@/game/application/server/ai/aiRuntimeConfig";`
    },
    {
      // API 层只许组合根，deep-import source/config 一律被拦。
      pattern: APPLICATION_SERVER_DEEP_IMPORT,
      snippet: `import { createOpeningGenerationSource } from "@/game/application/server/ai/openingGenerationSource";`
    },
    {
      // domain/gameplay 连 application 门面本体都禁止（含 server/ai source）。
      pattern: forbiddenSpecifierPrefix("@/game/application"),
      snippet: `import { createOpeningGenerationSource } from "@/game/application/server/ai/openingGenerationSource";`
    },
    { pattern: SLG_IMPORT, snippet: `import { grid } from "../ai-slg-game/src/map";` },
    { pattern: SLG_IMPORT, snippet: `import { hex } from "@ai-slg-game/map";` },
    {
      pattern: RELATIVE_ESCAPE_FROM_DOMAIN,
      snippet: `import { load } from "../gameplay/rpg/ruleEngine";`
    },
    {
      pattern: RELATIVE_ESCAPE_FROM_GAMEPLAY,
      snippet: `import { persist } from "../../application/server/persist";`
    },
    {
      pattern: RELATIVE_GAMEPLAY_IMPORT,
      snippet: `import { resolve } from "../game/gameplay/rpg/ruleEngine/resolveByType";`
    },
    {
      pattern: APPLICATION_SERVER_IMPORT,
      snippet: `import { getServerGameEntryPoints } from "@/game/application/server/compositionRoot";`
    },
    {
      pattern: APPLICATION_SERVER_IMPORT,
      snippet: `import { createSource } from "@/game/application/server/ai/sourceFactory";`
    },
    {
      pattern: APPLICATION_SERVER_DEEP_IMPORT,
      snippet: `import { adapter } from "@/game/application/server/persistence/sqliteGameRepository";`
    },
    {
      pattern: APPLICATION_SERVER_DEEP_IMPORT,
      snippet: `import { createSource } from "@/game/application/server/ai/sourceFactory";`
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

  it("facade imports do not trip any facade deep-import rule", () => {
    for (const facade of FACADES) {
      const snippet = `import { x } from "${facade.path}";`;
      expect(
        findBoundaryViolations(snippet, Object.values(FACADE_DEEP_IMPORTS)),
        facade.name
      ).toEqual([]);
    }
  });

  it("@ai-game/ui does not trip the new-package rule", () => {
    const snippet = `import { Panel } from "@ai-game/ui";`;
    expect(findBoundaryViolations(snippet, [NEW_AI_GAME_PACKAGE_IMPORT])).toEqual([]);
  });

  it("@ai-game/ai-transport does not trip the blanket @ai-game rules (only its own专项守卫拦它)", () => {
    const snippet = `import { createOpenAiCompatibleTransport } from "@ai-game/ai-transport";`;
    expect(
      findBoundaryViolations(snippet, [AI_GAME_PACKAGE_IMPORT, NEW_AI_GAME_PACKAGE_IMPORT])
    ).toEqual([]);
    // 但专项守卫必须仍然抓得住它。
    expect(findBoundaryViolations(snippet, [AI_TRANSPORT_IMPORT])).toEqual([AI_TRANSPORT_IMPORT.label]);
  });

  it("@ai-game/logging does not trip blanket rules but is caught by its directory guard", () => {
    const snippet = `import { createLogger } from "@ai-game/logging";`;
    expect(
      findBoundaryViolations(snippet, [AI_GAME_PACKAGE_IMPORT, NEW_AI_GAME_PACKAGE_IMPORT])
    ).toEqual([]);
    expect(findBoundaryViolations(snippet, [SHARED_LOGGING_IMPORT])).toEqual([
      SHARED_LOGGING_IMPORT.label
    ]);
  });

  it("relative data import does not trip the gameplay escape rule", () => {
    const snippet = `import profiles from "../../../../../data/base/gameTypeProfiles.json";`;
    expect(findBoundaryViolations(snippet, [RELATIVE_ESCAPE_FROM_GAMEPLAY])).toEqual([]);
  });

  it("relative domain import does not trip the relative gameplay rule", () => {
    const snippet = `import { types } from "../game/domain/worldEntity";`;
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

describe("canonical client surfaces stay behind the application facade", () => {
  it("canonical components and exactly six game routes are inside the scanned rule scopes", () => {
    const componentFiles = exists(resolve(sourceRoot, "components"), false).map(toPosixRelative);
    for (const relative of [
      "components/AdventureGameShell.tsx",
      "components/CurrentGameScreen.tsx",
      "components/NewGameSetupForm.tsx",
      "components/gameActionRequest.ts"
    ]) {
      expect(componentFiles).toContain(relative);
    }
    const routeFiles = exists(resolve(sourceRoot, "app/api"), false)
      .map(toPosixRelative)
      .filter((relative) => relative.endsWith("/route.ts"))
      .sort();
    expect(routeFiles).toEqual([
      "app/api/game/actions/route.ts",
      "app/api/game/current/route.ts",
      "app/api/game/dev/current/route.ts",
      "app/api/game/narrative/ensure/route.ts",
      "app/api/game/prologue/ack/route.ts",
      "app/api/game/route.ts"
    ]);
  });

  it("canonical components import game types only through @/game/application", () => {
    for (const relative of [
      "components/AdventureGameShell.tsx",
      "components/CurrentGameScreen.tsx",
      "components/NewGameSetupForm.tsx",
      "components/gameActionRequest.ts"
    ]) {
      const specifiers = extractSpecifiers(readFileSync(resolve(sourceRoot, relative), "utf8"));
      expect(specifiers, relative).toContain("@/game/application");
      const offenders = specifiers.filter(
        (specifier) => specifier.startsWith("@/game/") && specifier !== "@/game/application"
      );
      expect(offenders, relative).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// Canonical AI sources stay server-only and layered.
// ---------------------------------------------------------------------------

describe("canonical AI sources stay server-only and layered", () => {
  const aiDir = resolve(sourceRoot, "game/application/server/ai");

  it("source files exist and are inside the server rule scope", () => {
    const files = exists(aiDir, false).map(toPosixRelative);
    expect(files).toContain("game/application/server/ai/sourceFactory.ts");
    expect(files).toContain("game/application/server/ai/openingGenerationSource.ts");
  });

  it("AI sources never import persistence/sqlite/libsql", () => {
    for (const file of exists(aiDir, false)) {
      const offenders = extractSpecifiers(readFileSync(file, "utf8")).filter(
        (specifier) =>
          /persistence\//.test(specifier) ||
          /sqlite(?:Client|GameRepository)/.test(specifier) ||
          /@libsql\//.test(specifier)
      );
      expect(offenders, toPosixRelative(file)).toEqual([]);
    }
  });

  it("domain/gameplay never import application AI sources", () => {
    const files = [
      ...exists(resolve(sourceRoot, "game/domain"), false),
      ...exists(resolve(sourceRoot, "game/gameplay"), false)
    ];
    const offenders = files.flatMap((file) =>
      extractSpecifiers(readFileSync(file, "utf8"))
        .filter((specifier) => /application\/server\/ai/.test(specifier))
        .map((specifier) => `${toPosixRelative(file)}: ${specifier}`)
    );
    expect(offenders).toEqual([]);
  });

  it("composition root reaches AI only through canonical factories", () => {
    const rootSpecifiers = extractSpecifiers(
      readFileSync(resolve(sourceRoot, "game/application/server/compositionRoot.ts"), "utf8")
    );
    expect(rootSpecifiers).toContain("../server/ai/sourceFactory");
    expect(rootSpecifiers).toContain("../server/ai/intentParserSourceFactory");
    const factorySpecifiers = extractSpecifiers(
      readFileSync(resolve(sourceRoot, "game/application/server/ai/sourceFactory.ts"), "utf8")
    );
    expect(factorySpecifiers).toContain("./rpgAiClient");
    expect(factorySpecifiers).toContain("./openingGenerationSource");

    const clientSpecifiers = extractSpecifiers(
      readFileSync(resolve(sourceRoot, "game/application/server/ai/rpgAiClient.ts"), "utf8")
    );
    expect(clientSpecifiers).toContain("@ai-game/ai-transport");
  });
});

// ---------------------------------------------------------------------------
// @ai-game/ai-transport 共享包的分层守卫。上方目录规则已禁止 UI/API/
// domain/gameplay 达到 server/ai；这里额外钉死：
//   1) 全库只有 application/server/ai 内的生产代码可导入 @ai-game/ai-transport；
//   2) live source 与工厂不得导入 persistence/sqlite/libsql（与 fixture 同级）；
//   3) 只有 composition root 经工厂读取运行时配置（process.env 守卫已在下方覆盖）。
// ---------------------------------------------------------------------------

describe("ai-transport stays confined to application/server/ai", () => {
  const AI_DIR = "game/application/server/ai/";
  const productionFiles = walk(sourceRoot, false).filter(
    (file) => toPosixRelative(file) !== "dependencyBoundaries.test.ts"
  );

  it("only application/server/ai imports @ai-game/ai-transport (all production files)", () => {
    const offenders = productionFiles
      .filter((file) => !toPosixRelative(file).startsWith(AI_DIR))
      .filter((file) => /["']@ai-game\/ai-transport/.test(readFileSync(file, "utf8")))
      .map(toPosixRelative);
    expect(offenders).toEqual([]);
  });

  it("the ai-transport import is actually exercised inside application/server/ai (guard is not vacuous)", () => {
    const users = walk(resolve(sourceRoot, "game/application/server/ai"), false).filter((file) =>
      /["']@ai-game\/ai-transport/.test(readFileSync(file, "utf8"))
    );
    expect(users.length).toBeGreaterThan(0);
  });

  it("source modules never import persistence/sqlite/libsql", () => {
    for (const relative of [
      "sourceFactory.ts",
      "openingGenerationSource.ts",
      "liveWorldEvolutionSource.ts",
      "liveIntentParserSource.ts"
    ]) {
      const file = resolve(sourceRoot, "game/application/server/ai", relative);
      const offenders = extractSpecifiers(readFileSync(file, "utf8")).filter(
        (specifier) =>
          /persistence\//.test(specifier) ||
          /sqlite(?:Client|GameRepository)/.test(specifier) ||
          /@libsql\//.test(specifier)
      );
      expect(offenders, relative).toEqual([]);
    }
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
/** 纯端口文件：只有类型与 asGameId/asGenerationId 等。application 本体合法的 server 纯端口清单。 */
const PURE_PORT_SPECIFIERS = ["./server/persistence/gameRepository", "./server/ai/textAuditTypes"] as const;
/** API route 层唯一许可的 server 入口。 */
const COMPOSITION_ROOT_SPECIFIER = "@/game/application/server/compositionRoot";
const SERVER_LOGGER_SPECIFIER = "@/game/logging/serverConsoleLogger";

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
        ? PURE_PORT_SPECIFIERS
        : key.startsWith("app/api/")
          ? [COMPOSITION_ROOT_SPECIFIER]
          : null;
      for (const specifier of reaching) {
        if (allowed === null || !(allowed as readonly string[]).includes(specifier)) violations.push(`${key}: ${specifier}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("sanctioned entry points are actually exercised (guard is not vacuous)", () => {
    const facade = readFileSync(resolve(sourceRoot, "game/application/index.ts"), "utf8");
    expect(extractSpecifiers(facade)).toContain(PURE_PORT_SPECIFIERS[0]);
    // textAuditTypes 纯端口必须被 application 本体实际导入（非空转守卫）
    const generatePendingSceneSource = readFileSync(
      resolve(sourceRoot, "game/application/generatePendingScene.ts"),
      "utf8",
    );
    expect(extractSpecifiers(generatePendingSceneSource)).toContain("./server/ai/textAuditTypes");
    const routes = productionFiles
      .filter((file) => toPosixRelative(file).startsWith("app/api/"))
      .filter((file) =>
        extractSpecifiers(readFileSync(file, "utf8")).includes(COMPOSITION_ROOT_SPECIFIER)
      );
    expect(routes.length).toBeGreaterThanOrEqual(2);
  });

  // canonical domain/gameplay 纯函数层不触达上层，application 本体只经纯端口
  // 取持久化契约。钉死模块确实在扫描范围内、且不违反分层（守卫不空转）。
  it("canonical state surfaces stay inside scanned scopes and respect layering", () => {
    // domain 纯函数层文件存在且不导入 application/UI/server（目录规则已覆盖，此处钉死不空转）。
    for (const relative of [
      "game/domain/worldState.ts",
      "game/domain/storyState.ts",
      "game/domain/storyBudget.ts",
      "game/domain/action.ts",
      "game/domain/resolvedEvent.ts",
      "game/domain/materializedView.ts"
    ]) {
      const file = resolve(sourceRoot, relative);
      expect(statSync(file).isFile(), relative).toBe(true);
      const specifiers = extractSpecifiers(readFileSync(file, "utf8"));
      expect(
        specifiers.filter((s) => s.startsWith("@/game/application") || s.startsWith("@/game/gameplay")),
        relative
      ).toEqual([]);
    }
    // gameplay ruleEngine 纯函数不触达 application/UI/server。
    for (const relative of [
      "game/gameplay/rpg/ruleEngine/validateAction.ts",
      "game/gameplay/rpg/ruleEngine/resolveByType.ts",
      "game/gameplay/rpg/ruleEngine/updateStoryMetrics.ts",
      "game/gameplay/rpg/ruleEngine/index.ts"
    ]) {
      const file = resolve(sourceRoot, relative);
      expect(statSync(file).isFile(), relative).toBe(true);
      const specifiers = extractSpecifiers(readFileSync(file, "utf8"));
      expect(
        specifiers.filter((s) => s.startsWith("@/game/application") || s.startsWith("@/components/") || s.startsWith("@/store/")),
        relative
      ).toEqual([]);
    }
    // application 编排只经纯端口取持久化契约（无 libsql/env/路径）。
    for (const relative of [
      "game/application/createGame.ts",
      "game/application/performTurn.ts",
      "game/application/stateCommit.ts",
      "game/application/sceneWriteBack.ts"
    ]) {
      const file = resolve(sourceRoot, relative);
      expect(statSync(file).isFile(), relative).toBe(true);
      const specifiers = extractSpecifiers(readFileSync(file, "utf8"));
      expect(specifiers, relative).toContain(PURE_PORT_SPECIFIERS[0]);
      expect(
        specifiers.filter(
          (s) =>
            reachesServerLayer(s) &&
            !PURE_PORT_SPECIFIERS.includes(s as typeof PURE_PORT_SPECIFIERS[number])
        ),
        relative
      ).toEqual([]);
    }
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

  it("only the server composition root imports the server console logger", () => {
    const violations = productionFiles
      .filter((file) => toPosixRelative(file) !== "game/application/server/compositionRoot.ts")
      .filter((file) => toPosixRelative(file) !== "game/application/server/compositionRoot.ts")
      .filter((file) => extractSpecifiers(readFileSync(file, "utf8")).includes(SERVER_LOGGER_SPECIFIER))
      .map(toPosixRelative);
    expect(violations).toEqual([]);
    const compositionRoot = readFileSync(
      resolve(sourceRoot, "game/application/server/compositionRoot.ts"),
      "utf8"
    );
    expect(extractSpecifiers(compositionRoot)).toContain(SERVER_LOGGER_SPECIFIER);
  });
});

// ---------------------------------------------------------------------------
// Canonical runtime closure: there is one executable chain and no source-debt
// typecheck quarantine. Persisted schema/fixture version values are outside
// this naming scan and remain intentionally supported as data-contract facts.
// ---------------------------------------------------------------------------

describe("one canonical executable chain remains", () => {
  const productionFiles = walk(sourceRoot, false).filter(
    (file) => toPosixRelative(file) !== "dependencyBoundaries.test.ts",
  );

  it("has one repository, composition root, read model, request client, and six routes", () => {
    const relativeFiles = productionFiles.map(toPosixRelative);
    expect(relativeFiles.filter((file) => file.endsWith("/gameRepository.ts"))).toEqual([
      "game/application/server/persistence/gameRepository.ts",
    ]);
    expect(relativeFiles.filter((file) => file.endsWith("/compositionRoot.ts"))).toEqual([
      "game/application/server/compositionRoot.ts",
    ]);
    expect(relativeFiles.filter((file) => file.endsWith("/gameSessionView.ts"))).toEqual([
      "game/application/gameSessionView.ts",
    ]);
    expect(relativeFiles.filter((file) => file.endsWith("/gameActionRequest.ts"))).toEqual([
      "components/gameActionRequest.ts",
    ]);
    expect(relativeFiles.filter((file) => file.startsWith("app/api/") && file.endsWith("/route.ts")).sort()).toEqual([
      "app/api/game/actions/route.ts",
      "app/api/game/current/route.ts",
      "app/api/game/dev/current/route.ts",
      "app/api/game/narrative/ensure/route.ts",
      "app/api/game/prologue/ack/route.ts",
      "app/api/game/route.ts",
    ]);
  });

  it("contains no retired executable gameplay chain", () => {
    const retiredPrefixes = [
      "game/gameplay/rpg/actions/",
      "game/gameplay/rpg/battle/",
      "game/gameplay/rpg/choices/",
      "game/gameplay/rpg/narrative/",
      "game/gameplay/rpg/quests/",
      "game/gameplay/rpg/scenario/",
    ];
    const retired = productionFiles
      .map(toPosixRelative)
      .filter((file) => retiredPrefixes.some((prefix) => file.startsWith(prefix)));
    expect(retired).toEqual([]);
  });

  it("contains no retired town demo script or assets", () => {
    const repositoryRoot = resolve(sourceRoot, "..");
    const retiredScript = ["genTown", "BuildingImages.mjs"].join("");
    const retiredAssetDirectory = ["town", "experiment"].join("-");
    expect(existsSync(resolve(repositoryRoot, "scripts", retiredScript))).toBe(false);
    expect(existsSync(resolve(repositoryRoot, "public/assets", retiredAssetDirectory))).toBe(false);
  });

  it("has no versioned executable naming outside persisted schema/fixture values", () => {
    const offenders = productionFiles.flatMap((file) => {
      const source = readFileSync(file, "utf8");
      const versionPattern = new RegExp(["V", "[12]|v2\\.1|/api/v[12]/"].join(""));
      return versionPattern.test(source) ? [toPosixRelative(file)] : [];
    });
    expect(offenders).toEqual([]);
  });

  it("does not quarantine application, API, or component production source from typecheck", () => {
    const config = JSON.parse(readFileSync(resolve(sourceRoot, "../tsconfig.json"), "utf8")) as {
      readonly exclude?: readonly string[];
    };
    expect(config.exclude ?? []).toEqual(["node_modules", ".next"]);
    expect((config.exclude ?? []).filter((entry) => /(?:src|app|api|component|game\/application)/i.test(entry))).toEqual([]);
  });
});
