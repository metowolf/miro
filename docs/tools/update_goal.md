# update_goal / set_goal_budget

目标（`/goal`）模式下仅有的两个模型侧工具：把目标推进到终态，或给目标设一道硬预算。
两者都不碰文件、不起子进程，改的是运行时状态而不是工作区，所以语义上同 `update_tasks`
——不弹审批框。

| 属性 | `update_goal` | `set_goal_budget` |
| --- | --- | --- |
| kind | `goal` | `goal` |
| UI 标题 | Update goal | Set goal budget |
| 实现 | `src/miro/tools/update-goal.js` | 同左 |
| 需要审批 | 否 | 否 |
| 可并行 | 是，可与同批的 `read` / `search` / `tasks` / `goal` 一起跑，上限 8 | 同左 |
| 可流式抢跑 | 是 | 是 |

## 装配条件

目标状态（`src/miro/goal.js` 的 `createGoalState()` 实例）由 `createToolRunners` 注入，
不是模块级单例：同一进程里可以有多个会话，共享一份状态会让它们互相覆盖。

- 没有传 `goal` 时**两个工具都不装配**。schemas 会过滤掉没有 runner 的工具，所以无目标的
  会话根本看不到它们，模型不会去调一个必然失败的工具。
- `MAIN_AGENT_ONLY_TOOLS` 把两个名字排除在子智能体的白名单之外。目标是整个会话的状态，
  让子智能体宣布「目标完成」或改预算，等于用局部结论覆盖全局状态；同时也避免了子智能体
  看得到 schema 却调不动（`Unknown tool`）。

## update_goal

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `status` | `active` / `complete` / `blocked` | 是 | 新的目标状态。 |
| `reason` | string | 否（讲 `blocked` 时实质必填） | 简短原因，展示给用户。 |

`paused` 不在可写枚举里：暂停是用户侧的 `/goal pause` 与中断的产物，模型只能把它恢复成
`active`。未知状态返回 `update_goal: invalid status ...`，不改动现有目标。

各状态的行为：

- `active`：恢复 `paused` / `blocked` 的目标，不结束本回合（只回一行 `Goal resumed. ...`）。
  已经 `active` 时回 `Goal already active.`；已经 `complete` 时拒绝恢复。
- `complete`：落终态并返回 `stopTurn`。输出里附一句「下一条消息写完成总结」。
- `blocked`：落终态并返回 `stopTurn`，输出里附一句「向用户解释阻塞点与需要什么」。
- 目标在本轮进行中被用户取消时，如实回 `Goal not updated: no current goal.`，而不是静默
  新建一个；目标已处于非 `active` 终态时拒绝二次改状态。

`update_goal` 的 `description` 本身就是行为约束（多数回合不该调用、3 轮 blocked 门槛、
完成审计），不是可选的说明文字：改写措辞会直接影响模型会不会只写了个计划就宣布完成。

## set_goal_budget

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `value` | number | 是 | 预算数值，必须为正。 |
| `unit` | `turns` / `tokens` / `milliseconds` / `seconds` / `minutes` / `hours` | 是 | 数值的单位。 |

`budgetLimitsFromInput` 负责换算与校验：单位受支持时换算成内部的
`{ turnBudget, tokenBudget, wallClockBudgetMs }`（三者只设置被指定的那一项），
回合数与 token 数取整且最小为 1，时间预算最小 1 秒、上限不限。非法数值、不支持的
单位、过小的时间预算都返回明确的错误文本并保持原预算不变——静默取整成 1 秒会让
「30 毫秒内完成」变成一次无声的行为改变。

设完就已经超预算是合法结局（例如「20 轮内完成」但已经跑了 25 轮）：此时立刻把目标置为
`blocked` 并返回 `stopTurn`，比让模型继续跑到下一次预算检查更诚实。

## 与循环的配合

`src/miro/agent-loop.js` 里三处专门配合目标：

- **提醒刷新**：每轮按当前状态重算目标提醒，先摘掉历史里旧的几份（按
  `GOAL_NOTICE_PREFIXES` 前缀识别）再推新的一份。进度、预算余量与状态每轮都在变，留着
  过期的那份会让模型同时读到「目标进行中」和「目标已暂停」两种矛盾说法。
- **轮次之间检查预算**：一个回合可以跑满轮次上限，token 与墙钟都在这中间累积，只在回合
  边界判定会把「30 分钟内完成」变成「30 分钟加上最后一个回合」。触顶时先用
  `GOAL_BUDGET_STOP_REMINDER` 给一轮宽限（让模型自己写总结），宽限用过就硬停。
- **token 只算输出**：输入里绝大部分是每轮重发的同一段历史，按总量计会让「500k tokens」
  在长会话里几轮就用光，而那与模型实际做了多少工作无关。

`stopTurn: true` 只是把本回合标记为「到此收尾」，不回滚已经跑起来的同批调用：那批结果
仍要按声明顺序回填，丢掉它们会让历史里出现没有结果的 `tool_call`，下一次请求被协议层
直接拒掉。

## 使用约定

- 只有用户明确给出时限（「20 轮内」「30 分钟内」「别超过 500k token」）才设预算；含糊的
  「花点时间」「尽量快点」不能当成预算，更不能由模型自己发明。
- 复合时间先换算成一个单位：「2 小时 3 分钟」是 `value: 123, unit: "minutes"`。
- 预算到顶是 `blocked` 而不是 `complete`，用户可以 `/goal resume` 继续。
- 终态摘要由模型在随后的正文里写；工具输出只负责给一句该写什么的提示。
