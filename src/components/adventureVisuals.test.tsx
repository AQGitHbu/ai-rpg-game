import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { NewGameInput } from "@/game/application";
import {
  ADVENTURE_VISUAL_KINDS,
  AdventureVisual,
  resolveAdventureVisualVariant
} from "./adventureVisuals";

// ---------------------------------------------------------------------------
// Phase 7 Task 4：本地内联 SVG 视觉档案。
// 1) 七种题材 × 八类资源全组合都渲染出带可访问名称的内联 SVG；
// 2) 非法运行时输入一律解析为 "generic"，不抛错；
// 3) 装饰模式（decorative）用 aria-hidden 隐藏，不占用 img role；
// 4) 组件源码零网络/生图引用（读源文件断言，沿用 dependencyBoundaries 的
//    readFileSync 源码扫描惯例）。测试全程不 mock fetch。
// ---------------------------------------------------------------------------

/** UI 层经 application 门面取题材类型（禁止直连 domain）。 */
type GameTypeId = NewGameInput["gameType"];

const ALL_GAME_TYPES: readonly GameTypeId[] = [
  "wuxia",
  "xianxia",
  "fantasy",
  "science_fiction",
  "urban",
  "alternate_history",
  "post_apocalypse"
];

describe("AdventureVisual", () => {
  it("七种题材 × 八类资源全部渲染为带可访问名称的 img", () => {
    for (const gameType of ALL_GAME_TYPES) {
      for (const kind of ADVENTURE_VISUAL_KINDS) {
        const { unmount } = render(
          <AdventureVisual gameType={gameType} kind={kind} label={`${gameType}-${kind}`} />
        );
        expect(
          screen.getByRole("img", { name: `${gameType}-${kind}` })
        ).toBeInTheDocument();
        unmount();
      }
    }
  });

  it("非装饰 SVG 内含 <title>，可访问名称即 label", () => {
    const { container } = render(
      <AdventureVisual gameType="wuxia" kind="npc" label="陆掌柜" />
    );
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg!.getAttribute("role")).toBe("img");
    expect(svg!.getAttribute("aria-label")).toBe("陆掌柜");
    expect(svg!.querySelector("title")?.textContent).toBe("陆掌柜");
  });

  it("装饰模式 aria-hidden，不暴露 img role（地点名由相邻文本提供）", () => {
    const { container } = render(
      <AdventureVisual
        gameType="urban"
        kind="location_backdrop"
        label="旧城巷口"
        decorative
      />
    );
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg!.getAttribute("aria-hidden")).toBe("true");
    expect(svg!.hasAttribute("role")).toBe(false);
    expect(svg!.querySelector("title")).toBeNull();
    expect(screen.queryByRole("img")).toBeNull();
  });
});

describe("resolveAdventureVisualVariant", () => {
  it("七种合法题材原样返回", () => {
    for (const gameType of ALL_GAME_TYPES) {
      expect(resolveAdventureVisualVariant(gameType, "npc")).toBe(gameType);
    }
  });

  it("非法运行时输入一律返回 generic，不抛错", () => {
    expect(resolveAdventureVisualVariant("unknown", "npc")).toBe("generic");
    expect(resolveAdventureVisualVariant("wuxia", "portal")).toBe("generic");
    expect(resolveAdventureVisualVariant(null, "item")).toBe("generic");
    expect(resolveAdventureVisualVariant(undefined, undefined)).toBe("generic");
    expect(resolveAdventureVisualVariant(42, ["npc"])).toBe("generic");
    expect(resolveAdventureVisualVariant("../wuxia", "npc")).toBe("generic");
  });
});

describe("视觉档案源码零网络/生图引用", () => {
  it("adventureVisuals.tsx 不含 http/fetch/AI_/image_gen 字符串", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/components/adventureVisuals.tsx"),
      "utf8"
    );
    for (const forbidden of ["http", "fetch", "AI" + "_", "image" + "_gen"]) {
      expect(source.includes(forbidden), `forbidden string: ${forbidden}`).toBe(false);
    }
    expect(source.includes("<img")).toBe(false);
  });
});
