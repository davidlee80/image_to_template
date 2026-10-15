# 评估记录（evaluation）

记录各阶段真实样本评估、策略参数与环境事实。**全页和区域视觉阈值在 T08/T10
真实评估后冻结**；本文不预设"95% 还原"之类的门槛，不把差异比例当还原率。

## 1. 策略参数（当前实施默认值，均待真实样本校准）

| 参数 | 默认值 | 出处 |
|---|---|---|
| pixelmatch threshold / includeAA | 0.15 / false | T07（设计初始值） |
| 低置信度阈值 | 0.7 | T10（设计初始值） |
| 补丁幅度：位置单轮/累计 | 8px / 24px | T14（实施默认） |
| 补丁幅度：字号单轮/累计 | 2px / 4px | T14（实施默认） |
| 校准迭代 | 默认 3、上限 5 | T15 |
| 校准最小改善幅度 | 全页 mismatchRatio 下降 ≥ 0.05% | T15（实施默认） |
| 区域回退容差 | 任一区域上升 > 0.2% 即拒绝 | T15（实施默认） |
| 区域评价区域 | header（顶部 12%）/ timeline（左栏 55%）/ photos（右栏 50%）/ sidebar（右下 38%） | T14（设计默认划分） |
| 分页块安全边距 | 2px | T13 |
| 字号下限 | 9px（不无限缩小） | T13 |

## 2. 环境事实（影响像素基准，跨系统结果不得直接对比）

| 事实 | 影响 | 处理 |
|---|---|---|
| ~~本机 Playwright Chromium 无 CJK 字体~~（2026-10-15 已解除） | 曾导致无 manifest 回退时中文渲染空白 | 仓库 fonts/ 携带思源字体（SIL OFL 1.1）；携带字体的包严格渲染中文通过（回归：tests/integration/fonts-delivery.test.ts）；不带字体的包仍回退系统字体 |
| 携带字体的 HTML 嵌入体积 | 三槽全用约 37MB（思源宋体 11.6MB 主因）；sans+latin 常见组合约 22MB | HTML 为中间产物（交付物是 PNG/PDF）；后续可优化为 woff2 子集 |
| 控制台中文乱码（GBK 代码页） | 终端显示不可作为内容判定依据 | 以工具读取（JSON/文件）为准 |
| PowerShell Constrained Language | .NET 调用被禁 | 用 npm/Node 工具链 |

## 3. 真实样本评估（T08 / T10 步骤 7）

**待真实素材（授权字体、模型配置、3～5 张类似图）到位后建立。**
每张样本记录：关键文字正确性（人工逐字核对）、漏识别/冲突数、复查项数量、
溢出情况、调用次数、耗时与可获得的费用数据。

## 4. 自动校准评估（D 阶段）

**待 T08 基准完成后建立。** 记录每轮补丁、区域分数变化、接受/拒绝原因
（report.calibration 与 history/calibration.json）；改善必须有区域证据。

## 5. 已完成验证（离线链路，2026-10-14）

| 验收维度 | 证据 |
|---|---|
| 分页无丢字/重字/空页 | `tests/integration/adaptive.test.ts`（12 项恰好出现一次、页号连续、无空页） |
| PNG/PDF 页数一致 | 同上（PDF 页对象数 ≥ PNG 页数） |
| 超大块报错不裁切 | 同上（OVERSIZED_BLOCK → failed，无 pages 产物） |
| scale 仅改栅格分辨率 | 同上（逻辑宽度不变、输出翻倍） |
| 补丁白名单/幅度/累计 | `tests/unit/patch.test.ts`（改正文/改图/未知 ID/超限/4 轮累积拦截） |
| 校准改善接受/退化拒绝/回滚 | `tests/integration/calibrate.test.ts`（6 用例：接受+快照、区域回退拒绝、非法补丁不改写、迭代/预算上限、中断恢复、内容编辑拒绝） |
| 复查结论哈希绑定 | `tests/integration/validate.test.ts`（模板变化后 stale 检出） |
| 导出/重载离线完整 | 同上（新位置结构校验 + 可渲染） |
| 批量汇总与隔离 | `tests/integration/batch.test.ts`（失败不污染、汇总完整、严格策略） |

全量测试：`npm run check` 与 `npm test` 通过（220 tests / 219 pass / 1 skip；
skip 为 Windows 符号链接权限用例）。
