"use client";

import { useState, type CSSProperties, type FormEvent } from "react";
import Image from "next/image";
import { InlineButton, Panel, Tag } from "@ai-game/ui";
import {
  validateNewGameInput,
  type NewGameInput,
  type NewGameInputError,
  type GameSessionView,
  type GenerationSource
} from "@/game/application";
import { AdventureVisual, ADVENTURE_THEMES } from "./adventureVisuals";

// ---------------------------------------------------------------------------
// 新开局表单（Task 4 + 界面重构）：受控表单，提交时真实调用 POST /api/game。
// 客户端先用 application facade 转发的 validateNewGameInput 预校验（server 会重新校验），
// 通过后只提交 NewGameInput 允许的字段——seed/gameId/生成来源无从伪造。
// loading 期间禁用提交防止重复请求，状态经 aria-live 区域反馈。
//
// 单页双栏重构：左侧"预览舞台"实时呈现当前开局（角色卡 + 世界 + 开端），
// 右侧为编辑区。选中游戏类型时整套页面配色随该题材的 ADVENTURE_THEMES 切换，
// 玩家在点选瞬间即进入对应世界。纯呈现层改动，不触碰任何表单逻辑或校验规则。
// ---------------------------------------------------------------------------

const GAME_TYPES = [
  { id: "wuxia", label: "武侠", hint: "江湖、门派与朝堂" },
  { id: "xianxia", label: "仙侠", hint: "宗门、修行与异兽" },
  { id: "fantasy", label: "奇幻", hint: "王国、魔法与遗迹" },
  { id: "science_fiction", label: "科幻", hint: "星际、赛博与未来都市" },
  { id: "urban", label: "都市", hint: "当代城市与组织冲突" },
  { id: "alternate_history", label: "历史架空", hint: "类历史制度与权谋" },
  { id: "post_apocalypse", label: "末日", hint: "灾变、废土与生存" },
] as const satisfies readonly {
  id: NewGameInput["gameType"];
  label: string;
  hint: string;
}[];

/**
 * 每个游戏类型配套的示例开局：选择类型时整体预填"02 / 主角"与"03 / 世界与开端"，
 * 玩家可随时点击修改，提交以实际编辑内容为准。文本长度满足表单校验规则。
 */
type GameTypePreset = {
  characterName: string;
  characterIdentity: string;
  characterProfile: string;
  worldPremise: string;
  storyOpening: string;
};

