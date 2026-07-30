# 角色界面横屏重构 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 重构 `AdventureDetailsPanel` 中的“角色”弹窗面板为横屏双栏结构，左侧展示带有古风金框的 Avatar 头像与身份，右侧展示包含 HP 血条、核心属性与扩展属性插槽的网格。

**Architecture:** 
将现有的单列列表 `dl.details-character` 替换为响应式双栏 `.details-character-landscape`。
左侧包含头像 SVG 与基本身份卡，右侧包含 HP 血条段与网格化属性段。同步在 `globals.css` 中添加对应的网格与主题卡片样式，并在 `AdventureDetailsPanel.test.tsx` 中编写全面的自动化单元测试。

**Tech Stack:** React (Next.js client component), Vanilla CSS, Vitest + React Testing Library

## Global Constraints

- 不改变现有的 `GameSessionView` 领域数据结构或 Application 层契约。
- 绝不引入 TailwindCSS，统一在 `src/app/globals.css` 中书写 CSS 类。
- 复用 `AdventureHud` 现有 SVG 矢量头像。

---

### Task 1: 更新角色面板结构与单元测试

**Files:**
- Modify: `src/components/AdventureDetailsPanel.test.tsx`
- Modify: `src/components/AdventureDetailsPanel.tsx`
- Modify: `src/app/globals.css`

**Interfaces:**
- Consumes: `view.player` (`name`, `identity`, `stats.hp`, `stats.attack`, `stats.defense`)
- Produces: `.details-character-landscape` 横屏角色面板 DOM 结构与样式

- [ ] **Step 1: 编写/更新针对横屏角色面板的失败测试**

```tsx
// 在 src/components/AdventureDetailsPanel.test.tsx 中更新或增加测试：
it("panel=character 渲染横屏角色面板，包含头像、身份与扩展属性卡片", () => {
  vi.stubGlobal("fetch", vi.fn());
  const { container } = render(<AdventureDetailsPanel view={buildSessionViewFixture()} panel="character" />);

  expect(screen.getByText("沈青崖")).toBeInTheDocument();
  expect(screen.getByText("落魄镖师")).toBeInTheDocument();
  expect(screen.getByText("等级 1")).toBeInTheDocument();
  expect(screen.getByText("生命 (HP)")).toBeInTheDocument();
  expect(screen.getByText("基础属性")).toBeInTheDocument();
  expect(screen.getByText("拓展属性")).toBeInTheDocument();

  // 验证带有 .details-character-landscape 容器与 SVG 头像
  expect(container.querySelector(".details-character-landscape")).not.toBeNull();
  expect(container.querySelector(".character-avatar-frame svg")).not.toBeNull();
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `npx vitest run src/components/AdventureDetailsPanel.test.tsx`
Expected: FAIL ("details-character-landscape" 或 "基础属性" 未在旧面板中找到)

- [ ] **Step 3: 实现 `AdventureDetailsPanel.tsx` 角色横屏 DOM 结构**

```tsx
// 在 src/components/AdventureDetailsPanel.tsx 中重构角色面板渲染部分：
function CharacterAvatarIcon() {
  return (
    <svg viewBox="0 0 64 64" focusable="false" aria-hidden="true">
      <circle cx="32" cy="32" r="30" />
      <circle cx="32" cy="25" r="11" />
      <path d="M12 56c4-13 12-19 20-19s16 6 20 19" />
    </svg>
  );
}

