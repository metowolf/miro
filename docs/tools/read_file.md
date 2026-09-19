# read_file

把文本文件按行读进上下文，行首带行号。这是 `edit_file` 的前置步骤：改哪一段，得先看
到那一段的原文。

| 属性 | 值 |
| --- | --- |
| kind | `read` |
| UI 标题 | Read |
| 实现 | `src/miro/tools/read-file.js` |
| 需要审批 | 否（只读） |
| 可并行 | 是，可与同批的 `read` / `search` / `tasks` 一起跑，上限 8 |
| 可流式抢跑 | 是 |

## 参数

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `path` | string | 是 | 要读的路径，绝对路径或相对工作区。 |
| `offset` | integer ≥ 0 | 否 | 从第几行开始（从 0 计），默认 0。 |
| `limit` | integer 1–10000 | 否 | 最多返回多少行，默认 2000。 |

参数非法时返回的是可读的错误文本，而不是抛出异常：`offset` / `limit` 不是安全整数或
越界时报 `read: 'offset' must be an integer between 0 and ...`。

## 执行过程

1. `path.resolve(cwd, path)`，命中设备路径黑名单（`/dev/zero`、`/dev/random`、
   `/dev/urandom`、`/dev/full`、`/dev/stdin`、`/dev/stdout`、`/dev/stderr`、`/dev/tty`、
   `/dev/console`、`/dev/fd/0`、`/dev/fd/1`、`/dev/fd/2`）时直接拒绝——这些路径会无限
   产出数据，读下去会挂住整个回合。
2. `realpath` + `stat`。目录直接报错并建议改用 `glob`；其它非普通文件（管道、设备）报
   `read: path is not a regular file`。读不到时错误信息带原始路径。
3. 读前 4096 字节做二进制嗅探：出现 `\0`，或者不可打印字节（`< 9` 或 `13 < b < 32`）
   占比超过 30%，就判定为二进制并拒绝。
4. 以 64 KiB 块流式扫描文件，一边按行切分一边累计输出预算；只有落在请求区间内的行才会
   写进结果，整条超长行也不会被完整留在内存里。
5. 逐行做 16 KiB 的行内截断、逐条累计输出字节数，超过上限就停止收集并给出续读提示。

## 输出格式

```text
12→const answer = 42;
13→console.log(answer);

[end of file; showed lines 12-13 of 137]
```

- 行格式是 `行号→内容`，行号从 1 开始，`offset` 里给的偏移也按这个口径回填。
- 结尾提示有两种：还有剩余内容时是
  `[showed lines 12-13; more content remains; use offset=13 for the rest]`，读到文件末尾
  时是 `[end of file; showed lines 12-13 of 137]`。提示里的 `offset` 可以直接回填到下一次
  调用。
- 空文件返回 `[empty file]`。
- 有行被 16 KiB 截断时追加
  `[one or more lines were truncated to 16 KiB; use grep or terminal for an exact long-line slice]`。
- `offset` 超出文件末尾时报 `read: offset N is beyond end of file (M lines total)`。

工具返回的 `content` 是这份文本，`locations` 是 `[{ path, line: offset + 1 }]`。

## 限制

- 输出总字节数上限 512 KiB，其中为结尾提示预留 1 KiB；超出的部分不返回，靠 `offset`
  继续读。
- 单行上限 16 KiB；超长行（压缩后的 JS、单行 JSON）会被截断。
- 输出里的行尾统一按 `\n` 处理，`\r\n` 与 `\r` 都会被归一化。
- `offset` / `limit` 都按**行**计，不按字节或字符。

## 与 edit_file 的配合

`edit_file` 不再引用行号，而是按原文精确替换，所以读回来的内容要用在 `oldText` 上：
`oldText` 必须是文件里当前真实存在、且唯一的一段文本，行号只用来定位，删掉行号也不会
影响匹配。要看某段旧文本是否仍与磁盘一致，重新 `read_file` 或 `grep` 一次再改。

## 常见错误

| 现象 | 原因 |
| --- | --- |
| `read: path is a directory; use glob instead` | 传了目录。 |
| `read: cannot read binary file` | 命中了二进制嗅探，改用 `terminal` 里的 `file` 看类型，或用能处理二进制的命令。 |
| `read: refusing unsafe device path` | 传了设备路径。 |
| `read: offset N is beyond end of file` | `offset` 超过了文件总行数。 |
