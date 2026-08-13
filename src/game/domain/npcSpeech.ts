/**
 * NPC 台词是直接呈现给玩家的对白正文，不携带说话人名称、动作或
 * “说道/答道”这类舞台说明。这个边界同时服务于生成、审批和旧存档投影。
 */

const GENERIC_ACKNOWLEDGEMENTS = new Set([
  "我知道了",
  "知道了",
  "好的",
  "好",
  "明白了",
  "明白",
  "嗯",
  "嗯嗯",
]);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isNarrativeSpeakerPrefix(prefix: string, npcName?: string): boolean {
  const compact = prefix.replace(/\s+/gu, "");
  if (npcName !== undefined && npcName.trim() !== "") {
    const escapedName = escapeRegExp(npcName.trim());
    if (new RegExp(`^${escapedName}(?:（[^）]*）)?`).test(compact)) return true;
  }
  return /(?:说道|答道|说|道|问道|回道|补充道|解释道|低声|轻声|冷冷|如实|坦诚|谨慎|犹豫|看着|看了|望着|注视|压低声音)/u.test(compact);
}

function isActionOnlyNarration(value: string, npcName?: string): boolean {
  if (npcName === undefined || npcName.trim() === "") return false;
  const compact = value.replace(/\s+/gu, "");
  const escapedName = escapeRegExp(npcName.trim());
  return new RegExp(`^${escapedName}(?:（[^）]*）)?`, "u").test(compact)
    && /(?:看了你一眼|看向你|望着你|注视着你|点了点头|摇了摇头|继续巡视|沉默不语|没有说话)/u.test(compact);
}

/**
 * 去除 NPC 台词外层的叙述性包装，保留直接对白正文。
 *
 * 只在引号包住完整对白，或前缀明确像说话人/动作描述时才剥离，
 * 避免误伤“关于这件事：我还不能确定”这样的正常台词。
 */
export function normalizeNpcSpeech(text: string, npcName?: string): string {
  const value = text.trim();
  if (value === "") return "";

  const firstQuote = value.search(/["“「『]/u);
  if (firstQuote >= 0) {
    const opening = value[firstQuote];
    const closing = opening === "“" ? "”" : opening === "「" ? "」" : opening === "『" ? "』" : "\"";
    const lastQuote = value.lastIndexOf(closing);
    const suffix = lastQuote >= 0 ? value.slice(lastQuote + 1).trim() : "";
    if (lastQuote > firstQuote && (suffix === "" || /^[。！？!?]$/u.test(suffix))) {
      const prefix = value.slice(0, firstQuote).trim();
      if (prefix === "" || isNarrativeSpeakerPrefix(prefix, npcName)) {
        return value.slice(firstQuote + 1, lastQuote).trim();
      }
    }
  }

  if (npcName !== undefined && npcName.trim() !== "") {
    const escapedName = escapeRegExp(npcName.trim());
    const withoutName = value.replace(
      new RegExp(`^${escapedName}(?:（[^）]*）)?\\s*[:：]\\s*`, "u"),
      "",
    ).trim();
    if (withoutName !== value) return withoutName;

    const withoutSpeechVerb = value.replace(
      new RegExp(
        `^${escapedName}(?:（[^）]*）)?\\s*(?:如实|坦诚|谨慎|冷冷|低声|轻声|犹豫|压低声音)?(?:说道|答道|回道|问道|补充道|解释道|说|道)\\s*[：:，,]\\s*`,
        "u",
      ),
      "",
    ).trim();
    if (withoutSpeechVerb !== value) return withoutSpeechVerb;
  }

  // 旧场景可能把纯动作旁白误存进 NPC 气泡；没有可恢复的对白时，
  // 交给调用方使用 direct greeting，而不是继续显示第三人称动作。
  if (isActionOnlyNarration(value, npcName)) return "";

  const separator = value.search(/[:：]/u);
  if (separator > 0 && isNarrativeSpeakerPrefix(value.slice(0, separator), npcName)) {
    return value.slice(separator + 1).trim();
  }

  return value;
}

/** 判断台词是否只是没有承接对象的通用确认句。 */
export function isGenericNpcAcknowledgement(text: string): boolean {
  const normalized = normalizeNpcSpeech(text)
    .replace(/[“”"。！？!?，,、；;：:\s]/gu, "")
    .trim();
  return GENERIC_ACKNOWLEDGEMENTS.has(normalized);
}

/** 生成稳定的、直接面向玩家的 NPC 默认开场台词。 */
export function composeDirectNpcGreeting(): string {
  return "欢迎光临，有什么需要我帮忙的吗？";
}