// 修改 panel === "character" 分支逻辑
    <div className="details-character-landscape">
      <div className="character-card-portrait">
        <div className="character-avatar-frame" aria-hidden="true">
          <CharacterAvatarIcon />
        </div>
        <div className="character-identity-info">
          <h3 className="character-name">{view.player.name}</h3>
          <span className="character-tag">{view.player.identity}</span>
          <div className="character-level-badge">等级 1</div>
        </div>
      </div>

      <div className="character-card-stats">
        <section className="character-vitals-section">
          <div className="character-stat-bar-header">
            <span className="stat-label">生命 (HP)</span>
            <span className="stat-value">{view.player.stats.hp} / {view.player.stats.hp}</span>
          </div>
          <div className="character-stat-bar" role="progressbar" aria-valuenow={100} aria-valuemin={0} aria-valuemax={100}>
            <div className="character-stat-bar-fill" style={{ width: "100%" }} />
          </div>
        </section>

        <section className="character-attributes-section">
          <h4>基础属性</h4>
          <div className="character-stats-grid">
            <div className="stat-card">
              <span className="stat-card-label">攻击</span>
              <span className="stat-card-value">{view.player.stats.attack}</span>
            </div>
            <div className="stat-card">
              <span className="stat-card-label">防御</span>
              <span className="stat-card-value">{view.player.stats.defense}</span>
            </div>
          </div>
        </section>

        <section className="character-attributes-section">
          <h4>拓展属性</h4>
          <div className="character-stats-grid">
            <div className="stat-card stat-card-extended">
              <span className="stat-card-label">速度</span>
              <span className="stat-card-value">10</span>
            </div>
            <div className="stat-card stat-card-extended">
              <span className="stat-card-label">暴击率</span>
              <span className="stat-card-value">5%</span>
            </div>
            <div className="stat-card stat-card-extended">
              <span className="stat-card-label">闪避率</span>
              <span className="stat-card-value">5%</span>
            </div>
          </div>
        </section>
      </div>
    </div>
```

- [ ] **Step 4: 在 `src/app/globals.css` 中实现横屏与卡片 CSS 样式**

```css
.details-character-landscape {
  display: grid;
  grid-template-columns: 200px 1fr;
  gap: 24px;
  min-width: min(100%, 600px);
  padding: 8px 4px;
}

@media (max-width: 640px) {
  .details-character-landscape {
    grid-template-columns: 1fr;
  }
}

.character-card-portrait {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding: 20px 16px;
  background: var(--game-surface);
  border: 1px solid var(--game-surface-border);
  border-radius: 12px;
  gap: 12px;
}

.character-avatar-frame {
  width: 96px;
  height: 96px;
  border-radius: 50%;
  background: radial-gradient(circle, #2d261e 0%, #15120e 100%);
  border: 2px solid #a88948;
  box-shadow: 0 0 12px rgba(168, 137, 72, 0.25);
  display: grid;
  place-items: center;
  padding: 12px;
}

.character-avatar-frame svg {
  width: 100%;
  height: 100%;
  fill: #ebd8a3;
  stroke: #ebd8a3;
  stroke-width: 2;
}

.character-identity-info {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  width: 100%;
}

.character-name {
  margin: 0;
  font-size: 1.25rem;
  font-weight: 700;
  color: var(--game-text);
}

.character-tag {
  display: inline-block;
  padding: 2px 10px;
  font-size: 0.8125rem;
  background: #332b1f;
  color: #d4c088;
  border: 1px solid #574830;
  border-radius: 12px;
}

.character-level-badge {
  font-size: 0.75rem;
  color: var(--game-text-muted);
  margin-top: 4px;
}

.character-card-stats {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.character-vitals-section {
  background: var(--game-surface);
  border: 1px solid var(--game-surface-border);
  border-radius: 8px;
  padding: 12px 16px;
}

.character-stat-bar-header {
  display: flex;
  justify-content: space-between;
  font-size: 0.875rem;
  font-weight: 600;
  margin-bottom: 6px;
}

.character-stat-bar {
  height: 10px;
  background: #1f1b14;
  border-radius: 5px;
  overflow: hidden;
  border: 1px solid #3d3427;
}

.character-stat-bar-fill {
  height: 100%;
  background: linear-gradient(90deg, #9e2a2b 0%, #d90429 100%);
  border-radius: 5px;
  transition: width 0.3s ease;
}

.character-attributes-section h4 {
  margin: 0 0 8px 0;
  font-size: 0.875rem;
  color: var(--game-text-muted);
  border-bottom: 1px solid var(--game-surface-border);
  padding-bottom: 4px;
}

.character-stats-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
  gap: 10px;
}

.stat-card {
  display: flex;
  flex-direction: column;
  padding: 10px 12px;
  background: var(--game-surface);
  border: 1px solid var(--game-surface-border);
  border-radius: 8px;
}

.stat-card-label {
  font-size: 0.75rem;
  color: var(--game-text-muted);
}

.stat-card-value {
  font-size: 1.125rem;
  font-weight: 700;
  color: var(--game-text);
  margin-top: 2px;
}

.stat-card-extended {
  opacity: 0.85;
}
```

- [ ] **Step 5: 验证测试通过**

Run: `npx vitest run`
Expected: PASS (所有 91 个测试文件全过)
