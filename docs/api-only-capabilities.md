# 仅 API 提供的能力（无管理端 UI 入口）

本文档对应外部审计的 **R2**：后端已实现、但管理端没有操作入口的能力。

处理原则：**要么补 UI，要么明确标注为 API-only** —— 不能停在「代码里有、用户找不到」的灰色地带。
本轮已为「会员卡转让」补上 UI（见文末），其余按下表明确为 API-only。

> 判定方法：`web-admin/src/api/modules/index.js` 中已有封装，但 `web-admin/src/views/**` 零引用。
> 复核命令见每节末尾。

---

## 1. 体测记录 CRUD（`backend/routes/physical-tests.js`）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/physical-tests?studentId=` | 按学员查体测历史 |
| POST | `/api/physical-tests` | 新增一次体测（身高/体重/BMI/体脂等） |
| PUT | `/api/physical-tests/:id` | 修改 |
| DELETE | `/api/physical-tests/:id` | 删除（管理员） |

**为什么暂不补 UI**：体测是低频、强专业录入（多项指标 + 测量条件），做成通用表单对普通员工反而
是负担；当前客户由教练在小程序端录入，管理端只做查询。
**若要补**：建议挂在「学员详情 → 体测」标签页，只读列表 + 新增弹窗，不做批量。

```bash
grep -rl "getPhysicalTests\|addPhysicalTest" web-admin/src/views   # 当前：0
```

---

## 2. 教室增删改（`backend/routes/admin.js`）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/admin/classrooms` | 列表（**已有 UI**：排期页筛选用） |
| POST | `/api/admin/classrooms` | 新增教室 |
| PUT | `/api/admin/classrooms/:id` | 改名/改容量 |

**为什么暂不补 UI**：教室是机构一次性配置（通常 1–5 间），建成后极少变动；
现有入口由部署时的种子数据或管理员直接调用接口完成。
**若要补**：放在「设置 → 场地」区块，与卡种管理同页。

```bash
grep -rl "addClassroom\|updateClassroom" web-admin/src/views       # 当前：0
```

---

## 3. 积分排行榜（`GET /api/points/ranking`）

**为什么暂不补 UI**：排行榜是**家长端**激励功能（小程序展示），管理端价值有限；
管理端已有的 `/api/growth/points/*` 覆盖了运营视角。
**若要补**：挂在增长中心的「积分」页签，只读。

```bash
grep -rl "getPointsRanking" web-admin/src/views                    # 当前：0
```

---

## 4. 学员维度考勤单查（`GET /api/attendances/student/:id`）

**为什么暂不补 UI**：该数据已在「学员详情 → 上课记录」与「上课记录」页的筛选里覆盖，
单独做单查入口属重复入口（奥卡姆剃刀：能合并的不新增）。
**结论**：**不补**，保留为集成/导出场景的 API。

```bash
grep -rl "getAttendanceByStudent" web-admin/src/views              # 当前：0
```

---

## 5. 会员卡列表（`GET /api/membership/cards`）

**为什么暂不补 UI**：卡信息在「学员详情」按人展示（谁持卡、剩多少、何时到期），
这符合机构实际的查询路径（先找人、再看卡）。全局卡列表只对财务对账有用，
而财务页已提供收入/退款维度。
**结论**：**不补**，保留为 API。

---

## 6. 会员卡转让 —— 本轮**已补 UI**

`POST /api/membership/card/:id/transfer`（仅管理员）

此前：卡种 `transferable=1` 已在售，但前端零入口。线下转让后系统无记录，
受让人上课**查无卡** → 扣课失败但考勤已记，账实不符。

现在：**学员详情 → 会员卡卡片 → 「转让」按钮**（仅对 `transferable=1` 且 `status='active'` 的卡显示）。
弹窗内远程搜索受让人（排除原持卡人），带「历史不追溯」的明确提示。

```bash
grep -rl "transferCard" web-admin/src/views                        # 当前：1（students/index.vue）
```

---

## 维护约定

新增后端能力时，二选一：

1. **补 UI** —— 在本文档删掉对应条目；
2. **标 API-only** —— 在本文档新增一节，写清「为什么不做 UI」与「谁在用这个接口」。

不要让能力停留在两者之间：审计已经因为这类灰色地带反复产生误判。
