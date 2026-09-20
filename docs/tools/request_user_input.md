# `request_user_input`

向用户提出需要决定的结构化问题。交互式 Default 与 Plan 模式都可使用；非交互运行和子智能体不暴露此工具，避免等待无人操作的弹窗。

## 参数

- `questions`：1–4 个问题。
- 每个问题必须有唯一 `id`、不超过 12 个字符的 `header`、完整 `question`，以及 2–4 个 label 唯一的选项。
- 每个选项包含 `label` 与 `description`；单选题还可提供 Markdown `preview`。
- `multiSelect: true` 允许多选。多选题不支持 preview，因为 preview 面板用于比较互斥方案。

无 preview 的题目会自动提供 `Other` 自定义答案；preview 题改为提供可选备注。多题与多选题可在 Submit 页复核并返回修改，也允许带着未回答项提交。

结果按问题 id 回灌：

```json
{
  "answers": { "library": "A, Custom choice" },
  "annotations": {
    "approach": { "preview": "selected Markdown", "notes": "user notes" }
  }
}
```

多选答案以 `, ` 连接；未回答项省略。用户取消时，模型应根据已有证据采用最佳假设继续，而不是原样重问。

## 权限与限制

仅用于无法从代码库或上下文查明、且会实质改变结果的缺失信息、偏好与取舍。工具使用模态 UI，因此不参与并行或流式抢跑。
