# glob

按 glob 模式查找文件，返回相对搜索目录的路径列表。纯 Node 实现，不依赖 `fd`。

| 属性 | 值 |
| --- | --- |
| kind | `search` |
| UI 标题 | Glob |
| 实现 | `src/miro/tools/glob.js` |
| 需要审批 | 否 |
| 可并行 | 是，可与同批的 `read` / `search` / `tasks` 一起跑，上限 8 |
| 可流式抢跑 | 是 |

## 参数

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `pattern` | string | 是 | 要匹配的模式，如 `*.ts`、`**/*.json`、`src/**/*.spec.ts`。 |
| `path` | string | 否 | 搜索目录，默认当前目录（`.`）。 |
| `limit` | number | 否 | 最多返回多少条结果，默认 1000。 |

`limit` 不是正数时回退默认值。`path` 只接受目录：不存在返回 `glob: path not found`，
不是目录返回 `glob: not a directory`。

## 执行过程

1. 解析 `path`（相对路径拼工作区）并校验是目录。
2. 用 `fs.glob` 遍历，`dot: false`（隐藏文件不进结果），先按
   [共用忽略规则](./README.md#忽略规则搜索类工具共用) 剪枝，产出路径再逐段复查一遍，
   兜住回调没剪干净的情况。
3. 只报告文件：每个候选都 `stat` 一次，目录命中直接丢掉——对调用方没有价值。`stat`
   失败（断链的符号链接）也跳过。
4. 达到 `limit` 立即停止遍历。
5. 结果按路径排序后输出。

## 输出格式

路径之间用换行分隔，路径相对搜索目录：

```text
src/components/App.jsx
src/components/Message.jsx
src/main.js
```

- 整体输出超过 30 000 字符时截断。
- 达到上限时追加 `[1000 results limit reached. Use limit=2000 for more, or refine pattern]`。
- 一条都没找到时输出 `No files found matching pattern`。
- 模式本身非法时返回 `glob: invalid pattern: <原因>`（例如括号不闭合）。

## 与其他工具的分工

| 想做的事 | 用哪个 |
| --- | --- |
| 知道文件名形状，找文件 | `glob` |
| 知道内容片段，找位置 | `grep` |
| 已经知道路径 | `read_file` |
| 要看目录结构细节（大小、权限） | `terminal` 里的 `ls` / `find` |

`glob` 只回答「有哪些文件」，不返回文件内容，也不返回行号。拿到路径后按需要交给
`read_file` 或 `grep`。

隐藏文件（`dot: false`）与忽略目录都不会出现在结果里。确实需要搜 `.git`、
`node_modules` 这类目录时，`glob` 与 `grep` 都不是合适入口：改成在 `terminal` 里用
受限范围的 `ls` / `find`，或者先确认这件事真的必要。
