# 角色界面横屏重构与扩展性设计规范

## 1. 背景与目标

当前 RPG 游戏的“角色”查看弹窗（`AdventureDetailsPanel` 中的 `panel === "character"`）为竖向单列结构，视觉样式较为单一且属性可读性与扩展能力受限。
本次重构将参考经典 RPG 角色卡界面风格，将“角色”弹窗优化为**横屏双栏结构**：
- **左侧**：展示大图角色头像（复用 HUD 现有的矢量 SVG 头像，结合古典卡片与金属边框包裹）、姓名、身份、等级与称号。
- **右侧**：展示核心生存状态（HP 视觉条及数值）与基础战斗属性（攻击、防御），并建立可复用的模块化网格，便于未来拓展速度、暴击率、闪避率等衍生数值。

## 2. 界面与布局设计

### 2.1 容器与横屏模态框 (`AdventureOverlay` & `details-character`)

- 当面板为 `character` 时，底层容器使用专用 Class `.details-character-landscape`（或扩展 `.details-character`）。
- 弹窗宽度适配：横屏最大宽度扩大为 `min(92vw, 680px)`，在 Desktop / Mobile 视图下保持灵活居中与良好的两栏排版。

### 2.2 左侧：角色头像与身份卡片 (`.character-card-portrait`)

- **Avatar 视窗**：使用与 `AdventureHud` 一致的 SVG 头像图形，放大置于圆角/六边形古典纹理框内，配备暗金/微光深色背景。
- **身份信息**：
  - 角色姓名：`view.player.name`（大字粗体）
  - 角色身份：`view.player.identity`（配小标签 / Tag 样式）
  - 扩展徽章：`等级: 1`（预留衍生数据接口，MVP 缺省推导为 Lv.1）

### 2.3 右侧：状态与属性网格区 (`.character-card-stats`)

- **生存/核心状态 Header**：
  - HP 生命值显示：显示 `HP view.player.stats.hp / view.player.stats.hp` 及其专属血条进度指示器（利用 CSS 自定义属性控制百分比及渐变）。
- **基础属性网格 (`.character-stats-grid`)**：
  - 攻击：`view.player.stats.attack`
  - 防御：`view.player.stats.defense`
- **扩展属性插槽 (Extensible Stat Slots)**：
  - 预留速度 (`速度: 10`)、暴击率 (`暴击: 5%`)、闪避率 (`闪避: 5%`) 等显示卡片，在玩家属性字典无扩展数据时，展示优雅推导的基准值或暗态预留插槽，为后续数值扩展提供稳定架构支持。

## 3. 组件与 CSS 架构

- **`src/components/AdventureDetailsPanel.tsx`**：
  - 升级 `panel === "character"` 的 DOM 结构，抽离 `CharacterPanel` 子组件或结构化渲染函数。
  - 引入 SVG Avatar 头像组件，避免代码重复。
- **`src/app/globals.css`**：
  - 新增 `.details-character-landscape` 及其相关子元素 Flex/Grid 样式。
  - 保证在移动端小屏下亦能纵向优雅降级（Responsive grid layout）。

## 4. 测试与验证

- 在 `src/components/AdventureDetailsPanel.test.tsx` 中增加对横屏角色面板的测试：
  - 验证头像 SVG 是否渲染。
  - 验证角色姓名、身份、生命值、攻击力、防御力等文本及布局容器存在。
- 运行 `npx vitest run` 验证所有现有及新增测试均无 regression。
