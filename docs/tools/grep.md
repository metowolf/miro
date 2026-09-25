# grep

在工作区里递归搜索文件内容，返回命中行与行号。纯 Node 实现，不依赖机器上有没有
ripgrep。

| 属性 | 值 |
| --- | --- |
| kind | `search` |
| UI 标题 | Grep |
| 实现 | `src/miro/tools/grep.js` |
| 需要审批 | 否 |
| 可并行 | 是，可与同批的 `read` / `search` / `tasks` 一起跑，上限 8 |
| 可流式抢跑 | 是 |

## 参数

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `pattern` | string | 是 | 搜索模式，默认按正则解释。 |
| `path` | string | 否 | 要搜的目录或文件，默认当前目录（`.`）。 |
| `glob` | string | 否 | 文件过滤，如 `*.ts`、`**/*.spec.ts`，默认 `**/*`。 |
| `ignoreCase` | boolean | 否 | 忽略大小写，默认 false。 |
| `literal` | boolean | 否 | 把 `pattern` 当字面量而不是正则，默认 false。 |
| `context` | number | 否 | 每条命中前后各显示多少行，默认 0。 |
| `limit` | number | 否 | 最多返回多少条命中，默认 100。 |

`context` 为负数按 0 处理；`limit` 不是正数时回退默认值。`literal: true` 时模式会先做
正则元字符转义，再走同一条匹配管线——不是另开一条代码路径。

## 执行过程

1. 编译正则。非法模式返回 `grep: invalid pattern: <原因>`。
2. 解析 `path`：绝对路径直接用，相对路径拼工作区；`stat` 失败返回 `grep: path not found`。
3. 是文件时只搜这一个文件，忽略 `glob` 参数，不套用目录忽略规则；是目录时用 `fs.glob`
   按模式遍历（`dot: false`），套用包含父级和嵌套 `.gitignore` 的
   [共用忽略规则](./README.md#忽略规则搜索类工具共用)，结果按路径排序。
4. 逐个文件读入（`utf8`），跳过：非普通文件、大于 512 KiB 的文件、内容里含 `\0` 的
   二进制文件、读失败的文件。
5. 按行匹配，累计命中数，达到 `limit` 就停止遍历后续文件。
6. `context > 0` 时把每条命中的 `[i-context, i+context]` 收成互不重叠的区间，相邻区间
   也合并，避免同一行被打印两遍。

## 输出格式

`context` 为 0（默认）：

```text
src/cli.js:120: const provider = options.provider ?? null;
src/cli.js:184: if (provider) return provider;
```

`context` 大于 0：命中行用 `:` 分隔，上下文行用 `-` 分隔（与 `grep -C` 的约定一致）：

```text
src/cli.js-118- function resolveProvider(options) {
src/cli.js:120: const provider = options.provider ?? null;
src/cli.js-121- return provider ?? "miro";
```

- 单行超过 500 字符时截断并加 `…`：一行压缩后的代码不该吃掉整个输出预算。
- 整体输出超过 30 000 字符时截断。
- 结局提示按情况追加一行方括号说明：
  - 达到数量上限：`[100 matches limit reached. Use limit=200 for more, or refine pattern]`
  - 出现长行截断：`[Some lines truncated to 500 chars. Use read_file to see full lines]`
- 一条都没命中时输出 `No matches found`（不是空字符串，模型能明确知道搜索跑过了）。

## 什么时候用它

- 找符号定义、调用点、文案出现位置：比先 `glob` 列文件再逐个 `read_file` 省上下文。
- 想要上下文不看全文件：配合 `context: 3` 一次拿到足够判断的片段，需要细看再用
  `read_file` 读那一段。
- 需要精确到「某个字符串」而不是模式：`literal: true`，免得 `(`、`[` 这类字符被当成
  正则语义。

搜索范围要收窄时优先用 `path` 与 `glob`，而不是把 `limit` 调大：结果上限只是安全阀，
真正影响上下文的是命中内容本身。
