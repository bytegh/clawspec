# ClawSpec — OpenClaw × OpenSpec 项目编排插件设计文档

- **状态**: Draft / Ready for implementation
- **日期**: 2026-03-20
- **作者**: Rax
- **面向对象**: 后续参与实现的 Agent / 工程协作者
- **建议插件 id**: `clawspec`
- **建议显示名**: `ClawSpec Project Orchestrator`

---

## 1. 文档目的

本文档定义一个新的 OpenClaw 插件：**ClawSpec**。

它的目标不是再做一个普通的 command 集合，而是把 OpenClaw 在 channel 里的“单轮对话式开发”升级成一个**可持续推进、可暂停、可继续、可归档的项目执行系统**，并且尽量复用 **OpenSpec** 现有的 spec-driven 工作流，而不是从零重新发明 proposal / specs / design / tasks 的标准文档体系。

这份文档会作为后续实现该插件的**唯一设计基线**之一，给其他 Agent 阅读和落地，因此会同时包含：

1. 问题背景
2. 目标与边界
3. 依赖能力确认
4. 总体架构
5. 命令设计
6. 状态机设计
7. OpenSpec 集成方案
8. Worker 执行合同
9. 归档与恢复机制
10. 插件目录与实现分层
11. 实施阶段建议
12. 风险与取舍
13. 验收标准

---

## 2. 背景与问题陈述

### 2.1 当前 OpenClaw channel 的真实痛点

目前在 Discord / Telegram / WhatsApp 等 channel 中，OpenClaw 的 agent loop 天然是：

- 一条消息进入
- 组装上下文
- 模型推理
- 调工具
- 输出结果
- 这一轮结束

这套机制适合：

- 问答
- 单次动作
- 小型自动化
- 一次性编码请求

但**不适合长链路项目执行**。原因很现实：

1. 用户让某个 Agent 按 todo / task list 持续做事时，Agent 常常在“更新了一次状态并汇报”后就停住。
2. 想做功能开发时，需要不断靠人类一句一句继续推动，channel 体验接近“手动遥控”，而不是“项目执行模式”。
3. 即使任务本身已经被拆成 task，OpenClaw 当前 channel 也没有一个开箱即用的“做完一项 -> 自动进入下一项 -> 可暂停 -> 可恢复”的通用机制。
4. 缺乏统一的项目文档落盘与归档协议，导致下次继续时上下文恢复成本高。

### 2.2 用户明确提出的目标

用户希望获得一个**更通用**的机制，而不是只给 Piper 做一个 watchdog。

目标行为大致如下：

- 在 channel 里通过 command 开始一个项目
- 选择项目目录
- 输入项目描述
- 系统自动生成标准文档（尽量复用 OpenSpec）
- 下达开始命令后，Agent 自动持续推进任务
- 每完成一项：
  - 自动维护 task 状态
  - 汇报本轮完成内容
  - 再进入下一项
- 支持中途：
  - `pause`
  - 聊完后 `continue`
- 项目完成后：
  - 汇报总体情况
  - 说明创建了什么文件、修改了什么代码
- 发送 `archive` 后：
  - 把本轮项目相关上下文、决策、总结、会话摘要沉淀到项目目录
  - 方便下次继续加载

### 2.3 为什么不是“小 patch / hook”能解决

一个简单的 hook / watchdog 只能解决：

- “为什么它汇报一次后不继续干”

但解决不了：

- 项目初始化
- 标准文档生成
- 阶段流转
- 多命令控制
- pause / continue / archive
- 项目级状态管理
- 项目恢复

因此，这不是一个“修一个 channel 行为”的小改动，而应该是：

> **一个真正的项目编排插件（project orchestrator plugin）**

---

## 3. 关键设计判断

### 3.1 不重复造 OpenSpec 的轮子

本设计的核心原则：

> **OpenSpec 管标准工件与阶段流，OpenClaw 插件管命令、调度、续跑、暂停、归档。**

我们不应该自己重新定义：

- proposal 模板
- specs 模板
- design 模板
- tasks 模板
- archive 的 spec 流程

