import {
  createBudgetPolicy,
  type GameTypeId,
  type EndingTone,
  type ItemCategory,
  type ItemRarity,
  type ItemStatLine,
  type LocationDefinitionCandidate,
  type NpcDefinitionCandidate,
  type QuestDefinitionCandidate,
  type ScenarioBlueprintCandidate,
  type ValidatedNewGameInput,
  type WorldFactCandidate
} from "@/game/domain";
import { loadScenarioProfiles, type GameTypeProfile, type ScenarioProfiles } from "./gameTypeProfiles";

// ---------------------------------------------------------------------------
// Task 6：确定性 fallback 蓝图生成器。
//
// 设计约束（见 plan / brief）：
//   - 随机源只能显式来自 `seed` 参数：本文件内实现 FNV-1a 字符串哈希 +
//     mulberry32 PRNG，全程无 Math.random / Date / 网络 / AI。
//   - `inputDigest` 覆盖影响蓝图的全部输入 + seed + templateVersion + 解析后
//     profile 的 allowedTags（tags 派生来源）；任一字段变化都会改变 digest；
//     `generationId` 由 digest+seed 派生，无 uuid/time。
//   - 内容配额固定：4 主要地点 + 1 隐藏地点、4–6 核心 NPC、三阶段主线各一、
//     1–2 短支线、3 普通敌人 + 1 Boss、2 个可达结局。
//   - 输入来源标记：世界摘要 / 玩家身份 / 开场叙事 / 主线冲突中嵌入玩家输入，
//     世界事实用 FactSource=player_input 标记来自玩家的宣称。
//   - 玩家自由文本里宣称的数值 / 神器 / 已完成事件绝不进入状态：基础数值只取
//     模板数值表，物品只来自模板，不解析自由文本。
//   - 所有实体 tags 一律取自 profile.allowedTags（校验器强制不得使用
//     forbiddenTags），因此 7 种类型均安全。
// ---------------------------------------------------------------------------

/** fallback 模板版本；纳入 inputDigest，模板演进时提升。fallback-8：Phase 14 开局收窄——仅起始锚点+序幕+结局方向。 */
export const FALLBACK_TEMPLATE_VERSION = "fallback-8";

/** 玩家输入来源标记：出现在世界摘要 / 身份 / 开场 / 主线冲突 / 事实文本中，便于追溯。 */
const PLAYER_INPUT_MARK = "【玩家输入】";

// ---------------------------------------------------------------------------
// 本地确定性哈希与 PRNG（无外部依赖）。
// ---------------------------------------------------------------------------

