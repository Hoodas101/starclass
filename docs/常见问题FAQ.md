# 常见问题 FAQ

> 面向非技术用户：从「怎么装」到「怎么用好、怎么用一辈子」的全量问答。
> 按你所处的阶段找对应章节即可，不需要从头读到尾。

## 目录

- [一、安装与启动](#一安装与启动)
- [二、日常使用](#二日常使用)
- [三、数据与备份](#三数据与备份)
- [四、迁移与升级](#四迁移与升级)
- [五、正式上线（公网部署）](#五正式上线公网部署)
- [六、排障](#六排障)

---

## 一、安装与启动

### Q1：我完全不懂技术，能跑起来吗？

能。只需要三步：

1. 安装 Node.js（去 https://nodejs.org 点第一个大按钮，一路下一步）
2. 下载本项目（绿色按钮 Code → Download ZIP，解压）
3. 在项目文件夹里打开终端，输入 `bash deploy.sh` 回车

约 1~3 分钟后看到"部署完成"，浏览器打开 **http://localhost:3001** 就能用了。

> 「在项目文件夹里打开终端」的捷径：macOS 在访达中右键文件夹 →「服务 → 新建位于文件夹位置的终端窗口」；Windows 在文件夹地址栏输入 `cmd` 回车。

### Q2：Node.js 要什么版本？

**18 或更高**（推荐 20 / 22）。查看当前版本：`node -v`。版本太旧到 nodejs.org 重新下载安装即可。

### Q3：`npm install` 卡住或报网络错误？

国内网络切换 npm 镜像后再跑：

```bash
npm config set registry https://registry.npmmirror.com
bash deploy.sh
```

### Q4：better-sqlite3 编译失败？

这是数据库组件需要本机编译。按提示装编译工具后重跑 `bash deploy.sh`：

- macOS：终端执行 `xcode-select --install`，弹窗确认安装
- Linux（Debian/Ubuntu）：`sudo apt install build-essential python3`
- Linux（CentOS）：`sudo yum groupinstall "Development Tools"`
- Windows：以管理员安装 https://github.com/felixcn/node-gyp-bin 或直接装 Visual Studio Build Tools（勾选 C++ 桌面开发）

> 多数情况下 Node.js 官方安装包自带预编译产物，无需手动编译；上面是兜底。

### Q5：端口 3001 被占用怎么办？

```bash
bash stop-all.sh          # 先停掉本系统旧进程
# 仍被占用则换端口启动：
PORT=3002 bash start-all.sh
```

访问地址相应改为 http://localhost:3002。

### Q6：deploy.sh 和 start-all.sh 有什么区别？

| 脚本 | 做什么 | 什么时候用 |
|---|---|---|
| `bash deploy.sh` | 装依赖 + 建库 + 构建管理端 + 启动，一条龙 | 第一次部署、或升级代码后 |
| `bash start-all.sh` | 只补缺失依赖 + 启动（构建产物新则不重建） | 日常开机启动 |
| `bash stop-all.sh` | 停止所有服务 | 不用了 / 重启前 |

### Q7：关机重启后数据还在吗？

在。所有数据都存在一个文件里：`backend/db/data.db`。重启后只需 `bash start-all.sh` 重新拉起服务。想让它开机自动运行，见 Q16。

---

## 二、日常使用

### Q8：初始账号是什么？

| 身份 | 手机号 | 密码 |
|---|---|---|
| 管理员 | `13800000001` | `123456` |
| 教练 | `13800000011` | `123456` |
| 家长 | `13900000001` | 无需密码（仅开发/测试环境） |

> 家长手机号免密登录是演示便利：生产环境默认关闭（`PARENT_PHONE_LOGIN` 未设为 true），家长须走微信小程序登录。开发环境想体验家长端 Web 页面时可 `export PARENT_PHONE_LOGIN=true`。

> 这是示例数据的体验账号。**正式使用前请务必修改密码**（管理后台 → 系统设置 → 账号安全），并删除示例学员/订单，或见 Q10 从零开始。

### Q9：忘记管理员密码了？

示例数据库：删除 `backend/db/data.db*` 三个文件，重新跑 `bash deploy.sh`，会重建带示例数据的库。
正式数据库：**不要删文件**。在服务器上执行：

```bash
node -e "
const db = require('./backend/node_modules/better-sqlite3')('backend/db/data.db');
const bcrypt = require('./backend/node_modules/bcryptjs');
db.prepare('UPDATE users SET password=? WHERE phone=?').run(bcrypt.hashSync('你要设的新密码', 10), '13800000001');
console.log('密码已重置');
"
```

### Q10：想清空示例数据、正式录入自己的机构？

两种方式：

- **推荐（干净起步）**：`rm backend/db/data.db*` → `npm run init:db`（只建表不灌示例）→ 重启服务，然后在后台「系统设置」改机构名称，逐个录入自己的教练、学员、课程。
- 省事（在示例库上删）：管理后台逐个删除演示学员、订单、排课。功能完全一致，只是数据库里会留少量示例 ID。

### Q11：教练 / 家长账号怎么创建？

教练：管理后台 → 员工管理 → 添加员工（填手机号），该手机号即获得教练登录账号（初始密码 `123456`），用于查看本人课表与课时数据。
家长：在成员档案里把学员绑定给家长手机号即可；家长侧自助查看（通知、课表、报名）可通过可选付费的微信小程序端实现，纯 Web 部署时由管理员代为登记与通知。

### Q12：时效卡、次数卡有什么区别？

- **时效卡**（月卡/季卡/年卡）：按到期日判断权益，请假可顺延天数（规则在「系统设置 → 请假规则」配置）。
- **次数卡**：按剩余课时扣减，每次上课/点名扣 1 次。
一张卡只能选一种计费模式；续费时两种可以共存于同一成员。

### Q13：会员卡能暂停吗？

能。管理后台 → 成员管理 → 成员详情 → 会员卡「暂停 / 恢复」。暂停期间到期日自动顺延，课时/天数都不消耗，适合学员请假 long-term、生病、外出场景。

### Q14：能改「老师 / 学员 / 会员」这类叫法吗？

能。「系统设置 → 机构称呼自定义」全站替换：篮球馆可以叫"队员"，健身房可以叫"会员"，美术班叫"学员"——Web 工作台全模块文案同步变化（购买小程序扩展后三端亦同步），无需改代码。

### Q15：数据导出来是 Excel 吗？

是。销售、排课、学员、签到、积分、课时统计等列表页均有「导出」按钮，直接下载 `.xlsx` 文件，可用 Excel / WPS 打开。

### Q16：怎么让服务器 7×24 小时运行、断电自动拉起？

用 pm2 进程守护（一行命令）：

```bash
npm install -g pm2
cd backend && pm2 start server.js --name starclass
pm2 startup && pm2 save   # 开机自启
```

之后：`pm2 status` 看状态，`pm2 logs starclass` 看日志，`pm2 restart starclass` 重启。

---

## 三、数据与备份

### Q17：我的数据到底存在哪？会不会被传到云上？

只存在你自己机器的 **一个文件**：`backend/db/data.db`（SQLite 单文件数据库）。上传的图片等附件在 `backend/uploads/`。**系统没有云依赖、不会外传任何数据**——这就是"数据完全归属机构"的含义。

### Q18：怎么备份？多久备份一次？

**最简单**：管理后台 → 系统设置 → 「一键备份」下载当前数据库文件。

**服务器自动**：系统每日自动备份到 `backend/db/backups/`（保留滚动窗口；容器内为 `/data/backups`）。

**手动命令行**（建议每周一次，异地保存）：

```bash
sqlite3 backend/db/data.db ".backup 'backup-$(date +%F).db'"
```

把生成的文件拷到 U 盘 / 网盘 / 另一台电脑即可。**没有备份就没法找回误删的数据**——这是唯一真正会丢数据的场景，请务必养成习惯。

### Q19：数据误删 / 数据库损坏了怎么恢复？

停服务 → 用最近一次备份覆盖回去：

```bash
cp backup-2026-09-01.db backend/db/data.db
bash start-all.sh
```

SQLite 使用 WAL 模式，正常断电不损坏数据；极端损坏（磁盘故障）时，用 `sqlite3 data.db "PRAGMA integrity_check;"` 检查。

---

## 四、迁移与升级

### Q20：换电脑 / 搬到云服务器，要拷哪些东西？

只需三样：

1. 整个项目代码（GitHub clone 即可）
2. `backend/db/data.db`（全部业务数据）
3. `backend/uploads/`（上传的图片等，如果有）

新机跑完 `bash deploy.sh`（会自动建空库），停服务，把上面两个文件放回原位，重启——完成。

### Q21：项目出了新版本，怎么升级？

```bash
git pull
bash deploy.sh      # 不会动你的数据，自动跑数据库迁移
```

数据库升级走幂等迁移（`backend/migrations/`），旧库自动加新表/新列，无需手动处理。**升级前先做一次 Q18 的备份**即可放心。

### Q22：Node 版本升级会不会弄坏数据库？

不会。数据在 SQLite 文件里，与 Node 版本无关。升级 Node 后若 `better-sqlite3` 报错，删 `backend/node_modules` 重跑 `bash deploy.sh` 重装依赖即可。

---

## 五、正式上线（公网部署）

### Q23：一定要买服务器吗？

看使用范围：

| 场景 | 方案 | 成本 |
|---|---|---|
| 管理员在店里用 | 店里任意一台电脑跑 `bash start-all.sh` | 0 元 |
| 多台设备 / 校外也要访问 | 一台 1 核 2G 云服务器（约 ¥60~100/年） | 很低 |

纯 Web 部署没有域名/HTTPS 的硬性要求（店内局域网直接 `http://电脑IP:3001` 即可）；面向公网访问建议配置 HTTPS，完整步骤见 [`部署上线说明.md`](../部署上线说明.md)。

### Q24：微信小程序（家长端 / 教练端 / 管理端）在哪里？

三端原生小程序为**可选付费商业扩展**，不包含在本开源仓库中。后端 API 已预留微信登录、支付与订阅消息能力，购买部署授权后即可对接你自己的小程序。获取方式：在 [Issues](https://github.com/Hoodas101/starclass/issues) 留言联系。

不配小程序也完全不影响 Web 工作台的全部业务功能：招生、排课、考勤、请假审批、通知下发、销售、薪资、导出闭环均可独立完成。

---

## 六、排障

### Q25：服务启动失败，看哪里？

`tail -50 backend.log`。最常见三类：

- `EADDRINUSE` → 端口被占，见 Q5
- `JWT_SECRET` 相关 → 生产模式未设密钥，`export JWT_SECRET=$(openssl rand -hex 32)` 后重启
- `Cannot find module` → 依赖没装全，删 `backend/node_modules` 重跑 `bash deploy.sh`

### Q26：页面能打开但操作报 401 / 总被登出？

`JWT_SECRET` 变了（重启时设了新值），旧登录令牌失效——重新登录即可。部署时用 systemd/pm2 固定一个稳定的密钥值，别每次启动重新生成。

### Q27：改了 web-admin 的代码，打开还是旧页面？

构建产物由后端托管，改代码后需 `cd web-admin && npm run build`（或重跑 `bash deploy.sh`），然后强制刷新浏览器（Cmd+Shift+R / Ctrl+F5）。开发时可用 `npm run dev:web`（热更新）。

### Q28：想确认系统是不是健康？

```bash
curl http://localhost:3001/api/health   # 服务状态
npm run smoke                            # 39 项接口断言（服务需运行）
```

### Q29：一个问题困扰我很久，FAQ 没有？

1. 先跑 `npm run test:backend`（256 项回归）确认不是环境问题
2. 到 GitHub 提 Issue（附上报错截图 + `node -v` + 操作系统）
3. 系统内置反馈通道：管理后台 → 意见反馈

---

## 相关文档

- 各角色操作手册：[`使用手册.md`](../使用手册.md)
- 公网部署：[`部署上线说明.md`](../部署上线说明.md)
- 开发与测试：[`TEST-GUIDE.md`](../TEST-GUIDE.md)