如果 OpenSpec 已经提供这些，就尽量沿用它的 schema、模板、状态命令与归档命令。

### 3.2 不强行把 OpenSpec 变成黑盒自动写文档器

经验证，OpenSpec 当前更像：

- workflow/schema 引擎
- 标准文档模板与 instructions 提供者
- status / validate / archive 工具

它**不是**“把一段自由文本描述直接变成全套完整文档”的一键黑盒。

因此正确做法不是：

- 指望 `openspec` 单独自动写完 proposal/specs/design/tasks

而是：

- 由插件调用 `openspec instructions <artifact>` 获取规范
- 再让 worker agent 按这些 instructions 写出对应工件

### 3.3 channel 是控制面，不是执行面

本插件必须采用 **Control Plane / Worker Plane 分离** 的设计：

#### Channel / Plugin = 控制面
负责：
- 收命令
- 管状态
- 启停项目
- 触发 worker
- 节流汇报
- pause / continue / archive

#### Worker Session = 执行面
负责：
- 读 proposal/specs/design/tasks
- 真正做实现
- 更新任务状态
- 生成 checkpoint
- 输出本轮执行结果

如果把这些全塞在 channel 主会话里，迟早会乱套。

---

## 4. 已确认的依赖事实（必须保留给实现 Agent）

### 4.1 OpenClaw Plugin 侧已确认能力

本地文档与验证表明，OpenClaw plugin 支持：

1. **注册 plugin command**
   - 命令在 built-in commands 和 AI agent 之前处理
   - 适合做 `/project start`、`/project pause`、`/project status` 这类控制命令
2. **注册 plugin hooks**
   - 可以在生命周期节点触发逻辑
3. **plugin-managed hooks 不能被单独 enable/disable**
   - 只能开关整个 plugin
   - 因此需要我们自己做 per-channel / per-project 的行为开关
4. **manifest-first plugin 结构**
   - 每个插件必须有 `openclaw.plugin.json`
   - `configSchema` 必填
5. **commands 可以带 args，也可以 requireAuth**
6. **plugin 是 in-process 运行**
   - 需要格外谨慎控制状态与副作用

### 4.2 OpenSpec 侧已确认能力（本地 smoke test）

本机已验证 OpenSpec CLI 可用，安装版本此前已确认可运行。

已本地验证到的命令/行为：

1. `openspec --help`
   - CLI 正常
2. `openspec schemas --json`
   - 当前默认 schema 为 `spec-driven`
   - 工件顺序为：`proposal -> specs -> design -> tasks`
3. `openspec templates --json`
   - 能输出 proposal/specs/design/tasks 对应模板路径
4. `openspec init --tools none <path>`
   - 可初始化 OpenSpec 项目结构
5. `openspec new change <name> --description "..."`
   - 可创建 change 目录
6. `openspec instructions proposal --change <id>`
   - 返回 proposal 写作说明、目标路径、模板骨架
7. `openspec instructions specs --change <id>`
   - 返回 specs 写作说明与目标路径
8. `openspec instructions design --change <id>`
   - 返回 design 写作说明与目标路径
9. `openspec instructions tasks --change <id>`
   - 返回 tasks 写作说明与目标路径
   - 且明确要求 task 必须是 `- [ ]` checkbox 格式
10. `openspec status --change <id>`
   - 可显示当前工件完成度与阻塞关系
11. `openspec validate`
   - 有完整 validate 流程
12. `openspec archive`
   - 有归档能力

### 4.3 重要约束

1. `/opsx:*` 不是 Discord 原生命令面，不能指望 Discord 自动提供这层能力。
2. 因此，用户在 channel 里的交互面必须由 **OpenClaw plugin command** 来提供。
3. 我们应尽量“向 OpenSpec 的工作流靠拢”，而不是再定义一套完全不同的命令体系。

---

## 5. 产品定义

## 5.1 插件名称

建议插件代号：

- **`clawspec`**

原因：

- 语义上同时包含 OpenClaw 与 OpenSpec
- 比 `project-orchestrator` 更短
- 对用户来说更像一个“项目模式”能力

### 5.2 插件使命

