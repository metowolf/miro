# edit_file

按精确文本替换改动已有文件：每处改动给出「旧文本 → 新文本」，旧文本必须唯一出现
（除非该处打开 `replaceAll`），全部改动都以原文件为基准匹配，落盘走原子替换。

| 属性 | 值 |
| --- | --- |
| kind | `edit` |
| UI 标题 | Edit |
| 实现 | `src/miro/tools/edit-file.js` |
| 需要审批 | 是（`auto` 下有效路径仍在工作区内时自动放行；越界或经现有符号链接逃出工作区需单次审批；`manual` 下一律审批） |
| 可并行 | 否，按调用顺序串行 |
| 可流式抢跑 | 仅当它是本批的第一个调用、且该次判定不需要弹审批框 |

## 参数

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `path` | string | 是 | 要编辑的路径，绝对路径或相对工作区。 |
| `edits` | array，至少 1 项 | 是 | 一处或多处替换，全部以原文为基准。 |

`edits[i]` 的字段：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `oldText` | string | 是 | 要替换掉的原文；默认必须唯一，不够独特时把上下文一起带上。 |
| `newText` | string | 是 | 替换后的内容；空串表示删除。 |
| `replaceAll` | boolean | 否 | 设为 `true` 时替换 `oldText` 的所有出现（例如全文重命名一个符号）；默认 `false`，此时 `oldText` 不唯一会报错。 |

`edits` 也兼容字符串（会被 `JSON.parse`）、单个对象，以及把 `oldText` / `newText` 直接
放在顶层。`oldText` 为空串会被拒绝：新建文件请用 `write_file`。

`replaceAll` 只对同一处 `edit` 生效，且只作用于精确匹配（按非重叠方式计数）；整行 trim
与 Unicode 归一化兜底即使开了 `replaceAll` 也仍要求候选唯一。要改多处不同片段，仍然放在
`edits` 数组里。

## 匹配规则

每处 `oldText` 依次按三种方式定位，全部相对**原始文件内容**：

1. **精确匹配**：`oldText` 在原文里恰好出现一次时直接命中。出现多次时，未开
   `replaceAll` 报 `oldText appears N matches at lines …`，把上下文写得更独特后重试；
   开了 `replaceAll` 则逐个命中。
2. **整行 trim 匹配**：精确匹配失败（通常是缩进或行尾空格对不上）时，按整行
   `trim()` 后的内容比较，仍要求候选唯一。命中多个时报
   `line-trimmed matching found N matches at lines …`。
3. **Unicode 归一化匹配**：前两种都失败时，逐行执行 NFKC、去掉行尾空白，并把弯引号、
   Unicode 横线及特殊空格折叠为 ASCII 等价字符。命中必须唯一；命中区间会映回原文并再次
   归一化校验，映射若会吞入模型未指定的兼容字符则按未命中处理。

三轮都没命中的报 `oldText was not found (exact, line-trimmed, or normalized match)`，并提示用
`read_file` 确认磁盘上的真实内容。

所有区间算好后统一校验：任一处与另一处重叠时报 `overlap; merge them into one edit`。
多处改动会按起点从后往前拼接，前面的区间不会因为后面的改动而移位。

## 编码与行尾

- 只接受 UTF-8 文本：解码走严格模式，带 NUL 字节或非法 UTF-8（例如 UTF-16、GBK）
  直接报错且不改动原始字节，避免把 U+FFFD 乱码写回。
- 读文件时保留 BOM，写回时恢复。
- 行尾按文件自身的风格处理，不会整文件抹平：
  - 纯 `\r\n` 文件在匹配视图里折成 `\n`，新文本写回时还原成 `\r\n`；
  - 纯 `\n` 文件原样处理；
  - **混合行尾**（`\r\n` 与裸 `\n` 混用，或存在孤立 `\r`）不会被统一：匹配仍在视图里
    做（`\r\n` 折成 `\n`，孤立的 `\r` 作为普通内容字符保留），落盘时只重写命中的
    片段，未改动部分按原文原样拼回；新文本的行尾沿用被替换片段自身的风格。

## 落盘

- 原子写：先解析写入目标（`realpath`，因此编辑符号链接时改的是链接指向的真实文件，
  而不是把链接本身换掉），再在同目录写 `.miro-edit-<uuid>.tmp`，用原文件的 mode
  `chmod` 后 `rename` 覆盖；中途出错会删掉临时文件并返回
  `edit_file: cannot write <path>: <原因>`。
- 替换后内容仍与原文完全一致时不落盘，直接返回 `No changes to make …`，不产生无意义
  的 mtime 变化与空 diff。
- 路径权限由循环层统一审批，执行器不会二次拦截已经获准的越界写入。

## 返回值

`output` 是一行摘要，例如 `Replaced 2 blocks in /workspace/src/app.js`（`blocks` 是最终
命中的替换处数，`replaceAll` 时即出现次数）。若其中有用到整行 trim 兜底匹配，会追加
`(N via line-trimmed match; re-read to confirm whitespace)`，提醒改动位置的缩进与
`oldText` 并不完全一致。

`content` 是给 UI 的 diff 块（新旧内容各截断到 80 000 字符），`locations` 是文件路径。
若使用 Unicode 归一化兜底，摘要会追加 `via normalized match`，提醒重新读取确认标点与空格。

## 常见错误与处理

| 错误 | 处理 |
| --- | --- |
| `oldText must not be empty` | 用 `write_file` 新建文件。 |
| `oldText appears N matches at lines …` | 旧文本不唯一：补上前后文，或把该处 `replaceAll` 设为 `true`。 |
| `oldText was not found (exact, line-trimmed, or normalized match)` | 先 `read_file` / `grep` 确认磁盘上的真实内容。 |
| `overlap; merge them into one edit` | 把相交的两处合并成一条 edit，或在同一条里给出完整替换文本。 |
| `looks like a binary file (contains NUL bytes)` | 不是文本文件，别用 `edit_file`。 |
| `is not valid UTF-8 text` | 先转成 UTF-8（例如 `iconv`）再编辑。 |
| `cannot read <path>` | 路径不存在或不可读。 |

## 与 write_file 的分工

- 局部改动、以现有内容为基准：`edit_file`。
- 新建文件、整文件重写：`write_file`。

`edit_file` 的安全性来自「旧文本必须真实存在，且默认唯一」：匹配不上时它宁可失败，也
不会按行号盲写，更不会静默把改动落到已经变过的内容上。`replaceAll` 是需要显式打开的
逃生口，默认行为仍逐处要求唯一。
