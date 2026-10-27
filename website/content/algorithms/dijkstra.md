---
title: "Dijkstra：从松弛操作到堆优化"
description: "在非负边权的图上，如何把「当前最近」变成一个可以证明正确的贪心选择。"
date: "2026-10-26"
category: "题目解析"
tags: [图论, 最短路, 优先队列]
difficulty: "基础"
source: "https://www.luogu.com.cn/problem/P4779"
sourceLabel: "洛谷 P4779 · 单源最短路径（标准版）"
sample: true
featured: true
---

## 问题与约束

在带非负边权的有向图中，计算起点到每个顶点的最短距离。这份笔记以[洛谷 P4779](https://www.luogu.com.cn/problem/P4779)为练习入口；题目的完整数据范围以原题为准。

关键前提是**边权非负**。这个条件支撑了「取出当前距离最小的顶点后，其距离已经确定」的判断。

## 松弛操作

若当前有一条经过 `u` 到达 `v` 的更短路径，就更新 `dist[v]`。用小根堆维护待处理的候选距离，每次取出最小者。

同一个顶点可能多次入堆。弹出时，如果候选距离已经不等于当前的 `dist[u]`，说明这是旧状态，直接跳过。

## C++17 实现

下面的程序读取 `n, m, s` 和全部有向边。原题保证从起点可达所有顶点；代码额外以 `-1` 表示不可达，便于作为通用模板修改。

```cpp
#include <bits/stdc++.h>
using namespace std;
using ll = long long;

int main() {
    ios::sync_with_stdio(false);
    cin.tie(nullptr);

    int n, m, s;
    cin >> n >> m >> s;
    vector<vector<pair<int, ll>>> graph(n + 1);
    for (int i = 0; i < m; ++i) {
        int u, v;
        ll w;
        cin >> u >> v >> w;
        graph[u].push_back({v, w});
    }

    const ll INF = numeric_limits<ll>::max() / 4;
    vector<ll> dist(n + 1, INF);
    priority_queue<pair<ll, int>, vector<pair<ll, int>>,
                   greater<pair<ll, int>>> pq;
    dist[s] = 0;
    pq.push({0, s});

    while (!pq.empty()) {
        auto [d, u] = pq.top();
        pq.pop();
        if (d != dist[u]) continue;
        for (auto [v, w] : graph[u]) {
            if (dist[v] > d + w) {
                dist[v] = d + w;
                pq.push({dist[v], v});
            }
        }
    }

    for (int v = 1; v <= n; ++v)
        cout << (dist[v] == INF ? -1 : dist[v])
             << (v == n ? '\n' : ' ');
}
```

## 为什么需要跳过旧状态

例如，某个顶点先以距离 10 入堆，之后又被更新成距离 7。堆里仍然保留着距离 10 的旧条目。跳过它能避免重复扫描邻接边。

对于这份保留重复条目的实现，时间复杂度可写作 `O(n + m log(m + 1))`，空间复杂度为 `O(n + m)`。简单图中通常也写作 `O((n + m) log n)`。关于该实现的补充说明，可阅读 [CP-Algorithms 的稀疏图 Dijkstra](https://cp-algorithms.com/graph/dijkstra_sparse.html)。

## 边界检查

- 只有一个顶点、没有边时，起点距离是 0。
- 重边不需要预处理，松弛操作自然选择更短的路径。
- 零权边是允许的，负权边则不能套用这个结论。
- 使用足够宽的整数类型，并确认距离相加不会溢出。

## 回顾提示

重新做题时，先尝试不看代码解释：为什么非负边权能保证已经确定的最短距离不会被后来路径改小？
