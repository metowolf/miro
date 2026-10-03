/** /init 发给模型的预置提示词（Chinese）。 */

export const INIT_PROMPT = `请分析这个代码库并创建一个 AGENTS.md 文件，它会被提供给后续的 AI agent 会话，用于在本仓库中工作。

需要写入的内容：
1. 常用命令，例如如何构建、检查代码风格、运行测试。包含在本代码库中开发所必需的命令，例如如何运行单个测试。
2. 高层次的代码架构与结构，让后续会话能更快进入状态。重点写那些需要读多个文件才能理解的「全局」架构。

使用须知：
- 如果已经存在 AGENTS.md，则针对它提出改进。
- 首次创建 AGENTS.md 时不要重复啰嗦，也不要写「给用户提供有帮助的错误信息」「为所有新工具函数编写单元测试」「不要把敏感信息（API key、token）写进代码或提交」这类显而易见的指示。
- 不要罗列那些一眼就能发现的每个组件或文件结构。
- 不要写通用的开发实践。
- 如果存在 Cursor 规则（.cursor/rules/ 或 .cursorrules）或 Copilot 规则（.github/copilot-instructions.md），务必把其中重要的部分纳入。
- 如果存在 README.md，务必把其中重要的部分纳入。
- 不要编造「常见开发任务」「开发小技巧」「支持与文档」这类信息，除非你读到的其他文件里确实明确写了。
- 除引言之外的正文请使用中文撰写。
- 请务必在文件开头加上以下内容：

\`\`\`
# AGENTS.md

This file provides guidance to AI coding agents when working with code in this repository.
\`\`\``;

/** 追加用户参数时的引导语。 */
export const INIT_EXTRA_HEADING = "以下是用户追加的指令（其优先级高于上面的默认要求）：";
