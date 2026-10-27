---
title: "Agent 的可靠性，从一个可控的执行循环开始"
description: "拆开规划、工具调用与状态管理，聊聊一个 Agent 从「能跑」走向「可控」的起点。"
date: "2026-10-26"
category: "Agent 工程"
tags: [Agent, 架构设计, 工具调用]
featured: true
sample: true
---

## 先把循环画出来

一个最小的 Agent 可以拆成四步：读取上下文、生成下一步行动、执行工具、把结果写回状态。难点往往不在第一次调用模型，而在于循环的第十次、异常发生之后，以及用户中途改变目标的时候。

把这四步显式写下来，能帮助我们回答一个朴素的问题：**系统现在在哪里，接下来允许发生什么？**

```text
context → plan → action → observation
   ↑                          ↓
   └──────── state ────────────┘
```

## 给每一步定义边界

模型的输出应该先被解析和验证，再进入工具执行器。工具调用失败时，记录可供下一轮使用的错误类型；涉及外部副作用时，先检查权限与当前任务范围。

| 阶段 | 输入 | 必须留下的记录 |
| --- | --- | --- |
| 规划 | 用户目标与当前状态 | 计划版本、选择原因 |
| 行动 | 已验证的工具参数 | 调用 ID、开始时间 |
| 观察 | 工具的成功或失败结果 | 结构化结果、错误类型 |
| 收尾 | 终止条件与已有证据 | 完成状态、未解决事项 |

不要只保留最后的回答。中间状态决定了系统是否能解释失败、恢复执行，以及判断有没有重复操作。

## 把停止条件写进设计

循环至少需要三类出口：目标已经完成、预算已经用尽、需要外部输入。把「暂时做不下去」表达成明确状态，比让模型继续猜测更容易调试。

```python
def run_agent(state, model, tools, max_steps=12):
    for step in range(max_steps):
        decision = model.decide(state)
        if decision.kind == "finish":
            return {"status": "completed", "result": decision.result}
        if decision.kind == "ask_user":
            return {"status": "waiting", "question": decision.question}

        # execute_checked 负责参数验证、授权、超时和异常归一化。
        result = tools.execute_checked(decision.action)
        state = state.with_observation(result)

    return {"status": "budget_exhausted", "state": state}
```

这是一个结构示例，不是完整的生产实现。并发、取消、持久化、幂等键，以及对不可信工具结果的处理，都应该在具体系统中单独设计。

## 调试时，先看轨迹

当结果不符合预期时，可以沿着执行轨迹逐层排查：目标是否被正确理解、工具是否被正确选择、参数是否完整、结果有没有被误读。

一个实用的起点是给每次任务分配 `run_id`，给每次工具调用分配 `call_id`，并记录延迟与状态。日志中应删除凭证及与排查无关的敏感内容。

## 留给真实项目的问题

- 哪些操作可以安全重试，哪些必须带幂等键？
- 用户取消时，哪些工具能中止，哪些需要补偿？
- 状态恢复后，如何避免重复执行已经成功的行动？
- 评估集是否包含超时、权限不足与半完成的任务？

先让循环可观察、可停止，再讨论更复杂的规划策略。
