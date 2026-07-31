import {
  CONTENT_BUDGET,
  createBudgetPolicy,
  type GameTypeId,
  type EnemyTemplateCandidate,
  type ItemCategory,
  type ItemDefinitionCandidate,
  type ItemRarity,
  type ItemStatLine,
  type LocationDefinitionCandidate,
  type NpcDefinitionCandidate,
  type QuestDefinitionCandidate,
  type ScenarioBlueprintCandidate,
  type StatBlock,
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

/** fallback 模板版本；纳入 inputDigest，模板演进时提升。fallback-4：物品新增展示元数据（category / rarity / level / statLines，仅展示不进结算）。 */
export const FALLBACK_TEMPLATE_VERSION = "fallback-4";

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

  // 全部随机选择均来自 seed（不掺入 input），保证”随机源只来自 seed”。
  const rng = mulberry32(fnv1a(seed, 0x811c9dc5));
  const npcCount = CONTENT_BUDGET.coreNpcsMin + randInt(rng, 3); // 4–6
  const sideQuestCount = 1 + randInt(rng, CONTENT_BUDGET.sideQuestsMax); // 1–2

  const world = buildWorld(input, template, profile);
  const locations = buildLocations(template, profile, npcCount);
  const npcs = buildNpcs(template, profile, npcCount);
  const items = buildItems(template, profile);
  const enemies = buildEnemies(template, profile);
  const quests = buildQuests(input, template, profile, sideQuestCount, policy.mainActs);
  const endings = buildEndings(template, policy.mainActs);
  const player = buildPlayer(input, template);
  const openingScene = buildOpeningScene(input, template);

  return {
    schemaVersion: 1,
    generationId,
    seed,
    templateVersion: FALLBACK_TEMPLATE_VERSION,
    gameType: input.gameType,
    inputDigest,
    world,
    player,
    locations,
    npcs,
    quests,
    enemies,
    items,
    endings,
    openingScene,
    contentBudget: { ...CONTENT_BUDGET },
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

const LOCATION_IDS = ["loc_1", "loc_2", "loc_3", "loc_4", "loc_hidden"] as const;

// Town 层：固定把第二个主要地点标为 town（各题材模板 index 1 均为集市/商埠
// 型聚落，且是主线一阶段的 visit 目标），保证离线旅程确定性覆盖三层。
const TOWN_LOCATION_ID = LOCATION_IDS[1];

// 主线关键物品落位：与二阶段 talk_to_npc 目标 npc_3 同在 loc_3（主要地点开局
// 即解锁且互相连通，对二阶段一定可达；隐藏地点开局锁定，不可用作落位）。
const KEY_ITEM_LOCATION_ID = LOCATION_IDS[2];

/** NPC 落位：按索引映射到主要地点，隐藏地点不驻留 NPC。 */
function npcLocationId(npcIndex: number): string {
  const mainSlots = [LOCATION_IDS[0], LOCATION_IDS[1], LOCATION_IDS[2], LOCATION_IDS[3]];
  return mainSlots[npcIndex % mainSlots.length];
}

function buildLocations(
  template: TypeTemplate,
  profile: GameTypeProfile,
  npcCount: number
): LocationDefinitionCandidate[] {
  const connections: readonly string[][] = [
    ["loc_2"],
    ["loc_1", "loc_3"],
    ["loc_2", "loc_4"],
    ["loc_3", "loc_hidden"],
    ["loc_4"]
  ];
  return LOCATION_IDS.map((id, index) => {
    const npcIdsHere: string[] = [];
    for (let n = 0; n < npcCount; n += 1) {
      if (npcLocationId(n) === id) npcIdsHere.push(`npc_${n + 1}`);
    }
    return {
      id,
      name: template.locations[index].name,
      description: template.locations[index].description,
      kind: index === 4 ? ("hidden" as const) : ("main" as const),
      ...(id === TOWN_LOCATION_ID ? { scale: "town" as const } : {}),
      connectedLocationIds: connections[index],
      npcIds: npcIdsHere,
      // 初始物品（ITEM_START）不列为可取得物品；关键物品只落在唯一地点。
      availableItemIds: id === KEY_ITEM_LOCATION_ID ? [ITEM_KEY] : [],
      tags: [pickTag(profile, index)]
    };
  });
}

function buildNpcs(
  template: TypeTemplate,
  profile: GameTypeProfile,
  npcCount: number
): NpcDefinitionCandidate[] {
  const npcs: NpcDefinitionCandidate[] = [];
  for (let i = 0; i < npcCount; i += 1) {
    const source = template.npcs[i];
    // 至多一名同伴（配额 companionsMax=1）：固定第 4 名为同伴。
    const isCompanion = i === 3;
    const knownFactIds = i === 0 ? [FACT_IDENTITY] : i === 2 ? [FACT_GEN_1] : [];
    npcs.push({
      id: `npc_${i + 1}`,
      name: source.name,
      role: source.role,
      description: source.description,
      locationId: npcLocationId(i),
      isCompanion,
      knownFactIds,
      tags: [pickTag(profile, i)]
    });
  }
  return npcs;
}

const ITEM_START = "item_start";
const ITEM_KEY = "item_key";

function buildItems(template: TypeTemplate, profile: GameTypeProfile): ItemDefinitionCandidate[] {
  return [
    {
      id: ITEM_START,
      ...toItemCandidateFields(template.items[0]),
      tags: [pickTag(profile, 2)]
    },
    {
      id: ITEM_KEY,
      ...toItemCandidateFields(template.items[1]),
      tags: []
    }
  ];
}

/** 模板物品文本 → 候选字段：可选展示字段缺省时不写入键，保持序列化稳定。 */
function toItemCandidateFields(item: ItemText): Omit<ItemDefinitionCandidate, "id" | "tags"> {
  return {
    name: item.name,
    description: item.description,
    kind: item.kind,
    category: item.category,
    rarity: item.rarity,
    ...(item.level !== undefined ? { level: item.level } : {}),
    ...(item.statLines !== undefined ? { statLines: item.statLines } : {})
  };
}

const ENEMY_NORMAL_IDS = ["enemy_normal_1", "enemy_normal_2", "enemy_normal_3"] as const;
const ENEMY_BOSS_ID = "enemy_boss";

// 数值只取模板常量表；绝不解析玩家自由文本，落在 PHASE1_NUMERIC_RANGES 内。
const NORMAL_ENEMY_STATS: readonly StatBlock[] = [
  { hp: 24, attack: 5, defense: 2 },
  { hp: 30, attack: 6, defense: 3 },
  { hp: 36, attack: 7, defense: 4 }
];
// Phase 6：boss 数值调整为在玩家初始数值下存在有限 attack 胜利序列。
// 玩家 attack=6, defense=4；boss hp=20, attack=5, defense=2：
// 玩家每回合造成 max(1,6-2)=4 伤害，5 回合击杀；boss 每回合造成 max(1,5-4)=1 伤害，
// 4 回合反击共 4 伤害，玩家剩余 26 HP。满足有限胜利序列。
const BOSS_ENEMY_STATS: StatBlock = { hp: 20, attack: 5, defense: 2 };

// Phase 6：敌人预置地点。boss 放在 loc_4（stage 2 后由现有连通图可达）。
// 普通敌人分配到前三个主要地点，有落位但绝不自动暴露为 battle 行动。
const ENEMY_LOCATION_IDS: readonly string[] = [LOCATION_IDS[0], LOCATION_IDS[1], LOCATION_IDS[2]];
const BOSS_LOCATION_ID = LOCATION_IDS[3];

function buildEnemies(template: TypeTemplate, profile: GameTypeProfile): EnemyTemplateCandidate[] {
  const normals: EnemyTemplateCandidate[] = ENEMY_NORMAL_IDS.map((id, index) => ({
    id,
    name: template.normalEnemies[index],
    tier: "normal" as const,
    stats: { ...NORMAL_ENEMY_STATS[index] },
    locationId: ENEMY_LOCATION_IDS[index],
    tags: [pickTag(profile, index + 3)]
  }));
  return [
    ...normals,
    {
      id: ENEMY_BOSS_ID,
      name: template.bossEnemy,
      tier: "boss" as const,
      stats: { ...BOSS_ENEMY_STATS },
      locationId: BOSS_LOCATION_ID,
      tags: []
    }
  ];
}

const QUEST_SIDE_IDS = ["quest_s1", "quest_s2"] as const;
const ENDING_IDS = ["ending_1", "ending_2"] as const;

function mainQuestId(act: number): string {
  return `quest_main_${act}`;
}

// 中段幕 objective 轮换：引用既有实体，不引入新 ID。
const MID_OBJECTIVES: readonly (readonly { kind: string; [key: string]: string }[])[] = [
  [{ kind: "visit_location", locationId: "loc_2" }],
  [{ kind: "talk_to_npc", npcId: "npc_2" }],
  [{ kind: "discover_fact", factId: FACT_GEN_1 }]
];

function buildQuests(
  input: ValidatedNewGameInput,
  template: TypeTemplate,
  profile: GameTypeProfile,
  sideQuestCount: number,
  mainActs: number
): QuestDefinitionCandidate[] {
  const sideIds = QUEST_SIDE_IDS.slice(0, sideQuestCount);
  const quests: QuestDefinitionCandidate[] = [];

  for (let act = 1; act <= mainActs; act++) {
    const id = mainQuestId(act);
    const nextId = act < mainActs ? mainQuestId(act + 1) : null;

    if (act === 1) {
      quests.push({
        kind: "main", stage: act, id,
        name: template.mainQuests[0].name,
        description: `${input.characterName}${template.mainQuests[0].description}线索指向：${PLAYER_INPUT_MARK}${input.worldPremise}`,
        objectives: [{ kind: "visit_location", locationId: "loc_2" }],
        onSuccess: { kind: "unlock_quests", questIds: [mainQuestId(2), ...sideIds] },
        onFailure: { kind: "closed" },
        tags: [pickTag(profile, 0)]
      });
    } else if (act === mainActs) {
      quests.push({
        kind: "main", stage: act, id,
        name: template.mainQuests[2].name,
        description: template.mainQuests[2].description,
        objectives: [{ kind: "defeat_enemy", enemyId: ENEMY_BOSS_ID }],
        onSuccess: { kind: "reach_ending", endingId: ENDING_IDS[0] },
        onFailure: { kind: "reach_ending", endingId: ENDING_IDS[1] },
        tags: []
      });
    } else {
      const midIndex = (act - 2) % MID_OBJECTIVES.length;
      // 3 幕时保持旧行为：原名、原 objective（talk + obtain）
      const isLegacyMid = mainActs === 3 && act === 2;
      quests.push({
        kind: "main", stage: act, id,
        name: isLegacyMid ? template.mainQuests[1].name : `第 ${act} 章·${template.mainQuests[1].name}`,
        description: template.mainQuests[1].description,
        objectives: isLegacyMid
          ? [{ kind: "talk_to_npc", npcId: "npc_3" }, { kind: "obtain_item", itemId: ITEM_KEY }]
          : MID_OBJECTIVES[midIndex] as QuestDefinitionCandidate["objectives"],
        onSuccess: { kind: "unlock_quests", questIds: [nextId as string] },
        onFailure: { kind: "closed" },
        tags: []
      });
    }
  }

  // 支线：objective 引用真实实体；outcome 直接关闭，不影响主线可达性。
  const sideObjectives: QuestDefinitionCandidate["objectives"][] = [
    [{ kind: "discover_fact", factId: FACT_GEN_1 }],
    [{ kind: "visit_location", locationId: "loc_4" }]
  ];
  sideIds.forEach((id, index) => {
    quests.push({
      kind: "side",
      id,
      name: template.sideQuests[index].name,
      description: template.sideQuests[index].description,
      objectives: sideObjectives[index],
      onSuccess: { kind: "closed" },
      onFailure: { kind: "closed" },
      tags: []
    });
  });
  return quests;
}

function buildEndings(template: TypeTemplate, mainActs: number): ScenarioBlueprintCandidate["endings"] {
  const finalQuestId = mainQuestId(mainActs);
  return [
    {
      id: ENDING_IDS[0],
      name: template.endings[0].name,
      description: template.endings[0].description,
      requirements: [{ kind: "quest_completed", questId: finalQuestId }]
    },
    {
      id: ENDING_IDS[1],
      name: template.endings[1].name,
      description: template.endings[1].description,
      requirements: [{ kind: "quest_failed", questId: finalQuestId }]
    }
  ];
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
    startingLocationId: "loc_1",
    startingItemIds: [ITEM_START],
    // 基础数值恒取模板表，与自由文本无关。
    baseStats: { hp: 30, attack: 6, defense: 4 }
  };
}

function buildOpeningScene(
  input: ValidatedNewGameInput,
  template: TypeTemplate
): ScenarioBlueprintCandidate["openingScene"] {
  return {
    id: "scene_opening",
    locationId: "loc_1",
    // 开场叙事嵌入玩家的故事开端并带来源标记。
    narration: `${PLAYER_INPUT_MARK}${input.storyOpening}${template.openingFlavor}`,
    presentNpcIds: ["npc_1"],
    suggestedActions: [...template.sceneActions],
    // 开场可调查事实：选择生成型事实（非玩家输入宣称），玩家需主动调查才能发现。
    investigableFactIds: [FACT_GEN_1, FACT_GEN_2]
  };
}