> 在 channel 中为 OpenClaw 提供一个基于 OpenSpec 工作流的项目编排层，使用户能够以命令方式启动、推进、暂停、恢复、归档一个长期项目，而不需要反复手动逐轮推动对话。

---

## 6. 目标与非目标

### 6.1 目标（Goals）

1. 在 channel 中支持基于 command 的项目控制流。
2. 使用 OpenSpec 作为标准工件与阶段流的底座。
3. 从项目描述出发，自动落地 proposal/specs/design/tasks 工件（通过 worker + `openspec instructions`）。
4. 让 worker 根据 `tasks.md` 自动逐项推进，并持续维护状态。
5. 支持：
   - start
   - pause
   - continue
   - status
   - archive
6. 项目执行期间，自动输出 checkpoint 汇报。
7. 项目完成后，输出总汇总。
8. 提供项目级 archive 文件，便于恢复与二次开发。
9. 保持 OpenSpec 原有结构尽量不被破坏。

### 6.2 非目标（Non-Goals）

1. **不**在 V1 中实现完整 GUI。
2. **不**在 V1 中支持多用户并发编辑同一个项目。
3. **不**在 V1 中替代 Git / PR / CI 流程。
4. **不**在 V1 中自动推断过于复杂的多仓库拓扑。
5. **不**在 V1 中把 OpenSpec 改造成“完全自动写文档的大模型平台”。
6. **不**在 V1 中要求每个项目都必须走 Discord thread。

---

## 7. 总体架构

```text
User in Channel
   |
   v
ClawSpec Plugin Commands
   |
   +--> Project State Store
   |
   +--> OpenSpec Adapter (CLI wrapper)
   |
   +--> Worker Session Orchestrator
              |
              v
       Persistent Worker Session
              |
              +--> Read/Write proposal/specs/design/tasks
              +--> Implement code / docs / file changes
              +--> Update tasks.md and progress artifacts
              +--> Return structured checkpoint summary
```

### 7.1 组件划分

#### A. Command Layer
负责解析并处理：
- `/project start`
- `/project path ...`
- `/project desc ...`
- `/project run`
- `/project pause`
- `/project continue`
- `/project status`
- `/project archive`
- 以及其他补充命令

#### B. State Store
记录每个 channel / project 的当前状态。

#### C. OpenSpec Adapter
负责安全、统一地调用：
- `openspec init`
- `openspec new change`
- `openspec instructions ...`
- `openspec status`
- `openspec validate`
- `openspec archive`

#### D. Worker Orchestrator
负责：
- 启动或绑定持久 worker session
- 给 worker 下发阶段任务
- 接收 checkpoint
- 判断是否继续下一项
- 处理 pause / continue

#### E. Archive Layer
负责把本轮项目执行沉淀为可恢复的档案材料。

---

## 8. 建议目录结构

### 8.1 插件目录（OpenClaw 插件标准结构）

```text
plugins/clawspec/
├── openclaw.plugin.json
├── package.json
├── tsconfig.json
├── README.md
└── src/
    ├── index.ts
    ├── commands/
    │   ├── project.ts
    │   ├── status.ts
    │   └── archive.ts
    ├── state/
    │   ├── store.ts
    │   ├── schema.ts
    │   └── locks.ts
    ├── openspec/
    │   ├── cli.ts
    │   ├── parser.ts
    │   └── templates.ts
    ├── orchestrator/
    │   ├── project-runner.ts
    │   ├── checkpoint-loop.ts
    │   ├── pause.ts
    │   └── resume.ts
    ├── worker/
    │   ├── session.ts
    │   ├── prompts.ts
    │   └── summaries.ts
    ├── archive/
    │   ├── export.ts
    │   └── recover.ts
    └── utils/
        ├── paths.ts
        ├── slug.ts
        └── markdown.ts
```

### 8.2 Manifest（示意）

