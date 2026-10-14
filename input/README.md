# input/ 真实基准图说明

本目录用于存放真实旅行攻略基准图片（T08 真实验收的输入）。

## 当前状态

**基准图已提供**（2026-10-14 记录）：`input/travel_plan_page_0005.png`
（PNG 1653×2339，SHA-256 见 `docs/wiki/baseline.md`）。已随仓库提交。

T08 真实验收仍需：文本逐字核对基准、合法授权字体、模型配置与一次真实调用。
在字体与模型配置到位前，离线测试继续使用 `tests/fixtures/images/synthetic-travel.png`
（合成图），仅用于验证工程链路。
