# write_file

整文件写入：新建文件，或把已有文件整体替换成给定内容。

| 属性 | 值 |
| --- | --- |
| kind | `edit` |
| UI 标题 | Edit |
| 实现 | `src/miro/tools/write-file.js` |
| 需要审批 | 是（`auto` 下有效路径仍在工作区内时自动放行；越界或经现有符号链接逃出工作区需单次审批；`manual` 下一律审批） |
| 可并行 | 否，按调用顺序串行 |
| 可流式抢跑 | 仅当它是本批的第一个调用、且该次判定不需要弹审批框 |

## 参数

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `path` | string | 是 | 要写入的路径，绝对路径或相对工作区。 |
| `content` | string | 是 | 文件的完整新内容。 |

缺 `path` 报 `edit: missing required parameter 'path'`，`content` 不是字符串报
`edit: missing required parameter 'content' (full file text)`——错误信息里的前缀是 `edit`，
这是从「写与改共用一个 Edit 工具」时期沿用下来的措辞。

## 执行过程

1. 解析路径（绝对路径直接用，相对路径拼 `cwd`）。
2. 尽力读一次旧内容，读不到就是 `null`（新文件）。
3. `Bun.write(path, content)` 整文件覆盖。
4. 统计行数：按 `\n` 切分，末尾换行不计空行，所以 `"a\n"` 是 1 行，`""` 是 0 行。
5. 返回 `Wrote N line(s) to <path>`，以及一份 diff content 块与 `locations`。

路径授权不在这个执行器里做：越界写入该不该问，由循环层的权限判定统一决定，执行器
不再二次拦截已经获批的路径。

## 审批时看到什么

`write_file` 的 kind 是 `edit`，会走 `CONFIRM_KINDS` 的审批路径。但它**没有** `preview`
预检函数，因为审批发生在读旧文件之前——此刻还没有 `oldText`。审批弹窗拿到的 diff 由
`extractToolDiff` 的 content 分支从 `rawInput.content` 拼出「新建预览」。

真正落盘后返回的那份 diff 有旧内容：`oldText` 与 `newText` 都各自截断到 80 000 字符
（`EDIT_PREVIEW_LINES(400) × 200`）。这只是展示用预览，写入的内容是完整的。

## 什么时候该用它

- 新建文件。
- 整文件重写：内容几乎全部要改，或者要重新组织结构。

其余情况用 `edit_file`：它按精确旧文本做定点替换，改动量、diff 体积和审批时用户要看的
内容都小得多，也不会因为一次大段写入把整份文件替换成模型记忆里的版本。

`write_file` 不会校验 `content` 是否与旧内容有实质差异，也不做冲突检测——它对文件的
现状没有认知，直接覆盖。需要「基于当前内容改」的语义就用 `edit_file`。

## 兼容说明

`write-file.js` 额外导出 `editTool`，等于 `writeFileTool`，是拆分 write / edit 之前的
公开导出名，仅为兼容保留。