```json
{
  "id": "clawspec",
  "name": "ClawSpec Project Orchestrator",
  "description": "OpenSpec-aware project orchestration for channel-driven development",
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "defaultAgentId": { "type": "string" },
      "defaultRuntime": { "type": "string", "enum": ["acp", "subagent"] },
      "projectStateDir": { "type": "string" },
      "maxAutoContinueTurns": { "type": "integer", "minimum": 1, "maximum": 100 },
      "checkpointMode": { "type": "string", "enum": ["every-task", "batched"] },
      "allowChannels": {
        "type": "array",
        "items": { "type": "string" }
      },
      "archiveDirName": { "type": "string" }
    }
  }
}
```

---

## 9. 数据模型设计

## 9.1 Project State

建议每个活动项目记录为一条结构化状态：

```json
{
  "projectId": "clawspec-20260320-001",
  "channelKey": "discord:1474686041939251210",
  "repoPath": "C:\\Users\\Administrator\\some-project",
  "projectTitle": "add project execution mode",
  "description": "用户给出的项目描述全文",
  "changeName": "project-execution-mode",
  "openspecRoot": "C:\\Users\\Administrator\\some-project\\openspec",
  "worker": {
    "runtime": "acp",
    "agentId": "codex",
    "sessionKey": "agent:...",
    "mode": "session"
  },
  "status": "running",
  "phase": "implementing",
  "pauseRequested": false,
  "blockedReason": null,
  "currentTask": "2.3 Implement checkpoint summarizer",
  "completedTasks": 5,
  "pendingTasks": 11,
  "lastCheckpointAt": "2026-03-20T09:00:00Z",
  "lastSummary": "完成 task 2.2，新增 state store",
  "archivePath": null
}
```

### 9.2 状态枚举

#### Project Status
- `idle`
- `collecting_path`
- `collecting_description`
- `bootstrapping`
- `planning`
- `running`
- `pause_requested`
- `paused`
- `blocked`
- `done`
- `archived`
- `error`

#### Phase
- `init`
- `proposal`
- `specs`
- `design`
- `tasks`
- `implementing`
- `validating`
- `archiving`

---

## 10. 命令设计（靠近 OpenSpec 工作流）

## 10.1 命令前缀

建议统一使用：

- `/project ...`

原因：
- 对用户直观
- 不和 OpenSpec CLI 直接冲突
- plugin 内部可以再映射到 OpenSpec 命令

如果以后需要贴近 OpenSpec 品牌，也可以提供 alias：

- `/spec ...`
- `/ops ...`

但 V1 建议先保守，统一 `/project`。

---

## 10.2 MVP 命令集

### 1) `/project start`
用途：开始一个新项目初始化流程。

行为：
- 创建临时 project state
- 进入 `collecting_path`
- 回复用户：请提供项目路径

### 2) `/project path <path>`
用途：设置目标项目目录。

行为：
- 记录 repo path
- 校验路径存在/可写/是否为 Git repo（尽量）
- 如果未初始化 OpenSpec，标记稍后 bootstrap
- 进入 `collecting_description`

### 3) `/project desc <description>`
用途：记录项目描述。

行为：
- 写入 state
- 自动生成 `projectTitle` / `changeName`
- 进入 `bootstrapping`

### 4) `/project run`
用途：正式启动项目。

行为：
1. 如果 repo 未初始化 OpenSpec，则执行 `openspec init --tools none <path>`
2. 执行 `openspec new change <changeName> --description "..."`
3. 依次拉取 instructions：
   - proposal
   - specs
   - design
   - tasks
4. 驱动 worker 写这些工件
5. 当 tasks 生成完成后进入 `running`
6. 开始自动执行 task loop

### 5) `/project pause`
用途：请求暂停。

行为：
- 不粗暴 kill 当前轮
- 设置 `pauseRequested=true`
- worker 在最近安全点停止
- 状态转为 `paused`

### 6) `/project continue`
用途：从暂停或阻塞后继续。

行为：
- 读取当前 project state
- 重新喂给 worker 必要上下文
- 从 `tasks.md` 中下一个未完成任务继续

### 7) `/project status`
用途：查看项目当前状态。

输出建议：
- repoPath
- changeName
- status / phase
- 当前任务
- 完成数 / 未完成数
- 最近 checkpoint
- 是否 paused / blocked
- worker session 标识

### 8) `/project archive`
用途：收尾归档。

