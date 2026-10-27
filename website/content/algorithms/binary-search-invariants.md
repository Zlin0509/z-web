---
title: "二分查找：先写不变量，再写 while"
description: "把边界交给区间语义。用半开区间与单调谓词，统一理解常见二分问题。"
date: "2026-10-26"
category: "算法专题"
tags: [二分, 边界处理]
difficulty: "入门"
sample: true
---

## 明确要找哪一侧

考虑一个单调布尔序列：左边全为 `false`，右边全为 `true`。目标是找到第一个 `true` 的位置；如果不存在，返回数组长度 `n`。

比起记忆某个二分模板，更可靠的起点是明确：哪些位置已被排除，答案还有可能在哪里。

## 半开区间的含义

用 `[left, right)` 保存待检查范围，初始为 `[0, n)`。循环过程中，`left` 左侧已知都是 `false`，`right` 及其右侧已知都是 `true`，其中 `n` 是一个不需要实际读取的哨兵答案。

```cpp
template <class Predicate>
int first_true(int n, Predicate check) {
    int left = 0, right = n;
    while (left < right) {
        int mid = left + (right - left) / 2;
        if (check(mid)) right = mid;
        else left = mid + 1;
    }
    return left;
}
```

当 `check(mid)` 成立时，`mid` 可能就是答案，所以把 `right` 移到它的位置；否则，`mid` 已被排除，新的左边界是 `mid + 1`。

## lower_bound 只是一个实例

在升序数组里查找第一个不小于 `target` 的位置，可以把谓词设为 `a[i] >= target`。

```cpp
vector<int> a = {1, 2, 2, 5, 9};
int target = 2;
int pos = first_true(static_cast<int>(a.size()), [&](int i) {
    return a[i] >= target;
});
// pos == 1
```

此片段需要与上面的 `first_true` 一起使用，并包含 `<vector>` 和相应的命名空间声明。

## 用四组边界验证

| 输入情形 | 预期返回 |
| --- | --- |
| 空数组 | 0 |
| 全部 false | n |
| 全部 true | 0 |
| 只有最后一个 true | n - 1 |

每轮都必须缩小区间，否则可能出现死循环。`left + (right - left) / 2` 在非负、合法的整型索引范围内也避免了直接计算 `left + right` 的溢出风险。

## 二分答案之前

把这套方法搬到答案空间时，需要先证明判定函数的单调性，再确认搜索上下界覆盖所有可能答案。如果判定本身没有单调性，再熟练的模板也不能保证正确。