const GAME_TYPE_PRESETS: Record<NewGameInput["gameType"], GameTypePreset> = {
  wuxia: {
    characterName: "沈青崖",
    characterIdentity: "落魄镖师",
    characterProfile: "青崖镖局独子，镖局一夜覆灭后流落江湖，靠押送散货为生。",
    worldPremise: "镖局一夜覆灭，江湖各派暗流涌动，真凶身份成谜，官府与门派各怀心思。",
    storyOpening: "暮色四合，主角背着旧刀走进青石镇，镇口贴着一张字迹潦草的缉凶告示。"
  },
  xianxia: {
    characterName: "云澈",
    characterIdentity: "被逐出山门的记名弟子",
    characterProfile: "曾是天枢宗记名弟子，因偷学禁术被逐出山门，身负一缕残缺的先天剑气，性情孤僻。",
    worldPremise: "灵气潮汐百年一衰，修仙界各大宗门为争夺最后的飞升机缘明争暗斗，上古遗迹陆续苏醒。",
    storyOpening: "主角在荒山破庙醒来，掌心多出一道燃烧的符文，而追杀他的宗门执法长老已踏剑而至。"
  },
  fantasy: {
    characterName: "凯尔",
    characterIdentity: "边陲村落的见习猎魔人",
    characterProfile: "自幼在边陲村落长大，只会几手粗浅的剑术，祖父留下的旧银钉与兽皮书是仅有的家当。",
    worldPremise: "王国边境的魔法潮汐正在崩解，古遗迹中苏醒的异族越过灰烬山脉，法师塔与王室互相猜忌。",
    storyOpening: "守夜时，主角看见村外麦田一夜之间枯萎成灰，田中央立着一根刻满符文的黑色石柱。"
  },
  science_fiction: {
    characterName: "林渡",
    characterIdentity: "失踪航站的维修员",
    characterProfile: "曾是环带航站的高级维修员，事故后身份记录被清除，熟悉每一段走私航道的暗门。",
    worldPremise: "人类城市依靠一座不断删除居民记忆的轨道电梯维持能源。",
    storyOpening: "我在停运十年的站台收到了一张写着自己名字的返程票。"
  },
  urban: {
    characterName: "林之遥",
    characterIdentity: "财经记者",
    characterProfile: "跑了五年财经口，写过两篇让上市公司股价跳水的深度报道。",
    worldPremise: "滨江金融城连环并购案背后，一笔离奇消失的资金牵动着各方神经。",
    storyOpening: "深夜的编辑部只剩一盏灯，主角收到一封匿名邮件，附件是半份审计底稿。"
  },
  alternate_history: {
    characterName: "顾明远",
    characterIdentity: "大理寺书吏",
    characterProfile: "寒门出身的大理寺书吏，精通律令条文，因整理卷宗无意间发现一桩牵连朝堂的旧案。",
    worldPremise: "朝廷与藩王剑拔弩张，漕运税银连年短缺，一封密奏牵出盘踞朝野数十年的权贵网。",
    storyOpening: "主角在誊抄卷宗时发现一张夹在旧档里的名册，上面的名字竟牵涉当朝首辅。"
  },
  post_apocalypse: {
    characterName: "周临",
    characterIdentity: "废土补给车队司机",
    characterProfile: "灾变后在废土长大，驾驶技术娴熟，熟悉每条辐射区的安全路线，靠运送补给为生。",
    worldPremise: "大灾变后地表被灰烬与辐射覆盖，幸存者聚居于破败城邦，净水与燃料成为硬通货。",
    storyOpening: "主角开车驶入空荡的旧城寻找燃料，电台里突然传来一段重复了三十年的求救信号。"
  }
};

/** 首次渲染与默认展示使用的游戏类型；其预设会预填主角与世界开端字段。 */
const DEFAULT_GAME_TYPE = "wuxia" as const;
const DEFAULT_PRESET = GAME_TYPE_PRESETS[DEFAULT_GAME_TYPE];

/** 每个题材对应的本地背景图路径（游戏开始配置页的题材选择卡片用）。 */
const GAME_TYPE_BACKGROUNDS: Record<NewGameInput["gameType"], string> = {
  wuxia: "/assets/genres/wuxia.jpg",
  xianxia: "/assets/genres/xianxia.jpg",
  fantasy: "/assets/genres/fantasy.jpg",
  science_fiction: "/assets/genres/science_fiction.jpg",
  urban: "/assets/genres/urban.jpg",
  alternate_history: "/assets/genres/alternate_history.jpg",
  post_apocalypse: "/assets/genres/post_apocalypse.jpg"
};

type SegmentOption<T extends string> = { value: T; label: string; hint: string };

/** 表单内两个枚举字段的收窄类型：NewGameInput 中 gameLength 可选，剔除 undefined。 */
type NarrativeStyleValue = NonNullable<NewGameInput["narrativeStyle"]>;
type GameLengthValue = NonNullable<NewGameInput["gameLength"]>;

/** 叙事风格分段选项：并排平铺，替代下拉框。 */
const NARRATIVE_STYLE_OPTIONS: readonly SegmentOption<NarrativeStyleValue>[] = [
  { value: "concise", label: "简洁", hint: "短句直给" },
  { value: "novel", label: "小说化", hint: "铺陈细腻" },
  { value: "cinematic", label: "电影化", hint: "画面感强" }
] as const satisfies readonly SegmentOption<NarrativeStyleValue>[];

/** 游戏时长分段选项：并排平铺，替代下拉框。 */
const GAME_LENGTH_OPTIONS: readonly SegmentOption<GameLengthValue>[] = [
  { value: "short", label: "短篇", hint: "一个完整篇章" },
  { value: "medium", label: "中篇", hint: "多幕推进" },
  { value: "long", label: "长篇", hint: "绵长史诗" },
  { value: "open", label: "不限", hint: "随剧情推演" }
] as const satisfies readonly SegmentOption<GameLengthValue>[];

