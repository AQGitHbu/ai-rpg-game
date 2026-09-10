// 纯对白 label 的格式审批（Plan 2026-09-09 / Task 6 Step 1）。
//
// checkDialogueLabel 不修改 label 正文，只允许外部空白 trim；拒绝列明的
// 结构违规：外层引号、句首说话标签、括号舞台说明、序号、装饰性前缀、
// 常见小说式冒号前缀。边界：只证明已列格式，不宣称理解任意语义。

import { fail, MAX_LABEL_LENGTH, type Check } from "@/game/domain/narrativeUnit";

const OUTER_QUOTE_PAIRS: Readonly<Record<string, string>> = {
  "“": "”",
  "「": "」",
  "『": "』",
  "\"": "\"",
  "'": "'",
};

/** 句首说话标签的动词尾：`盯着她问：` / `低声道：` 一类前缀。 */
const SPEECH_TAG_TAIL =
  /(?:问|说|讲|道|喊|答|叫|吼|嚷|骂|劝|求|催|笑|嘀咕|喃喃|开口|低声|沉声|轻声|冷声|反问|追问|叹|补了一句|开口道)$/u;

/** 序号前缀：`1、` `2. ` `一、`。 */
const NUMBERING_PREFIX = /^(?:[（(]?\d{1,3}[）)?]?[、.．]\s*|[一二三四五六七八九十][、.．])/u;

/** 装饰性前缀：`>` `＞` `#` `*` `•` `—`。 */
const DECORATIVE_PREFIX = /^[>＞#*•·—]/u;

/** 括号舞台说明：任何位置的 `（…）` 或 `(...)`。 */
const STAGE_DIRECTION = /[（(][^）)]*[)）]/u;

export function checkDialogueLabel(raw: string): Check<string> {
  const label = raw.trim();
  if (label === "") return fail("label_empty");
  if (Array.from(label).length > MAX_LABEL_LENGTH) return fail("label_too_long");

  const first = label[0];
  const last = label[label.length - 1];
  if (first !== undefined && last !== undefined && OUTER_QUOTE_PAIRS[first] === last) {
    return fail("label_outer_quote");
  }
  if (DECORATIVE_PREFIX.test(label)) return fail("label_decorative_prefix");
  if (NUMBERING_PREFIX.test(label)) return fail("label_numbered");
  if (STAGE_DIRECTION.test(label)) return fail("label_stage_direction");

  // 说话标签式冒号：冒号出现在任何句末标点之前，且冒号前的前缀
  // 以说话动词收尾，或是一个不含标点的短名称标签。
  const colonIndex = (() => {
    const full = label.indexOf("：");
    const half = label.indexOf(":");
    if (full === -1) return half;
    if (half === -1) return full;
    return Math.min(full, half);
  })();
  if (colonIndex > 0) {
    const prefix = label.slice(0, colonIndex);
    if (!/[。！？!?；;]/.test(prefix)) {
      if (SPEECH_TAG_TAIL.test(prefix)) return fail("label_speaker_tag");
      if (!/[，,、；;]/.test(prefix) && Array.from(prefix).length <= 6) {
        return fail("label_speaker_tag");
      }
    }
  }

  return { ok: true, value: label };
}
