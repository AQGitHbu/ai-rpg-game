import { describe, expect, it } from "vitest";
import { paginateSpeechText } from "./speechPagination";

// ---------------------------------------------------------------------------
// 对白分页纯函数：把一段 NPC 对白按每页字符预算切成多页。
// 契约（封闭、确定性，无 Date / Math.random / AI）：
//   - 空白输入 → 空数组；
//   - 整体不超预算 → 单页（原文 trim 后原样返回）；
//   - 超预算时优先在句读（。！？…!?）后断页，页内不超预算；
//   - 单句本身超预算时按预算硬切，不丢字；
//   - 所有页顺序拼接 === trim 后原文（零丢失、零改写）；
//   - 预算必须为正整数，否则抛错。
// ---------------------------------------------------------------------------

describe("paginateSpeechText", () => {
  it("空串与纯空白 → 空数组", () => {
    expect(paginateSpeechText("", 20)).toEqual([]);
    expect(paginateSpeechText("   \n  ", 20)).toEqual([]);
  });

  it("不超预算的短对白 → 恰好一页且等于 trim 后原文", () => {
    expect(paginateSpeechText("  你好，旅人。  ", 20)).toEqual(["你好，旅人。"]);
  });

  it("超预算时在句读处断页，每页不超预算", () => {
    const text = "年轻人，最近村里发生了一些奇怪的事情。你愿意帮我们调查吗？";
    const pages = paginateSpeechText(text, 20);
    expect(pages).toEqual([
      "年轻人，最近村里发生了一些奇怪的事情。",
      "你愿意帮我们调查吗？"
    ]);
    for (const page of pages) {
      expect(page.length).toBeLessThanOrEqual(20);
    }
  });

  it("能装下的相邻句子聚合进同一页（贪心，不逐句成页）", () => {
    const text = "一。二。三。这是一个明显更长的句子占据一页。";
    const pages = paginateSpeechText(text, 6);
    expect(pages[0]).toBe("一。二。三。");
  });

  it("单句超预算 → 按预算硬切，不丢字", () => {
    const text = "这一句非常长而且完全没有任何句读符号可以用来断页";
    const pages = paginateSpeechText(text, 8);
    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages) {
      expect(page.length).toBeLessThanOrEqual(8);
    }
    expect(pages.join("")).toBe(text);
  });

  it("长句优先在逗号或分号后软切，不把中文词切成两页", () => {
    const text = "老汉眯着眼，语气带着几分警惕：“我姓赵，就住在前头坳里。这几日山里不太平，来了些生面孔，鬼鬼祟祟的。你要是跟他们一伙的，我劝你趁早回头；若不是，倒可以跟我说说，你一个镖师打扮的人，去那荒山野岭做什么？”";
    const pages = paginateSpeechText(text, 48);

    expect(pages.join("")).toBe(text);
    expect(pages).not.toContain("么？”");
    expect(pages.some((page) => page.endsWith("什"))).toBe(false);
    expect(pages.some((page) => page.length > 48)).toBe(false);
  });

  it("所有页顺序拼接 === trim 后原文（零丢失）", () => {
    const text = "  暮色四合！你背着旧刀走进青石镇……镇口贴着一张字迹潦草的缉凶告示。要去看看吗？ ";
    expect(paginateSpeechText(text, 12).join("")).toBe(text.trim());
  });

  it("确定性：相同输入产出相同分页", () => {
    const text = "年轻人，最近村里发生了一些奇怪的事情。你愿意帮我们调查吗？";
    expect(paginateSpeechText(text, 20)).toEqual(paginateSpeechText(text, 20));
  });

  it("预算非正整数 → 抛错", () => {
    expect(() => paginateSpeechText("你好。", 0)).toThrow();
    expect(() => paginateSpeechText("你好。", -1)).toThrow();
    expect(() => paginateSpeechText("你好。", 2.5)).toThrow();
  });
});
