# Narrative P1 旅程协议

本文件冻结 P1 真实旅程的执行规则；它不是一次运行结果，也不保存模型名、输入哈希、provider 原文或成绩。实际注册命令会把这些非秘密运行快照写入独立的 `artifacts/narrative-p1/<runId>/`，不进入仓库。

## 固定样本

- 两次独立初始化：`S1`、`S2`。
- 每次初始化复制为 `private`、`public`、`verify_first` 三条路线，共 6 条预定路线。
- 当前协议版本为 `narrative-p1/v3`。开局完成后关闭连接并 checkpoint WAL，三条路线复制同一获批 SQLite 快照到互相隔离的新文件；不覆盖已有路线文件。旧版逐路线重新创建开局的结果只作为历史诊断，不能作为本矩阵的策略对照。
- 初始化或单路线失败不会缩小分母，也不补抽样本。
- 输入由 `validateNewGameInput` 校验后才写入注册协议；旅程途中不得改题材、角色、文风或隐含背景。

## 路线政策

- `private`：优先明确保密后取得引荐。
- `public`：不先承诺保密，优先公开渠道与核验。
- `verify_first`：在首个交付机会提交固定自由输入，先取得合法核验动作，再显式交付。
- 其余节点只从当前 read model 的合法 opaque choice 中选择；没有合法步骤即路线失败。
- 选路使用服务端当前 Action/interaction 引用，不能按 label 关键词猜测后果或无条件选第一项。缺少当前路线需要的合法能力记为 unsupported；回合返回成功不等于互动已结算，必须有对应成功事件。HTTP 按本路线增量计数，初始化结果单独留证。

## 单条诊断

`--profile=diagnostic` 单独登记 `claimScope=diagnostic`，只运行 `S1-diagnostic`：保密承诺 → 引荐 → 首个交付机会提交固定核验原句 → 核验 → 显式交付 → 终局。其上限为 24 动作、200 HTTP、30 分钟，每 epoch 仍为 3 版本/24 HTTP。它使用独立 runId/协议/产物，不属于正式六条分母，也不能替换失败矩阵样本。正式登记默认 `--profile=matrix`。

## 预算与停止

- 每路线最多 24 次有效动作；每个生成 epoch 最多 3 个候选版本、24 次 HTTP。
- 整批最多 1000 次 HTTP、3 小时墙钟；HTTP 在发送前预留，失败或进程中断不退回。
- 生产入口最多一次显式人工重试；runner 不用替代文本、后门状态或预知结果替代路线。

## 模式与完整性

- `register` 只做本地输入、配置能力和代码指纹登记，零网络。
- `live` 只读取已冻结协议，并要求显式 `RUN_REAL_AI_JOURNEY=1`。
- `replay` 在全新的 SQLite 中重新执行同一开局、作者、NPC 判断、语义审核、审批、规则、CAS 和旅程循环，仅最底层请求消费原始响应磁带。它不读取密钥、不创建网络 transport，也不读取旧 `completed` 布尔作为通过证据。重放输出固定写入指定输出目录的 `replay/` 子目录，原始 live 文件只读。
- 每个 opening/route stream 的 `<stream>.runtime.json` 保存完整非密请求、原始响应、稳定 gameId/seed/callId、按业务键记录的领域时间及每个决策前和终局的逻辑存档。文件含规范 JSON 哈希，并绑定 protocolHash、代码指纹和输入哈希；完成时在连接/审计队列关闭后保存原始审计文件哈希，重放校验 envelope sequence、callId/attempt 唯一顺序、messages 和 raw output。摘要列出原始产物目录及全部磁带文件 SHA256，不能混用别的登记或删除审计后通过；缺失旧磁带、请求/顺序/响应数量/领域状态不一致均拒绝。重放仍实际获取和续租，只有明确的临时 leaseId/leaseExpiresAt 不参与语义比较；原值与重放值另存 comparison，未知存档字段默认精确比较。HTTP 为 0，磁带消费另报 `replayedTransportAttempts`。
- 协议哈希、固定路线、规范化输入或代码指纹不匹配时，在任何 provider I/O 前拒绝运行。
- 正常失败路线同样在后台任务和审计排空后记录失败码、动作数及最终存档，封存磁带。失败轨迹重放一致仍保留 `completed=false` 与原失败码，不能计为故事通过；缺少完整收尾的进程中断样本不能补造完成证据。
- 退出码：`0` 表示该登记范围内全部路线完成（matrix 为六条，diagnostic 为一条）；`1` 表示路线未完成、硬错误或协议违约；`2` 表示参数、未登记或显式门禁错误。

## 产物边界

每次运行写入独立目录，至少包含协议哈希、规范化输入、非敏感环境配置、路线摘要、HTTP/动作计数和安全步骤摘要。provider 审计原文只由受控审计链保存；API key、Authorization、cookie 和完整凭据不得写入协议、玩家 History 或普通日志。

批次开始及每条路线结束均 checkpoint summary，保留六条分母及未完成状态；取消或三小时截止后拒绝新请求并向生产生成传递取消信号。中断产物不是完整验收通过记录。