行为：
- 调 `openspec validate`
- 如果 change 已完成，则调 `openspec archive`
- 同时生成项目侧 archive 材料
- 状态转为 `archived`

---

## 10.3 V1.1 可选命令

### `/project note <text>`
向当前项目追加上下文，不重启项目。

### `/project summary`
输出当前项目的聚合摘要。

### `/project files`
输出本轮创建/修改/删除的关键文件。

### `/project tasks`
输出当前 `tasks.md` 的未完成项摘要。

### `/project stop`
硬停止（谨慎实现，V1 可不做）。

### `/project resume <projectId>`
从 archive 或现存状态恢复项目。

---

## 11. OpenSpec 集成方案

## 11.1 集成原则

1. **保留 OpenSpec 原生目录结构**
2. **不改 OpenSpec 的 canonical truth**
3. **插件只做 orchestrator，不做 schema owner**
4. **文档写入由 worker 完成，但目标路径与模板来自 OpenSpec**

## 11.2 canonical truth

以下内容应视为项目事实来源：

- `openspec/changes/<change>/proposal.md`
- `openspec/changes/<change>/specs/**`
- `openspec/changes/<change>/design.md`
- `openspec/changes/<change>/tasks.md`

其中，**任务真相必须在 `tasks.md`**。

插件不能自己再维护一份独立任务清单，否则迟早双份真相。

## 11.3 OpenSpec CLI 调用顺序

### Bootstrap
```bash
openspec init --tools none <repoPath>
```

### Create change
```bash
openspec new change <changeName> --description "<projectDescription>"
```

### Get artifact instructions
```bash
openspec instructions proposal --change <changeName>
openspec instructions specs --change <changeName>
openspec instructions design --change <changeName>
openspec instructions tasks --change <changeName>
```

### Track progress
```bash
openspec status --change <changeName>
```

### Validate
```bash
openspec validate <changeName> --type change --json --no-interactive
```

### Archive
```bash
openspec archive <changeName> -y
```

## 11.4 关键实现说明

OpenSpec 当前能提供的是：

- artifact 应该写到哪里
- artifact 依赖什么
- artifact 模板长什么样
- artifact 编写规则是什么

因此插件必须实现一个 **Instruction-to-Worker Adapter**：

```text
openspec instructions <artifact>
        |
        v
解析输出中的：output / instruction / template / dependencies
        |
        v
构造 worker prompt
        |
        v
让 worker 写入目标文件
```

换句话说：

> OpenSpec 不负责自己写 proposal/design/tasks；
> 它负责定义这些东西该怎么写。
> Worker 负责真正写出来。

---

## 12. Worker Session 设计

## 12.1 Worker 运行形态

推荐默认：**persistent worker session**。

优先级建议：

1. `runtime="acp"`, `mode="session"`
2. agentId 通过配置决定（例如 Codex / Claude Code）
3. thread 绑定作为 V1.1 可选项，不强制

原因：
- coding 类任务适合持久 session
- 可以跨多轮保留项目上下文
- plugin 可持续给这个 worker 下发任务

## 12.2 Worker 职责

worker 只负责做事，不负责项目总调度。

### 规划阶段职责
1. 读取项目描述
2. 读取 OpenSpec instructions
3. 写 proposal
4. 写 specs
5. 写 design
6. 写 tasks
7. 每步写完做简短总结

### 执行阶段职责
1. 读取 `tasks.md`
2. 选择下一个未完成任务
3. 执行实现
4. 更新 `tasks.md`
5. 输出 checkpoint：
   - 完成了什么
   - 修改了哪些文件
   - 当前是否 blocked
   - 建议是否继续

## 12.3 Worker 停止条件

worker 不应“随便停”。

只有以下情况可以停：

1. 全部 task 完成
2. 收到 pause 请求
3. 出现 blocker
4. 达到安全阈值（例如连续无进展）
5. 外部显式 stop

## 12.4 Checkpoint 输出协议（建议）

建议每轮 worker 结束返回标准结构：

