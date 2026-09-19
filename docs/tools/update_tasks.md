# update_tasks

维护本周回合的进度清单。任务清单独立于权限模式与工具审批，也不需要用户批准——它的
作用是让长流程在几十次工具调用之后仍然记得目标。

| 属性 | 值 |
| --- | --- |
| kind | `tasks` |
| UI 标题 | Update tasks |
| 实现 | `src/miro/tools/update-tasks.js` |
| 需要审批 | 否 |
| 可并行 | 是，可与同批的 `read` / `search` / `tasks` 一起跑，上限 8 |
| 可流式抢跑 | 是 |

## 参数

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `tasks` | array | 是 | 当前**完整**清单，按顺序排列。 |

`tasks[i]` 的字段：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `step` | string | 是 | 这一步要做什么。 |
| `status` | `pending` / `in_progress` / `completed` | 是 | 这一步的状态。 |

一次调用提交的是整张清单，不是增量补丁：要改某一步的状态，就把完整清单再发一遍。

## 校验与归一化

- `tasks` 不是数组时报 `update_tasks: missing required parameter 'tasks' (an array of
  {step, status})`。
- 每一项必须是对象；`step`（也接受 ACP 同构的 `content` 字段名）去空白后不能为空，
  否则报 `update_tasks: tasks[i] is missing a non-empty step`。
- `status` 不在枚举里时按 `pending` 处理，不让一个拼错的字符串使整张清单作废。
- 归一化后同时只能有**一个** `in_progress`，出现两个报
  `update_tasks: at most one step can be in_progress at a time`。这是硬约束，不是建议：
  「同时进行两步」在清单里无法区分哪一步是当前焦点。

## 输出与渲染

- 非空清单：输出 `Updated N task(s).`，随后每行 `- [status] step`。
  ```text
  Updated 3 tasks.
  - [completed] 读源码里 8 个内置工具的 schema 与执行器
  - [in_progress] 为每个工具写 docs/tools/<name>.md
  - [pending] 写 docs/tools/README.md 索引
  ```
- 空数组：输出 `Task list cleared.`，同时清空界面上的清单块。

归一化后的条目通过 `onUpdate` 回调转成 `plan` 事件，`App.jsx` 再调用 `store.setPlan()`；
transcript 上的清单块由 store 生成。内容完全相同的快照会被去重，所以重复提交同一张
清单不会在界面上再落一个块。

## 使用约定

- 多步、要跑好几轮工具的任务才值得用；一两次调用能做完的事不必铺清单。
- 每次提交完整清单；把做完的标成 `completed`，当前的标成 `in_progress`，其余为
  `pending`。
- 子智能体看不到这个工具：清单属于父会话，子智能体写入会覆盖父的进度。
