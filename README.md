# 循环决议（dsh-council）使用说明书

> **一句话说明**：让你的 AI 不再"一个人说了算"——它会先想清楚"做成什么样算好"，再派给**执行者**去做，由**检验者**按标准逐条验收，不达标自动返工，直到达标后再自己抽查一遍才交付给你。

适用环境：DeepSeek Harness（DSH）桌面版或命令行版，已安装 Agent Teams。

---

## 目录

1. [它解决什么问题](#一它解决什么问题)
2. [三个角色](#二三个角色)
3. [安装](#三安装)
4. [快速开始](#四快速开始)
5. [工作流程详解](#五工作流程详解)
6. [工具参考](#六工具参考)
7. [配置项](#七配置项)
8. [调优建议](#八调优建议)
9. [常见问题](#九常见问题)
10. [卸载](#十卸载)
11. [开发者信息](#十一开发者信息)

---

## 一、它解决什么问题

AI 单打独斗时有两个常见毛病：

| 毛病 | 表现 | 本插件的对策 |
|---|---|---|
| **自说自话** | 做完了自己宣布"已完成" | "完成"由**检验者**判定，不达标自动返工 |
| **一条路走到黑** | 方向错了还继续挖，越挖越贵 | Leader 可以**中途改标准、改方向、收回权限**，轮次到顶强制交回你决断 |

代价是多了两次往返。所以它只适合**可检验的实活**（改代码、写文档、查证材料），不适合闲聊和一次就能答完的问题——指令里已经明确要求 AI 自己判断，不要滥用。

---

## 二、三个角色

```
        你（用户）
          │  对话
          ▼
   ┌──────────────┐
   │    Leader    │  ← 你正在对话的这个 AI
   │  理解/判断/交付 │
   └──┬────────┬──┘
      │派活     │送检
      ▼        ▲
 ┌─────────┐  ┌──────────┐
 │ 执行者   │─▶│ 检验者    │
 │ 动手做   │  │ 逐条判定  │
 └─────────┘  └──────────┘
```

**三方上下文完全独立**——执行者和检验者不知道你们聊过什么，所有信息通过插件拼装的简报传递。这不是限制，恰恰是省 token 的关键：它们只看到"这一轮该干什么"，看不到整段历史。

| 角色 | 职责 | 不能做什么 |
|---|---|---|
| **Leader** | 理解你的话、定标准、派活、判断、交付 | 不能自己下场代替执行者 |
| **执行者** | 按简报把活做出来，附证据回报 | 不能改标准，不能宣布通过 |
| **检验者** | 逐条判定 PASS/FAIL，给可执行的修复意见 | **默认禁用写文件工具**，只判不动手 |

**权限不对称是硬约束**：六个 `council_*` 工具只在 Leader 手里注册，两位成员的 step 里根本看不到它们。所以它们在机制上不可能自己改标准、也不可能自己宣布通过——不是靠提示词自觉。

---

## 三、安装

### 前置条件

- DeepSeek Harness（桌面版或 CLI）
- 已启用 **Agent Teams**（`@deepseek-ai/dsh-experimental-agent-team`）
- Node.js ≥ 22.19.0

### 安装步骤

1. 把本仓库放到任意目录，例如 `~/dsh-plugins/dsh-council`
2. 在 DSH 里让 AI 执行安装，或直接调用插件管理器：

```
安装插件：install_bundle，target 填本目录的绝对路径
```

3. 看到 `application: applied` 即安装成功。
4. **重开一个会话**（已存在的会话保持它启动时的插件版本）。

### 验证安装

在新会话里问：

> 现在有哪些 council 工具？

AI 应能列出 `council_start` / `council_send` / `council_verdict` / `council_policy` / `council_status` / `council_finish` 六个。

也可以让 AI 直接调 `council_status`，未开局时会返回：

```
阶段：idle　轮次：0
成员：
· lead（运行中）
尚未开局：先 council_start。
```

---

## 四、快速开始

装好后**不需要任何配置**，直接用自然语言提需求即可。AI 会自己判断要不要开局。

**推荐的说法**（明确、可检验）：

> 帮我把 X 功能实现出来，并且保证有测试。

> 帮我查证"某说法"是否成立，要给出可追溯的来源。

**不建议的说法**（会浪费 token）：

> 这个报错是什么意思？ ← 一句话能答完的，不要开局

**你也可以直接指挥循环**：

> 这轮标准太松了，把第 2 条改成"必须有实际命令输出作为证据"再重来。

> 检验者老挑毛病但都不是成果问题，停了吧，把情况告诉我。

> 别再让执行者改文件了，把它的写文件权限收回来。

---

## 五、工作流程详解

### 5.1 开局

Leader 调用 `council_start`，做两件事：

1. **登记任务和验收标准**——3~6 条，每条都要能被第三方判定（要有路径、命令、证据）
2. **创建两位成员**——`executor` 和 `verifier`

好标准 vs 坏标准的例子：

| ❌ 不可判定 | ✅ 可判定 |
|---|---|
| 代码质量要好 | `npm test` 退出码为 0 |
| 文档要完整 | README 含"安装/使用/配置"三个二级标题 |
| 性能有提升 | 同一输入下 `time` 输出 < 200ms |

### 5.2 派活

`council_send(to="executor")` 发送派活简报。简报由插件自动拼装：

```
【第 1 轮 · 执行】
<任务>

验收标准（检验者会逐条判定，没有证据的条目判 FAIL）：
1. ...
2. ...

写入范围（只改这些）：src/a.js、src/b.js

做到以上各条即停手，不要扩大范围，也不要替检验者下结论。
回报格式（≤15 行）：做了什么 / 改了哪些文件 / 怎么自查的 / 残余风险。
```

Leader 只补一句可选的 `note`，**不重复粘贴任务全文**——这是省 token 的关键设计。

### 5.3 检验

拿到执行者回报后，`council_send(to="verifier", report=回报原文)` 送检。检验简报会把标准和执行者自述一起给检验者，并要求：

> 逐条判定，每行：标准编号 → PASS/FAIL → 证据（路径:行 或 命令输出）→ 必须修的问题（≤5 条）。
> 没有证据的条目判 FAIL。只判定、不改文件、不重做任务。

### 5.4 裁决与循环

Leader 用 `council_verdict` 记录结论：

- **PASS** → 阶段转 `ready`，Leader 自己再抽查一遍 → `council_finish` → 回复你
- **FAIL** → 自动开下一轮，`fixes` 会附到下一轮任务里
- **到轮次上限**（默认 2 轮）→ 阶段转 `escalated`，**强制停止**，把卡点和取舍交回你

### 5.5 Leader 的三个"刹车"

这是本插件的核心判断力，写在提示词里约束 Leader：

| 情况 | Leader 该做的 |
|---|---|
| 检验者反复针对**标准**而不是成果 | 用 `council_verdict(criteria=[...])` **修订标准**，而不是逼执行者再改一遍 |
| 连续两轮同一条失败，或失败与目标无关 | 停手，把取舍交给你，不空转 |
| 执行者越界（乱删、跑危险命令） | 用 `council_policy(deny=[...])` **真收权**，而不是喊话 |

---

## 六、工具参考

> 这六个工具**只有 Leader 能调用**。

### `council_start` — 开局

| 参数 | 必填 | 说明 |
|---|---|---|
| `task` | ✅ | 要做成什么（一句话，含边界） |
| `criteria` | ✅ | 可判定的验收标准，3~6 条 |
| `files` | | 预计改动的文件/目录（相对工作目录） |

返回：轮次、阶段、新建成员、成员状态、下一步提示。

### `council_send` — 派活 / 送检

| 参数 | 说明 |
|---|---|
| `to` | 成员名（默认执行者） |
| `note` | 可选，补一句上下文，≤500 字 |
| `report` | 送检时填执行者回报原文（不填则用最近一次记录） |

### `council_verdict` — 记录裁决

| 参数 | 说明 |
|---|---|
| `verdict` | `PASS` 或 `FAIL` |
| `fixes` | FAIL 时**必填**，必须修的问题（≤5 条） |
| `criteria` | 可选，修订后的**完整**标准列表（旧标准自动入历史） |
| `report` | 可选，检验者原文（≤2000 字） |

### `council_policy` — 收权 / 放权

| 参数 | 说明 |
|---|---|
| `target` | 成员名 |
| `deny` | 收回这些工具 |
| `allow` | 只保留这些工具（白名单） |

未知工具名会被丢弃并在 `dropped` 里回报，不会静默生效。限制会同时发一条消息告知对方，避免它反复撞墙。

### `council_status` — 看板

无参数。返回轮次、阶段、任务、标准、成员状态、生效限制、裁决历史。

### `council_finish` — 收尾

| 参数 | 说明 |
|---|---|
| `summary` | 可选，交付摘要 |
| `accepted` | 默认 `true`；`false` 表转 `escalated` |

只记账，**不代替 Leader 回复你**。

---

## 七、配置项

改 `cordis.patch.yml` 的 `config`，或在 profile 的 patch 层覆盖。

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关。`false` 时插件加载但不注册任何工具 |
| `executorName` | `executor` | 执行者名字（lower-kebab-case） |
| `verifierName` | `verifier` | 检验者名字（不能与执行者重名） |
| `context` | `fresh` | `fresh` 零上下文；`fork` 继承 Leader 已完成的轮次 |
| `maxRounds` | `2` | 最多几轮「派活→检验」，1~8 |
| `maxMessageChars` | `4000` | 单条团队消息上限，防止把整段对话塞给对方 |
| `verifierDenyTools` | 见下 | 检验者默认禁用的工具 |
| `executorDenyTools` | `[]` | 执行者默认禁用的工具 |
| `persist` | `true` | 决议板是否落盘 |
| `boardFile` | `.council/board.json` | 决议板路径（相对工作目录） |

**检验者默认禁用**：
`write`、`edit`、`apply_patch`、`ops_write_file`、`ops_edit_file`、`ops_replace`、`ops_remove`、`ops_move`、`ops_copy`

**配置示例**（放宽到 3 轮、检验者额外禁用 shell）：

```yaml
- insert:
    - id: dsh-council
      name: dsh-council
      config:
        maxRounds: 3
        verifierDenyTools:
          - write
          - edit
          - apply_patch
          - bash
          - ops_bash
```

非法配置会**响亮失败**（抛错），不会静默回落默认值。

---

## 八、调优建议

| 你的感受 | 调整 |
|---|---|
| 太慢、轮次太多 | `maxRounds: 1` |
| 返工不够、想更严 | `maxRounds: 3`，并在标准里要求"每条都要贴命令输出" |
| 嫌它话太多 | `maxMessageChars: 2000` |
| 想让成员了解我们的对话 | `context: fork`（代价：token 明显上升） |
| 执行者毛手毛脚 | `executorDenyTools: ["ops_remove", "ops_move"]` 长期收权 |
| 不想留文件 | `persist: false` |

---

## 九、常见问题

**Q：装好了但 AI 不用它？**
A：直接说"用 council 跑这个任务"。若还不用，可能是任务本身不可检验（比如"帮我想个名字"），那是正确行为。

**Q：报错说没有 Agent Teams？**
A：本插件依赖 Agent Teams 服务。插件本身能加载，但 `council_*` 会如实报错。安装 `@deepseek-ai/dsh-experimental-agent-team` + `@deepseek-ai/dsh-experimental-tool-agent-team` 后**重开会话**。

**Q：装完没反应？**
A：**重开会话**。已存在的会话保持启动时的插件版本。

**Q：检验者说改不了文件？**
A：这是设计如此，默认禁写。需要它改就是 Leader 用错了角色。

**Q：决议板存在哪？**
A：`<工作目录>/.council/board.json`（可用 `boardFile` 改）。删掉就重置。

**Q：会不会把我的整个对话发给成员？**
A：不会。成员只收到插件拼装的简报，Leader 的补充被限制在 500 字以内。

**Q：跑一半想停？**
A：直接说"停"。也可以让它 `council_finish(accepted: false)` 记为 `escalated`。

---

## 十、卸载

在 DSH 插件管理器里移除 bundle `dsh-council`，或：

```
remove_bundle，target 填 dsh-council
```

然后重开会话。工作目录里的 `.council/` 可手动删除。

---

## 十一、开发者信息

```
dsh-council/
├── index.js              # 插件入口：注册工具 + 协议提示词
├── lib/
│   ├── config.js         # 配置默认值与校验
│   ├── board.js          # 决议板（串行更新 + 落盘）
│   ├── briefs.js         # 派活/送检简报模板
│   └── tools.js          # 六个工具的实现
├── test/
│   ├── unit.mjs          # 纯函数单测
│   └── smoke.mjs         # 假 ctx 跑完整生命周期
├── locale/{zh,en}.json   # 插件管理器显示名与描述
├── icon.svg
└── cordis.patch.yml      # 挂载行
```

**跑测试**：

```bash
npm test
```

期望输出：

```
ALL LOCAL TESTS PASSED
SMOKE PASSED
  tools: council_finish, council_policy, council_send, council_start, council_status, council_verdict
  verifier deny: write, edit
  rounds: 2 phase: accepted
```

**设计要点**：

- `apply` 返回值保持 `undefined`，工具注册绑定在插件 fiber 上，卸载即撤销
- 每个 Lead 会话一块独立决议板，按窗口工作目录区分，互不串味
- 板子更新走串行 promise 链 + `structuredClone` 快照，并发调用不互相覆盖
- 成员被重新唤醒（新 agent 实例）时自动重装工具限制
- 不静态 import 任何 `@deepseek-ai/*`，入口加载时这些包未必可见

**兼容的 Harness 版本**：0.2.2-rc.1 系列（`ctx.agentTeams` / `ctx.tools.restrict` / `ctx.systemPrompt.section` / `agent/created` 事件）。

---

## 许可

MIT
