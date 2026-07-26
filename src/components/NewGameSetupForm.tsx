"use client";

import { useState } from "react";
import { InlineButton, Panel, Tag } from "@ai-game/ui";

const GAME_TYPES = [
  { id: "wuxia", label: "武侠", hint: "江湖、门派与朝堂" },
  { id: "xianxia", label: "仙侠", hint: "宗门、修行与异兽" },
  { id: "fantasy", label: "奇幻", hint: "王国、魔法与遗迹" },
  { id: "science_fiction", label: "科幻", hint: "星际、赛博与未来都市" },
  { id: "urban", label: "都市", hint: "当代城市与组织冲突" },
  { id: "alternate_history", label: "历史架空", hint: "类历史制度与权谋" },
  { id: "post_apocalypse", label: "末日", hint: "灾变、废土与生存" },
] as const;

export function NewGameSetupForm() {
  const [gameType, setGameType] = useState<(typeof GAME_TYPES)[number]["id"]>("wuxia");
  const [readyMessage, setReadyMessage] = useState("");
  const selectedType = GAME_TYPES.find((type) => type.id === gameType)!;

  return (
    <form
      className="new-game-form"
      onSubmit={(event) => {
        event.preventDefault();
        setReadyMessage(
          `“${selectedType.label}”开局资料已通过 UI 校验；世界蓝图生成将在 MVP Phase 1 接入。`,
        );
      }}
    >
      <Panel
        eyebrow="01 / 世界范围"
        header={(
          <div className="panel-heading">
            <div>
              <h2>选择游戏类型</h2>
              <p>类型限制世界生成不能跑题，并绑定对应的 AI 绘图风格。</p>
            </div>
            <Tag variant="accent">{selectedType.label}</Tag>
          </div>
        )}
      >
        <fieldset className="game-type-grid">
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
                onChange={() => setGameType(type.id)}
              />
              <strong>{type.label}</strong>
              <span>{type.hint}</span>
            </label>
          ))}
        </fieldset>
      </Panel>

      <Panel eyebrow="02 / 主角" title="你将以谁的身份进入故事？">
        <div className="form-grid form-grid--two">
          <label>
            <span>角色名字</span>
            <input name="characterName" minLength={2} maxLength={20} required placeholder="例如：沈砚" />
          </label>
          <label>
            <span>身份 / 职业</span>
            <input
              name="characterIdentity"
              minLength={2}
              maxLength={80}
              required
              placeholder="例如：被逐出师门的机关师"
            />
          </label>
        </div>
        <label>
          <span>角色基础信息</span>
          <textarea
            name="characterProfile"
            maxLength={300}
            rows={3}
            placeholder="经历、性格、能力倾向或重要关系；这里的描述不会直接授予规则数值。"
          />
        </label>
      </Panel>

      <Panel eyebrow="03 / 世界与开端" title="告诉系统，你想从怎样的局势开始">
        <label>
          <span>世界观背景</span>
          <textarea
            name="worldPremise"
            minLength={20}
            maxLength={500}
            rows={5}
            required
            placeholder="例如：七座浮空城以交易记忆维持运转，地面已经被遗忘了三百年……"
          />
        </label>
        <label>
          <span>故事开端</span>
          <textarea
            name="storyOpening"
            minLength={20}
            maxLength={300}
            rows={4}
            required
            placeholder="例如：我收到一封来自失踪妹妹、却署着三年前日期的信……"
          />
        </label>
        <label className="narrative-style">
          <span>叙事风格</span>
          <select name="narrativeStyle" defaultValue="cinematic">
            <option value="concise">简洁</option>
            <option value="novel">小说化</option>
            <option value="cinematic">电影化</option>
          </select>
        </label>
      </Panel>

      <div className="new-game-actions">
        <p>Phase 0 只验证公共 UI 消费；不会在浏览器中调用 AI 或创建存档。</p>
        <InlineButton type="submit" size="md">
          确认开局资料
        </InlineButton>
      </div>

      {readyMessage ? (
        <Panel className="setup-result" compact>
          <Tag variant="success">资料已就绪</Tag>
          <p role="status">{readyMessage}</p>
        </Panel>
      ) : null}
    </form>
  );
}