```md
Status: running | blocked | paused | done
Completed Task: 2.3 Implement checkpoint summarizer
Files Changed:
- src/orchestrator/checkpoint-loop.ts
- src/worker/summaries.ts
Notes:
- 新增 checkpoint 聚合逻辑
- 尚未处理 archive export
Next Suggested Action:
- continue next task
```

插件根据这个结构决定是否自动续跑。

---

## 13. 自动续跑机制

## 13.1 原则

不要依赖“worker 汇报完之后自己想起来继续”。

应由 **plugin orchestrator** 来判断是否续跑。

## 13.2 自动续跑判定条件

每次 worker checkpoint 完成后，plugin 检查：

1. 当前 project status == `running`
2. 未设置 `pauseRequested`
3. checkpoint 不是 `blocked`
4. `tasks.md` 仍有未完成项
5. 未达到 `maxAutoContinueTurns`
6. 未触发“连续无进展保护”

若全部满足：
- 自动向 worker 发下一轮继续指令

否则：
- 停在当前状态并汇报

## 13.3 无进展保护

必须加保险，避免死循环。

建议：
- 若连续 2~3 轮未完成任何 task
- 或连续 2~3 轮只重复同一 blocker
- 自动转为 `blocked` 或 `paused`
- 通知用户介入

---

## 14. Pause / Continue 设计

## 14.1 Pause 语义

V1 采用 **cooperative pause**。

即：
- `/project pause` 不直接杀死 worker
- 而是把 `pauseRequested=true`
- worker 在当前安全点：
  - 写完本轮状态
  - 更新 `tasks.md`
  - 发 checkpoint
  - 停止后续自动续跑

状态流转：

```text
running -> pause_requested -> paused
```

## 14.2 Continue 语义

`/project continue` 时：

1. 清除 `pauseRequested`
2. 读取当前 `tasks.md`
3. 找出下一个未完成任务
4. 读取最近 archive / progress / summary
5. 重启 worker 到 `running`

---

## 15. 项目内辅助文件设计

除了 OpenSpec 的 canonical 工件外，插件还应在项目目录下维护自己的辅助状态。

建议放在：

```text
<repo>/.openclaw/clawspec/
```

### 15.1 建议文件

```text
<repo>/.openclaw/clawspec/
├── state.json
├── progress.md
├── changed-files.md
├── decision-log.md
├── latest-summary.md
└── archives/
    └── <projectId>/
        ├── session-summary.md
        ├── changed-files.md
        ├── decision-log.md
        ├── resume-context.md
        └── run-metadata.json
```

### 15.2 文件职责

#### `state.json`
插件内部状态真相。

#### `progress.md`
对人类友好的推进记录。

#### `changed-files.md`
记录本轮主要修改文件。

#### `decision-log.md`
记录关键设计决策，避免下次恢复时失忆。

#### `latest-summary.md`
便于快速 resume 的短摘要。

---

## 16. Archive 设计

## 16.1 为什么 archive 不能只靠 transcript

单纯保留 transcript 有几个问题：

1. 太长
2. 噪音多
3. 不利于下次快速恢复
4. 对项目理解不够结构化

因此 archive 应该输出的是：

- **项目知识摘要**
- **关键决策**
- **改动清单**
- **恢复上下文**

## 16.2 Archive 行为

执行 `/project archive` 时建议做以下动作：

1. 若 project 已完成，运行 `openspec archive <change> -y`
2. 生成项目执行总结：
   - `session-summary.md`
   - `changed-files.md`
   - `decision-log.md`
   - `resume-context.md`
   - `run-metadata.json`
3. 更新 plugin state：
   - `status = archived`
4. 向 channel 输出收尾汇报

## 16.3 Resume Context 内容建议

`resume-context.md` 应包含：

1. 当前项目目的
2. 当前 changeName
3. proposal/specs/design/tasks 路径
4. 已完成任务
5. 未完成任务
6. 关键决策
7. 当前代码状态摘要
8. 下次继续时建议先读哪些文件

---

## 17. 汇报策略

## 17.1 Checkpoint 汇报

每完成一项任务后，汇报应尽量短，但必须有信息密度。

推荐格式：

- 已完成任务：2.3 xxx
- 修改文件：a.ts, b.ts
- 当前状态：继续 / blocked / paused
- 下一步：2.4 yyy

