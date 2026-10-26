# StarClass 审计 / 修复追踪台账

> 用途：跨轮次追踪「问题 → 根因 → 修复 → 验证」的闭环。每一轮的发现、决策、遗留项都记在这里，
> 避免重复审计、也方便回看每个修复为什么这么做。配合 `CHANGELOG.md`（面向发布的变更记录）使用。

---

## 2026-10-26 · Task B — 视觉巡检常规化 + 全 36 页审查

**目标**：把 Playwright 截图对比纳入常规流程（CI / 本地门禁），并系统审查全部页面，发现「问题 + 漏洞」。

### 一、常规化交付物

| 交付物 | 路径 | 说明 |
| --- | --- | --- |
| 截图巡检工具 | `web-admin/tests/visual-sweep.mjs` | API 登录注入 token → 遍历 36 页 → 采集 console 错误 / ≥400 / 断点横向溢出 / 像素 diff → 输出 REPORT |
| 静态服务 | `tools/serve-ui.mjs` | 仓库内静态服务，代理 `/api` 到后端；CI 与本地复用 |
| npm 脚本 | `web-admin/package.json` | `visual:serve` / `visual:update` / `visual:sweep` |
| CI 作业 | `.github/workflows/ci.yml` | `visual-sweep`：构建→seed 隔离库→起后端+静态服务→`--update` 采集基线→上传 `tests/shots/` |
| 基线 | `web-admin/tests/baseline/` | 36 页 ×（视口+整页）截图 + REPORT，作为后续对比基准（运行产物 `shots/` 与 `baseline/*.diff.png` 已 gitignore） |

> 像素闸门策略：CI 不卡像素漂移（平台字体敏感，易误报）；本地 `--fail-on-diff` 才是真实像素闸门。

### 二、安全审查结论（无漏洞）

- 全仓 grep + 读码：无 `v-html` / `innerHTML` / `eval` / `new Function` / `dangerouslySetInnerHTML`。
- 两处 `document.write` 打印视图（签到表 `checkin/index.vue`、收据 `orders/index.vue`）均对动态字段 `escapeHtml`，无 XSS。
- 导出 / 备份 / JSON 导入 / 恢复端点全部 `isAdminReq` 守卫；`isAdminReq` 由 JWT 校验后的 openid 推导角色，
  显式忽略客户端 `x-openid`（`backend/utils/index.js` 的 `getOpenId` / `verifyToken`），前端无法伪造越权。

### 三、修复的问题（已验证）

| # | 页面 | 现象 | 根因 | 修复 | 验证 |
| --- | --- | --- | --- | --- | --- |
| B1 | 学员表 `students/index.vue` | `联系方式/出生日期/加入时间/序号` 省略号截断（30 处） | `resolveColumnWidths` 只用 `autoWidths` 覆盖列定义 `minWidth`；`cellPadding(20)` < EP `.cell` 实际内边距(各 12px)，密集表被压窄 | `resolveColumnWidths` 取 `max(自适应实测, 列定义 minWidth)`；上调 `联系方式 130→140` / `出生日期 100→120` / `加入时间 100→160` 并加 `tooltip`；`序号` 加 `tooltip` | 截断探针 30→0 |
| B2 | 请假表 `leave/index.vue` | 「请假时间」`2026-10-26 13:30` 截断为 `2026-10-26 0…` | min-width 130 < 内容 16 字符 | min-width 130→160 + `show-overflow-tooltip`（「申请时间」同改 100→160） | 该页截断归零 |
| B3 | 登录页 `login/index.vue` | 角色网格 `repeat(4,1fr)` 但只有 3 个 chip → 幽灵第 4 列 | 写死 4 列 | 改为 `repeat(3,1fr)` | 网格 3 列 = 3 chip |

> B1 的 `tableWidth.js` 修复是「全表受益」的：所有引入该 util 的表格（学员/订单/销售/增长/试听/报表）列都不会再被压到作者意图的 `minWidth` 之下。

### 四、全量巡检结果（2026-10-26 修复后）

```
总页: 36 | ✅36 🔹0 🔺0 ⛔0 🆕0
（无 console 错误 / 无 ≥400 响应 / 无横向溢出 / 无失败请求）
```

### 五、已知 / 非缺陷（留痕，避免重复上报）

- 请假表「请假原因」等长自由文本列仍按设计以 `show-overflow-tooltip` 截断、悬停看全文 —— 标准做法，非缺陷。
- 部分页面在 `shots/` 基线对比时的像素漂移属字体/渲染差异，非功能问题（故 CI 不卡 diff）。

### 六、遗留 / 待决策

- 无阻塞项。后续若新增页面，需在 `visual-sweep.mjs` 的 `TARGETS` 中补登记，否则不会被巡检覆盖。
