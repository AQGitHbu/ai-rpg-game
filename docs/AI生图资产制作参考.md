# 视觉资产参考

## 当前资产与展示

- `public/assets/genres/` 提供七种题材的静态 JPG 封面，由新游戏表单使用。
- `public/assets/town/` 提供八张建筑 WebP，小镇地图按建筑类型展示。
- 世界地点、角色、NPC、物品和敌人由 `AdventureVisual` 的 SVG 与界面占位呈现；运行时没有 AI 生图请求、图片生成队列或专属角色序列帧。
- 图片只承担展示，地图坐标、实体存在性、任务与战斗结果均来自结构化状态。

## 阅读路由

| 任务 | 入口 |
|---|---|
| 修改已有封面或占位视觉 | `src/components/NewGameSetupForm.tsx`、`src/components/adventureVisuals.tsx` |
| 修改建筑贴图与空间展示 | [小镇系统](agent/小镇程序化生成.md) 与 `src/components/town/TownMapSvg.tsx` |
| 实施图片展示框架 | [展示框架设计](superpowers/specs/2026-09-07-content-asset-registry-design.md) 和 [对应 Plan](superpowers/plans/2026-09-08-content-asset-registry.md)，均为待实施资料 |
| 追溯生图规格、Prompt 与制作试验 | [制作参考归档](archive/AI生图资产制作参考.md)，不作当前实现依据 |

修改玩家规则或图片服务能力时分别更新所属策划/系统文档；本文只维护资源定位，不复制未来服务协议。
