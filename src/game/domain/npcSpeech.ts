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
  // Without an exact npcName, only strip an unmistakable short third-person
  // speaker wrapper. Bare “说/道/坦诚” also occur naturally in first-person
  // answers before a colon; preserving uncertain text is safer than deleting it.
  return /^(?![我你])[^，。！？!?：:]{1,20}(?:说道|答道|问道|回道|补充道|解释道)$/u.test(compact);
}

function isActionOnlyNarration(value: string, npcName?: string): boolean {
  if (npcName === undefined || npcName.trim() === "") return false;
  const compact = value.replace(/\s+/gu, "");
  const escapedName = escapeRegExp(npcName.trim());
  return new RegExp(`^${escapedName}(?:（[^）]*）)?`, "u").test(compact)
    && /(?:看了你一眼|看向你|望着你|注视着你|点了点头|摇了摇头|继续巡视|沉默不语|没有说话)/u.test(compact);
}

/**
 * 兼容模型把两句直接对白各自包上引号后拼接的输出，例如
 * `第一句。”“第二句`。这种残留标点会直接出现在气泡里，既不像正常对白，
 * 也会让后续句子难以阅读；只移除句间成对引号，保留句号和正常引号内容。
 */
function repairDialogueQuoteArtifacts(value: string): string {
  return value
    .replace(/([。！？!?])\s*[”"]\s*[“「『]/gu, "$1")
    .replace(/([^\s])\s*[”"]\s*[“「『](?=[\p{L}\p{N}\p{Unified_Ideograph}])/gu, "$1");
}

/**
 * 剥离台词最前面的整段括号舞台说明，例如
 * `（哑巴猎户用炭笔写下几个字，推到你面前）铁旗会总舵`。
 * 若整句只剩舞台说明则保留原文，交给动作旁白判断处理。
 */
function stripLeadingStageDirection(value: string): string {
  const withoutDirection = value.replace(/^（[^）]*）\s*/u, "").trim();
  return withoutDirection === "" ? value : withoutDirection;
}

/** 纯舞台动作（包括前置沉默省略号）不能进入 NPC 对话气泡。 */
function stripStandaloneStageDirection(value: string): string {
  return /^[…。！？!?\s]*（[^）]*）[…。！？!?\s]*$/u.test(value) ? "" : value;
}

/**
 * 对话分页会把整段 `‘…’` 包装拆到页首页尾，留下单侧引号。台词边界不允许
 * 引号包装，所以只在两侧数量不等时剥掉多余的一侧；数量相等的成对引用
 * （例如句中提到 `‘铁旗会’`）保持原样。
 */
function stripUnbalancedSingleQuoteWrapper(value: string): string {
  const opens = (value.match(/‘/gu) ?? []).length;
  const closes = (value.match(/’/gu) ?? []).length;
  if (opens > closes) return value.replace(/^‘+/u, "").trim();
  if (closes > opens) return value.replace(/’+$/u, "").trim();
  return value;
}

/**
 * 去除 NPC 台词外层的叙述性包装，保留直接对白正文。
 *
 * 只在引号包住完整对白，或前缀明确像说话人/动作描述时才剥离，
 * 避免误伤“关于这件事：我还不能确定”这样的正常台词。
 */
export function normalizeNpcSpeech(text: string, npcName?: string): string {
  const value = stripUnbalancedSingleQuoteWrapper(
    stripLeadingStageDirection(stripStandaloneStageDirection(repairDialogueQuoteArtifacts(text.trim()))),
  );
  if (value === "") return "";

  // ‘…’ 只可能整段包裹一句台词；句中出现的单弯引号是引用，保持原样。
  if (/^‘.+’$/u.test(value)) {
    const speech = value.slice(1, -1).trim();
    if (speech !== "") return speech;
  }

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
 * 这里只做无剧情语义的安全兜底；具体角色事实、地点和任务交接必须由
 * 当前场景的结构化上下文或 live performer 提供，不能按 role/name 硬编码。
 */
export function composeDirectNpcGreeting(_npcRole?: string, _npcName?: string): string {
  const hasContext = (_npcRole?.trim() ?? "") !== "" || (_npcName?.trim() ?? "") !== "";
  if (hasContext) {
    return "有什么要问的，直接说。我只回答亲眼见过或已经核对的部分。";
  }
  return "先进来坐。有什么需要我帮忙的，慢慢说清楚。";
}

/** 已参与过剧情的 NPC 待机提醒变体：只引用权威当前目标，不制造未发生的地点、证物或人物。 */
const IDLE_REMINDER_VARIANTS: readonly string[] = [
  "先前说定的事别忘了。{objective}要紧，有了结果再来告诉我。",
  "我还在这儿守着。{objective}有了眉目，随时来寻我。",
  "别在我这里耽搁太久。{objective}查清楚了，我们再从头核对。",
];

/** 无交互历史 NPC 的中性闲聊变体：不泄露未参与的主线内容。 */
const IDLE_AMBIENT_VARIANTS: readonly string[] = [
  "今日没什么可说的。你忙你的正事，我先招呼着。",
  "我就在这里。亲眼见过的事，问了我才答。",
  "忙你的去吧。真有要紧事，我不会瞒你。",
];

/**
 * 组合非焦点 NPC 的零回合闲聊台词。
 * 有结构化交互历史且存在权威当前目标 → 提醒变体；否则 → 中性闲聊变体。
 * variantIndex 由调用方从结构化字段（回合数/幕次/交互条数）派生，保证确定性重放。
 */
export function composeIdleNpcLine(input: {
  readonly currentObjectiveLabel: string | null;
  readonly hasInteractionHistory: boolean;
  readonly variantIndex: number;
}): string {
  const isReminder = input.hasInteractionHistory && input.currentObjectiveLabel !== null;
  const variants = isReminder ? IDLE_REMINDER_VARIANTS : IDLE_AMBIENT_VARIANTS;
  const template = variants[Math.abs(input.variantIndex) % variants.length]!;
  return isReminder
    ? template.replaceAll("{objective}", input.currentObjectiveLabel!)
    : template;
}