## 17.2 Final 汇报

项目完成时，汇报应至少包含：

1. 总共完成了哪些 task group
2. 创建了哪些关键文件
3. 修改了哪些关键代码
4. 是否通过 validate
5. 是否已 archive
6. 后续待办 / 可选改进

---

## 18. OpenClaw Plugin 实现建议

## 18.1 index.ts 职责

`src/index.ts` 负责：

1. 注册所有 `/project` 命令
2. 初始化 state store
3. 初始化 OpenSpec adapter
4. 注册必要 hooks（如需）

## 18.2 Commands 层职责

命令层只做：

- 参数解析
- 调 orchestrator
- 输出用户可见结果

不要把核心业务逻辑塞进 command handler。

## 18.3 Orchestrator 层职责

orchestrator 负责：

- 状态流转
- 触发 worker
- 检查 checkpoint
- 自动续跑
- pause / continue / archive

这是插件的大脑。

## 18.4 OpenSpec Adapter 层职责

封装所有 CLI 调用，统一处理：

- cwd
- 编码
- stderr/stdout
- JSON / text 解析
- 超时
- 错误包装

不要在多个文件里散落 `exec('openspec ...')`。

## 18.5 State Store 层职责

封装：

- 读取 / 写入 project state
- 锁
- 多命令并发保护
- per-channel active project 映射

---

## 19. 关键实现细节与建议

## 19.1 path 选择策略

项目路径必须支持两种模式：

1. 用户显式指定绝对路径
2. 将来支持 preset / quick select（V2）

V1 先做显式路径即可。

## 19.2 slug / changeName 生成

建议根据 description 自动生成 kebab-case changeName，必要时可让用户覆盖。

例如：
- `channel-project-mode`
- `piper-auto-execution-loop`
- `openspec-project-orchestrator`

## 19.3 编码与命令执行

Windows 下必须统一处理 UTF-8 输出，避免 CLI 输出乱码。

## 19.4 任务状态维护

`tasks.md` 是唯一任务事实来源。

worker 更新规则：
- 未完成: `- [ ]`
- 完成: `- [x]`
- 若需要额外状态，插件另存在 `state.json`

不建议在 `tasks.md` 上引入太多自定义标记，先兼容 OpenSpec 默认格式。

## 19.5 设计与实现解耦

proposal/specs/design/tasks 四个工件生成完成前，不建议直接进入大规模代码实现。

也就是：

```text
Bootstrap -> Plan docs -> Validate docs baseline -> Execute tasks
```

这样更符合 OpenSpec 的精神。

---

## 20. 风险与取舍

## 20.1 风险：把插件做得过重

### 风险
如果一开始就想把：
- 多项目
- 多用户
- 多 worker
- UI
- approvals
- Git 集成
- PR 汇总
- 自定义 schema

全塞进去，项目很容易失控。

### 取舍
V1 必须只做一条主链：

- 单 channel
- 单 active project
- 单 worker
- 单 schema（spec-driven）

## 20.2 风险：双份任务真相

### 风险
插件维护一份任务状态，worker 又改 `tasks.md`，会发生冲突。

### 取舍
以 `tasks.md` 为 canonical truth，插件只缓存索引结果。

## 20.3 风险：自动续跑死循环

### 风险
worker 卡住后重复自催。

### 取舍
加：
- 无进展检测
- 最大自动续跑轮数
- blocker 升级机制

## 20.4 风险：OpenSpec 结构被篡改

### 风险
如果为了“更顺手”把 design/task 移到项目根目录，OpenSpec 的 status / archive / validate 容易失真。

### 取舍
保持 OpenSpec 默认结构，项目根目录只放 plugin 辅助文件。

---

## 21. 分阶段实施路线

## Phase 0 — Spike / 验证

目标：确认基础链路能跑通。

交付：
- 简单 plugin skeleton
- `/project start`
- `/project path`
- `/project desc`
- `/project run`
- 能调用 `openspec init` + `openspec new change`

## Phase 1 — 文档工件生成

目标：proposal/specs/design/tasks 自动落盘。