/** 通过受控枚举查找 option，返回 null 表示不存在（防御性收窄，替代 unchecked cast）。 */
function findSegmentOption<T extends string>(
  options: readonly SegmentOption<T>[],
  value: string
): SegmentOption<T> | null {
  return options.find((option) => option.value === value) ?? null;
}

type FieldErrorMap = Partial<Record<keyof NewGameInput, string>>;

/** 域错误码 → 可显示文案：params 为稳定可显示参数。 */
function formatFieldError(error: NewGameInputError): string {
  const { params } = error;
  switch (error.code) {
    case "REQUIRED":
      return "此项为必填内容。";
    case "TOO_SHORT":
      return `至少需要 ${params.min} 个字符（当前 ${params.actual} 个）。`;
    case "TOO_LONG":
      return `最多允许 ${params.max} 个字符（当前 ${params.actual} 个）。`;
    case "INVALID_ENUM":
      return "取值不在允许范围内。";
    case "BLANK":
      return "标签不能为空白。";
    case "DUPLICATE_TAG":
      return `标签“${params.tag}”重复。`;
    case "TOO_MANY_TAGS":
      return `最多选择 ${params.max} 个标签。`;
  }
}

/** 每个字段只显示第一条错误，供输入框内联提示。 */
function toFieldErrorMap(errors: readonly NewGameInputError[]): FieldErrorMap {
  const map: FieldErrorMap = {};
  for (const error of errors) {
    map[error.field] ??= formatFieldError(error);
  }
  return map;
}

/** POST /api/game 的响应形态（宽松解析：非法 body 一律按未知错误处理）。 */
type CreateGameApiBody = {
  view?: GameSessionView;
  generationSource?: unknown;
  code?: string;
  fieldErrors?: NewGameInputError[];
};

/** 严格收窄安全来源字段：缺失或未知值都不得默认按 generated 处理。 */
function parseGenerationSource(value: unknown): GenerationSource | null {
  return value === "generated" || value === "fallback" ? value : null;
}

type NewGameSetupFormProps = {
  /** 创建成功回调：父级用会话视图与安全来源切换到开场画面。 */
  onCreated?: (view: GameSessionView, generationSource: GenerationSource) => void;
  /** 仅由 current-game 的 server metadata 提供，浏览器不可自行开启。 */
  developmentTools?: boolean;
};