/** FNV-1a 32 位；以 UTF-16 code unit 遍历，中英文均产生稳定散列。 */
function fnv1a(text: string, offsetBasis: number): number {
  let hash = offsetBasis >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** 拼接两路不同 basis 的 FNV-1a，得到 16 位十六进制串，显著降低碰撞概率。 */
function hashHex(text: string): string {
  const a = fnv1a(text, 0x811c9dc5);
  const b = fnv1a(`${text}\u0001salt`, (0x811c9dc5 ^ 0x9e3779b9) >>> 0);
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}

/** mulberry32：由数值种子产出 [0,1) 均匀序列，确定且可复现。 */
function mulberry32(seedNumber: number): () => number {
  let state = seedNumber >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randInt(rng: () => number, maxExclusive: number): number {
  return Math.floor(rng() * maxExclusive);
}

// ---------------------------------------------------------------------------
// 题材内容模板：仅提供文案（名称/描述/基调），tags 一律从 profile 派生。
// ---------------------------------------------------------------------------

type EntityText = { readonly name: string; readonly description: string };
type NpcText = { readonly name: string; readonly role: string; readonly description: string };
/** 模板物品文本 + 展示元数据：展示字段只进背包界面，不参与任何规则结算。 */
type ItemText = EntityText & {
  readonly kind: string;
  readonly category: ItemCategory;
  readonly rarity: ItemRarity;
  readonly level?: number;
  readonly statLines?: readonly ItemStatLine[];
};

type TypeTemplate = {
  readonly tone: string;
  readonly themes: readonly string[];
  readonly worldFlavor: string;
  /** 5 项：前 4 为主要地点，第 5 项为隐藏地点。 */
  readonly locations: readonly EntityText[];
  /** ≥6 项，支撑 4–6 NPC 的上限。 */
  readonly npcs: readonly NpcText[];
  /** 3 个普通敌人名 + 1 个 Boss 名。 */
  readonly normalEnemies: readonly [string, string, string];
  readonly bossEnemy: string;
  /** 2 件物品：索引 0 为初始物品，索引 1 为主线关键物品。 */
  readonly items: readonly [ItemText, ItemText];
  /** 三阶段主线的名称与冲突描述片段。 */
  readonly mainQuests: readonly [EntityText, EntityText, EntityText];
  /** 至多 2 条支线。 */
  readonly sideQuests: readonly [EntityText, EntityText];
  /** 2 个结局。 */
  readonly endings: readonly [EntityText, EntityText];
  readonly openingFlavor: string;
  readonly sceneActions: readonly string[];
  /** 生成型世界事实文本。 */
  readonly generatedFacts: readonly [string, string];
};

const TEMPLATES: Readonly<Record<GameTypeId, TypeTemplate>> = {
  wuxia: {
    tone: "苍凉侠气",
    themes: ["恩怨情仇", "侠义抉择", "门派纷争"],
    worldFlavor: "刀光剑影之下，人人各怀心事，一桩旧案搅动了整片江湖。",
    locations: [
      { name: "青石镇", description: "旧案发端的边陲小镇，镇口常年贴着缉凶告示。" },
      { name: "渡口集市", description: "三教九流往来歇脚，消息在此散得最快。" },
      { name: "铁剑山庄", description: "武林世家坐镇之地，庄门深锁却暗流涌动。" },
      { name: "断魂崖", description: "传说恩怨了断之处，崖风凛冽杀机四伏。" },
      { name: "山门密道", description: "隐匿于崖壁之后的古旧密道，鲜有人知。" }
    ],
    npcs: [
      { name: "老掌柜", role: "线人", description: "镖局旧识，知道当年不少内情。" },
      { name: "渡口船娘", role: "消息贩子", description: "撑船摆渡，听尽南来北往的风声。" },
      { name: "铁剑庄主", role: "盟友", description: "武林世家之主，正为家门声誉所困。" },
      { name: "游方郎中", role: "同伴", description: "行走江湖的郎中，愿随主角查明真相。" },
      { name: "说书先生", role: "线人", description: "茶楼说书，编排的段子里藏着旧事。" },
      { name: "巡城捕头", role: "官府", description: "衙门捕头，公务之外亦有私心。" }
    ],
    normalEnemies: ["黑衣刺客", "山道劫匪", "门派死士"],
    bossEnemy: "幕后黑手",
    items: [
      {
        name: "护身短刀", description: "随身旧刀，伴主角走过风霜。", kind: "weapon",
        category: "equipment", rarity: "fine", level: 2,
        statLines: [
          { label: "攻击力", value: "+6" },
          { label: "身法", value: "+3%" }
        ]
      },
      {
        name: "镖局信物", description: "证明当年身份的关键信物。", kind: "key",
        category: "quest", rarity: "rare"
      }
    ],
    mainQuests: [
      { name: "旧案重启", description: "循着告示追查灭门旧案的头绪。" },
      { name: "山庄求证", description: "深入铁剑山庄求证并取回关键信物。" },
      { name: "断魂决战", description: "在断魂崖直面幕后黑手，了结恩怨。" }
    ],
    sideQuests: [
      { name: "密道传闻", description: "查证山门密道的古老传闻。" },
      { name: "崖畔巡踪", description: "沿断魂崖搜寻残留的蛛丝马迹。" }
    ],
    endings: [
      { name: "沉冤得雪", description: "真相大白，旧案昭雪，江湖重归安宁。" },
      { name: "遁入山门", description: "复仇未竟，主角借密道悄然远走。" }
    ],
    openingFlavor: "旧刀在鞘中低鸣，一段江湖往事就此揭开。",
    sceneActions: ["打听旧案线索", "查看告示细节", "寻访当年旧识"],
    generatedFacts: ["山门密道尽头似另有出口，去向成谜。", "近来常有黑衣人在镇外徘徊。"]
  },
  science_fiction: {
    tone: "冷峻悬疑",
    themes: ["技术伦理", "殖民博弈", "真相追索"],
    worldFlavor: "在可推演的科技秩序之下，失联船队的谜团正牵动整条航线。",
    locations: [
      { name: "曙光空间站", description: "航线枢纽站，往来货船在此补给中转。" },
      { name: "环带货运港", description: "货运集散的港区，暗面规矩自成一套。" },
      { name: "殖民地穹顶城", description: "穹顶之下的殖民都市，议会与企业角力。" },
      { name: "静默号残骸", description: "漂浮在轨道上的失事货船残骸。" },
      { name: "废弃AI机房", description: "早被封存的旧式AI机房，仍有余电闪烁。" }
    ],
    npcs: [
      { name: "站务调度员", role: "线人", description: "掌握进出港记录，愿意透露些许内情。" },
      { name: "港区走私客", role: "消息贩子", description: "在灰色航道上讨生活，消息灵通。" },
      { name: "殖民地议员", role: "盟友", description: "力主彻查失联事件的殖民地代表。" },
      { name: "义体医师", role: "同伴", description: "改造技术精湛，愿随主角深入调查。" },
      { name: "老领航员", role: "线人", description: "跑过无数航线的退役领航员。" },
      { name: "巡查安保官", role: "官方", description: "港区治安官，职责与压力并存。" }
    ],
    normalEnemies: ["治安巡逻无人机", "走私团打手", "失控工程机甲"],
    bossEnemy: "叛逃AI核心",
    items: [
      {
        name: "领航员终端", description: "随身终端，存有旧航线数据。", kind: "gear",
        category: "equipment", rarity: "fine", level: 2,
        statLines: [
          { label: "数据解析", value: "+8%" },
          { label: "导航精度", value: "+5%" }
        ]
      },
      {
        name: "加密数据核心", description: "封存失联真相的加密核心。", kind: "key",
        category: "quest", rarity: "rare"
      }
    ],
    mainQuests: [
      { name: "失联溯源", description: "从港区记录追查船队失联的起点。" },
      { name: "残骸取证", description: "潜入静默号残骸取回加密数据核心。" },
      { name: "核心对峙", description: "在废弃机房与叛逃AI核心正面对峙。" }
    ],
    sideQuests: [
      { name: "旧机房传闻", description: "核实废弃AI机房仍在运转的传闻。" },
      { name: "航道巡查", description: "沿环带航道排查异常信号。" }
    ],
    endings: [
      { name: "真相曝光", description: "失联真相公之于众，秩序得以重整。" },
      { name: "隐入星海", description: "调查受阻，主角带着秘密隐入星海。" }
    ],
    openingFlavor: "终端幽光映着舷窗，一场跨越航线的追查开始了。",
    sceneActions: ["调阅进出港记录", "解析加密讯息", "联系可靠线人"],
    generatedFacts: ["废弃机房仍在低功耗运行，来源不明。", "近期多艘货船的航迹被人为抹除。"]
  },
  urban: {
    tone: "写实冷静",
    themes: ["商战博弈", "悬疑调查", "职业操守"],
    worldFlavor: "在当代城市的规则之内，一笔消失的资金串起了层层内幕。",
    locations: [
      { name: "报社编辑部", description: "深夜仍亮着灯的编辑部，线索从这里出发。" },
      { name: "滨江金融城", description: "玻璃幕墙林立的金融核心区。" },
      { name: "老城巷口咖啡馆", description: "闹市一隅的咖啡馆，谈话不易被打扰。" },
      { name: "城郊仓库", description: "记录着可疑资金流向的偏僻仓库。" },
      { name: "地下停车场档案室", description: "藏在停车场深处的临时档案室。" }
    ],
    npcs: [
      { name: "报社主编", role: "线人", description: "老练的主编，为报道尺度反复权衡。" },
      { name: "咖啡馆老板", role: "消息贩子", description: "见多识广，认得城里各色人物。" },
      { name: "投行合伙人", role: "盟友", description: "熟悉并购内情，暗中提供帮助。" },
      { name: "律师朋友", role: "同伴", description: "多年好友，愿在法律边界内相助。" },
      { name: "退休老刑警", role: "线人", description: "退休多年仍保留着办案直觉。" },
      { name: "便衣警探", role: "官方", description: "正在侦办相关案件的警方人员。" }
    ],
    normalEnemies: ["私人保镖", "收账打手", "神秘跟踪者"],
    bossEnemy: "幕后操盘人",
    items: [
      {
        name: "记者证", description: "随身证件，是采访调查的通行凭据。", kind: "gear",
        category: "equipment", rarity: "common", level: 1,
        statLines: [
          { label: "调查效率", value: "+5%" },
          { label: "人脉", value: "+3" }
        ]
      },
      {
        name: "审计底稿", description: "揭示资金去向的关键审计底稿。", kind: "key",
        category: "quest", rarity: "rare"
      }
    ],
    mainQuests: [
      { name: "匿名线索", description: "顺着匿名邮件核实资金异动的线索。" },
      { name: "仓库取证", description: "潜入城郊仓库取回关键审计底稿。" },
      { name: "对簿真相", description: "在档案室与幕后操盘人当面摊牌。" }
    ],
    sideQuests: [
      { name: "档案疑云", description: "核实地下档案室的可疑传闻。" },
      { name: "街角摸排", description: "在金融城周边摸排相关人证。" }
    ],
    endings: [
      { name: "真相见报", description: "调查成稿见报，黑幕曝光于众。" },
      { name: "悄然收手", description: "压力之下选择收手，真相暂被掩埋。" }
    ],
    openingFlavor: "屏幕微光映着倦容，一场深夜调查悄然启动。",
    sceneActions: ["核实匿名邮件", "梳理资金线索", "约见可靠信源"],
    generatedFacts: ["地下档案室近期频繁有人出入。", "一笔资金在并购完成前被悄然转移。"]
  },
  xianxia: {
    tone: "缥缈玄奇",
    themes: ["修行问道", "宗门恩怨", "天道抉择"],
    worldFlavor: "灵气流转的天地间，一段被封印的秘辛正待有缘人揭开。",
    locations: [
      { name: "青云外门", description: "修士入门之地，剑气与钟声交织。" },
      { name: "坊市集镇", description: "散修往来的坊市，法宝丹药皆可易货。" },
      { name: "碧游宗殿", description: "名门大宗的正殿，规矩森严。" },
      { name: "落魂古渊", description: "灵气紊乱的古老深渊，凶险异常。" },
      { name: "隐脉洞天", description: "藏于灵脉深处的洞天，鲜为人知。" }
    ],
    npcs: [
      { name: "守山执事", role: "线人", description: "外门执事，熟知山门旧事。" },
      { name: "坊市散修", role: "消息贩子", description: "游走坊市，消息驳杂。" },
      { name: "碧游长老", role: "盟友", description: "宗门长老，有意彻查秘辛。" },
      { name: "同门师妹", role: "同伴", description: "一同修行的师妹，愿随行历练。" },
      { name: "云游道人", role: "线人", description: "行踪不定的云游道人。" },
      { name: "巡山戒律", role: "官方", description: "掌戒律的巡山弟子。" }
    ],
    normalEnemies: ["炼气邪修", "护山灵兽", "宗门叛徒"],
    bossEnemy: "夺舍魔头",
    items: [
      {
        name: "养气玉符", description: "随身玉符，护持心神。", kind: "talisman",
        category: "equipment", rarity: "fine", level: 2,
        statLines: [
          { label: "心神防护", value: "+6" },
          { label: "灵气亲和", value: "+4%" }
        ]
      },
      {
        name: "残卷秘录", description: "记载封印秘辛的残卷。", kind: "key",
        category: "quest", rarity: "rare"
      }
    ],
    mainQuests: [
      { name: "秘辛初现", description: "从山门旧事中察觉被封印的秘辛。" },
      { name: "古渊寻踪", description: "深入落魂古渊取回残卷秘录。" },
      { name: "洞天了断", description: "在隐脉洞天与夺舍魔头一决生死。" }
    ],
    sideQuests: [
      { name: "灵脉异动", description: "查探隐脉洞天的灵气异动。" },
      { name: "坊市传言", description: "核实坊市流传的秘辛传言。" }
    ],
    endings: [
      { name: "证道封魔", description: "秘辛得解，魔头授首，宗门重归清明。" },
      { name: "遁隐灵脉", description: "道行未足，主角循灵脉隐世潜修。" }
    ],
    openingFlavor: "灵光在指尖流转，一段问道之旅由此展开。",
    sceneActions: ["探听山门旧事", "研读残卷线索", "寻访云游前辈"],
    generatedFacts: ["隐脉洞天的封印近来出现松动。", "古渊深处的灵气紊乱另有源头。"]
  },
  fantasy: {
    tone: "壮阔奇幻",
    themes: ["王国纷争", "古老遗祸", "英雄抉择"],
    worldFlavor: "剑与魔法的国度里，一段沉睡的祸患正悄然苏醒。",
    locations: [
      { name: "银瀑城", description: "王国边境的要塞之城，商旅云集。" },
      { name: "佣兵集市", description: "各族佣兵接单歇脚的喧闹集市。" },
      { name: "白鹰议会厅", description: "骑士团议事之所，纹章高悬。" },
      { name: "灰烬遗迹", description: "古战场留下的魔能遗迹，危机四伏。" },
      { name: "地脉密窟", description: "深藏地脉的隐秘洞窟，封印所在。" }
    ],
    npcs: [
      { name: "城门守卫", role: "线人", description: "值守城门，知晓往来风声。" },
      { name: "佣兵掮客", role: "消息贩子", description: "为佣兵牵线，消息灵通。" },
      { name: "白鹰骑士", role: "盟友", description: "正直的骑士，有意查清遗祸。" },
      { name: "精灵游侠", role: "同伴", description: "沉静的游侠，愿与主角同行。" },
      { name: "云游吟游诗人", role: "线人", description: "四处游历的吟游诗人。" },
      { name: "议会执事", role: "官方", description: "掌管议会文书的执事。" }
    ],
    normalEnemies: ["劫掠强盗", "遗迹魔像", "堕落骑士"],
    bossEnemy: "苏醒的古祸",
    items: [
      {
        name: "旅人短剑", description: "随身佩剑，陪伴征途。", kind: "weapon",
        category: "equipment", rarity: "fine", level: 2,
        statLines: [
          { label: "攻击力", value: "+6" },
          { label: "挥砍速度", value: "+4%" }
        ]
      },
      {
        name: "封印纹石", description: "维系古老封印的纹石。", kind: "key",
        category: "quest", rarity: "rare"
      }
    ],
    mainQuests: [
      { name: "遗祸初醒", description: "循边境异象追查古老遗祸的源头。" },
      { name: "遗迹寻石", description: "深入灰烬遗迹取回封印纹石。" },
      { name: "地脉决战", description: "在地脉密窟阻止古祸彻底苏醒。" }
    ],
    sideQuests: [
      { name: "密窟传说", description: "查证地脉密窟的古老传说。" },
      { name: "边境巡防", description: "协助巡查银瀑城周边的异动。" }
    ],
    endings: [
      { name: "封印重铸", description: "古祸重归沉眠，王国转危为安。" },
      { name: "退守边城", description: "力有未逮，主角退守边城再图后计。" }
    ],
    openingFlavor: "佩剑轻响，一段跨越王国的征程就此启程。",
    sceneActions: ["探听边境异象", "追查封印线索", "寻访骑士盟友"],
    generatedFacts: ["地脉密窟的封印纹石正在黯淡。", "灰烬遗迹近来魔能潮汐异常。"]
  },
  alternate_history: {
    tone: "凝重权谋",
    themes: ["朝堂博弈", "边关战事", "变法抉择"],
    worldFlavor: "在与史书分岔的时局里，一桩粮道悬案牵动了朝野格局。",
    locations: [
      { name: "临安府衙", description: "地方府衙，公文往来皆有玄机。" },
      { name: "运河商埠", description: "南北通衢的商埠，人货杂沓。" },
      { name: "枢密官署", description: "掌兵机要务的官署，戒备森严。" },
      { name: "朔方边关", description: "战事吃紧的边关要塞。" },
      { name: "废驿暗仓", description: "废弃驿站下的隐秘暗仓。" }
    ],
    npcs: [
      { name: "府衙书吏", role: "线人", description: "抄录公文的书吏，知晓案牍内情。" },
      { name: "商埠牙人", role: "消息贩子", description: "撮合买卖的牙人，耳目众多。" },
      { name: "枢密副使", role: "盟友", description: "力主查案的枢密副使。" },
      { name: "随行幕僚", role: "同伴", description: "足智多谋的幕僚，随主角奔走。" },
      { name: "退隐老将", role: "线人", description: "解甲多年的老将，熟知边事。" },
      { name: "巡按御史", role: "官方", description: "奉旨巡按的御史。" }
    ],
    normalEnemies: ["私盐死士", "边地马匪", "叛军斥候"],
    bossEnemy: "通敌权臣",
    items: [
      {
        name: "随身佩刀", description: "护身佩刀，久经风霜。", kind: "weapon",
        category: "equipment", rarity: "fine", level: 2,
        statLines: [
          { label: "攻击力", value: "+6" },
          { label: "破甲", value: "+2" }
        ]
      },
      {
        name: "粮道密档", description: "记载粮道内情的关键密档。", kind: "key",
        category: "quest", rarity: "rare"
      }
    ],
    mainQuests: [
      { name: "粮道悬案", description: "从府衙案牍追查粮道被劫的悬案。" },
      { name: "暗仓取档", description: "潜入废驿暗仓取回粮道密档。" },
      { name: "边关摊牌", description: "在朔方边关揭穿通敌权臣的图谋。" }
    ],
    sideQuests: [
      { name: "暗仓风声", description: "核实废驿暗仓的可疑风声。" },
      { name: "商埠查踪", description: "在运河商埠追查涉案人证。" }
    ],
    endings: [
      { name: "肃清奸佞", description: "奸佞伏法，粮道重启，边关转安。" },
      { name: "隐忍待时", description: "时机未至，主角隐忍蓄势以待将来。" }
    ],
    openingFlavor: "案牍墨迹未干，一场朝野博弈缓缓拉开。",
    sceneActions: ["查阅府衙案牍", "追查密档线索", "结交朝中盟友"],
    generatedFacts: ["废驿暗仓近来夜有车马进出。", "粮道被劫前有官文被人抽换。"]
  },
  post_apocalypse: {
    tone: "荒芜冷硬",
    themes: ["资源争夺", "人性考验", "秩序重建"],
    worldFlavor: "文明崩塌后的废土上，一处水源的秘密关乎聚落存亡。",
    locations: [
      { name: "水塔镇", description: "依水塔而建的幸存者聚落。" },
      { name: "高架桥集市", description: "废墟高架下的以物易物集市。" },
      { name: "旧城避难所", description: "旧世界遗留的地下避难所。" },
      { name: "辐射废区", description: "变异横行的高辐射废弃城区。" },
      { name: "地下水脉室", description: "隐匿于废墟下的地下水脉控制室。" }
    ],
    npcs: [
      { name: "镇口哨兵", role: "线人", description: "看守镇口，熟悉周边动静。" },
      { name: "集市拾荒商", role: "消息贩子", description: "倒卖废料，消息驳杂。" },
      { name: "避难所管理员", role: "盟友", description: "维系避难所秩序，力主查明真相。" },
      { name: "流浪机械师", role: "同伴", description: "拼装废料的机械师，愿随主角上路。" },
      { name: "老拾荒者", role: "线人", description: "在废土上讨活多年的老手。" },
      { name: "巡逻队长", role: "官方", description: "聚落巡逻队的队长。" }
    ],
    normalEnemies: ["废土劫掠者", "变异走兽", "叛离幸存者"],
    bossEnemy: "水源霸主",
    items: [
      {
        name: "简易护具", description: "拼装的随身护具，聊胜于无。", kind: "gear",
        category: "equipment", rarity: "common", level: 1,
        statLines: [
          { label: "防御力", value: "+5" },
          { label: "耐久", value: "+3" }
        ]
      },
      {
        name: "水脉图纸", description: "标注地下水脉的关键图纸。", kind: "key",
        category: "quest", rarity: "rare"
      }
    ],
    mainQuests: [
      { name: "断水危机", description: "追查聚落供水骤减背后的缘由。" },
      { name: "废区取图", description: "深入辐射废区取回水脉图纸。" },
      { name: "水脉夺控", description: "在地下水脉室夺回被霸占的水源控制。" }
    ],
    sideQuests: [
      { name: "水脉传闻", description: "核实地下水脉室的可疑传闻。" },
      { name: "废墟清点", description: "在高架桥集市清点可疑物资。" }
    ],
    endings: [
      { name: "重掌水源", description: "水源重归聚落，秩序艰难重建。" },
      { name: "另寻活路", description: "夺控失败，主角带众另寻活路。" }
    ],
    openingFlavor: "干渴的风卷过废墟，一场关乎存亡的奔走开始了。",
    sceneActions: ["打听供水异常", "追查水脉线索", "联络可靠伙伴"],
    generatedFacts: ["地下水脉室近来被不明势力把持。", "废区深处的辐射读数出现异常波动。"]
  }
};

// ---------------------------------------------------------------------------
// tag 派生：一律从 profile.allowedTags 取值，保证 ⊆ allowedTags。
// ---------------------------------------------------------------------------

/** 取 allowedTags 中第 index 个（循环），列表非空由配置加载器保证。 */
function pickTag(profile: GameTypeProfile, index: number): string {
  const tags = profile.allowedTags;
  return tags[index % tags.length];
}

// ---------------------------------------------------------------------------
// 生成器主体。
// ---------------------------------------------------------------------------

export type CreateFallbackBlueprintOptions = {
  /** 可注入 profiles bundle 以便测试；默认调用 loadScenarioProfiles()。 */
  readonly profiles?: ScenarioProfiles;
};

export function createFallbackBlueprint(
  input: ValidatedNewGameInput,
  seed: string,
  options: CreateFallbackBlueprintOptions = {}
): ScenarioBlueprintCandidate {
  const profiles = options.profiles ?? loadScenarioProfiles();
  const profile = profiles.gameTypeProfiles[input.gameType];
  const template = TEMPLATES[input.gameType];

  const inputDigest = computeInputDigest(input, seed, profile);
  const generationId = `gen-${hashHex(`${inputDigest}|${seed}`)}`;
  const policy = createBudgetPolicy(input.gameLength);

  // Phase 14 开局收窄：仅生成起始锚点（1 地点 + 1 NPC + 1 任务）+ 序幕 + 结局方向。
  // 其余内容（更多地点/NPC/任务/物品/敌人/结局）由运行时 AI 导演懒生成。
  const world = buildWorld(input, template, profile);
  const startLocation = buildStartLocation(template, profile);
  const startNpc = buildStartNpc(template, profile);
  const startQuest = buildStartQuest(input, template, profile);
  const player = buildPlayer(input, template);
  const openingScene = buildOpeningScene(input, template, input.gameType);
  const startAnchor = buildStartAnchor();
  const endingDirection = buildEndingDirection(template, policy.mainActs);

  return {
    schemaVersion: 2,
    generationId,
    seed,
    templateVersion: FALLBACK_TEMPLATE_VERSION,
    gameType: input.gameType,
    inputDigest,
    world,
    player,
    startAnchor,
    endingDirection,
    locations: [startLocation],
    npcs: [startNpc],
    quests: [startQuest],
    enemies: [],
    items: [],
    endings: [],
    openingScene,
    budgetPolicy: policy
  };
}

// ---------------------------------------------------------------------------
// inputDigest：覆盖影响蓝图的全部输入 + seed + templateVersion + profile 内容。
// ---------------------------------------------------------------------------

function computeInputDigest(
  input: ValidatedNewGameInput,
  seed: string,
  profile: GameTypeProfile
): string {
  // 固定 key 顺序的规范化序列化；undefined 的 characterProfile 归一为 null，
  // 与“有 profile”明确区分。personalityTags 保留规范化后的顺序。
  // profileAllowedTags：解析后 profile 中影响蓝图的内容（全部 tags 由它派生），
  // 无论来自注入还是默认配置，内容漂移必然翻转 digest（fixture pin 会显式报错）。
  const source = JSON.stringify({
    gameType: input.gameType,
    gameLength: input.gameLength,
    characterName: input.characterName,
    characterIdentity: input.characterIdentity,
    characterProfile: input.characterProfile ?? null,
    personalityTags: input.personalityTags,
    worldPremise: input.worldPremise,
    storyOpening: input.storyOpening,
    narrativeStyle: input.narrativeStyle,
    contentIntensity: input.contentIntensity,
    seed,
    templateVersion: FALLBACK_TEMPLATE_VERSION,
    profileAllowedTags: profile.allowedTags
  });
  return hashHex(source);
}

// ---------------------------------------------------------------------------
// 各子结构构造器。
// ---------------------------------------------------------------------------

const FACT_PREMISE = "fact_premise";
const FACT_IDENTITY = "fact_identity";
const FACT_GEN_1 = "fact_gen_1";
const FACT_GEN_2 = "fact_gen_2";

function buildWorld(
  input: ValidatedNewGameInput,
  template: TypeTemplate,
  profile: GameTypeProfile
): ScenarioBlueprintCandidate["world"] {
  const facts: WorldFactCandidate[] = [
    // 玩家宣称：以 player_input 标记来源，初始即视为已知（compile 时据此设 discovered）。
    { id: FACT_PREMISE, text: `${PLAYER_INPUT_MARK}世界背景：${input.worldPremise}`, source: "player_input" },
    {
      id: FACT_IDENTITY,
      text: `${PLAYER_INPUT_MARK}${input.characterName}自述身份：${input.characterIdentity}`,
      source: "player_input"
    },
    // 生成补全：待玩法探索揭示。
    { id: FACT_GEN_1, text: template.generatedFacts[0], source: "generated" },
    { id: FACT_GEN_2, text: template.generatedFacts[1], source: "generated" }
  ];
  return {
    summary: `${PLAYER_INPUT_MARK}${input.worldPremise}${template.worldFlavor}`,
    tone: template.tone,
    themes: [...template.themes],
    facts,
    tags: [pickTag(profile, 0), pickTag(profile, 1)]
  };
}

// Phase 14：起始锚点固定 ID——开局仅 1 地点 / 1 NPC / 1 任务。
const START_LOCATION_ID = "loc_1";
const START_NPC_ID = "npc_1";
const START_QUEST_ID = "quest_main_1";

/** 题材 → 序幕基调映射：序幕 tone 影响 visual 风格，由模板基调派生。 */
const PROLOGUE_TONES: Readonly<Record<GameTypeId, "serious" | "epic" | "mysterious">> = {
  wuxia: "serious",
  science_fiction: "mysterious",
  urban: "serious",
  xianxia: "mysterious",
  fantasy: "epic",
  alternate_history: "serious",
  post_apocalypse: "serious"
};

/** Phase 14：开局起始地点——仅 1 个主要地点，无连接、无可用物品。 */
function buildStartLocation(
  template: TypeTemplate,
  profile: GameTypeProfile
): LocationDefinitionCandidate {
  return {
    id: START_LOCATION_ID,
    name: template.locations[0].name,
    description: template.locations[0].description,
    kind: "main",
    connectedLocationIds: [],
    npcIds: [START_NPC_ID],
    availableItemIds: [],
    tags: [pickTag(profile, 0)]
  };
}

/** Phase 14：开局起始 NPC——仅 1 个，驻留在起始地点，知晓玩家身份事实。 */
function buildStartNpc(
  template: TypeTemplate,
  profile: GameTypeProfile
): NpcDefinitionCandidate {
  return {
    id: START_NPC_ID,
    name: template.npcs[0].name,
    role: template.npcs[0].role,
    description: template.npcs[0].description,
    locationId: START_LOCATION_ID,
    isCompanion: false,
    knownFactIds: [FACT_IDENTITY],
    tags: [pickTag(profile, 0)]
  };
}

/** Phase 14：开局起始任务——仅 stage 1，目标为与起始 NPC 交谈，直接关闭。 */
function buildStartQuest(
  input: ValidatedNewGameInput,
  template: TypeTemplate,
  profile: GameTypeProfile
): QuestDefinitionCandidate {
  return {
    kind: "main",
    stage: 1,
    id: START_QUEST_ID,
    name: template.mainQuests[0].name,
    description: `第 1 幕：${input.characterName}${template.mainQuests[0].description}线索指向：${PLAYER_INPUT_MARK}${input.worldPremise}`,
    objectives: [{ kind: "talk_to_npc", npcId: START_NPC_ID }],
    onSuccess: { kind: "closed" },
    onFailure: { kind: "closed" },
    tags: [pickTag(profile, 0)]
  };
}

/** Phase 14：起始锚点——指向起始地点 / NPC / 任务，运行时只读。 */
function buildStartAnchor(): ScenarioBlueprintCandidate["startAnchor"] {
  return {
    locationId: START_LOCATION_ID,
    npcId: START_NPC_ID,
    startQuestId: START_QUEST_ID
  };
}

/** Phase 14：结局方向骨架——题材主题 + 全部可能基调。lockedAt 取主线幕数过半值
 *  （Math.ceil(mainActs / 2)），符合 spec 结局推演机制"主线推进到关键节点（过半）"，
 *  与 sqliteGameRepository.withEndingDirectionDefault 迁移路径保持一致。 */
function buildEndingDirection(
  template: TypeTemplate,
  mainActs: number
): ScenarioBlueprintCandidate["endingDirection"] {
  const allTones: readonly EndingTone[] = ["triumph", "tragedy", "bittersweet", "ambiguous"];
  return {
    theme: template.themes[0],
    possibleTones: [...allTones],
    lockedAt: Math.ceil(mainActs / 2)
  };
}

function buildPlayer(
  input: ValidatedNewGameInput,
  template: TypeTemplate
): ScenarioBlueprintCandidate["player"] {
  const profileText = input.characterProfile !== undefined ? input.characterProfile : "";
  return {
    name: input.characterName,
    identity: input.characterIdentity,
    // 身份解释来自玩家输入并带来源标记；不采信文本中的数值/神器/功绩宣称。
    backgroundSummary: `${PLAYER_INPUT_MARK}身为${input.characterIdentity}，${input.characterName}${profileText}${template.openingFlavor}`,
    startingLocationId: START_LOCATION_ID,
    // Phase 14：开局无物品——起始物品由运行时 AI 导演懒生成。
    startingItemIds: [],
    // 基础数值恒取模板表，与自由文本无关。
    baseStats: { hp: 30, attack: 6, defense: 4 }
  };
}

/** Phase 14：开场场景含序幕（黑底白字开场），tone 由题材派生。 */
function buildOpeningScene(
  input: ValidatedNewGameInput,
  template: TypeTemplate,
  gameType: GameTypeId
): ScenarioBlueprintCandidate["openingScene"] {
  return {
    id: "scene_opening",
    locationId: START_LOCATION_ID,
    // 开场叙事嵌入玩家的故事开端并带来源标记。
    narration: `${PLAYER_INPUT_MARK}${input.storyOpening}${template.openingFlavor}`,
    presentNpcIds: [START_NPC_ID],
    suggestedActions: [...template.sceneActions],
    // 开场可调查事实：选择生成型事实（非玩家输入宣称），玩家需主动调查才能发现。
    investigableFactIds: [FACT_GEN_1, FACT_GEN_2],
    // Phase 14：序幕正文——结合世界前提与题材风格，一次性生成；玩家输入带来源标记。
    prologue: {
      text: `${PLAYER_INPUT_MARK}${input.worldPremise}${template.worldFlavor}`,
      tone: PROLOGUE_TONES[gameType]
    }
  };
}
