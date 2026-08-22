# GoGauge for Chrome — OpenCode Go 用量仪表盘

> Chrome 扩展版 · 本地优先 · 自动读取 opencode.ai 登录态 · 仅在点击【增量同步】后才拉取 · 支持缓存命中率 / 配额窗口 / Token 构成分析

![Version](https://img.shields.io/badge/version-1.0.0-blue)
![Manifest](https://img.shields.io/badge/manifest-v3-green)
![License](https://img.shields.io/badge/license-MIT-lightgrey)
![Chrome](https://img.shields.io/badge/chrome-%3E%3D88-orange)

<p align="center">
  <img src="icons/icon128.png" width="72" alt="GoGauge">
</p>

受 [yphyphyph/opencode-go-gauge](https://github.com/yphyphyph/opencode-go-gauge) 启发，将其 Python + pywebview 的“配额解析 + 用量明细”完整移植为 **Chrome 扩展（Manifest V3）**。图标与视觉参考 [OnesoftQwQ/opencode-go-copilot](https://github.com/OnesoftQwQ/opencode-go-copilot)，主题自动跟随浏览器/系统（prefers-color-scheme），无需手动切换。

---

## 特性

| 能力 | 说明 |
|------|------|
| **配额窗口** | 5h Rolling / Weekly / Monthly 进度条 + 剩余可用 % + 距重置倒计时，正则解析 opencode.ai/workspace/<id>/go HTML |
| **用量概览** | 命中率 / 命中量 / 总 Token（含缓存）/ 请求数 / 会话数 / 费用（USD / CNY 实时汇率） |
| **缓存命中率** | hit / (hit + miss)，同时展示命中/未命中绝对量，口径与原版 db.py:totals() 完全一致 |
| **今日趋势** | 24h 输入/输出/推理柱状图（IndexedDB 聚合） |
| **模型分析** | Token 构成 · 模型占比环形图 · 模型排行 · 按输入/输出/费用趋势（复用 Chart.js） |
| **使用记录** | 请求级明细分页（20 条/页）+ 模型筛选 + 时间范围（今天/7 天/30 天/全部） |
| **自动登录** | 安装后只要在浏览器登录过 https://opencode.ai，扩展通过 chrome.cookies 自动读取 auth Cookie，无需粘贴 token；监听 cookies.onChanged 即时刷新登录态 |
| **手动触发** | **绝不自动拉取** — 仅在用户点击「增量同步 / 全部同步」后才执行批量请求，避免大流量误触 |
| **增量同步（智能）** | 动态拉取直到与本地重叠为止，按“同一分钟”比对 count / tokenSum / cost，不一致时弹出不可关闭的抉择框（通知栏也推送），可选：重新全量 / 拼接 / 忽略 |
| **全量同步（探测）** | 指数探测总页数 2048 -> 4096 -> 8192 ... 直到空页，二分精确定位，进度条显示真实 当前页 / 总页数；无 2000 页上限，受 **100 MB 本地存储上限** 约束，超限自动截断或提示 |
| **极速开关** | 仪表盘“极速同步” = 并发 20 + 无间隔；关闭则并发 5 + 150ms 间隔，避免 429 限流 |
| **本地优先** | 全量写入 IndexedDB (goGauge) + chrome.storage.local，**不上传、不遥测、不落盘到第三方**，卸载扩展即清空 |
| **深浅色自适应** | 跟随系统 prefers-color-scheme，弹窗/仪表盘/通知/toast 全链路暗色适配，修复“同步中红底黑字”等对比度问题 |
| **通知兜底** | 增量不一致时即使未打开仪表盘，也通过 chrome.notifications 推送到系统通知中心，避免用户错过抉择 |

## 预览

| 弹窗（Popup） | 仪表盘（Dashboard） |
|---|---|
| 顶部登录态 + 配额窗口进度条 + 用量概览（30d 默认）+ 缓存命中率进度条 | 侧边栏：仪表盘 / 模型分析 / 使用记录 / 设置 · 顶部同步 Banner + 总页数进度 |
| ![popup](icons/icon128.png) | ![dashboard](icons/icon128.png) |

> 可自行截图替换占位图，文件置于 docs/screenshots/ 并在 README 引用即可。

---

## 快速开始（给使用者）

### 方式 A — 下载 Release（推荐，他人安装同此）

1. 打开本仓库右侧 **Releases**，下载最新 go-usage.zip
2. 解压到本地任意目录（不要删除，Chrome 需持续读取）
3. 打开 chrome://extensions → 右上角开启 **开发者模式**
4. 点击 **加载已解压的扩展程序** → 选择解压后的文件夹
5. 在浏览器登录一次 https://opencode.ai（已登录则跳过）
6. 点击工具栏 **GoGauge** 图标 → 确认显示“已登录” → 点 **增量同步** 或 **全部同步**
7. 同步完成后点 **打开完整仪表盘** 查看详细分析

> 更新：重新下载 zip 覆盖解压，然后在 chrome://extensions 点扩展卡片的 **刷新** 即可。

### 方式 B — 从源码安装

```powershell
git clone https://github.com/wwwzzzxxx/opencode-go-gauge-chrome.git
# 直接在 chrome://extensions 加载已解压的扩展程序，选择项目根目录即可
# 无需 npm / build，改完代码后点“刷新”即生效
```

### 打包分发

```powershell
powershell .\build.ps1
# 输出 go-usage.zip（已自动排除 .git / *.zip），可直接发给他人或上传 Chrome Web Store
```

---

## 使用约定

1. **参考项目**：配额正则与 /_server 解析与 [opencode-go-gauge](https://github.com/yphyphyph/opencode-go-gauge) 保持一致；UI 图标与部分动效参考 [opencode-go-copilot](https://github.com/OnesoftQwQ/opencode-go-copilot)。
2. **自动获取 Cookie**：src/background.js:checkAuth() 通过 chrome.cookies.get({url:"https://opencode.ai/", name:"auth"}) + getAll({domain:"opencode.ai"}) 读取；cookies.onChanged + Content Script 嗅探 wrk_xxx 自动写入 workspaceId，无需手动粘贴。
3. **人为点击才统计**：未注册任何 alarms 自启动；runSync() 仅在收到 START_SYNC（弹窗或仪表盘按钮）后执行；扩展安装 / 浏览器启动 / 弹窗打开均不会自动请求大批量数据。进度与取消按钮完整暴露，支持中途取消。

---

## 同步模式详解

### 增量同步（左侧主按钮）

- **不再固定 250 条**。改为：以 20 并发（极速）/ 5 并发（普通）持续拉取，直到某一分钟的数据在本地能查到且 count / tokenSum / cost 完全一致 — 视为已追到重叠点，自动停止并拼接。
- **分钟级校验**：同一分钟内的多条 API 调用会聚合成 minute=YYYY-MM-DDTHH:mm 的摘要比对，避免单纯时间戳 30 分钟窗口的歧义。
- **不一致处理**：若本地与远端同一分钟的量不一致（说明缓存已失效/历史被改写），会在**扫完总页数后立刻**弹出**不可点掉**的模态框 + 系统通知，三个选项：
  - **重新全量**：清空 IndexedDB 后按全量逻辑重拉（最稳）
  - **从此处拼接**：删除该分钟及之后本地数据，保留远端该分钟起的新数据
  - **忽略继续**：保留本地，仅追加新拉取部分
- 弹窗收敛为**单次汇总**，即使本地存在多个不一致分钟也只弹一次，避免多文件时连弹。
- 进度：增量不再显示虚假“共 50000”，仅全量显示二分探测的真实总数；增量进度按 200 页分段平滑，避免跳动。

### 全部同步（右侧次按钮）

- **先探测总页数**：指数探索 2048 -> 4096 -> 8192 -> ... 直到命中空页，再二分查找精确总页数（例如 5000 页会显示为 5000 而非固定 50000）。
- **100 MB 上限**：探测与拉取全程预估 perPageBytes，若 currentBytes + batchBytes > 100MB 则停止并提示“已达到 100MB 上限”。仪表盘与弹窗的“已用/剩余”文案统一。
- **无 2000 页上限**：全量由探测结果决定，MAX_FULL_PAGES 不再写死 2000。
- **并发**：极速 20 / 普通 5，可在仪表盘设置页切换；进度 Banner 实时显示 第 X-Y / 共 N 页 · 已拉取 M 条。

### 去哪触发

- 弹窗：**增量同步**（主）+ **全部同步**（次）
- 仪表盘顶部：同样的两个按钮（文案已统一为“增量同步 / 全部同步”），点击后顶部出现同步 Banner，支持取消。

---

## 指标口径（与原版一致）

```js
total_input  = input_tokens + cache_read_tokens + cache_write_5m + cache_write_1h
uncached     = input_tokens
hit          = cache_read_tokens
hit_rate     = hit / (hit + uncached) * 100          // 命中率
total_tokens = uncached + output_tokens + reasoning_tokens  // 展示用总 Token
cost_usd     = cost_raw / 1e8
cost_cny     = cost_usd * usdCny   // open.er-api.com 实时汇率，6h 缓存
```

来源：src/lib/db.js:computeTotals() 对齐 db.py:totals()；模型排行/趋势由 computeModelStats / computeDailyStats / computeTodayTrend 聚合。

---

## 隐私与安全

- **仅本地**：用量明细存 IndexedDB (goGauge)，设置/配额/汇率存 chrome.storage.local，均随扩展卸载清空。**不会上传到任何服务器**。
- **Cookie 仅内存使用**：auth Cookie 仅在发起 https://opencode.ai/_server 与配额页请求时由浏览器自动携带，不写入日志、不持久化到文件、不外发。
- **100 MB 保护**：本地存储超过 100 MB 自动停止，防止无上限全量撑爆硬盘。
- **可一键清空**：仪表盘设置页 → 清空本地数据（同时清 IndexedDB + storage）。
- **发布前自检**：已扫描代码库，确认无硬编码 wrk_* / token / 私有 Cookie；.gitignore 已排除 *.zip / 日志 / 系统文件。

> 如需审计：src/lib/api.js 为唯一网络层，src/lib/db.js 为唯一存储层。

---

## 权限说明

```json
"permissions": ["storage", "cookies", "tabs", "alarms", "notifications"],
"host_permissions": ["https://opencode.ai/*", "https://open.er-api.com/*"]
```

| 权限 | 用途 |
|------|------|
| storage | chrome.storage.local 存 workspaceId / settings / lastQuota / usdCny |
| cookies | 读取 https://opencode.ai 的 auth Cookie |
| tabs | 打开仪表盘 / 跳转登录页 |
| alarms | 预留（当前未自动调度，仅手动触发） |
| notifications | 增量不一致时系统通知兜底（即使未开仪表盘也能收到） |
| https://opencode.ai/* | 配额页与 /_server 接口（扩展 host_permissions 下绕过 CORS，无需手动设 Cookie header） |
| https://open.er-api.com/* | USD->CNY 汇率，6h 缓存 |

不含 webRequest / declarativeNetRequest 等高危权限；Content Script 仅注入 opencode.ai/* 且仅做 wrk_xxx 嗅探。

---

## 架构

```
manifest.json (MV3, type:module)
├─ src/background.js          — 单一真相源：auth / quota 缓存 / runSync / 探测 / 100MB 截断 / 通知
│   ├─ src/lib/api.js        — 移植 opencode_api.py：quota 正则、_server 调用、usage 解析、workspace 解析
│   └─ src/lib/db.js         — 移植 db.py：IndexedDB 封装 totals / model_stats / daily_stats / trend / paging
├─ src/content.js             — 注入 opencode.ai，嗅探 workspaceId 并通知 background
├─ popup/                     — 轻量入口：登录态、配额预览、用量概览、开始统计 + 进度（默认 30d）
│   ├─ popup.html / popup.css / popup.js
└─ dashboard/                 — 完整仪表盘：侧边栏 5 页 + Chart.js（复用 go-gauge 的 chart.umd.min.js）
    ├─ dashboard.html / dashboard.css / dashboard.js
    └─ chart.umd.min.js
```

**关键移植点**

- opencode_api.py -> src/lib/api.js：WORKSPACE_SERVER_ID / DEFAULT_USAGE_SERVER_ID / build_cookie_header -> fetch(..., {credentials:"include"})；parseQuotaHtml / parseUsageResponse / fetchUsagePage / fetchWorkspaceRefs / resolveWorkspaceId 正则逐行对齐。
- db.py -> src/lib/db.js：SQL 聚合改写为 IndexedDB 全量拉取后 JS 聚合（10w 量级内存可控），口径一致。
- server.py -> background.js：FETCH_BATCH 并发、分钟级重叠检测、指数探测 + 二分、100MB 预估、SYNC_STATE 广播（storage + runtime message 双通道，解决“同步完成标签需刷新才消失”）。

---

## 开发

```powershell
# 目录
go-usage/
  manifest.json
  src/background.js
  src/content.js
  src/lib/api.js
  src/lib/db.js
  popup/popup.html
  dashboard/dashboard.html
  icons/icon*.png

# 本地调试
# 1) chrome://extensions 开开发者模式 -> 加载已解压的扩展程序 -> 选本目录
# 2) 改代码后点扩展卡片“刷新”，popup/dashboard 会热重载；background 改动需刷新扩展

# 打包
powershell .\build.ps1
# 输出 go-usage.zip（包含 manifest/icons/popup/dashboard/src/README.md，排除 .git/*.zip）
```

无构建步骤，原生 ES Module + IndexedDB + Chart.js。

**已修复的关键问题**

- Cannot access 'isTurbo' before initialization — 变量提升顺序修复
- 暗色模式红底黑字 / 深底黑字 — 全量排查并改为白字
- 进度条跳动 — 统一增量/全量进度计算，增量按 200 页平滑
- 同步完成后“同步中”标签需刷新才消失 — 改为 storage.onChanged 监听自动消失

---

## 常见问题

**Q: 别人怎么安装？**
A: 把 go-usage.zip 发给对方，按“快速开始 -> 方式 A”解压后加载即可；或让对方 git clone 后加载源码目录。后续可发布到 Chrome Web Store 实现一键安装。

**Q: 需要手动填 token 吗？**
A: 不需要。只要在 Chrome 里登录过 opencode.ai，扩展自动读取 auth Cookie。

**Q: 会自动偷跑流量吗？**
A: 不会。必须点「增量同步 / 全部同步」才会请求；安装、启动、打开弹窗都不会自动拉取。

**Q: 全量会无限拉取吗？**
A: 不会。先指数探测真实总页数，进度精确；同时受 100 MB 上限保护，超限自动停止并提示。

**Q: 增量为什么会弹“不一致”框？**
A: 说明同一分钟的本地与远端 count/token/cost 对不上，可能是历史被重写或缓存失效。按需选“重新全量 / 拼接 / 忽略”。即使没开仪表盘也会收到系统通知。

**Q: 费用/汇率准吗？**
A: 费用 cost_raw/1e8 与原版一致；汇率来自 open.er-api.com，6 小时缓存。

---

## 致谢

- 接口与正则：[yphyphyph/opencode-go-gauge](https://github.com/yphyphyph/opencode-go-gauge)（MIT）
- 图标与视觉：[OnesoftQwQ/opencode-go-copilot](https://github.com/OnesoftQwQ/opencode-go-copilot)
- 数据提供：OpenCode

---

## License

MIT — 同原项目保持一致。详见 LICENSE。