export function NewGameSetupForm({ onCreated, developmentTools = false }: NewGameSetupFormProps = {}) {
  const [gameType, setGameType] = useState<(typeof GAME_TYPES)[number]["id"]>(DEFAULT_GAME_TYPE);
  const [characterName, setCharacterName] = useState(DEFAULT_PRESET.characterName);
  const [characterIdentity, setCharacterIdentity] = useState(DEFAULT_PRESET.characterIdentity);
  const [characterProfile, setCharacterProfile] = useState(DEFAULT_PRESET.characterProfile);
  const [worldPremise, setWorldPremise] = useState(DEFAULT_PRESET.worldPremise);
  const [storyOpening, setStoryOpening] = useState(DEFAULT_PRESET.storyOpening);
  const [narrativeStyle, setNarrativeStyle] =
    useState<NarrativeStyleValue>("novel");
  const [gameLength, setGameLength] =
    useState<GameLengthValue>("short");
  const [submitting, setSubmitting] = useState(false);
  const [statusMessage, setStatusMessage] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrorMap>({});
  const selectedType = GAME_TYPES.find((type) => type.id === gameType)!;
  // 当前题材的主题色，用于整套页面的配色切换。
  const theme = ADVENTURE_THEMES[gameType];
  const themeStyle = {
    "--stage-fill": theme.fill,
    "--stage-line": theme.line,
    "--stage-accent": theme.accent
  } as CSSProperties;

  /** 内联错误的可访问性接线：aria-invalid + aria-describedby 指向错误文本。 */
  function fieldErrorProps(field: keyof NewGameInput) {
    const message = fieldErrors[field];
    if (message === undefined) return {};
    return { "aria-invalid": true, "aria-describedby": `${field}-error` } as const;
  }

  function renderFieldError(field: keyof NewGameInput) {
    const message = fieldErrors[field];
    if (message === undefined) return null;
    return (
      <span id={`${field}-error`} className="field-error">
        {message}
      </span>
    );
  }

  /** 切换游戏类型时整体替换主角与世界开端字段为对应示例（覆盖玩家已编辑内容）。 */
  function handleGameTypeChange(id: (typeof GAME_TYPES)[number]["id"]) {
    const preset = GAME_TYPE_PRESETS[id];
    setGameType(id);
    setCharacterName(preset.characterName);
    setCharacterIdentity(preset.characterIdentity);
    setCharacterProfile(preset.characterProfile);
    setWorldPremise(preset.worldPremise);
    setStoryOpening(preset.storyOpening);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // loading 期间禁止重复提交（按钮已禁用，这里是键盘/程序化提交的兜底）。
    if (submitting) return;

    // 只承载 NewGameInput 允许的字段；标签与内容强度暂无表单项，取安全缺省。
    const input: NewGameInput = {
      gameType,
      characterName,
      characterIdentity,
      characterProfile,
      personalityTags: [],
      worldPremise,
      storyOpening,
      narrativeStyle,
      gameLength,
      contentIntensity: "normal"
    };

    // 客户端预校验：立即反馈字段错误，不发无谓请求（server 仍会重新校验）。
    const validated = validateNewGameInput(input);
    if (!validated.ok) {
      setFieldErrors(toFieldErrorMap(validated.errors));
      setErrorMessage("请修正表单中标出的问题后重试。");
      setStatusMessage("");
      return;
    }

    setFieldErrors({});
    setErrorMessage("");
    setSubmitting(true);
    setStatusMessage("正在生成世界，请稍候……");
    try {
      const response = await fetch("/api/game", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input)
      });
      const body = (await response.json().catch(() => null)) as CreateGameApiBody | null;
      // 成功判定要求 view 与合法来源同时存在：来源缺失/未知视为契约失败。
      const generationSource = parseGenerationSource(body?.generationSource);
      if (response.ok && body?.view !== undefined && generationSource !== null) {
        setStatusMessage("开局已生成。");
        onCreated?.(body.view, generationSource);
        return;
      }
      setStatusMessage("");
      switch (body?.code) {
        case "INVALID_INPUT":
          setFieldErrors(toFieldErrorMap(body.fieldErrors ?? []));
          setErrorMessage("请修正表单中标出的问题后重试。");
          break;
        case "ACTIVE_GAME_EXISTS":
          setErrorMessage(
            "已存在进行中的存档：刷新页面即可回到当前开场，本次提交没有创建新存档。"
          );
          break;
        case "GENERATION_INVALID":
          setErrorMessage("开局生成未通过规则校验，请调整开局资料后重试。");
          break;
        case "INFRASTRUCTURE_FAILURE":
          setErrorMessage("本地存档数据库暂时不可用，请稍后重试。");
          break;
        default:
          setErrorMessage("创建开局失败，请稍后重试。");
      }
    } catch {
      setStatusMessage("");
      setErrorMessage("网络异常：请求未能到达本地服务，请稍后重试。");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleOfflineJourneyStart(): Promise<void> {
    if (submitting) return;
    setFieldErrors({});
    setErrorMessage("");
    setSubmitting(true);
    setStatusMessage("正在载入离线完整旅程开局……");
    try {
      const response = await fetch("/api/game", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ developmentPreset: "phase10-journey-v1" })
      });
      const body = (await response.json().catch(() => null)) as CreateGameApiBody | null;
      const generationSource = parseGenerationSource(body?.generationSource);
      if (response.ok && body?.view !== undefined && generationSource !== null) {
        setStatusMessage("离线完整旅程开局已载入。");
        onCreated?.(body.view, generationSource);
        return;
      }
      setStatusMessage("");
      setErrorMessage(body?.code === "ACTIVE_GAME_EXISTS"
        ? "已存在进行中的存档：请先在开发工具中清除当前存档。"
        : "离线完整旅程开局未能载入，请稍后重试。");
    } catch {
      setStatusMessage("");
      setErrorMessage("网络异常：请求未能到达本地服务，请稍后重试。");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="new-game-form new-game-form--split" noValidate onSubmit={handleSubmit} style={themeStyle}>
      {/* 左侧：预览舞台，实时呈现当前开局全貌 */}
      <aside className="setup-stage" aria-label="开局预览">
        <div className="setup-stage--banner" aria-hidden="true">
          <AdventureVisual gameType={gameType} kind="location_backdrop" label={`${selectedType.label}世界背景`} decorative />
        </div>

        <div className="setup-stage--body">
          <p className="eyebrow">你的角色</p>

          <div className="character-card">
            <div className="character-card--portrait" aria-hidden="true">
              <AdventureVisual gameType={gameType} kind="npc" label="角色形象" decorative />
            </div>
            <div className="character-card--info">
              <h3>{characterName || "无名者"}</h3>
              <p className="character-card--identity">{characterIdentity || "身份未定"}</p>
            </div>
          </div>

          <div className="stage-block">
            <p className="stage-block--label">角色基础信息</p>
            <p className="stage-block--body">{characterProfile || "还没有角色基础信息。"}</p>
          </div>

          <div className="stage-block">
            <p className="stage-block--label">世界观背景</p>
            <p className="stage-block--body">{worldPremise || "还没有世界观背景。"}</p>
          </div>

          <div className="stage-block">
            <p className="stage-block--label">故事开端</p>
            <p className="stage-block--body stage-block--quote">{storyOpening || "还没有故事开端。"}</p>
          </div>

          <div className="stage-block--meta">
            <Tag variant="accent">{selectedType.label}</Tag>
            <span>{findSegmentOption(NARRATIVE_STYLE_OPTIONS, narrativeStyle)?.label ?? narrativeStyle}</span>
            <span>{findSegmentOption(GAME_LENGTH_OPTIONS, gameLength)?.label ?? gameLength}</span>
          </div>
        </div>

        {developmentTools ? (
          <section className="stage-dev-tools" aria-label="开发开局">
            <p className="stage-dev-tools--title">开发开局</p>
            <p className="stage-dev-tools--desc">
              载入 Phase 10 离线完整旅程使用的固定开局数据；不调用开局 AI 或运行时 AI。
            </p>
            <InlineButton type="button" disabled={submitting} onClick={() => void handleOfflineJourneyStart()}>
              使用已有数据开始
            </InlineButton>
          </section>
        ) : null}
      </aside>

      {/* 右侧：编辑区 */}
      <div className="setup-editor">
        <Panel
          eyebrow="其一 · 择世"
          header={(
            <div className="panel-heading">
              <div>
                <h2>选择世界</h2>
                <p>类型限制世界生成不能跑题，并绑定对应的 AI 绘图风格与界面主题。</p>
              </div>
              <Tag variant="accent">{selectedType.label}</Tag>
            </div>
          )}
        >
          <fieldset className="game-type-grid" disabled={submitting}>
            <legend className="sr-only">游戏类型</legend>
            {GAME_TYPES.map((type) => (
              <label
                key={type.id}
                className={`game-type-card${gameType === type.id ? " game-type-card--selected" : ""}`}
              >
                <input
                  type="radio"
                  name="gameType"
                  value={type.id}
                  checked={gameType === type.id}
                  onChange={() => handleGameTypeChange(type.id)}
                />
                <span className="game-type-card--visual" aria-hidden="true">
                  <Image src={GAME_TYPE_BACKGROUNDS[type.id]} alt="" fill sizes="220px" priority={type.id === DEFAULT_GAME_TYPE} />
                </span>
                <strong>{type.label}</strong>
                <span>{type.hint}</span>
              </label>
            ))}
          </fieldset>
        </Panel>

        <Panel eyebrow="其二 · 立人" title="你将以谁的身份进入故事？">
          <div className="form-grid form-grid--two">
            {/* 错误文本放在 label 外（aria-describedby 关联），避免污染可访问名称。 */}
            <div className="form-field">
              <label>
                <span>角色名字</span>
                <input
                  name="characterName"
                  value={characterName}
                  onChange={(event) => setCharacterName(event.target.value)}
                  maxLength={20}
                  placeholder="例如：沈砚"
                  {...fieldErrorProps("characterName")}
                />
              </label>
              {renderFieldError("characterName")}
            </div>
            <div className="form-field">
              <label>
                <span>身份 / 职业</span>
                <input
                  name="characterIdentity"
                  value={characterIdentity}
                  onChange={(event) => setCharacterIdentity(event.target.value)}
                  maxLength={80}
                  placeholder="例如：被逐出师门的机关师"
                  {...fieldErrorProps("characterIdentity")}
                />
              </label>
              {renderFieldError("characterIdentity")}
            </div>
          </div>
          <div className="form-field">
            <label>
              <span>角色基础信息</span>
              <textarea
                name="characterProfile"
                value={characterProfile}
                onChange={(event) => setCharacterProfile(event.target.value)}
                maxLength={300}
                rows={3}
                placeholder="经历、性格、能力倾向或重要关系；这里的描述不会直接授予规则数值。"
                {...fieldErrorProps("characterProfile")}
              />
            </label>
            {renderFieldError("characterProfile")}
          </div>
        </Panel>

        <Panel eyebrow="其三 · 起势" title="告诉系统，你想从怎样的局势开始">
          <div className="form-field">
            <label>
              <span>世界观背景</span>
              <textarea
                name="worldPremise"
                value={worldPremise}
                onChange={(event) => setWorldPremise(event.target.value)}
                maxLength={500}
                rows={5}
                placeholder="例如：七座浮空城以交易记忆维持运转，地面已经被遗忘了三百年……"
                {...fieldErrorProps("worldPremise")}
              />
            </label>
            {renderFieldError("worldPremise")}
          </div>
          <div className="form-field">
            <label>
              <span>故事开端</span>
              <textarea
                name="storyOpening"
                value={storyOpening}
                onChange={(event) => setStoryOpening(event.target.value)}
                maxLength={300}
                rows={4}
                placeholder="例如：我收到一封来自失踪妹妹、却署着三年前日期的信……"
                {...fieldErrorProps("storyOpening")}
              />
            </label>
            {renderFieldError("storyOpening")}
          </div>

          <div className="segment-grid">
            <fieldset className="segment-group">
              <legend className="segment-group--legend">叙事风格</legend>
              <div className="segment-row">
                {NARRATIVE_STYLE_OPTIONS.map((option) => (
                  <label
                    key={option.value}
                    className={`segment-option${narrativeStyle === option.value ? " segment-option--selected" : ""}`}
                  >
                    <input
                      type="radio"
                      name="narrativeStyle"
                      value={option.value}
                      checked={narrativeStyle === option.value}
                      onChange={(event) => {
                        const matched = findSegmentOption(NARRATIVE_STYLE_OPTIONS, event.target.value);
                        if (matched !== null) setNarrativeStyle(matched.value);
                      }}
                    />
                    <strong>{option.label}</strong>
                    <span>{option.hint}</span>
                  </label>
                ))}
              </div>
            </fieldset>

            <fieldset className="segment-group">
              <legend className="segment-group--legend">游戏时长</legend>
              <div className="segment-row">
                {GAME_LENGTH_OPTIONS.map((option) => (
                  <label
                    key={option.value}
                    className={`segment-option${gameLength === option.value ? " segment-option--selected" : ""}`}
                  >
                    <input
                      type="radio"
                      name="gameLength"
                      value={option.value}
                      checked={gameLength === option.value}
                      onChange={(event) => {
                        const matched = findSegmentOption(GAME_LENGTH_OPTIONS, event.target.value);
                        if (matched !== null) setGameLength(matched.value);
                      }}
                    />
                    <strong>{option.label}</strong>
                    <span>{option.hint}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          </div>
        </Panel>

        <div className="new-game-actions">
          <p>提交后将在本地生成开局并保存为当前存档；本阶段不调用 AI。</p>
          <InlineButton type="submit" size="md" disabled={submitting} className="journey-button">
            踏上旅程
          </InlineButton>
        </div>

        {/* aria-live 状态区域：role="status" 隐含 aria-live="polite"，常驻挂载以便播报变化。 */}
        <p role="status" className="form-status">
          {statusMessage}
        </p>

        {errorMessage ? (
          <Panel className="setup-result" compact>
            <Tag variant="danger">提交未完成</Tag>
            <p role="alert">{errorMessage}</p>
          </Panel>
        ) : null}
      </div>
    </form>
  );
}