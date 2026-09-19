/** /init 发给模型的预置提示词（Cantonese）。 */

export const INIT_PROMPT = `請分析呢個代碼庫，然後建立一個 AGENTS.md 檔案，佢會提供俾之後嘅 AI agent 會話，用嚟在本倉庫裏面做嘢。

需要寫入嘅內容：
1. 常用命令，例如點樣建置、檢查代碼風格、跑測試。包括在本代碼庫開發所必需嘅命令，例如點樣跑單個測試。
2. 高層次嘅代碼架構同結構，令之後嘅會話快啲上手。重點寫嗰啲要讀好幾個檔案先睇得明嘅「全局」架構。

使用須知：
- 如果已經有 AGENTS.md，就針對佢提出改進。
- 第一次建立 AGENTS.md 嘅時候唔好重複囉唆，亦唔好寫「俾用戶有幫助嘅錯誤訊息」「為所有新工具函數寫單元測試」「唔好將敏感資訊（API key、token）寫入代碼或者提交」呢類一眼就知嘅指示。
- 唔好逐個羅列一眼就見到嘅組件或者檔案結構。
- 唔好寫通用嘅開發實踐。
- 如果有 Cursor 規則（.cursor/rules/ 或者 .cursorrules）或者 Copilot 規則（.github/copilot-instructions.md），一定要將裏面重要嘅部分納入。
- 如果有 README.md，一定要將裏面重要嘅部分納入。
- 唔好編造「常見開發任務」「開發小技巧」「支援同文檔」呢類資訊，除非你讀到嘅其他檔案真係明確寫咗。
- 除引言之外嘅正文請用粵語書面語撰寫。
- 請一定要在檔案開頭加上以下內容：

\`\`\`
# AGENTS.md

This file provides guidance to AI coding agents when working with code in this repository.
\`\`\``;

/** 追加用户参数时的引导语。 */
export const INIT_EXTRA_HEADING = "以下係用戶追加嘅指令（佢嘅優先級高過上面嘅預設要求）：";
