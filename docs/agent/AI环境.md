# AI 环境

## 定位

`ai-rpg-game` 拥有自己的 AI 环境变量和 `.env.local`。初始开发时允许从 RPG 主工作区或 sibling `ai-slg-game` 的本地 env 复制同名键值，但这只是一次性本地初始化，不是运行时依赖。

运行时、测试和部署不得读取 `../ai-slg-game/.env*`。两个项目之后可以独立更换 URL、模型或 Key。

## 契约

必需键：

```dotenv
AI_API_BASE_URL=...
AI_MODEL=...
AI_API_KEY=...
```

- 实际值只放 RPG 自己的 `.env.local`、部署环境或 secret store，不提交。
- `AI_API_BASE_URL` 必须是 HTTP(S) URL。
- 脚本、日志、错误和测试不得输出任何值。
- `AI_GAME_ENV_SOURCE` 只用于本地 bootstrap 指定来源路径，不是应用运行时配置，也不能提交到配置文件。

## 持久化环境变量（Phase 2）

```dotenv
GAME_DB_PATH=./db/rpg.sqlite
```

- 仅 server 运行时读取：全库只有 `src/game/application/server/persistence/sqliteClient.ts` 解析该键（经 composition root 注入的 env 记录）；客户端 bundle、domain/gameplay 与 application 本体均不感知，边界由 `src/dependencyBoundaries.test.ts` 静态守卫强制。
- 未设置或空白时回退默认 `db/rpg.sqlite`（`db/` 目录已被 `.gitignore` 忽略，不提交数据库文件）。
- 测试不读全局配置：一律显式注入 `tmp/` 下的临时路径，用完自清理。
- `.env.example` 已含该键示例；`GAME_PERSISTENCE_BACKEND` 目前仅为声明性占位，代码未读取（Phase 2 只支持 sqlite）。

## 本地操作

```powershell
npm run env:bootstrap
npm run env:check
```

`env:bootstrap` 的来源优先级为：

1. 当前进程显式设置的 `AI_GAME_ENV_SOURCE`；
2. RPG 主工作区自己的 `.env.local`（用于给 RPG worktree 初始化）；
3. sibling SLG 主工作区的 `.env.local`；
4. sibling SLG 主工作区的 `.env`。

脚本只复制上述三个键，不复制 SLG 其他配置，不覆盖已有且有效的 RPG `.env.local`；需要覆盖时显式运行 `npm run env:bootstrap -- --force`。

## 阶段边界

Phase 1/Phase 2 不发起 AI 调用（Phase 2 仅确定性 fallback 生成），因此缺少真实 AI 值不会阻止 `setup` 或 `doctor`；开始真实 AI 阶段前，`npm run env:check` 必须成为该阶段验收命令。Provider transport 仍需按共享候选流程判断，不在环境脚本中实现。
