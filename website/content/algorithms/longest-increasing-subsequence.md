---
title: "最长上升子序列：换一个状态，少一层枚举"
description: "从 O(n²) 动态规划走到 O(n log n)，理解 tails 数组究竟保存了什么。"
date: "2026-10-26"
category: "算法专题"
tags: [动态规划, 二分, 贪心]
difficulty: "进阶"
sample: true
---

## 从直接的状态开始

定义 `dp[i]` 为以第 `i` 个元素结尾的严格上升子序列的最大长度。枚举之前的所有位置 `j`，当 `a[j] < a[i]` 时尝试转移。

这个定义很直观，但枚举前驱让时间复杂度达到 `O(n²)`。想去掉一层枚举，就需要考虑哪些状态可以合并。

## 相同长度，只保留更小的结尾

对于长度相同的上升子序列，结尾越小，越容易接上未来的元素。因此定义 `tails[k]` 为长度 `k + 1` 的上升子序列能取得的最小结尾值。

处理一个新元素 `x` 时，找到第一个不小于它的结尾值并替换；如果所有结尾都更小，就把它追加到数组末尾。

```cpp
#include <algorithm>
#include <vector>
using namespace std;

int lis_length(const vector<int>& a) {
    vector<int> tails;
    for (int x : a) {
        auto it = lower_bound(tails.begin(), tails.end(), x);
        if (it == tails.end()) tails.push_back(x);
        else *it = x;
    }
    return static_cast<int>(tails.size());
}
```

## 用一个序列走一遍

对 `[3, 1, 2, 5, 4]`，状态变化如下：

| 读入元素 | tails |
| --- | --- |
| 3 | [3] |
| 1 | [1] |
| 2 | [1, 2] |
| 5 | [1, 2, 5] |
| 4 | [1, 2, 4] |

最终长度为 3。替换结尾没有增加序列长度，但为后续扩展创造了更好的条件。`tails` 记录每个长度的最优结尾，**一般不能直接当作原数组里的一条合法子序列输出**。

## 严格与非严格的区别

严格上升使用 `lower_bound`，因为相同元素不能延长序列。若要求最长不下降子序列，则用 `upper_bound` 寻找第一个严格大于当前值的位置。

对 `[2, 2, 2]`，严格上升的答案是 1，不下降的答案是 3。这个小例子适合检查边界。

## 复杂度与延伸

每个元素执行一次二分，总时间复杂度是 `O(n log n)`，额外空间是 `O(n)`。若需要还原具体序列，还要记录前驱索引与各长度的末尾位置。

可以继续阅读 [CP-Algorithms 的 LIS 专题](https://cp-algorithms.com/sequences/longest_increasing_subsequence.html)，对照理解状态、证明与序列还原的区别。
