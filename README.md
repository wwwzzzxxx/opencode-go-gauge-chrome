# GoGauge for Chrome — OpenCode Go 用量仪表盘（Chrome 插件版）

> 本地优先 · 仅在点击「开始统计」后拉取数据 · 自动读取 opencode.ai 登录 Cookie · 展示配额窗口与缓存命中率

受 [yphyphyph/opencode-go-gauge](https://github.com/yphyphyph/opencode-go-gauge) 启发，将其 Python + pywebview 的“配额解析 + 用量明细”能力移植为 **Chrome 扩展（Manifest V3）**，做到：**安装后只要在浏览器登录过 `opencode.ai`，插件即可自动获取 Cookie 并完成统计，无需手动复制 token；数据量大时不会自动请求，必须由用户点击「开始统计」才触发批量拉取**。

<p align="center">
  <img src="icons/icon128.png" width="64" alt="GoGauge">
</p>

---

## ✨ 功能清单

| 功能 | 说明 | 口径 |
|------|------|------|
| **配额窗口** | 5h Rolling / Weekly / Monthly 进度条 + 剩余百分比 + 重置倒计时 | 正则解析 `opencode.ai/workspace/<id>/go` HTML 中的 `rollingUsage / weeklyUsage / monthlyUsage` |
| **用量概览** | 缓存命中率 · 命中量 · 总 TOKEN（含缓存命中） · 请求数 · 会话数 · 费用（USD/¥） | 与 go-gauge 完全一致 |
| **缓存命中率** | `命中 / (命中+未命中)`，同时展示命中/未命中绝对量 | `hit / (hit+miss)`，`total_input = input+cacheRead+cacheWrite` |
| **今日趋势** | 24 小时输入/输出柱状图 | IndexedDB 聚合 |
| **模型分析** | Token 构成、模型占比环形图、模型排行、按输入/输出/费用趋势 | `computeModelStats / computeDailyStats` |
| **使用记录** | 请求级明细分页（20 条/页），模型筛选，时间范围 | `usage_records` IndexedDB |
| **会话历史** | 按 `session_id` 聚合请求数/Token/费用 | `getSessionStats` |
| **自动登录** | **自动读取 `opencode.ai` 的 `auth` Cookie**（`chrome.cookies`） | 监听 `cookies.onChanged`，登录后插件立即变为“已登录” |
| **手动触发** | **只有点击「开始统计」才开始批量拉取**，避免大流量误触 | `background` 仅在 `START_SYNC` 消息后执行 `runSync` |
| **增量/全量** | 增量 5 页（250 条）快速同步；全量最多 2000 页，带窗口期裁剪 | `FETCH_BATCH=5` 并发，`windowDays` 控制保留期 |
| **本地优先** | 全部写入 `IndexedDB (goGauge)`，不上传、不遥测 | 可一键清空 |

---

## 🏗 架构

```
manifest.json (v3)
  ├─ background (service worker, type:module)
  │    ├─ src/lib/api.js        — 移植 opencode_api.py：quota 正则、_server 调用、usage 解析
  │    └─ src/lib/db.js         — IndexedDB 封装：totals / model_stats / daily_stats / trend
  ├─ content.js                 — 注入 opencode.ai，嗅探 workspaceId 并通知 background
  ├─ popup/                     — 轻量入口：登录态、配额预览、概览 KPI、开始统计 + 进度
  └─ dashboard/                 — 完整仪表盘：侧边栏 5 页 + Chart.js
       ├─ dashboard.html/css/js
       └─ chart.umd.min.js (复用 go-gauge)
```

**关键移植点**

- `opencode_api.py → src/lib/api.js`：`WORKSPACE_SERVER_ID` / `DEFAULT_USAGE_SERVER_ID` / `build_cookie_header` → `fetch(..., {credentials:"include"})`（插件 host_permissions 下自动携带 `auth` Cookie，无需手动设 `Cookie`  forbidden header）；`parseQuotaHtml / parseUsageResponse / fetchUsagePage / fetchWorkspaceRefs / resolveWorkspaceId / fetchKeyNames` 均逐行对齐 Python 正则。
- `db.py → src/lib/db.js`：`totals` / `model_stats` / `daily_stats` / `today_trend` / `usage_records_page` / `session_stats_page` 的 SQL 聚合改写为 IndexedDB 全量拉取后 JS 聚合（数据量 10w 内内存可控），口径一致。
- `server.py 同步逻辑 → background.js runSync`：`FETCH_BATCH=5` 并发、增量空批次熔断、窗口边界停拉、汇率 `open.er-api.com` 缓存、进度 `SYNC_STATE` 广播。

---

## 🔐 权限说明

```json
"permissions": ["storage","cookies","tabs"],
"host_permissions": ["https://opencode.ai/*","https://open.er-api.com/*"]
```

- `cookies`：读取 `https://opencode.ai` 的 `auth` Cookie，用于后续 `/_server` 与 `dashboard` 请求。Cookie 仅在本地内存使用，不会写入日志或上传。
- `storage`：`chrome.storage.local` 保存 `workspaceId / settings / lastQuota / usdCny`；`IndexedDB` 保存用量明细。
- `https://opencode.ai/*`：配额页与 `/_server` 接口跨域访问（扩展 host_permissions 下绕过 CORS）。
- 不含 `webRequest`、`declarativeNetRequest` 等高危权限；不注入敏感页，只在 `opencode.ai/*` 注入轻量 `content.js`。

---

## 🚀 安装（开发者模式）

1. 打开 `chrome://extensions`，右上角开启 **开发者模式**
2. 点击 **加载已解压的扩展程序**，选择本项目根目录 `go-usage`
3. 在浏览器登录一次 https://opencode.ai （若已登录则无需操作）
4. 点击工具栏的 **GoGauge** 图标 → 查看登录态（应显示“已登录”+ 工作区 ID 缩写）
5. 点击 **▶ 开始统计**（增量）或 **全量同步** → 观察进度条；完成后再点 **打开完整仪表盘** 查看详细分析

> 更新代码后，在 `chrome://extensions` 点击扩展卡片的 **刷新** 按钮即可热重载。

---

## 🖱 使用约定（满足你的 3 点需求）

1. **参考项目**：除 `opencode-go-gauge` 外，还调研了 [opencode-go-stats](https://github.com/bubblebuffer/opencode-go-stats)、[opencode-visual-usage-limit](https://github.com/birksgone/opencode-visual-usage-limit)、[opencode-go-meter](https://github.com/hiraghi/opencode-go-meter) 的接口与可视化方案；本插件的配额正则与 `/_server` 解析与 go-gauge 保持一致，确保兼容性。
2. **自动获取 Cookie**：`background.js:checkAuth()` 通过 `chrome.cookies.get({url:"https://opencode.ai/", name:"auth"})` + `getAll({domain:"opencode.ai"})` 自动获取；`cookies.onChanged` 监听使登录/退出即时反映到 Popup/Dashboard，无需手动粘贴 token。`content.js` 还会在 `opencode.ai` 页面嗅探 `wrk_xxx` 并写入 `workspaceId`，省去手动选择工作区。
3. **人为点击才统计**：`manifest` 未注册任何 `alarms` 自启动；`background` 的 `runSync()` 仅在收到 `START_SYNC`（由 Popup 的「开始统计」/「全量同步」或 Dashboard 的同步按钮触发）后才执行；扩展安装、浏览器启动、Popup 打开均不会自动请求大批量数据。进度与取消按钮完整暴露，避免长时间阻塞。

---

## 📊 缓存命中率等指标口径

```js
total_input = input_tokens + cache_read_tokens + cache_write_5m + cache_write_1h
uncached    = input_tokens
hit         = cache_read_tokens
hit_rate    = hit / (hit + uncached) * 100
total_tokens_for_display = uncached + output_tokens + reasoning_tokens
cost_usd    = cost_raw / 1e8        // 与 Python 一致
cny         = cost_usd * usdCny     // open.er-api.com 实时汇率，6h 缓存
```

与 `db.py:totals()` 实现逐行对齐，Dashboard 的“用量概览/Token 构成/模型排行”均复用该口径。

---

## 🛠 开发

```powershell
# 目录结构
go-usage/
  manifest.json
  src/background.js
  src/content.js
  src/lib/api.js
  src/lib/db.js
  popup/popup.html
  dashboard/dashboard.html

# 打包
powershell .\build.ps1
# 输出 go-usage.zip，可直接上传 Chrome Web Store 或自托管
```

无构建步骤，原生 ES 模块 + IndexedDB + Chart.js。

---

## 📦 发布

- `manifest.version` 遵循 semver，提交前同步 `dashboard` 关于页版本展示
- `chrome.storage.local` + IndexedDB 数据与扩展绑定，卸载扩展会清空（符合隐私预期）

---

## 🙏 致谢

- 接口与正则：[yphyphyph/opencode-go-gauge](https://github.com/yphyphyph/opencode-go-gauge)（MIT）
- 数据提供：OpenCode

---

## 📄 License

MIT — 同原项目保持一致。