交付：
- OpenSpec adapter
- instructions 解析
- worker 写四类工件
- `openspec status` 联动

## Phase 2 — 自动任务执行循环

目标：让 worker 真正根据 tasks 推进。

交付：
- `tasks.md` 解析
- checkpoint loop
- 自动续跑
- 基本汇报

## Phase 3 — Pause / Continue / Archive

目标：项目可停可续可归档。

交付：
- pauseRequested
- continue
- archive 输出
- resume-context

## Phase 4 — 强化与体验优化

目标：更接近长期可用系统。

交付：
- 无进展保护
- changed-files 汇总
- decision-log 抽取
- per-channel 开关
- thread / UI / Git 改进（可选）

---

## 22. 验收标准（V1）

以下标准全部满足，V1 才算完成：

1. 用户能在 channel 中通过命令启动一个项目。
2. 能设置项目路径和项目描述。
3. 插件能在目标 repo 中初始化 OpenSpec（若尚未初始化）。
4. 插件能创建 change。
5. 插件能借助 `openspec instructions` 驱动 worker 生成：
   - proposal
   - specs
   - design
   - tasks
6. 插件能驱动 worker 根据 `tasks.md` 自动推进至少 2 个连续任务，无需用户手动逐轮继续。
7. `pause` 能在安全点暂停。
8. `continue` 能从未完成任务继续。
9. `status` 能正确显示当前项目信息。
10. `archive` 能把项目执行摘要落地到项目目录下。
11. 完成后能输出总体汇总：
   - 创建/修改文件
   - 完成任务
   - 当前状态
12. 整个流程不破坏 OpenSpec 默认工件结构。

---

## 23. 建议的初始命令 UX

```text
/project start
→ 进入新项目初始化流程

/project path C:\Users\Administrator\my-repo
→ 设置项目目录

/project desc 在 channel 中增加基于 OpenSpec 的项目执行模式，支持 start/pause/continue/archive
→ 设置项目描述

/project run
→ 初始化 OpenSpec / 创建 change / 生成 proposal/specs/design/tasks / 开始执行

/project status
→ 查看当前状态

/project pause
→ 在安全点暂停

/project continue
→ 继续执行

/project archive
→ 校验并归档
```

---

## 24. 建议的首版实现边界（很重要）

为了让项目能快速落地，V1 请坚持以下边界：

1. **只支持一个 active project / channel**
2. **只支持一个默认 schema: `spec-driven`**
3. **只支持一个 worker session**
4. **只用 OpenSpec 默认 proposal/specs/design/tasks**
5. **只做 cooperative pause，不做复杂强杀恢复**
6. **先不做 thread UI 增强**
7. **先不做真正的多项目调度器**

把这条主线跑通，比一开始贪大求全重要得多。

---

## 25. 最终结论

ClawSpec 的本质不是一个“命令插件”，而是：

> **一个基于 OpenSpec 工件体系、运行在 OpenClaw channel 里的项目编排层。**

它要解决的问题不是“生成一份 design.md”这么简单，而是：

- 如何把聊天式开发升级为项目式开发
- 如何让项目具备 start / run / pause / continue / archive 的完整生命周期
- 如何复用 OpenSpec 已有价值，而不是再造一套文档体系

最重要的设计原则只有三条：

1. **OpenSpec 保持 canonical workflow**
2. **OpenClaw plugin 负责 orchestration**
3. **tasks.md 是任务真相，worker 负责更新，plugin 负责推进**

如果后续实现严格沿着本文档推进，V1 应该可以落地出一个真正可用的项目执行插件，而不是又一个“聊一半就停”的 channel patch。

---

## 26. 附录：给实现 Agent 的启动建议

如果你是下一位接手实现的 Agent，建议执行顺序：

1. 先搭 plugin skeleton + `openclaw.plugin.json`
2. 先把 `/project start/path/desc/run/status` 跑通
3. 接 OpenSpec adapter
4. 能创建 change 并生成四类工件
5. 再接 worker 自动续跑
6. 最后接 pause / continue / archive

不要一上来就做 archive / resume / UI。
先把主链打通。别飘。
