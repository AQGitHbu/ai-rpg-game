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

const GENERIC_GREETING = "你是来打听事情的吧？想知道什么，直接问我。";
const GENERIC_INQUIRY_PATTERNS = [
  /你(?:还)?想(?:从)?哪一段/u,
  /你(?:还)?想(?:问|了解|知道)什么/u,
  /有什么想问的/u,
];

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

/** 判断 AI 是否只返回了没有身份、地点或当前线索承接的通用问候。 */
export function isGenericNpcGreeting(text: string): boolean {
  const normalized = normalizeNpcSpeech(text)
    .replace(/[“”"。！？!?，,、；;：:\s]/gu, "")
    .trim();
  return normalized === GENERIC_GREETING.replace(/[。！？!?，,、；;：:\s]/gu, "");
}

/**
 * 判断台词是否只把对话责任推回给玩家的空泛追问。
 *
 * 这类句子即使披上“关于旧案”的前缀，仍没有给出角色自己的观察、线索、
 * 判断或下一步，会让每位 NPC 听起来像同一个问答机器人。live 输出遇到它
 * 应回退到带角色和线索的确定性台词，而不是把它当作合格的多轮对白。
 */
export function isGenericNpcInquiry(text: string): boolean {
  const normalized = normalizeNpcSpeech(text).replace(/\s+/gu, "").trim();
  return GENERIC_INQUIRY_PATTERNS.some((pattern) => pattern.test(normalized));
}

/**
 * 生成稳定的、直接面向玩家的 NPC 默认开场台词。
 * 无角色信息时保留旧兼容文案；有角色信息时必须先承接人物身份，
 * 避免幸存者、信使等剧情人物冒出与场景无关的“欢迎光临”。
 */
export function composeDirectNpcGreeting(npcRole?: string, npcName?: string): string {
  const role = npcRole?.trim() ?? "";
  if (/(传讯|信使|线人)/u.test(role)) return "你来得正好，我手里的线索只交给正在查这桩旧案的人。先把密信和腰牌的来历对上，我们再谈下一步。";
  if (/(幸存者|镖队)/u.test(role)) return "别急着问镖队，先让我确认你手里有没有能对上旧案的证据。我不想再让一个无辜的人替这桩旧案付出代价。";
  if (/(卷宗|保管人)/u.test(role)) return "这份旧案牵连太深；你若真要查下去，我可以先交出我保管的那一页。缺失的印记，必须和你手里的证据一一核对。";
  if (/知情人/u.test(role)) return "我手里的盟誓铁印能把最后一页卷宗钉在真相上；你若真要查下去，我就不再隐瞒。只是名字一旦说出口，就没有回头路了。";
  if (/(更夫|守夜)/u.test(role)) return "昨夜子时，一辆无灯马车从北巷出镇，赶车人左手缠着血布。车轮印还留在酒楼后巷；要查就去北巷看看，别把传闻当证据。";
  if (/(掌柜|摊主|老板|老板娘|店主|酒肆)/u.test(role)) return "你是来问镇口那张告示的吧？坐下说，我只讲自己听见的。至于谁在撒谎，你自己听完再判断。";
  if (role !== "") return "你不是来闲逛的。把想查的事和手里的证据说清楚，我只回答能确认的那部分。";
  return "先进来坐。有什么需要我帮忙的，慢慢说清楚。";
}
