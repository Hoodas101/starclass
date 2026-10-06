/**
 * 管理路由 — 数据看板、导出报表
 * GET /api/admin/dashboard — 数据看板
 * GET /api/admin/export    — 导出报表
 */
const express = require('express');
const router = express.Router();
const db = require('../db');
const { success, fail, safeFail, generateId, getOpenId, getActor, recordAudit, formatDate, now, hashPassword, resolvePerms, hasPerm, getReqUser, attendanceRate, isAdminReq } = require('../utils');
// 订单明细解析：导出 / 退卡 / 财务报表共用同一实现（此前各自复制，口径已分叉）
const { parseItems, itemQuantity, itemLineTotal } = require('../utils/items');
// 员工默认口令的唯一定义处（登录/改密/强制拦截共用，避免多处硬编码分叉）
const { getStaffDefaultPassword } = require('../utils/security');
// 已删除（status='refunded'）/ 已归档学员的统一排除条件（学员表别名须为 s）
const { ACTIVE_STUDENT_SQL } = require('../utils/student-state');
// 存量脏数据体检 + 一次性安全清理
const { scanDirtyData, applyCleanup } = require('../utils/data-health');
// 到期口径单一来源：看板「即将到期」的窗口与状态必须与续费提醒扫描同源，
// 否则会出现「预警清单列出、提醒却从不发出」的口径分裂（详见 utils/renewal.js 头注释）。
const { EXPIRY_WINDOWS, buildExpiringWhere } = require('../utils/renewal');

// E3：把 date(paid_at/1000,'unixepoch','localtime') 这类表达式谓词改写为 paid_at 的毫秒区间比较。
// 函数包裹的列用不上索引 → 看板每次调用对 orders 全表扫描 13 次；016 迁移建的 idx_orders_paid_at
// 只有在裸列比较（paid_at >= ? AND paid_at < ?）下才会被选中。
// paid_at 存的是 epoch 毫秒整数；区间一律取半开 [start, end)，与原来的 date(...) >= 'D' / <= 'D' 等价。
const dayStartMs = (d) => new Date(`${d}T00:00:00`).getTime();        // 'YYYY-MM-DD' 当日 00:00 本地
const dayEndMs = (d) => dayStartMs(d) + 86400000;                      // 次日 00:00（开区间上界）
const monthStartMs = (ym) => new Date(`${ym}-01T00:00:00`).getTime();  // 'YYYY-MM' 当月 1 日 00:00
const nextMonthStartMs = (ym) => {
  const [y, m] = ym.split('-').map(Number);
  const nm = m === 12 ? 1 : m + 1;
  return new Date(`${m === 12 ? y + 1 : y}-${String(nm).padStart(2, '0')}-01T00:00:00`).getTime();
};
const yearStartMs = (y) => new Date(`${y}-01-01T00:00:00`).getTime();

// 看板「即将到期」统计窗口（天）：取自到期口径单一来源 EXPIRY_WINDOWS 的 7 天档位，
// 不再在 SQL 里写死裸数字 7。若提醒档位配置调整、7 不再存在，回退到最大档位以免窗口落空。
const DASHBOARD_EXPIRING_DAYS = EXPIRY_WINDOWS.includes(7) ? 7 : Math.max(...EXPIRY_WINDOWS);

// courses.archived / teachers.class_fee / teachers.pay_rule 列已收编至 migrations/011

// 管理接口权限校验：管理员全部放行；拥有看板权限的员工（如销售）放行只读查询，写操作再按路由校验
router.use((req, res, next) => {
  if (req.userRole === 'admin') return next();
  const openid = getOpenId(req);
  if (openid) {
    const u = getReqUser(req);
    if (u && (u.role === 'admin' || u.role === 'coach' || hasPerm(u, 'dashboard') || hasPerm(u, 'sales'))) return next();
  }
  return res.status(403).json({ code: 403, data: null, message: '仅管理员可访问管理接口' });
});

// 写操作 / 敏感数据：仍要求管理员
// isAdminReq 统一来自 utils（此前本文件与另外 4 个路由各自复制了一份实现）
const adminOnly = (req, res, next) => {
  if (isAdminReq(req)) return next();
  return res.status(403).json({ code: 403, data: null, message: '仅管理员可操作' });
};

// 参考资源只读：教师/场地/活动列表供教练/销售在下拉与筛选中使用（写操作仍由 adminOnly 守护）
const staffRead = (req, res, next) => {
  const u = getReqUser(req);
  if (u && (u.role === 'admin' || u.role === 'coach' || hasPerm(u, 'dashboard') || hasPerm(u, 'sales'))) return next();
  return res.status(403).json({ code: 403, data: null, message: '无访问权限' });
};

/**
 * 看板数据守卫：含全机构收入/订单等经营数据，仅管理员或显式拥有 dashboard 权限的员工可见。
 * 顶部 guard 按教练角色放行是给课务参考数据（teachers/courses 下拉）用的，
 * 不代表教练可读财务报表；Web 路由与小程序 hasPerm('dashboard') 均按权限判定，后端补齐同一契约。
 */
const dashboardGuard = (req, res, next) => {
  if (!isAdminReq(req) && !hasPerm(getReqUser(req), 'dashboard')) {
    return res.status(403).json({ code: 403, data: null, message: '无权限查看数据看板' });
  }
  next();
};

/**
 * GET /api/admin/dashboard — 数据看板
 * 返回核心运营指标：成员数、今日课表、今日签到、今日订单、即将到期卡、到场率
 */
router.get('/dashboard', dashboardGuard, (req, res) => {
  try {
    const today = formatDate(now());
    const currentTime = now();
    // 数据范围：all=全机构 / me=仅当前用户（CRM OverviewScopeToggle 思想）。
    // 非管理员强制 me：销售/教练默认持有 dashboard 权限键，若缺省为 all，会看到
    // 全机构营收与他人业绩榜（业绩保密性失效）。管理员可显式切 all。
    const scope = isAdminReq(req) ? (req.query.scope === 'me' ? 'me' : 'all') : 'me';
    const u = getReqUser(req);
    let spName = '';
    if (scope === 'me' && u) {
      if (u.phone) {
        const t = db.prepare('SELECT name FROM teachers WHERE phone = ?').get(u.phone);
        if (t && t.name) spName = t.name;
      }
      if (!spName) spName = u.nickname || u.name || '';
    }
    // 签单人筛选同样要 TRIM 归一：orders.salesperson 是自由文本，历史写入存在
    // 未 trim 的值（'张三' / '张三 ' 视为两人）。写入侧已由 orders.js 统一 trim，
    // 读取侧必须对称归一，否则同一个人的业绩在筛选与非筛选下会得出两个结果。
    // 注意第 249 行有 `spSql.replace('salesperson', 'o.salesperson')`：它替换**第一个**
    // 匹配，得到 `AND TRIM(o.salesperson) = ?` —— 恰好正确，无需改动该 replace。
    const spSql = spName ? ' AND TRIM(salesperson) = ?' : '';
    const spParams = spName ? [String(spName).trim()] : [];

    // 核心指标（在册成员：已删除/已归档学员不计入，否则看板数字虚高）
    const totalStudents = db.prepare(`SELECT COUNT(*) as count FROM students s WHERE s.status = 'active' AND ${ACTIVE_STUDENT_SQL}`).get().count;
    const totalTeachers = db.prepare("SELECT COUNT(*) as count FROM teachers WHERE status = 'active'").get().count;
    const totalCourses = db.prepare("SELECT COUNT(*) as count FROM courses WHERE is_active = 1").get().count;

    // 今日课表
    const todaySchedules = db.prepare("SELECT COUNT(*) as count FROM schedules WHERE date = ? AND status = 'scheduled'").get(today).count;

    // 今日签到
    const todayCheckins = db.prepare("SELECT COUNT(*) as count FROM attendances WHERE date = ? AND status = 'present'").get(today).count;
    const todayLate = db.prepare("SELECT COUNT(*) as count FROM attendances WHERE date = ? AND status = 'late'").get(today).count;
    const todayAbsent = db.prepare("SELECT COUNT(*) as count FROM attendances WHERE date = ? AND status = 'absent'").get(today).count;

    // 今日收入（已支付订单）
    const todayRevenueRow = db.prepare(`
      SELECT COALESCE(SUM(payable_amount - COALESCE(refunded_amount, 0)), 0) as total FROM orders
      WHERE status IN ('paid', 'refunded') AND paid_at >= ? AND paid_at < ?${spSql}
    `).get(dayStartMs(today), dayEndMs(today), ...spParams);
    const todayRevenue = todayRevenueRow?.total || 0;

    // 昨日收入（涨跌对比）
    // 用 setDate 取昨天而不是减 86400000：夏令时切换日减固定毫秒会偏移到隔天或前天。
    const yd = new Date();
    yd.setDate(yd.getDate() - 1);
    const yesterday = formatDate(yd.getTime());
    const yesterdayRevenueRow = db.prepare(`
      SELECT COALESCE(SUM(payable_amount - COALESCE(refunded_amount, 0)), 0) as total FROM orders
      WHERE status IN ('paid', 'refunded') AND paid_at >= ? AND paid_at < ?${spSql}
    `).get(dayStartMs(yesterday), dayEndMs(yesterday), ...spParams);
    const yesterdayRevenue = yesterdayRevenueRow?.total || 0;
    const pct = (cur, prev) => (prev > 0 ? Math.round(((cur - prev) / prev) * 1000) / 10 : null);

    // 本周收入（周一为一周起点）
    const dayOfWeek = new Date().getDay();
    const weekStartMs = now() - ((dayOfWeek + 6) % 7) * 86400000;
    const weekStart = formatDate(weekStartMs);
    const weekRevenueRow = db.prepare(`
      SELECT COALESCE(SUM(payable_amount - COALESCE(refunded_amount, 0)), 0) as total FROM orders
      WHERE status IN ('paid', 'refunded') AND paid_at >= ? AND paid_at < ?${spSql}
    `).get(dayStartMs(weekStart), dayEndMs(today), ...spParams);
    const weekRevenue = weekRevenueRow?.total || 0;

    // 上周收入（周一为一周起点，上周同期）
    const prevWeekStartMs = weekStartMs - 7 * 86400000;
    const prevWeekStart = formatDate(prevWeekStartMs);
    const prevWeekEnd = formatDate(weekStartMs - 86400000);
    const prevWeekRevenueRow = db.prepare(`
      SELECT COALESCE(SUM(payable_amount - COALESCE(refunded_amount, 0)), 0) as total FROM orders
      WHERE status IN ('paid', 'refunded') AND paid_at >= ? AND paid_at < ?${spSql}
    `).get(dayStartMs(prevWeekStart), dayEndMs(prevWeekEnd), ...spParams);
    const prevWeekRevenue = prevWeekRevenueRow?.total || 0;

    // 本月净收入（口径与财务统一：收入按支付月归属，退款按退款发生月归属）
    const monthStart = today.slice(0, 7); // YYYY-MM
    const monthRevenueRow = db.prepare(`
      SELECT COALESCE(SUM(payable_amount), 0) as total FROM orders
      WHERE status IN ('paid', 'refunded') AND order_type != 'refund' AND paid_at >= ? AND paid_at < ?${spSql}
    `).get(monthStartMs(monthStart), nextMonthStartMs(monthStart), ...spParams);
    const monthRefundRow = db.prepare(`
      SELECT COALESCE(SUM(refunded_amount), 0) as total FROM orders
      WHERE status IN ('paid', 'refunded') AND order_type != 'refund' AND refunded_amount > 0 AND updated_at >= ? AND updated_at < ?${spSql}
    `).get(monthStartMs(monthStart), nextMonthStartMs(monthStart), ...spParams);
    const monthRevenue = (monthRevenueRow?.total || 0) - (monthRefundRow?.total || 0);

    // 上月净收入（同口径，保证环比可比）
    const prevMonthKey = new Date(new Date().getFullYear(), new Date().getMonth() - 1, 1);
    const prevMonthStart = `${prevMonthKey.getFullYear()}-${String(prevMonthKey.getMonth() + 1).padStart(2, '0')}`;
    const prevMonthRevenueRow = db.prepare(`
      SELECT COALESCE(SUM(payable_amount), 0) as total FROM orders
      WHERE status IN ('paid', 'refunded') AND order_type != 'refund' AND paid_at >= ? AND paid_at < ?${spSql}
    `).get(monthStartMs(prevMonthStart), nextMonthStartMs(prevMonthStart), ...spParams);
    const prevMonthRefundRow = db.prepare(`
      SELECT COALESCE(SUM(refunded_amount), 0) as total FROM orders
      WHERE status IN ('paid', 'refunded') AND order_type != 'refund' AND refunded_amount > 0 AND updated_at >= ? AND updated_at < ?${spSql}
    `).get(monthStartMs(prevMonthStart), nextMonthStartMs(prevMonthStart), ...spParams);
    const prevMonthRevenue = (prevMonthRevenueRow?.total || 0) - (prevMonthRefundRow?.total || 0);

    // 本年 / 去年收入
    const yearRevenueRow = db.prepare(`
      SELECT COALESCE(SUM(payable_amount - COALESCE(refunded_amount, 0)), 0) as total FROM orders
      WHERE status IN ('paid', 'refunded') AND paid_at >= ?${spSql}
    `).get(yearStartMs(today.slice(0, 4)), ...spParams);
    const yearRevenue = yearRevenueRow?.total || 0;
    const prevYear = String(Number(today.slice(0, 4)) - 1);
    const prevYearRevenueRow = db.prepare(`
      SELECT COALESCE(SUM(payable_amount - COALESCE(refunded_amount, 0)), 0) as total FROM orders
      WHERE status IN ('paid', 'refunded') AND paid_at >= ? AND paid_at < ?${spSql}
    `).get(yearStartMs(prevYear), yearStartMs(today.slice(0, 4)), ...spParams);
    const prevYearRevenue = prevYearRevenueRow?.total || 0;

    // 本月签单人排名
    const monthSales = db.prepare(`
      SELECT TRIM(salesperson) AS salesperson, COALESCE(SUM(payable_amount - COALESCE(refunded_amount, 0)), 0) as amount, COUNT(*) as count
      FROM orders
      WHERE status IN ('paid', 'refunded') AND TRIM(COALESCE(salesperson, '')) != '' AND paid_at >= ? AND paid_at < ?${spSql}
      GROUP BY TRIM(salesperson) ORDER BY amount DESC LIMIT 10
    `).all(monthStartMs(monthStart), nextMonthStartMs(monthStart), ...spParams);

    // 本周签单人排名（与小程序管理端一致：按签单人聚合金额与单数）
    const weekSales = db.prepare(`
      SELECT TRIM(salesperson) AS salesperson, COALESCE(SUM(payable_amount - COALESCE(refunded_amount, 0)), 0) as amount, COUNT(*) as count
      FROM orders
      WHERE status IN ('paid', 'refunded') AND TRIM(COALESCE(salesperson, '')) != ''
        AND paid_at >= ? AND paid_at < ?${spSql}
      GROUP BY TRIM(salesperson) ORDER BY amount DESC LIMIT 10
    `).all(dayStartMs(weekStart), dayEndMs(today), ...spParams);

    // 本年签单人排名
    const yearSales = db.prepare(`
      SELECT TRIM(salesperson) AS salesperson, COALESCE(SUM(payable_amount - COALESCE(refunded_amount, 0)), 0) as amount, COUNT(*) as count
      FROM orders
      WHERE status IN ('paid', 'refunded') AND TRIM(COALESCE(salesperson, '')) != '' AND paid_at >= ?${spSql}
      GROUP BY TRIM(salesperson) ORDER BY amount DESC LIMIT 10
    `).all(yearStartMs(today.slice(0, 4)), ...spParams);

    // 1v1 销售金额（is_1v1 标记）
    const oneToOneRow = db.prepare(`
      SELECT COALESCE(SUM(payable_amount - COALESCE(refunded_amount, 0)), 0) as total, COUNT(*) as count
      FROM orders
      WHERE status IN ('paid', 'refunded') AND is_1v1 = 1 AND paid_at >= ? AND paid_at < ?${spSql}
    `).get(monthStartMs(monthStart), nextMonthStartMs(monthStart), ...spParams);
    const oneToOne = { amount: oneToOneRow?.total || 0, count: oneToOneRow?.count || 0 };

    // 本月购买项目统计（按订单项名称聚合，取 Top5）
    // 刻意保留 status='paid' 毛额口径：退款是订单级的，无法分摊到具体商品项，
    // 纳入已全额退款订单会高估单品热度（与 CSV 导出 sales 分支同一取舍）。
    //
    // 金额口径修正（此前被放大 N 倍）：json_each 展开后每个**明细项**一行，
    // 旧实现 SUM(o.payable_amount) 于是把整单金额按明细条数重复累加 —— 一单 3 个明细
    // 就让该单品多算 2 倍整单金额。现改为累加**该明细名的行小计**（totalPrice，
    // 缺失回退 unitPrice×数量），与 CSV 导出 sales 分支、/charts productSales 同口径。
    // count 同步改为「件数（Σ quantity）」：旧实现用 COUNT(DISTINCT o.id) 得到笔数，
    // 与 /export、/charts 的件数口径互相打架，同一单品在三处报表上对不上。
    //
    // 元素护栏：items 数组里可能混入非对象元素（如 ["篮球季卡"]），直接 json_extract
    // 会抛 malformed JSON 让整条查询失败，被下方 try/catch 吞成「本月无数据」——
    // 统计不是降级而是**整块静默消失**。故先归一为 ev：非法元素 ev=NULL，
    // json_type(NULL) 返回 NULL 且 json_extract(NULL,...) 返回 NULL，全程不抛错，
    // 这类行自然被 item_name IS NOT NULL 过滤掉（与旧实现「非对象元素不产生统计」一致）。
    // 双重编码（数组元素是 JSON 字符串）的 ev 仍是合法 JSON 文本，json_extract 会自动
    // 下沉解析，故真实项目名照常归类，此处行为不变。
    let itemStats = [];
    try {
      itemStats = db.prepare(`
        WITH exploded AS (
          SELECT CASE WHEN json_valid(je.value) THEN je.value END AS ev
          FROM orders o, json_each(CASE WHEN json_valid(o.items) AND json_type(o.items) = 'array'
                                         THEN o.items ELSE '[]' END) AS je
          WHERE o.status = 'paid'
            AND o.paid_at >= ? AND o.paid_at < ?
            ${spSql.replace('salesperson', 'o.salesperson')}
        ),
        shaped AS (
          SELECT ev,
                 CASE WHEN json_type(ev) = 'object' AND CAST(json_extract(ev, '$.quantity') AS REAL) > 0
                      THEN CAST(json_extract(ev, '$.quantity') AS REAL) ELSE 1 END AS qty
          FROM exploded
        )
        SELECT json_extract(ev, '$.itemName') AS item_name,
               SUM(qty) AS order_count,
               SUM(CASE WHEN json_type(ev) = 'object'
                        THEN COALESCE(NULLIF(CAST(json_extract(ev, '$.totalPrice') AS REAL), 0),
                                      NULLIF(CAST(json_extract(ev, '$.unitPrice') AS REAL), 0) * qty,
                                      NULLIF(CAST(json_extract(ev, '$.price') AS REAL), 0) * qty,
                                      0)
                        ELSE 0 END) AS amount
        FROM shaped
        WHERE json_extract(ev, '$.itemName') IS NOT NULL
        GROUP BY item_name
        ORDER BY order_count DESC, amount DESC
        LIMIT 5
      `).all(monthStartMs(monthStart), nextMonthStartMs(monthStart), ...spParams).map((r) => ({
        itemName: r.item_name,
        count: r.order_count || 0,
        amount: r.amount || 0,
      }));
    } catch (e) {
      // 不能静默清空：查询失败时看板显示「暂无热销项目」，与「这个月真的一件都没
      // 卖出去」长得一模一样，经营判断会被误导，排查时也无从下手。
      console.error('[admin dashboard] 热销项目统计失败:', e && e.message ? e.message : e);
      itemStats = [];
    }

    // 即将到期卡（DASHBOARD_EXPIRING_DAYS 天内）—— 已删除/已归档学员的卡不计入，
    // 否则是无效续费提醒的虚高数字。窗口与状态口径与提醒扫描同源（utils/renewal.js）。
    const expiringCards = db.prepare(
      `SELECT COUNT(*) as count FROM member_cards mc
       JOIN students s ON s.id = mc.student_id
       WHERE ${buildExpiringWhere()} AND mc.expires_at < ? AND mc.expires_at > ? AND ${ACTIVE_STUDENT_SQL}`
    ).get(currentTime + DASHBOARD_EXPIRING_DAYS * 86400000, currentTime).count;

    // 到场率：统一口径见 utils.attendanceRate（迟到计到场，请假不计入分母）
    const attendanceRatePct = attendanceRate({ present: todayCheckins, late: todayLate, absent: todayAbsent });

    // 总会员卡数
    // 有效会员卡：仅统计进行中且未过期的卡（过期卡不计入有效统计）；
    // 已删除/已归档学员的卡一并排除（学员删除时不会动 member_cards，卡会滞留成 active）
    const totalCards = db.prepare(`
      SELECT COUNT(*) as count FROM member_cards mc
      JOIN students s ON s.id = mc.student_id
      WHERE mc.status = 'active' AND mc.expires_at > ? AND ${ACTIVE_STUDENT_SQL}
    `).get(currentTime).count;
    // 有效会员：持有进行中且未过期会员卡的学员人数（去重；区别于“在读成员”全量统计）
    const validMembers = db.prepare(`
      SELECT COUNT(DISTINCT mc.student_id) as count FROM member_cards mc
      JOIN students s ON s.id = mc.student_id
      WHERE mc.status = 'active' AND mc.expires_at > ? AND ${ACTIVE_STUDENT_SQL}
    `).get(currentTime).count;

    // 总积分发放
    const totalPointsRow = db.prepare('SELECT COALESCE(SUM(total_earned), 0) as total FROM points').get();
    const totalPoints = totalPointsRow?.total || 0;

    // 连续缺勤学员（对标班主任工作台的「关注雷达」：把需要关注的学员聚合到一屏）
    //
    // 口径（**默认值，未经业务确认**，机构可调）：
    //   · 窗口：最近 30 天
    //   · 阈值：该窗口内 ≥3 次考勤且**全部缺席**
    //   · 请假（leave）不计入缺席 —— 它是机构已批准的正常状态，不是异常
    //   · 排除已退费/已归档学员（与全站 ACTIVE_STUDENT_SQL 口径一致）
    //
    // 刻意用「窗口内全部缺席」而非严格「连续 N 次」：小机构学员考勤次数少，
    // 严格连续在数据稀疏时几乎不会触发，等于白做。待真实数据积累后可再收紧。
    const attFrom = formatDate(now() - 30 * 86400000);
    let attentionStudents = [];
    try {
      attentionStudents = db.prepare(`
        SELECT s.id, s.name, COUNT(*) AS total,
               SUM(CASE WHEN a.status = 'absent' THEN 1 ELSE 0 END) AS absent
        FROM attendances a
        JOIN students s ON s.id = a.student_id
        WHERE a.date >= ? AND a.date <= ? AND ${ACTIVE_STUDENT_SQL}
        GROUP BY s.id, s.name
        HAVING total >= 3 AND absent = total
        ORDER BY absent DESC, s.name
        LIMIT 5
      `).all(attFrom, today);
    } catch (e) {
      // 表结构异常时不让整个看板 500 —— 该区块降级为空
      console.error('[dashboard attentionStudents]', e && e.message);
    }

    res.json(success({
      overview: {
        totalStudents,
        validMembers,
        totalTeachers,
        totalCourses,
        totalCards,
        totalPoints,
      },
      today: {
        date: today,
        schedules: todaySchedules,
        checkins: todayCheckins,
        late: todayLate,
        absent: todayAbsent,
        attendanceRate: `${attendanceRatePct}%`,
      },
      revenue: {
        today: todayRevenue,
        week: weekRevenue,
        month: monthRevenue,
        year: yearRevenue,
        todayDelta: pct(todayRevenue, yesterdayRevenue),
        weekDelta: pct(weekRevenue, prevWeekRevenue),
        monthDelta: pct(monthRevenue, prevMonthRevenue),
        yearDelta: pct(yearRevenue, prevYearRevenue),
      },
      sales: {
        monthRanking: monthSales,
        weekRanking: weekSales,
        yearRanking: yearSales,
        oneToOne,
        itemStats,
      },
      alerts: {
        expiringCards,
        attentionStudents,
      },
    }));
  } catch (err) {
    res.status(500).json(safeFail("操作失败，请稍后重试"));
  }
});

/**
 * GET /api/admin/attention — 关注雷达聚合（dashboard 侧栏用）
 *
 * 四类聚合，一次请求取全（避免前端发 4 个请求拼装）：
 *   · expiring  到期预警 —— 会员卡 7 天内到期
 *   · followups 待跟进   —— 今日到期或已逾期的跟进任务
 *   · arrears   欠费     —— status='pending' 的待付款订单
 *   · absences  连续缺勤 —— 最近 7 次考勤**全部缺席**
 *
 * 口径（业务确认）：
 *   到期提前 7 天；连续缺勤按 7 次；请假不计入缺席（机构已批准的正常状态）；
 *   排除已退费/已归档学员（全站 ACTIVE_STUDENT_SQL 口径）。
 *
 * 权限：与 /dashboard 同一个 dashboardGuard。其中「待跟进」额外要求跟进权限
 * （与 followups.js 的 canFollowUp 同判据）——无权限时该类别返回空数组，
 * **不报 403**，否则有看板权限但无跟进权限的用户整块雷达都会挂掉。
 */
router.get('/attention', dashboardGuard, (req, res) => {
  try {
    const t = now();
    const DAY = 86400000;
    const u = getReqUser(req);

    // 1) 到期预警：7 天内
    const expiring = db.prepare(`
      SELECT mc.id, mc.student_id, s.name AS student_name,
             mc.card_type_name, mc.expires_at
      FROM member_cards mc
      JOIN students s ON s.id = mc.student_id
      WHERE mc.status = 'active'
        AND mc.expires_at > ? AND mc.expires_at <= ?
        AND ${ACTIVE_STUDENT_SQL}
      ORDER BY mc.expires_at ASC
      LIMIT 10
    `).all(t, t + 7 * DAY);

    // 2) 欠费：待付款订单（未支付的应收）
    const arrears = db.prepare(`
      SELECT o.id, o.order_no, o.student_name, o.payable_amount, o.created_at
      FROM orders o
      WHERE o.status = 'pending'
      ORDER BY o.created_at DESC
      LIMIT 10
    `).all();

    // 3) 连续缺勤：最近 7 次考勤全部为 absent（请假不算缺席）
    //    用窗口函数取每人最近 7 条，再要求其中 absent 数为 7。
    const absences = db.prepare(`
      WITH recent AS (
        SELECT student_id, status,
               ROW_NUMBER() OVER (PARTITION BY student_id ORDER BY date DESC) AS rn
        FROM attendances
        WHERE date IS NOT NULL AND date != ''
      )
      SELECT s.id, s.name, COUNT(*) AS absent_count
      FROM recent r
      JOIN students s ON s.id = r.student_id
      WHERE r.rn <= 7 AND r.status = 'absent' AND ${ACTIVE_STUDENT_SQL}
      GROUP BY s.id, s.name
      HAVING COUNT(*) = 7
      ORDER BY s.name
      LIMIT 10
    `).all();

    // 3.5) 请假待审批：需要老师当下处理的申请
    //      （原在主区「待处理事项」里，现收编进雷达作唯一入口）
    const leaves = db.prepare(`
      SELECT lr.id, lr.student_name, lr.course_name, lr.date, lr.start_time
      FROM leave_requests lr
      WHERE lr.status = 'pending'
      ORDER BY lr.date ASC, lr.start_time ASC
      LIMIT 10
    `).all();

    // 4) 待跟进：今日到期或已逾期（与 followups.js /today 同口径）
    //    无跟进权限时静默跳过，不让整块雷达 403
    let followups = [];
    const canFollow = req.userRole === 'admin'
      || (u && (u.role === 'coach' || hasPerm(u, 'growth') || hasPerm(u, 'sales')));
    if (canFollow) {
      followups = db.prepare(`
        SELECT id, target_name, task_type, reason, due_at, priority
        FROM follow_ups
        WHERE status = 'pending' AND due_at <= ?
        ORDER BY priority ASC, due_at ASC
        LIMIT 10
      `).all(t + (DAY - 1));
    }

    res.json(success({
      expiring,
      followups,
      arrears,
      absences,
      leaves,
      counts: {
        expiring: expiring.length,
        followups: followups.length,
        arrears: arrears.length,
        absences: absences.length,
        leaves: leaves.length,
      },
    }));
  } catch (err) {
    console.error('[admin attention]', err);
    res.status(500).json(safeFail('获取关注雷达失败'));
  }
});

/**
 * GET /api/admin/charts — 看板图表数据
 * 近7天到场率、报名活动分布、产品销量统计
 */
router.get('/charts', dashboardGuard, (req, res) => {
  try {
    // 到场趋势支持按周期查询：week=近7天，month=近30天（默认 week，与看板“本周/本月”切换联动）
    const period = req.query.period === 'month' ? 'month' : 'week';
    const attDays = period === 'month' ? 29 : 6;
    // 日期轴（本地日期字符串，与 SQL 侧 date(...,'localtime') 同口径）
    const dayList = [];
    for (let i = attDays; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000);
      dayList.push({ date: formatDate(d.getTime()), label: `${d.getMonth() + 1}/${d.getDate()}` });
    }

    // 到场趋势：单次 GROUP BY 取代「逐日 prepare + 查询」。
    // 旧实现按天循环 prepare（month 口径 = 30 次编译 + 30 次查询）；此处只编译并执行 1 次，
    // 且 date 区间条件可用索引。口径不变（迟到计到场、请假不进分母，见 utils.attendanceRate）。
    const attMap = new Map(db.prepare(`
      SELECT date,
             COALESCE(SUM(CASE WHEN status = 'present' THEN 1 ELSE 0 END), 0) AS present,
             COALESCE(SUM(CASE WHEN status = 'late' THEN 1 ELSE 0 END), 0) AS late,
             COALESCE(SUM(CASE WHEN status = 'absent' THEN 1 ELSE 0 END), 0) AS absent
      FROM attendances
      WHERE date >= ? AND date <= ?
      GROUP BY date
    `).all(dayList[0].date, dayList[dayList.length - 1].date).map((r) => [r.date, r]));

    const labels = dayList.map((d) => d.label);
    // 无记录的日期传 undefined，attendanceRate 的默认参数会按全 0 处理（与旧实现 COALESCE 结果一致）
    const attendanceData = dayList.map((d) => attendanceRate(attMap.get(d.date)));

    // 报名分布（按活动）
    const enrollRows = db.prepare(`
      SELECT course_name, COUNT(*) as count FROM enrollments
      WHERE status = 'active' GROUP BY course_name ORDER BY count DESC LIMIT 8
    `).all();
    const courseDist = enrollRows.map((c) => ({ name: c.course_name || '未命名活动', count: c.count }));

    // 产品销量（已支付订单按项目统计；单品维度无法分摊订单级退款，故保留毛口径）
    // 聚合下沉到 SQL（json_each）：不再把全部已付订单的 items 读进 JS 逐条 JSON.parse。
    // json_valid + json_type 护栏等价于旧实现的 try/catch —— 非法 JSON / 非数组明细按空处理。
    // 同时修正一处既有偏差：历史数据中存在「数组元素为 JSON 字符串」的双重编码行，
    // 旧实现取 item.itemName 恒为 undefined，这些真实销量被整批计入「其他」；
    // json_extract 对两种形态都能解析，故现在按真实项目名归类。
    // E15：此前对「全部已付订单」做 json_each 展开，订单量上万后每次调用都要解析整表；
    // 产品热度本就是近期口径，收窄到时间窗（默认近 90 天，可用 startDate/endDate 覆盖），返回形状不变。
    //
    // 元素级护栏（F2）：数组本身合法但元素非法时（如 items=["篮球季卡"]），
    // 旧实现对 je.value 直接 json_extract 会抛 malformed JSON，整条查询失败 →
    // /charts 整体 500，图表页全挂。故先把元素归一为 ev（非法元素 ev=NULL）：
    // json_type(NULL) / json_extract(NULL,path) 均返回 NULL 且不抛错，非法元素自然落入
    // 既有的「其他」桶（件数仍计 1）。注意不能写 `json_valid(x) AND json_type(x)=...`
    // —— SQLite 不保证 AND 的求值顺序，json_type 仍可能作用在非法文本上而抛错。
    // 双重编码元素的 ev 是合法 JSON 对象文本，json_type(ev)='object' 成立，
    // 仍按真实 itemName 归类，合法数据输出逐字不变。
    const psEnd = req.query.endDate || formatDate(Date.now());
    const psStart = req.query.startDate || formatDate(Date.now() - 89 * 86400000);
    const productSales = db.prepare(`
      WITH exploded AS (
        SELECT CASE WHEN json_valid(it.value) THEN it.value END AS ev
        FROM orders o, json_each(CASE WHEN json_valid(o.items) AND json_type(o.items) = 'array'
                                      THEN o.items ELSE '[]' END) AS it
        WHERE o.status = 'paid' AND o.paid_at >= ? AND o.paid_at < ?
      )
      SELECT COALESCE(NULLIF(CASE WHEN json_type(ev) = 'object'
                                  THEN json_extract(ev, '$.itemName') END, ''), '其他') AS name,
             SUM(CASE WHEN json_type(ev) = 'object' AND CAST(json_extract(ev, '$.quantity') AS REAL) > 0
                      THEN CAST(json_extract(ev, '$.quantity') AS REAL) ELSE 1 END) AS count
      FROM exploded
      GROUP BY name
      ORDER BY count DESC
    `).all(dayStartMs(psStart), dayEndMs(psEnd)).map((r) => ({ name: r.name, count: Number(r.count) }));

    // 近 30 天营收趋势：当月每日 vs 上月对应日（借鉴 trycompai/crm 的 AreaTrend 双序列）
    // 口径与看板收入 KPI 一致：含已全额退款订单并冲减退款额，否则全额退款当天会凭空少一笔收入。
    // 单次 GROUP BY 取代「逐日 prepare + 查询」：旧实现每天两次共 60 次编译，
    // 且谓词 date(paid_at/1000,'unixepoch','localtime') = ? 不可用索引，等于 60 次全表扫描。
    // 改为先按 paid_at 区间过滤（可用索引）再按同一表达式分组，编译与扫描各降为 1 次。
    const revDays = [];
    for (let i = 29; i >= 0; i--) {
      const cur = new Date(Date.now() - i * 86400000);
      const prev = new Date(cur.getTime() - 30 * 86400000);
      revDays.push({
        label: `${cur.getMonth() + 1}/${cur.getDate()}`,
        cur: formatDate(cur.getTime()),
        prev: formatDate(prev.getTime()),
      });
    }
    // 区间放宽取上界（当前时刻 +1 天）与下界（60 天前，早于所需最早一天 00:00）：
    // 精确归属由 GROUP BY 的日期表达式决定，放宽区间不影响结果，只保证不漏。
    const revMap = new Map(db.prepare(`
      SELECT date(paid_at/1000, 'unixepoch', 'localtime') AS d,
             COALESCE(SUM(payable_amount - COALESCE(refunded_amount, 0)), 0) AS total
      FROM orders
      WHERE status IN ('paid', 'refunded') AND paid_at >= ? AND paid_at <= ?
      GROUP BY d
    `).all(Date.now() - 60 * 86400000, Date.now() + 86400000).map((r) => [r.d, r.total]));

    const revLabels = revDays.map((d) => d.label);
    const revCurrent = revDays.map((d) => revMap.get(d.cur) || 0);
    const revPrev = revDays.map((d) => revMap.get(d.prev) || 0);

    res.json(success({
      attendanceTrend: { labels, data: attendanceData },
      revenueTrend: { labels: revLabels, current: revCurrent, prev: revPrev },
      courseDist,
      productSales
    }));
  } catch (err) {
    res.status(500).json(safeFail('获取图表数据失败'));
  }
});

/**
 * GET /api/admin/export — 导出报表
 * Query: { type } — students / orders / checkin / schedules / points
 */
router.get('/export', adminOnly, (req, res) => {
  try {
    const { type, startDate, endDate } = req.query;
    // E1：导出是 SELECT * 全表装载（orders 分支还要逐行 JSON.parse items），无界导出在大库上会打爆内存。
    // 强制要求时间范围 —— 七种导出类型都有可用的 epoch 毫秒日期列，见下方各分支的 range() 调用。
    if (!startDate || !endDate) {
      return res.status(400).json({ code: 400, data: null, message: '导出需指定时间范围（startDate 与 endDate，格式 YYYY-MM-DD）' });
    }
    let data = [];
    let filename = '';
    // 日期列一律是 epoch 毫秒整数（students.created_at / orders.paid_at / attendances.checkin_time /
    // points.updated_at / member_cards.created_at）。用裸列区间比较而非 date(col/1000,...) 表达式，
    // 前者才能命中索引，后者每次导出都是全表扫描。
    const range = (col) => {
      const parts = [];
      const params = [];
      if (startDate) { parts.push(`${col} >= ?`); params.push(dayStartMs(startDate)); }
      if (endDate) { parts.push(`${col} < ?`); params.push(dayEndMs(endDate)); }
      return { sql: parts.length ? ` AND ${parts.join(' AND ')}` : '', params };
    };

    switch (type) {
      case 'students': {
        const r = range('created_at');
        data = db.prepare(`SELECT s.*, 
            (SELECT pb.parent_name FROM parent_bindings pb WHERE pb.student_id = s.id AND pb.is_main = 1 LIMIT 1) as parent_name,
            (SELECT pb.parent_phone FROM parent_bindings pb WHERE pb.student_id = s.id AND pb.is_main = 1 LIMIT 1) as parent_phone
          FROM students s WHERE s.status = ? AND ${ACTIVE_STUDENT_SQL}${r.sql} ORDER BY s.created_at DESC`).all('active', ...r.params);
        filename = 'students.csv';
        break;
      }
      case 'orders': {
        const r = range('paid_at');
        data = db.prepare(`SELECT * FROM orders WHERE 1=1${r.sql} ORDER BY created_at DESC`).all(...r.params);
        filename = 'orders.csv';
        break;
      }
      case 'checkin': {
        // 不能用 range('checkin_time')：自动缺席（absent）等行不写 checkin_time（见 routes/checkin.js 的
        // runAutoAbsent），该列恒为 NULL；SQL 三值逻辑下 `NULL >= ?` 不为真，会把全部缺席记录静默丢弃。
        // 改用 attendances.date（'YYYY-MM-DD' 文本，所有写入路径均赋值）做区间过滤，
        // 与考勤列表口径一致（见 routes/attendances.js 的 a.date >= ? / a.date <= ?）。
        const parts = [];
        const params = [];
        if (startDate) { parts.push('a.date >= ?'); params.push(startDate); }
        if (endDate) { parts.push('a.date <= ?'); params.push(endDate); }
        const r = { sql: parts.length ? ` AND ${parts.join(' AND ')}` : '', params };
        data = db.prepare(`
          SELECT a.*, s.name as student_name, sc.course_name, sc.start_time, sc.end_time
          FROM attendances a
          LEFT JOIN students s ON s.id = a.student_id
          LEFT JOIN schedules sc ON sc.id = a.schedule_id
          WHERE 1=1${r.sql} ORDER BY a.checkin_time DESC
        `).all(...r.params);
        filename = 'attendances.csv';
        break;
      }
      case 'schedules': {
        const parts = ["status = 'scheduled'"];
        const params = [];
        if (startDate) { parts.push('date >= ?'); params.push(startDate); }
        if (endDate) { parts.push('date <= ?'); params.push(endDate); }
        data = db.prepare(`SELECT * FROM schedules WHERE ${parts.join(' AND ')} ORDER BY date ASC`).all(...params);
        filename = 'schedules.csv';
        break;
      }
      case 'points': {
        // 此前完全无日期过滤、整表 dump；改为按 updated_at 收敛（积分为一人一行，updated_at 即最近变动时间）
        const r = range('updated_at');
        data = db.prepare(`SELECT * FROM points WHERE 1=1${r.sql} ORDER BY balance DESC`).all(...r.params);
        filename = 'points.csv';
        break;
      }
      case 'member_cards': {
        const r = range('created_at');
        data = db.prepare(`SELECT * FROM member_cards WHERE 1=1${r.sql} ORDER BY created_at DESC`).all(...r.params);
        filename = 'member_cards.csv';
        break;
      }
      case 'sales': {
        // 销售排名 + 产品统计（自定义时间段，供看板导出）；时间范围已在上方强制
        const dayFrom = startDate;
        const dayTo = endDate;
        // 金额口径：含已全额退款订单并冲减退款额（与看板 KPI 一致）
        const where = `WHERE status IN ('paid', 'refunded') AND paid_at >= ? AND paid_at < ?`;
        // 产品统计另用窄口径：退款是订单级的，无法分摊到具体商品项，
        // 纳入已全额退款订单会高估单品销量，故单品统计仍只取未退款订单的毛额。
        const wherePaid = `WHERE status = 'paid' AND paid_at >= ? AND paid_at < ?`;
        // 绑定毫秒区间（半开 [from, to+1d)），使 paid_at 上的索引可用
        const fromMs = dayStartMs(dayFrom);
        const toMs = dayEndMs(dayTo);
        const rank = db.prepare(`
          SELECT TRIM(salesperson) AS salesperson, COALESCE(SUM(payable_amount - COALESCE(refunded_amount, 0)), 0) as amount, COUNT(*) as count
          FROM orders ${where} AND TRIM(COALESCE(salesperson, '')) != ''
          GROUP BY TRIM(salesperson) ORDER BY amount DESC
        `).all(fromMs, toMs);
        const revenue = db.prepare(`SELECT COALESCE(SUM(payable_amount - COALESCE(refunded_amount, 0)), 0) as amount, COUNT(*) as count FROM orders ${where}`).get(fromMs, toMs);
        const itemMap = {};
        // items 解析统一走 utils/items（与退卡退款、财务报表同一实现，口径不再分叉）。
        // 历史数据存在「数组元素为 JSON 字符串」的双重编码，且元素未必是对象。
        // 逐项兜底，避免整批计入「未命名产品」或金额恒为 0。
        // 此前用不存在的 i.price 字段，导致单品金额恒为 0；现用行小计 totalPrice，
        // 缺失时回退 unitPrice × 数量（面值），与看板商品统计口径一致。
        for (const o of db.prepare(`SELECT items FROM orders ${wherePaid}`).all(fromMs, toMs)) {
          for (const i of parseItems(o.items)) {
            const name = i.itemName || '未命名产品';
            itemMap[name] = itemMap[name] || { count: 0, amount: 0 };
            itemMap[name].count += itemQuantity(i);
            itemMap[name].amount += itemLineTotal(i);
          }
        }
        const itemStats = Object.entries(itemMap).map(([itemName, v]) => ({ itemName, ...v })).sort((a, b) => b.amount - a.amount);
        const oneToOne = db.prepare(`
          SELECT COALESCE(SUM(payable_amount - COALESCE(refunded_amount, 0)), 0) as amount, COUNT(*) as count FROM orders
          ${where} AND is_1v1 = 1
        `).get(fromMs, toMs);
        data = { revenue, ranking: rank, itemStats, oneToOne, startDate: dayFrom, endDate: dayTo };
        filename = 'sales.csv';
        break;
      }
      default:
        return res.json(fail('未知报表类型，可选：students/orders/checkin/schedules/points/member_cards/sales'));
    }

    res.json(success({ data, count: data.length, filename }));
  } catch (err) {
    res.status(500).json(safeFail("操作失败，请稍后重试"));
  }
});

// suppressions 表已收编至 migrations/014（此前在此处 CREATE TABLE IF NOT EXISTS，
// 对已存在该表的库是静默空操作，老库拿不到新列）

/**
 * GET /api/admin/suppressions — 勿扰名单列表
 */
router.get('/suppressions', adminOnly, (req, res) => {
  try {
    const keyword = req.query.keyword ? `%${req.query.keyword}%` : '';
    const list = keyword
      ? db.prepare('SELECT * FROM suppressions WHERE phone LIKE ? OR name LIKE ? ORDER BY created_at DESC').all(keyword, keyword)
      : db.prepare('SELECT * FROM suppressions ORDER BY created_at DESC').all();
    res.json(success({ list, total: list.length }));
  } catch (err) {
    res.status(500).json(safeFail('获取勿扰名单失败'));
  }
});

/**
 * POST /api/admin/suppressions — 添加勿扰
 * Body: { phone, name, type, reason }
 */
router.post('/suppressions', adminOnly, (req, res) => {
  try {
    const { phone, name = '', type = 'marketing', reason = '' } = req.body;
    if (!phone) return res.json(fail('手机号必填'));
    const exist = db.prepare('SELECT id FROM suppressions WHERE phone = ?').get(phone);
    if (exist) return res.json(fail('该手机号已在勿扰名单'));
    const id = generateId('SUP_');
    db.prepare(`
      INSERT INTO suppressions (id, phone, name, type, reason, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, phone, name, type, reason, getOpenId(req) || '', now());
    // 勿扰名单影响营销触达范围，需留痕（手机号为敏感信息，不写入审计）
    const actor = getActor(req);
    recordAudit(db, {
      entity: 'suppression',
      entityId: id,
      action: 'create',
      actorId: actor.id,
      actorRole: actor.role,
      after: { name, type, reason },
    });
    res.json(success({ id }));
  } catch (err) {
    res.status(500).json(safeFail('添加勿扰失败'));
  }
});

/**
 * DELETE /api/admin/suppressions/:id — 移除勿扰
 */
router.delete('/suppressions/:id', adminOnly, (req, res) => {
  try {
    const result = db.prepare('DELETE FROM suppressions WHERE id = ?').run(req.params.id);
    if (result.changes === 0) return res.json(fail('勿扰记录不存在'));
    // 移出勿扰名单会恢复营销触达，需留痕
    const actor = getActor(req);
    recordAudit(db, {
      entity: 'suppression',
      entityId: req.params.id,
      action: 'delete',
      actorId: actor.id,
      actorRole: actor.role,
    });
    res.json(success({ id: req.params.id, removed: result.changes }));
  } catch (err) {
    res.status(500).json(safeFail('移除勿扰失败'));
  }
});

// ============================================
// 排课基础资源：教师 / 场地 / 活动
// ============================================

/**
 * GET /api/admin/teachers — 在职教师列表
 */
router.get('/teachers', staffRead, (req, res) => {
  try {
    // includeInactive=1 时同时返回停用教练（管理页需要看到停用项以便恢复）
    const where = req.query.includeInactive === '1' ? '' : "WHERE status = 'active'";
    const isAdmin = isAdminReq(req);
    const teachers = db.prepare(`
      SELECT *
      FROM teachers ${where} ORDER BY created_at ASC
    `).all();
    // 批量取关联数据，替代逐教练查 users/schedules（N+1×3）
    const userByPhone = {};
    db.prepare("SELECT phone, role, permissions FROM users WHERE phone IS NOT NULL AND phone != ''").all()
      .forEach((u) => { userByPhone[u.phone] = u; });
    const scheduleCountByTeacher = {};
    db.prepare(`
      SELECT teacher_id, COUNT(*) as count FROM schedules
      WHERE status = 'scheduled' AND date >= date('now', 'localtime') GROUP BY teacher_id
    `).all().forEach((r) => { scheduleCountByTeacher[r.teacher_id] = r.count; });
    const list = teachers.map((t) => {
      const out = { ...t };
      // 手机号、薪酬规则与单课时费仅管理员可见，避免向教练/销售泄露
      if (!isAdmin) {
        delete out.phone;
        delete out.pay_rule;
        delete out.class_fee;
      }
      let payRule = null;
      if (isAdmin && t.pay_rule) {
        try { payRule = JSON.parse(t.pay_rule); } catch (e) { /* 忽略损坏数据 */ }
      }
      out.payRule = payRule;
      // 关联登录账号角色与自定义权限
      const linked = (t.phone && userByPhone[t.phone]) || null;
      out.role = linked ? (linked.role || 'coach') : 'coach';
      out.permissions = resolvePerms(linked || { role: 'coach' });
      // 该教练未来排课数量（详情展示）
      out.scheduleCount = scheduleCountByTeacher[t.id] || 0;
      return out;
    });
    res.json(success({ list, total: list.length }));
  } catch (err) {
    res.status(500).json(safeFail('获取教师列表失败'));
  }
});

/**
 * GET /api/admin/teachers/options — 在职教师轻量选项（「授课教师」下拉用）
 *
 * 为什么单独开这个别名：前端「上课记录」页的教师筛选封装名为 getTeacherOptions，
 * 请求路径 /admin/teachers/options，而后端此前只注册了 /admin/staff-options，
 * 浏览器实测 404 → 教师筛选恒空。两者语义不同：
 *   · staff-options   = 「全体员工」（teachers 表 + 角色映射，用于签单人下拉）；
 *   · teachers/options = 「授课教师」（数据源 teachers 表，仅在职），本接口。
 * 返回结构对齐 staff-options（{ list, total }），但每项仅 id/name（授课下拉无需角色）。
 * 权限与 staff-options 一致（管理员/教练/含 dashboard|sales 权限者可读）。
 * 注册位置：必须早于任何 /teachers/:id 动态路由，否则会被其吞掉（本文件动态路由是
 * PUT/DELETE /teachers/:id，方法不同不会冲突，但仍按约定就近放置以防日后新增 GET）。
 */
router.get('/teachers/options', staffRead, (req, res) => {
  try {
    // 仅列「教练」：teachers 表是员工载体（销售账号也录在里面），
    // 不过滤会让销售出现在「授课教师」下拉里被误选。无登录账号的教师视为教练保留。
    const list = db.prepare(`
      SELECT t.id, t.name FROM teachers t
      LEFT JOIN users u ON u.phone = t.phone
      WHERE t.status = 'active' AND (u.id IS NULL OR u.role = 'coach')
      ORDER BY t.created_at ASC
    `).all();
    res.json(success({ list, total: list.length }));
  } catch (err) {
    res.status(500).json(safeFail('获取教师选项失败'));
  }
});

/**
 * GET /api/admin/parents — 家长通讯录（去重，含绑定成员）
 */
router.get('/parents', adminOnly, (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT pb.parent_openid, pb.parent_name, pb.parent_phone, pb.relation,
        s.id as student_id, s.name as student_name, s.status as student_status
      FROM parent_bindings pb
      JOIN students s ON s.id = pb.student_id
      WHERE pb.parent_openid != '' AND pb.parent_phone != ''
      ORDER BY pb.parent_phone ASC, s.name ASC
    `).all();

    const map = new Map();
    for (const r of rows) {
      const key = r.parent_openid;
      if (!map.has(key)) {
        map.set(key, {
          parent_openid: key,
          parent_name: r.parent_name,
          parent_phone: r.parent_phone,
          relation: r.relation,
          students: [],
        });
      }
      const parent = map.get(key);
      if (r.student_status === 'active') {
        if (!parent.students.some((s) => s.id === r.student_id)) {
          parent.students.push({ id: r.student_id, name: r.student_name });
        }
      }
    }

    const list = [...map.values()];
    res.json(success({ list, total: list.length }));
  } catch (err) {
    res.status(500).json(safeFail('获取家长列表失败'));
  }
});

/**
 * GET /api/admin/staff-options — 员工轻量选项（销售/教练/管理者均可读，用于签单人下拉等）
 * 仅返回姓名与身份，不暴露手机号等敏感信息。
 */
router.get('/staff-options', (req, res) => {
  try {
    const teachers = db.prepare(`
      SELECT id, name, phone FROM teachers WHERE status = 'active' ORDER BY created_at ASC
    `).all();
    // 一次取全部「手机号→角色」映射，替代逐教练查 users（N+1）
    const roleByPhone = {};
    db.prepare("SELECT phone, role FROM users WHERE phone != '' AND phone IS NOT NULL").all()
      .forEach((u) => { roleByPhone[u.phone] = u.role; });
    const list = teachers.map((t) => ({
      id: t.id,
      name: t.name,
      role: (t.phone && roleByPhone[t.phone]) || 'coach',
    }));
    res.json(success({ list, total: list.length }));
  } catch (err) {
    res.status(500).json(safeFail('获取员工列表失败'));
  }
});

/**
 * POST /api/admin/teachers — 新增教师
 * 同步创建教练登录账号（users 表 role=coach），使教练可用手机号登录小程序
 */
router.post('/teachers', adminOnly, (req, res) => {
  try {
    const { name, phone, gender, specialty, hireDate, bio, role = 'coach', permissions, classFee, payRule } = req.body;
    if (!name || !name.trim()) return res.json(fail('教师姓名必填'));
    if (!['coach', 'sales', 'admin'].includes(role)) return res.json(fail('无效的员工身份'));

    // 手机号占用校验：同一手机号不能同时属于其他身份账号
    if (phone) {
      const phoneUser = db.prepare('SELECT id, role FROM users WHERE phone = ?').get(phone);
      if (phoneUser && phoneUser.role !== role) {
        return res.json(fail(`手机号 ${phone} 已注册为其他身份，无法配置为${role === 'admin' ? '管理者' : role === 'sales' ? '销售' : '教练'}`));
      }
    }

    const id = generateId('teacher_');
    const payRuleJson = payRule && typeof payRule === 'object'
      ? JSON.stringify(payRule)
      : null;
    db.prepare(`
      INSERT INTO teachers (id, name, phone, gender, specialty, bio, status, hire_date, class_fee, pay_rule, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)
    `).run(id, name.trim(), phone || '', gender || '', specialty || '', bio || '', hireDate || '', isFinite(Number(classFee)) ? Number(classFee) : 0, payRuleJson, now());

    // 同步创建/启用教练登录账号
    syncCoachAccount(phone, name.trim());
    if (phone) {
      const u = db.prepare('SELECT id FROM users WHERE phone = ?').get(phone);
      if (u) {
        db.prepare('UPDATE users SET role = ?, permissions = ?, updated_at = ? WHERE id = ?')
          .run(role, Array.isArray(permissions) ? JSON.stringify(permissions) : '', now(), u.id);
      }
    }
    // 新增教师会同步创建/提权登录账号（role/permissions），属权限变更，必须留痕
    const actor = getActor(req);
    recordAudit(db, {
      entity: 'teacher',
      entityId: id,
      action: 'create',
      actorId: actor.id,
      actorRole: actor.role,
      after: { name: name.trim(), role, has_phone: !!phone, permissions: Array.isArray(permissions) ? permissions : [] },
    });
    res.json(success({ id }));
  } catch (err) {
    console.error('[admin teachers create]', err);
    res.status(500).json(safeFail('新增教师失败'));
  }
});

/**
 * PUT /api/admin/teachers/:id — 更新教师
 */
router.put('/teachers/:id', adminOnly, (req, res) => {
  try {
    const { name, phone, gender, specialty, hireDate, bio, status, role, permissions, resetPassword, classFee, payRule } = req.body;
    const existing = db.prepare('SELECT id, name, phone, status FROM teachers WHERE id = ?').get(req.params.id);
    if (!existing) return res.json(fail('教师不存在'));

    // 防护：目标账号是管理员时，禁止停用/降级最后一位管理员，也禁止停用当前登录账号
    const targetPhone = phone || existing.phone;
    // 目标登录账号的定位：**先按旧手机号查**。改手机号时新号在 users 里尚不存在，
    // 只按新号查必然为 null —— 这正是「同时改手机号 + 改角色」赋权静默失效的根因：
    // 角色的 UPDATE 靠下方按新号回查命中老账号，但 token_version 的 bump 条件依赖
    // 这里为 null 的 targetUser，于是老账号 role 虽已改、旧 token 却未失效，
    // 7 天内仍带旧角色（权限提升未撤销 / 降级未落地）。旧号优先、再回退新号，
    // 覆盖「未改号」「改号」「清空号码」三种形态。
    const targetUser = (existing.phone ? db.prepare('SELECT id, openid, role, status FROM users WHERE phone = ?').get(existing.phone) : null)
      || (targetPhone ? db.prepare('SELECT id, openid, role, status FROM users WHERE phone = ?').get(targetPhone) : null);
    const willDisable = status === 'inactive' || (role && role !== 'admin' && targetUser && targetUser.role === 'admin');
    if (willDisable && targetUser) {
      if (targetUser.openid === getOpenId(req)) {
        return res.status(400).json(fail('不能停用或降级当前登录的管理员账号'));
      }
      if (targetUser.role === 'admin') {
        const adminCount = db.prepare("SELECT COUNT(*) c FROM users WHERE role = 'admin' AND status = 'active'").get().c;
        if (adminCount <= 1) {
          return res.status(400).json(fail('系统至少需要保留 1 名管理员，无法停用/降级最后一位管理员'));
        }
      }
    }

    // 手机号变更时校验占用并同步迁移登录账号
    const oldPhone = existing.phone || '';
    const newPhone = phone || '';
    // 仅当请求显式传了 phone 且与旧值不同时，才视为手机号变更
    // （不传 phone = 不修改手机号；传空串 = 显式清空并停用登录账号）
    const phoneChanged = phone !== undefined && phone !== oldPhone;
    if (phoneChanged && newPhone && newPhone !== oldPhone) {
      const conflict = db.prepare('SELECT id FROM users WHERE phone = ? AND phone != ?').get(newPhone, oldPhone);
      if (conflict) return res.json(fail(`手机号 ${newPhone} 已被其他账号使用`));
    }

    db.prepare(`
      UPDATE teachers SET
        name = COALESCE(?, name),
        phone = COALESCE(?, phone),
        gender = COALESCE(?, gender),
        specialty = COALESCE(?, specialty),
        hire_date = COALESCE(?, hire_date),
        bio = COALESCE(?, bio),
        status = COALESCE(?, status),
        class_fee = COALESCE(?, class_fee),
        pay_rule = COALESCE(?, pay_rule)
      WHERE id = ?
    `).run(name, phone, gender, specialty, hireDate, bio, status,
      classFee !== undefined && isFinite(Number(classFee)) ? Number(classFee) : null,
      payRule !== undefined ? (payRule && typeof payRule === 'object' ? JSON.stringify(payRule) : null) : null,
      req.params.id);

    // 教师档案的最终状态：请求显式传入优先，未传则沿用原状态。
    // 传入 syncCoachAccount 以「教师档案状态」为准同步登录账号 —— 此前该函数无条件
    // 写 status='active'，停用教练后编辑档案即被静默复活（见 syncCoachAccount 注释）。
    const teacherStatus = status || existing.status || 'active';

    // 同步教练登录账号（手机号/姓名/启用状态）
    if (phoneChanged) {
      if (oldPhone) {
        const oldUser = db.prepare('SELECT id FROM users WHERE phone = ?').get(oldPhone);
        if (oldUser) {
          if (newPhone) {
            db.prepare('UPDATE users SET phone = ?, openid = ?, updated_at = ? WHERE id = ?')
              .run(newPhone, `phone_${newPhone}`, now(), oldUser.id);
          } else {
            db.prepare("UPDATE users SET status = 'inactive', token_version = COALESCE(token_version,0) + 1, updated_at = ? WHERE id = ?").run(now(), oldUser.id);
          }
        }
      }
      if (newPhone) syncCoachAccount(newPhone, name || existing.name, teacherStatus);
    } else {
      // 手机号未变更：按教师档案状态同步登录账号（停用态不得被覆盖为 active）
      syncCoachAccount(newPhone || oldPhone, name || existing.name, teacherStatus);
    }
    if (status === 'inactive') {
      // 显式停用：bump token_version 吊销该账号所有旧 Token（syncCoachAccount 只改状态不吊销）
      db.prepare("UPDATE users SET status = 'inactive', token_version = COALESCE(token_version,0) + 1, updated_at = ? WHERE phone = ?").run(now(), newPhone || oldPhone);
    }

    // 登录账号状态变更单独留痕（entity='user'）：教师档案审计只记 teacher，
    // 而账号启用/停用直接决定能否登录，属权限事件，必须能从「用户」维度追溯 ——
    // 此前「停用教练被编辑档案静默复活」在 users 侧不留任何痕迹，事后无法察觉。
    const accountAfter = (newPhone || oldPhone)
      ? db.prepare('SELECT id, status FROM users WHERE phone = ?').get(newPhone || oldPhone)
      : null;
    if (accountAfter && targetUser && targetUser.status !== accountAfter.status) {
      const actorAcc = getActor(req);
      recordAudit(db, {
        entity: 'user',
        entityId: String(accountAfter.id),
        action: accountAfter.status === 'active' ? 'activate' : 'deactivate',
        actorId: actorAcc.id,
        actorRole: actorAcc.role,
        before: { status: targetUser.status || null },
        after: { status: accountAfter.status, source: 'teacher_update' },
      });
    }

    // Update permissions: sync the login account's role (coach / admin / sales)
    // and custom permissions. Role and permissions update independently so a
    // permissions-only call still takes effect.
    const hasValidRole = role && ['coach', 'admin', 'sales'].includes(role);
    const permUser = targetUser || (targetPhone ? db.prepare('SELECT id, role FROM users WHERE phone = ?').get(targetPhone) : null);
    if (permUser) {
      const updates = [];
      const params = [];
      if (hasValidRole) { updates.push('role = ?'); params.push(role); }
      if (permissions !== undefined) {
        updates.push('permissions = ?');
        params.push(Array.isArray(permissions) ? JSON.stringify(permissions) : '');
      }
      // 角色变更必须吊销旧 Token —— 角色被烘焙进 JWT payload，server.js 的
      // req.userRole 是唯一权威源。判据用 permUser.role（改号后按新号回查命中的
      // 同一老账号）而非改号前按新号查询恒为 null 的 targetUser，否则改号+改角色时
      // bump 静默跳过，旧 token 7 天内仍带旧角色。
      if (hasValidRole && permUser.role !== role) {
        updates.push('token_version = COALESCE(token_version,0) + 1');
      }
      if (updates.length) {
        params.push(now(), permUser.id);
        db.prepare(`UPDATE users SET ${updates.join(', ')}, updated_at = ? WHERE id = ?`).run(...params);
      }
    } else if (targetPhone && hasValidRole) {
      // 无登录账号时按目标角色创建
      db.prepare(`
        INSERT INTO users (id, openid, phone, nickname, avatar, role, password, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, '', ?, ?, 'active', ?, ?)
      `).run(generateId('user_'), `phone_${targetPhone}`, targetPhone, name || existing.name, role,
        hashPassword(getStaffDefaultPassword()), now(), now());
    }

    // 重置登录密码为初始密码（STAFF_DEFAULT_PASSWORD 可配，默认 123456）
    if (resetPassword) {
      const targetPhone = newPhone || oldPhone;
      if (targetPhone) {
        // bump token_version：重置后该账号旧 Token 全部失效
        db.prepare("UPDATE users SET password = ?, token_version = COALESCE(token_version,0) + 1, updated_at = ? WHERE phone = ?")
          .run(hashPassword(getStaffDefaultPassword()), now(), targetPhone);
      }
    }
    // 教师更新可能同步改登录账号角色/权限/密码/启用状态，属权限变更，必须留痕
    // （手机号与密码为敏感信息，仅记录「是否变更」布尔位）
    const actor = getActor(req);
    recordAudit(db, {
      entity: 'teacher',
      entityId: req.params.id,
      action: 'update',
      actorId: actor.id,
      actorRole: actor.role,
      before: { name: existing.name },
      after: {
        name: name || existing.name,
        status: status || null,
        role: hasValidRole ? role : null,
        phone_changed: !!phoneChanged,
        password_reset: !!resetPassword,
      },
    });
    res.json(success({ id: req.params.id }));
  } catch (err) {
    res.status(500).json(safeFail('更新教师失败'));
  }
});

/**
 * DELETE /api/admin/teachers/:id — 停用教师
 */
router.delete('/teachers/:id', adminOnly, (req, res) => {
  try {
    const existing = db.prepare('SELECT id, name, phone FROM teachers WHERE id = ?').get(req.params.id);
    if (!existing) return res.json(fail('教师不存在'));
    // 防护：停用管理员账号须保留至少 1 名管理员，且不能停用当前登录账号
    if (existing.phone) {
      const targetUser = db.prepare('SELECT id, openid, role FROM users WHERE phone = ?').get(existing.phone);
      if (targetUser && targetUser.role === 'admin') {
        if (targetUser.openid === getOpenId(req)) {
          return res.status(400).json(fail('不能停用当前登录的管理员账号'));
        }
        const adminCount = db.prepare("SELECT COUNT(*) c FROM users WHERE role = 'admin' AND status = 'active'").get().c;
        if (adminCount <= 1) {
          return res.status(400).json(fail('系统至少需要保留 1 名管理员，无法停用最后一位管理员'));
        }
      }
    }
    db.prepare("UPDATE teachers SET status = 'inactive' WHERE id = ?").run(req.params.id);
    // 同步停用教练登录账号（bump token_version 吊销其旧 Token）
    if (existing.phone) {
      db.prepare("UPDATE users SET status = 'inactive', token_version = COALESCE(token_version,0) + 1, updated_at = ? WHERE phone = ?").run(now(), existing.phone);
    }
    // 停用只影响账号可用性，不动历史/未来排期数据：排期上的教练字段是对
    // 「这节课当时安排了谁」的事实记录，不因账号停用而消失。保留它可使停用与
    // 重新启用完全对称，避免重新启用后无法回填、管理员被迫逐条手工重排（返工）。
    // 停用教师会同步停用登录账号，属权限变更，必须留痕
    const actor = getActor(req);
    recordAudit(db, {
      entity: 'teacher',
      entityId: req.params.id,
      action: 'deactivate',
      actorId: actor.id,
      actorRole: actor.role,
      before: { name: existing.name },
      after: { status: 'inactive', schedules_cleared: false },
    });
    res.json(success({ id: req.params.id }));
  } catch (err) {
    res.status(500).json(safeFail('停用教师失败'));
  }
});

/**
 * GET /api/admin/classrooms — 场地列表
 */
router.get('/classrooms', (req, res) => {
  try {
    const list = db.prepare(`
      SELECT id, name, capacity, area, equipment, location, status, color
      FROM classrooms WHERE status = 'active' ORDER BY created_at ASC
    `).all();
    res.json(success({ list, total: list.length }));
  } catch (err) {
    res.status(500).json(safeFail('获取场地列表失败'));
  }
});

/**
 * 场地未来排期守卫：列出仍引用该场地、且尚未取消的未来场次。
 * schedules.classroom_id 无外键，停用/删除场地后未来排期仍指向它，
 * 教练按排期到场才发现场地已不可用。故置为非 active 前先拦下并要求显式确认。
 * 「未来」= date >= 今日；已取消（cancelled）场次不计入。
 */
function classroomFutureConflicts(classroomId) {
  return db.prepare(`
    SELECT id, date, start_time, end_time, course_name
    FROM schedules
    WHERE classroom_id = ? AND date >= ? AND status != 'cancelled'
    ORDER BY date ASC, start_time ASC
  `).all(classroomId, formatDate(now()));
}

/** 场地冲突响应体（数量 + 前 5 条明细），供前端展示「哪些场次占了场地」 */
function classroomConflictPayload(conflicts) {
  return {
    conflictCount: conflicts.length,
    conflicts: conflicts.slice(0, 5).map((c) => ({
      id: c.id, date: c.date, start_time: c.start_time, end_time: c.end_time, course_name: c.course_name,
    })),
  };
}

/**
 * POST /api/admin/classrooms — 新增场地
 * Body: { name, capacity, area, equipment, location, color }
 * 名称必填且唯一（trim + 忽略大小写）：同名场地会让教练排错课。
 */
router.post('/classrooms', adminOnly, (req, res) => {
  try {
    const { name, capacity, area, equipment, location, color } = req.body;
    const cleanName = String(name || '').trim();
    if (!cleanName) return res.json(fail('场地名称必填'));
    // 唯一性校验用 LOWER(TRIM(name))：历史数据可能存在前后空格或大小写差异的同名场地
    const dup = db.prepare('SELECT id FROM classrooms WHERE LOWER(TRIM(name)) = LOWER(?)').get(cleanName);
    if (dup) return res.json(fail(`已存在同名场地「${cleanName}」`));

    const id = generateId('classroom_');
    const num = (v) => (v !== undefined && isFinite(Number(v)) ? Number(v) : 0);
    db.prepare(`
      INSERT INTO classrooms (id, name, capacity, area, equipment, location, status, color, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)
    `).run(id, cleanName, num(capacity), num(area), equipment || '', location || '', color || '', now());
    // 场地是排课基础数据，变更会影响未来排期，需留痕
    const actor = getActor(req);
    recordAudit(db, {
      entity: 'classroom',
      entityId: id,
      action: 'create',
      actorId: actor.id,
      actorRole: actor.role,
      after: { name: cleanName, capacity: num(capacity), location: location || '', color: color || '' },
    });
    res.json(success({ id }));
  } catch (err) {
    console.error('[admin classroom create]', err);
    res.status(500).json(safeFail('新增场地失败'));
  }
});

/**
 * PUT /api/admin/classrooms/:id — 更新场地（改名/容量/设备/位置/颜色/状态）
 *
 * 停用守卫：把 status 置为非 'active' 时，若存在**未来**排期引用该场地则拒绝，
 * 并在响应 data 里列出冲突场次；除非请求显式带 confirmCascade:true —— 此时把这些
 * 未来排期的 classroom_id/classroom_name 清空（解除占用），但**不取消排期本身**
 * （排期是教学事实，是否取消应由排课流程决定，不能因停用场地被连带取消）。
 */
router.put('/classrooms/:id', adminOnly, (req, res) => {
  try {
    const existing = db.prepare('SELECT * FROM classrooms WHERE id = ?').get(req.params.id);
    if (!existing) return res.json(fail('场地不存在'));
    const { name, capacity, area, equipment, location, color, status, confirmCascade } = req.body;

    // 改名唯一性（trim + 忽略大小写），排除自身
    if (name !== undefined) {
      const cleanName = String(name).trim();
      if (!cleanName) return res.json(fail('场地名称不能为空'));
      const dup = db.prepare('SELECT id FROM classrooms WHERE LOWER(TRIM(name)) = LOWER(?) AND id != ?')
        .get(cleanName, req.params.id);
      if (dup) return res.json(fail(`已存在同名场地「${cleanName}」`));
    }

    const nextStatus = status !== undefined ? String(status) : existing.status;
    const willDeactivate = nextStatus !== 'active';
    let conflicts = [];
    if (willDeactivate) {
      conflicts = classroomFutureConflicts(req.params.id);
      if (conflicts.length && confirmCascade !== true) {
        return res.status(400).json({
          code: 400,
          data: classroomConflictPayload(conflicts),
          message: `该场地仍有 ${conflicts.length} 场未来排期，停用前请先调整；如确认强制停用请带 confirmCascade:true 解除占用`,
        });
      }
    }

    const numOrNull = (v) => (v !== undefined && isFinite(Number(v)) ? Number(v) : null);
    // 事务：更新场地 + （可选）清空未来排期引用必须同生共死，避免半完成状态
    const detached = db.transaction(() => {
      db.prepare(`
        UPDATE classrooms SET
          name = COALESCE(?, name),
          capacity = COALESCE(?, capacity),
          area = COALESCE(?, area),
          equipment = COALESCE(?, equipment),
          location = COALESCE(?, location),
          color = COALESCE(?, color),
          status = COALESCE(?, status)
        WHERE id = ?
      `).run(
        name !== undefined ? String(name).trim() : null,
        numOrNull(capacity), numOrNull(area),
        equipment !== undefined ? String(equipment) : null,
        location !== undefined ? String(location) : null,
        color !== undefined ? String(color) : null,
        status !== undefined ? nextStatus : null,
        req.params.id
      );
      if (willDeactivate && confirmCascade === true && conflicts.length) {
        const ph = conflicts.map(() => '?').join(',');
        db.prepare(`UPDATE schedules SET classroom_id = '', classroom_name = '' WHERE id IN (${ph})`)
          .run(...conflicts.map((c) => c.id));
      }
      return (willDeactivate && confirmCascade === true) ? conflicts.length : 0;
    })();
    // 场地配置/状态变更影响未来排课，需留痕
    const actor = getActor(req);
    recordAudit(db, {
      entity: 'classroom',
      entityId: req.params.id,
      action: 'update',
      actorId: actor.id,
      actorRole: actor.role,
      before: { name: existing.name, status: existing.status },
      after: {
        name: name !== undefined ? String(name).trim() : existing.name,
        status: nextStatus,
        detached_schedules: detached,
      },
    });
    res.json(success({ id: req.params.id, status: nextStatus, detachedSchedules: detached }));
  } catch (err) {
    console.error('[admin classroom update]', err);
    res.status(500).json(safeFail('更新场地失败'));
  }
});

/**
 * DELETE /api/admin/classrooms/:id — 软删场地
 *
 * 一律软删（status='inactive'），不做物理删除：历史排期以 classroom_id/classroom_name
 * 记录「这节课当时在哪上」，物理删掉会让历史数据失去归属；而 GET /classrooms 只返回
 * active 场地，软删后自然从可选列表消失。未来排期守卫同 PUT（可 confirmCascade 解除占用）。
 */
router.delete('/classrooms/:id', adminOnly, (req, res) => {
  try {
    const existing = db.prepare('SELECT id, name, status FROM classrooms WHERE id = ?').get(req.params.id);
    if (!existing) return res.json(fail('场地不存在'));
    // confirmCascade 兼容 body 与 query 两种传法（DELETE 带 body 的客户端支持不一致）
    const confirmCascade = (req.body && req.body.confirmCascade === true)
      || req.query.confirmCascade === 'true';
    const conflicts = classroomFutureConflicts(req.params.id);
    if (conflicts.length && !confirmCascade) {
      return res.status(400).json({
        code: 400,
        data: classroomConflictPayload(conflicts),
        message: `该场地仍有 ${conflicts.length} 场未来排期，删除前请先调整；如确认强制删除请带 confirmCascade:true 解除占用`,
      });
    }
    const detached = db.transaction(() => {
      db.prepare("UPDATE classrooms SET status = 'inactive' WHERE id = ?").run(req.params.id);
      if (confirmCascade && conflicts.length) {
        const ph = conflicts.map(() => '?').join(',');
        db.prepare(`UPDATE schedules SET classroom_id = '', classroom_name = '' WHERE id IN (${ph})`)
          .run(...conflicts.map((c) => c.id));
      }
      return confirmCascade ? conflicts.length : 0;
    })();
    // 删除（软删）场地影响未来排课与历史数据归属，需留痕
    const actor = getActor(req);
    recordAudit(db, {
      entity: 'classroom',
      entityId: req.params.id,
      action: 'delete',
      actorId: actor.id,
      actorRole: actor.role,
      before: { name: existing.name, status: existing.status },
      after: { status: 'inactive', soft_deleted: true, detached_schedules: detached },
    });
    res.json(success({ id: req.params.id, softDeleted: true, detachedSchedules: detached }));
  } catch (err) {
    console.error('[admin classroom delete]', err);
    res.status(500).json(safeFail('删除场地失败'));
  }
});

/**
 * GET /api/admin/courses — 活动列表
 */
router.get('/courses', (req, res) => {
  try {
    // includeInactive=1 时同时返回停用/归档活动（管理页需要看到以便恢复）；
    // 默认仅返回在售且未归档的活动，归档后的班级从可报名/可选列表中隐藏
    const where = req.query.includeInactive === '1' ? '' : 'WHERE is_active = 1 AND archived = 0';
    const list = db.prepare(`
      SELECT id, name, category, description, duration, consume_classes, color,
             min_age, max_age, training_plan, max_students, price_per_class, is_active, archived,
             (SELECT COUNT(*) FROM student_class WHERE class_id = courses.id) AS member_count
      FROM courses ${where} ORDER BY created_at ASC
    `).all();
    res.json(success({ list, total: list.length }));
  } catch (err) {
    res.status(500).json(safeFail('获取活动列表失败'));
  }
});

/**
 * GET /api/admin/courses/options — 活动轻量选项（用于上课记录课程筛选等）
 * 仅返回 id 与名称，支持 q 搜索；默认返回全部（含停用/归档），以对齐历史下拉行为。
 * 必须放在 /courses/:id 之前。
 */
router.get('/courses/options', (req, res) => {
  try {
    const { q, includeInactive } = req.query;
    let where = '';
    const params = [];
    // 历史下拉使用 includeInactive=true，故默认不过滤；仅当显式 includeInactive=0 时只取在售
    if (includeInactive === '0') where = 'WHERE is_active = 1 AND archived = 0';
    if (q) {
      where += (where ? ' AND' : 'WHERE') + ' name LIKE ?';
      params.push(`%${q}%`);
    }
    const list = db.prepare(`
      SELECT id, name FROM courses ${where} ORDER BY created_at ASC LIMIT 50
    `).all(...params);
    res.json(success({ list, total: list.length }));
  } catch (err) {
    res.status(500).json(safeFail('获取活动选项失败'));
  }
});

/**
 * 解析并校验课程适龄区间（分龄段开班：3-5 / 6-8 / 9-12 / 13-15）。
 *
 * 空串 / null / undefined → NULL，表示「不限」；其余必须是 0–18 的整数。
 * 两端都有值时要求 min <= max，否则这个区间永远匹配不到任何学员，
 * 静默存进去比拒绝更糟（用户以为设好了，实际分不出班）。
 *
 * @returns {{min:number|null, max:number|null}|{err:string}}
 */
function parseAgeRange(minAge, maxAge) {
  const toAge = (v) => {
    if (v === undefined || v === null || v === '') return null;
    const n = Number(v);
    return Number.isInteger(n) ? n : NaN;
  };
  const min = toAge(minAge);
  const max = toAge(maxAge);
  if (Number.isNaN(min)) return { err: '适龄下限需为 0-18 的整数' };
  if (Number.isNaN(max)) return { err: '适龄上限需为 0-18 的整数' };
  if (min !== null && (min < 0 || min > 18)) return { err: '适龄下限需为 0-18 的整数' };
  if (max !== null && (max < 0 || max > 18)) return { err: '适龄上限需为 0-18 的整数' };
  if (min !== null && max !== null && min > max) return { err: '适龄下限不能大于上限' };
  return { min, max };
}

// 教案文本长度上限：存的是要点/文件链接，不是富文本，2000 字符足够且防止塞爆单行
const TRAINING_PLAN_MAX = 2000;

/**
 * POST /api/admin/courses — 新建活动
 */
router.post('/courses', adminOnly, (req, res) => {
  try {
    const { name, category, description, duration, consumeClasses, color, maxStudents, pricePerClass,
      minAge, maxAge, trainingPlan } = req.body;
    if (!name || !name.trim()) return res.json(fail('活动名称必填'));
    // 适龄区间与教案：前端课程表单已暴露这三个字段（按年龄分层开班 + 教案挂载）。
    // 后端若不接收就会**静默丢弃** —— 表单能填、存不进去，比没有这个字段更容易误导。
    const age = parseAgeRange(minAge, maxAge);
    if (age.err) return res.json(fail(age.err));
    const plan = String(trainingPlan || '').trim().slice(0, TRAINING_PLAN_MAX);

    const id = generateId('course_');
    db.prepare(`
      INSERT INTO courses (id, name, category, description, duration, consume_classes, color,
        max_students, price_per_class, min_age, max_age, training_plan, is_active, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
    `).run(id, name.trim(), category || '常规训练', description || '', duration || 90,
      consumeClasses || 1, color || '#FF6B35', maxStudents || 0, pricePerClass || 0,
      age.min, age.max, plan, now());
    // 新建活动（班级）属业务基础数据变更，需留痕
    const actor = getActor(req);
    recordAudit(db, {
      entity: 'course',
      entityId: id,
      action: 'create',
      actorId: actor.id,
      actorRole: actor.role,
      after: {
        name: name.trim(), category: category || '常规训练', consume_classes: consumeClasses || 1,
        min_age: age.min, max_age: age.max, training_plan: plan ? '（已填写）' : '',
      },
    });

    res.json(success({ id }));
  } catch (err) {
    console.error('[admin courses create]', err);
    res.status(500).json(safeFail('创建活动失败'));
  }
});

/**
 * PUT /api/admin/courses/:id — 更新活动
 */
router.put('/courses/:id', adminOnly, (req, res) => {
  try {
    const { name, category, description, duration, consumeClasses, color, maxStudents, pricePerClass, isActive, archived } = req.body;
    const existing = db.prepare('SELECT * FROM courses WHERE id = ?').get(req.params.id);
    if (!existing) return res.json(fail('活动不存在'));

    if (typeof archived === 'number' || typeof archived === 'boolean') {
      db.prepare('UPDATE courses SET archived = ? WHERE id = ?')
        .run(archived ? 1 : 0, req.params.id);
    }

    // 部分更新容错：未传字段以 null 绑定，避免 better-sqlite3 拒绝 undefined
    const p = (v) => (v === undefined ? null : v);
    db.prepare(`
      UPDATE courses SET
        name = COALESCE(?, name),
        category = COALESCE(?, category),
        description = COALESCE(?, description),
        duration = COALESCE(?, duration),
        consume_classes = COALESCE(?, consume_classes),
        color = COALESCE(?, color),
        max_students = COALESCE(?, max_students),
        price_per_class = COALESCE(?, price_per_class),
        is_active = COALESCE(?, is_active)
      WHERE id = ?
    `).run(p(name), p(category), p(description), p(duration), p(consumeClasses), p(color), p(maxStudents), p(pricePerClass), p(isActive), req.params.id);

    // 适龄区间与教案**不能用 COALESCE**：前端要把适龄改回「不限」时会传 null / ''，
    // 而 COALESCE(?, col) 在传入 NULL 时保留旧值，永远清不掉 —— 用户点了「不限」
    // 却仍看到旧区间，属静默失效。故对这三个字段改用显式存在性判断。
    const has = (k) => Object.prototype.hasOwnProperty.call(req.body, k);
    let ageAfter = null;
    if (has('minAge') || has('maxAge')) {
      // 只传一端时，另一端沿用库内现值再校验，避免「只改上限」把区间改成非法组合。
      const age = parseAgeRange(
        has('minAge') ? req.body.minAge : existing.min_age,
        has('maxAge') ? req.body.maxAge : existing.max_age,
      );
      if (age.err) return res.json(fail(age.err));
      db.prepare('UPDATE courses SET min_age = ?, max_age = ? WHERE id = ?')
        .run(age.min, age.max, req.params.id);
      ageAfter = age;
    }
    if (has('trainingPlan')) {
      db.prepare('UPDATE courses SET training_plan = ? WHERE id = ?')
        .run(String(req.body.trainingPlan || '').trim().slice(0, TRAINING_PLAN_MAX), req.params.id);
    }
    // 活动（班级）配置变更影响课时消耗口径与售卖，需留痕
    const actor = getActor(req);
    recordAudit(db, {
      entity: 'course',
      entityId: req.params.id,
      action: 'update',
      actorId: actor.id,
      actorRole: actor.role,
      before: { name: existing.name, min_age: existing.min_age, max_age: existing.max_age },
      after: {
        name: name || existing.name,
        consume_classes: consumeClasses === undefined ? null : consumeClasses,
        is_active: isActive === undefined ? null : (isActive ? 1 : 0),
        archived: (typeof archived === 'number' || typeof archived === 'boolean') ? (archived ? 1 : 0) : null,
        // 未改动时为 null（与既有字段一致的「未变更」表示法），避免审计里刷无意义的行
        min_age: ageAfter ? ageAfter.min : null,
        max_age: ageAfter ? ageAfter.max : null,
        training_plan: has('trainingPlan')
          ? (String(req.body.trainingPlan || '').trim() ? '（已填写）' : '（已清空）')
          : null,
      },
    });

    res.json(success({ id: req.params.id }));
  } catch (err) {
    console.error('[admin courses update]', err);
    res.status(500).json(safeFail('更新活动失败'));
  }
});

/**
 * DELETE /api/admin/courses/:id — 删除活动
 * 高危不可逆防护：删除课程会连带删掉扣课流水，却**不回补** member_cards 的
 * remaining_classes/used_classes —— 学员课时凭空少一截，且事后无法察觉。
 * 同理，出勤是计薪与出勤率的依据、收入结转是财务口径的依据，删掉都会让账对不上。
 *
 * 因此：已产生上课（attendances）、扣课（deduction_logs / leave_deduction_logs）、
 * 收入结转（revenue_recognitions）或补课（makeup_records）痕迹的课程一律拒绝删除，
 * 引导改为「停用」（PUT /api/admin/courses/:id { isActive: 0 }）。
 * 只排了课、还没上过的活动仍然允许删除 —— 建错的活动需要能清掉，
 * 且其积分流水会在下方事务里正确回滚，不会造成账实不符。
 */
router.delete('/courses/:id', adminOnly, (req, res) => {
  try {
    const existing = db.prepare('SELECT * FROM courses WHERE id = ?').get(req.params.id);
    if (!existing) return res.json(fail('活动不存在'));
    const scheds = db.prepare('SELECT id FROM schedules WHERE course_id = ?').all(req.params.id);

    // 使用痕迹统计：任一 > 0 即视为已产生教学/财务后果，禁止删除。
    // 无排期时以 IN (NULL) 占位——匹配不到任何行，避免拼出空 IN () 的语法错误。
    const usageIds = scheds.map((s) => s.id);
    const usagePh = usageIds.length ? usageIds.map(() => '?').join(',') : 'NULL';
    const countRows = (sql, ...args) => db.prepare(sql).get(...args).n;
    // 只把「删了会让账对不上」的痕迹作为拦截依据，不要看有没有排期。
    //   · attendances —— 出勤是计薪与出勤率的依据，删掉后已结算薪资失去凭据
    //   · deduction_logs / leave_deduction_logs —— 课时已被真实消耗，
    //     而删除路径不回补 member_cards 的 remaining_classes，学员课时会凭空少一截
    //   · revenue_recognitions —— 收入已结转，抹掉台账会让财务口径对不上
    //   · makeup_records —— 补课占用了课时安排
    // 反过来，只有排期与报名、尚未上过课的活动，删除是安全的（也确实需要能删，
    // 否则建错的活动永远清不掉），其积分流水会在下方事务里正确回滚。
    const usage = {
      attendances: countRows(`SELECT COUNT(*) n FROM attendances WHERE schedule_id IN (${usagePh})`, ...usageIds),
      deductions: countRows(`SELECT COUNT(*) n FROM deduction_logs WHERE schedule_id IN (${usagePh})`, ...usageIds),
      leaveDeductions: countRows(`SELECT COUNT(*) n FROM leave_deduction_logs WHERE schedule_id IN (${usagePh})`, ...usageIds),
      makeups: countRows(`SELECT COUNT(*) n FROM makeup_records WHERE original_schedule_id IN (${usagePh}) OR makeup_schedule_id IN (${usagePh})`, ...usageIds, ...usageIds),
      recognitions: countRows(`SELECT COUNT(*) n FROM revenue_recognitions WHERE schedule_id IN (${usagePh})`, ...usageIds)
        + countRows('SELECT COUNT(*) n FROM revenue_recognitions WHERE course_id = ?', req.params.id),
    };
    if (Object.keys(usage).some((k) => usage[k] > 0)) {
      return res.status(400).json(fail('该活动已产生上课、扣课或收入结转记录，删除会导致课时与账目对不上；请改为「停用」'));
    }
    // 级联清理包事务：中途失败会留下「报名已删、排期还在」的半删状态。
    // 删除签到流水时同步回滚 points.balance/total_earned——此前只删流水不改余额，
    // 学员积分账户凭空多出已删除活动的分数，兑换时账实不符。
    db.transaction(() => {
      if (scheds.length) {
        const ph = scheds.map(() => '?').join(',');
        const ids = scheds.map((s) => s.id);
        // Cascade-clean schedule-related rows. Roll back point logs by net sum
        // of earn+checkin (including reversal rows) before deleting them.
        const affected = db.prepare(`
          SELECT student_id, SUM(amount) total FROM point_logs
          WHERE type IN ('earn','checkin') AND reference_id IN (${ph}) GROUP BY student_id
        `).all(...ids).filter((a) => {
          // 净额为 0 的学员确实不用动：流水整批删除的净变动是 0，余额不动，两边自洽。
          // 但净额为**负**的必须处理（旧实现用 > 0 把它滤掉了）：净额为负说明这批流水里
          // 回滚（负值行）多于获得，整批删除后流水净额是**增加** |total| 的，
          // 余额若不动就会出现「流水净变动 ≠ 余额变动」。下面的 Math.min 对负数天然成立：
          // min(-10, 30) = -10 → newBal = 30 - (-10) = 40，与流水净增 10 一致。
          return (a.total || 0) !== 0;
        });
        db.prepare('DELETE FROM enrollments WHERE schedule_id IN (' + ph + ')').run(...ids);
        db.prepare('DELETE FROM attendances WHERE schedule_id IN (' + ph + ')').run(...ids);
        db.prepare('DELETE FROM leave_requests WHERE schedule_id IN (' + ph + ')').run(...ids);
        db.prepare('DELETE FROM deduction_logs WHERE schedule_id IN (' + ph + ')').run(...ids);
        // 补齐此前漏删的关联表：请假扣课流水、补课记录、已确认收入台账。
        // 只删流水不清理这些行，会在排期消失后留下指向空排期的孤儿数据。
        db.prepare('DELETE FROM leave_deduction_logs WHERE schedule_id IN (' + ph + ')').run(...ids);
        db.prepare('DELETE FROM makeup_records WHERE original_schedule_id IN (' + ph + ') OR makeup_schedule_id IN (' + ph + ')').run(...ids, ...ids);
        db.prepare('DELETE FROM revenue_recognitions WHERE schedule_id IN (' + ph + ')').run(...ids);
        db.prepare('DELETE FROM point_logs WHERE reference_id IN (' + ph + ')').run(...ids);
        db.prepare('DELETE FROM coach_comments WHERE schedule_id IN (' + ph + ')').run(...ids);
        db.prepare('DELETE FROM schedules WHERE id IN (' + ph + ')').run(...ids);
        for (const a of affected) {
          // 上面已把这批流水整批 DELETE，流水净变动恒为 −a.total，余额必须同步变动 −a.total。
          // · a.total > 0（净获得）：只能扣到 0 为止。余额只有 30 而要回滚 100 时实扣 30，
          //   若照旧扣 a.total，余额被 MAX(0,…) 截断成 0 而流水净减 100，两者永久相差 70。
          // · a.total < 0（回滚多于获得）：删掉的是负值行，流水净额反而**增加** |total|，
          //   余额必须同增 |total| —— 下面的 Math.min 对负数天然成立（min(-10,30) = -10）。
          const acc = db.prepare('SELECT balance FROM points WHERE student_id = ?').get(a.student_id);
          const actual = Math.min(a.total, (acc && acc.balance) || 0);
          // a.total > 0 时 actual ≤ balance 故结果 ≥ 0；a.total < 0 时结果高于原余额（补回被回滚的分）
          const newBal = ((acc && acc.balance) || 0) - actual;
          db.prepare(`
            UPDATE points SET
              total_earned = MAX(0, total_earned - ?),
              balance = ?,
              updated_at = ?
            WHERE student_id = ?
          `).run(actual, newBal, now(), a.student_id);
          // 已消耗掉、追不回的那部分（a.total − actual）补记一笔，使流水的净变动恰好
          // 等于余额变动 −actual；否则「流水合计」与「账户余额」会永久对不上。
          // 注：流水行仍需随活动一并清理（见上 DELETE），故这里补记的是净额差额而非原行。
          if (a.total - actual > 0) {
            db.prepare(`
              INSERT INTO point_logs (id, student_id, type, amount, balance, reason, description, created_at)
              VALUES (?, ?, 'earn', ?, ?, '删除活动回滚积分', '删除活动：积分已消耗部分不可回收', ?)
            `).run(generateId('PLG'), a.student_id, a.total - actual, newBal, now());
          }
        }
      }
      // 课程级关联：班级成员归属（student_class.class_id 即 courses.id）、
      // 按 course_id 直连的收入台账，一并清掉避免留下孤儿行
      db.prepare('DELETE FROM student_class WHERE class_id = ?').run(req.params.id);
      db.prepare('DELETE FROM revenue_recognitions WHERE course_id = ?').run(req.params.id);
      db.prepare('DELETE FROM courses WHERE id = ?').run(req.params.id);
    })();
    // 删除活动会级联清理排期/报名/签到/积分流水，属高危操作，必须留痕
    const actor = getActor(req);
    recordAudit(db, {
      entity: 'course',
      entityId: req.params.id,
      action: 'delete',
      actorId: actor.id,
      actorRole: actor.role,
      before: { name: existing.name, is_active: existing.is_active },
      after: { deleted_schedules: scheds.length },
    });
    res.json(success({ id: req.params.id }));
  } catch (err) {
    console.error('[admin course delete]', err);
    res.status(500).json(safeFail('删除活动失败'));
  }
});

/**
 * GET /api/admin/courses/:id/members — 班级成员列表
 * 返回归属到该课程(班级)的成员，含学员基础信息
 */
router.get('/courses/:id/members', adminOnly, (req, res) => {
  try {
    const cls = db.prepare('SELECT id, name FROM courses WHERE id = ?').get(req.params.id);
    if (!cls) return res.json(fail('班级不存在'));
    // 已删除（status='refunded'）/ 已归档（archived=1）学员不占旧模型（student_class）名册。
    // 注意：此处学员表别名是 st 不是 s，故未复用 utils/student-state 的 ACTIVE_STUDENT_SQL，
    // 条件与之一致；日后改判据时两处都要改。
    const list = db.prepare(`
      SELECT sc.id AS link_id, sc.student_id, sc.role, sc.joined_at,
             st.name, st.avatar, st.gender,
             -- 原先直接取 st.age，但 students 表根本没有 age 列（只有 birthday），
             -- 这条查询对任何调用恒 500 且被 catch 吞掉，名册永远空白。
             -- 改为按 birthday 派生，口径必须与学员列表（students.js）完全一致，
             -- 否则同一学员在名册页与学员页会显示两个不同的年龄。
             -- 用「年份差 − 今年生日是否已过」而非 365.25 天数除法：后者是截断，
             -- 生日当天及之前约 3 个月都会少算 1 岁（实测生日当天算出 9，实际应为 10）。
             -- ⚠️ 分龄段（courses.min_age/max_age）一旦启用，本口径会整体右移一岁。
             CASE
               WHEN st.birthday IS NOT NULL AND st.birthday != ''
                    AND st.birthday <= date('now')
               THEN CAST(strftime('%Y', 'now') AS INTEGER)
                    - CAST(strftime('%Y', st.birthday) AS INTEGER)
                    - (strftime('%m-%d', 'now') < strftime('%m-%d', st.birthday))
               ELSE NULL
             END AS age
      FROM student_class sc
      LEFT JOIN students st ON st.id = sc.student_id
      WHERE sc.class_id = ?
        AND COALESCE(st.archived, 0) = 0 AND COALESCE(st.status, '') <> 'refunded'
      ORDER BY sc.joined_at ASC
    `).all(req.params.id);
    res.json(success({ list, total: list.length, classId: cls.id, className: cls.name }));
  } catch (err) {
    console.error('[admin course members]', err);
    res.status(500).json(safeFail('获取班级成员失败'));
  }
});

/**
 * POST /api/admin/courses/:id/members — 批量添加班级成员
 * body: { studentIds: string[] }
 */
router.post('/courses/:id/members', adminOnly, (req, res) => {
  try {
    const cls = db.prepare('SELECT id FROM courses WHERE id = ?').get(req.params.id);
    if (!cls) return res.json(fail('班级不存在'));
    const ids = Array.isArray(req.body.studentIds) ? req.body.studentIds : [];
    if (!ids.length) return res.json(fail('请选择要添加的成员'));
    const t = now();
    const ins = db.prepare(`
      INSERT OR IGNORE INTO student_class (id, student_id, class_id, role, joined_at)
      VALUES (?, ?, ?, 'member', ?)
    `);
    let added = 0;
    for (const sid of ids) {
      if (!sid) continue;
      // 已删除/已归档学员不得被重新分班：与「不存在」同等处理，静默跳过
      const stu = db.prepare(`SELECT s.id FROM students s WHERE s.id = ? AND ${ACTIVE_STUDENT_SQL}`).get(sid);
      if (!stu) continue;
      added += ins.run(generateId('sc_'), sid, req.params.id, t).changes;
    }
    // 班级成员归属变更影响排课与报名范围，需留痕
    const actor = getActor(req);
    recordAudit(db, {
      entity: 'class_member',
      entityId: req.params.id,
      action: 'add',
      actorId: actor.id,
      actorRole: actor.role,
      after: { added, requested: ids.length, student_ids: ids },
    });
    res.json(success({ added }));
  } catch (err) {
    console.error('[admin course members add]', err);
    res.status(500).json(safeFail('添加成员失败'));
  }
});

/**
 * DELETE /api/admin/courses/:id/members/:studentId — 移除班级成员
 */
router.delete('/courses/:id/members/:studentId', adminOnly, (req, res) => {
  try {
    const cls = db.prepare('SELECT id FROM courses WHERE id = ?').get(req.params.id);
    if (!cls) return res.json(fail('班级不存在'));
    const r = db.prepare('DELETE FROM student_class WHERE class_id = ? AND student_id = ?')
      .run(req.params.id, req.params.studentId);
    // 移除班级成员影响排课与报名范围，需留痕
    const actor = getActor(req);
    recordAudit(db, {
      entity: 'class_member',
      entityId: `${req.params.id}:${req.params.studentId}`,
      action: 'remove',
      actorId: actor.id,
      actorRole: actor.role,
      after: { removed: r.changes },
    });
    res.json(success({ removed: r.changes }));
  } catch (err) {
    console.error('[admin course members remove]', err);
    res.status(500).json(safeFail('移除成员失败'));
  }
});

/**
 * GET /api/admin/students/:id/classes — 学员已编入的班级（成员侧视角）
 * 返回全部班级 + 该学员是否已加入标记，供详情页"编入班级"多选弹层使用
 */
router.get('/students/:id/classes', adminOnly, (req, res) => {
  try {
    const stu = db.prepare('SELECT id, name FROM students WHERE id = ?').get(req.params.id);
    if (!stu) return res.json(fail('学员不存在'));
    const classes = db.prepare(`
      SELECT c.id, c.name, c.category, c.color, c.is_active,
             sc.student_id AS joined
      FROM courses c
      LEFT JOIN student_class sc ON sc.class_id = c.id AND sc.student_id = ?
      ORDER BY c.name ASC
    `).all(req.params.id);
    const list = classes.map(c => ({ ...c, joined: !!c.joined }));
    res.json(success({ list, total: list.length, studentId: stu.id, studentName: stu.name }));
  } catch (err) {
    console.error('[admin student classes]', err);
    res.status(500).json(safeFail('获取学员班级失败'));
  }
});

/**
 * POST /api/admin/students/:id/classes — 覆盖式更新学员班级归属（成员侧）
 * body: { classIds: string[] }
 * 事务内：移除未选中的旧归属、新增新选中的归属，保证整体一致
 */
router.post('/students/:id/classes', adminOnly, (req, res) => {
  try {
  // 已删除/已归档学员不得被重新分班
  const stu = db.prepare(`SELECT s.id FROM students s WHERE s.id = ? AND ${ACTIVE_STUDENT_SQL}`).get(req.params.id);
  if (!stu) return res.json(fail('学员不存在'));
  const want = Array.isArray(req.body.classIds) ? req.body.classIds.filter(Boolean) : [];
    const tx = db.transaction(() => {
      const current = db.prepare('SELECT class_id FROM student_class WHERE student_id = ?')
        .all(req.params.id).map(r => r.class_id);
      const wantSet = new Set(want);
      const toRemove = current.filter(cid => !wantSet.has(cid));
      if (toRemove.length) {
        const ph = toRemove.map(() => '?').join(',');
        db.prepare(`DELETE FROM student_class WHERE student_id = ? AND class_id IN (${ph})`)
          .run(req.params.id, ...toRemove);
      }
      const t = now();
      const ins = db.prepare(`
        INSERT OR IGNORE INTO student_class (id, student_id, class_id, role, joined_at)
        VALUES (?, ?, ?, 'member', ?)
      `);
      let added = 0;
      for (const cid of wantSet) {
        const cls = db.prepare('SELECT id FROM courses WHERE id = ?').get(cid);
        if (!cls) continue;
        added += ins.run(generateId('sc_'), req.params.id, cid, t).changes;
      }
      return { removed: toRemove.length, added, total: wantSet.size };
    });
    const result = tx();
    // 覆盖式改写学员班级归属（含移除与新增），需留痕
    const actor = getActor(req);
    recordAudit(db, {
      entity: 'class_member',
      entityId: req.params.id,
      action: 'update',
      actorId: actor.id,
      actorRole: actor.role,
      after: { removed: result.removed, added: result.added, total: result.total, class_ids: want },
    });
    res.json(success({ ...result, studentId: req.params.id }));
  } catch (err) {
    console.error('[admin student classes update]', err);
    res.status(500).json(safeFail('更新学员班级失败'));
  }
});

/**
 * GET /api/admin/data-health — 存量脏数据体检（只读）
 * 报告孤儿家长账号 / 非法卡种 / 0 元卡种 / 重名卡种 / 教练表混入非教练账号。
 */
router.get('/data-health', (req, res) => {
  try {
    if (!isAdminReq(req)) return res.status(403).json(safeFail('仅管理员可查看数据体检'));
    res.json(success(scanDirtyData()));
  } catch (err) {
    console.error('[admin data-health]', err && err.stack ? err.stack : err);
    res.status(500).json(safeFail('数据体检失败'));
  }
});

/**
 * POST /api/admin/data-cleanup — 一次性安全清理
 * Body: { actions: ['orphan_parents', 'invalid_card_types'] }
 * 仅处理「无歧义」的两类：孤儿家长账号（删除）、非法卡种（下架不删除）。
 */
router.post('/data-cleanup', (req, res) => {
  try {
    if (!isAdminReq(req)) return res.status(403).json(safeFail('仅管理员可执行数据清理'));
    const actions = Array.isArray(req.body && req.body.actions) ? req.body.actions : [];
    if (!actions.length) return res.json(fail('请指定要执行的清理项'));
    const allowed = ['orphan_parents', 'invalid_card_types'];
    const bad = actions.filter((a) => !allowed.includes(a));
    if (bad.length) return res.json(fail(`不支持的清理项：${bad.join('、')}`));
    const result = applyCleanup(actions, req);
    res.json(success(result));
  } catch (err) {
    console.error('[admin data-cleanup]', err && err.stack ? err.stack : err);
    res.status(500).json(safeFail('数据清理失败'));
  }
});

module.exports = router;

/**
 * 同步教练登录账号：根据手机号创建或启用 users 表中 role=coach 的记录
 * @param {string} phone
 * @param {string} name
 * @param {string} [status] 教师档案状态（'active'/'inactive'）。显式传入时同步到登录账号；
 *   未传时**保持账号既有状态**。
 *
 * 为什么 status 必须是显式入参：此前本函数无条件写 status='active'，而 PUT /teachers/:id 的
 * 「手机号未变更」分支无条件调用它 —— 管理员停用离职教练后，只要再编辑一次该教师档案
 * （哪怕只改名字 / 课时费），离职账号就被静默复活，员工可立即重新登录，且只记 teacher 审计、
 * users 侧无任何痕迹。现改为以教师档案的 teachers.status 为准同步：停用态不会被覆盖为 active。
 */
// 员工初始/重置密码：可通过 STAFF_DEFAULT_PASSWORD 环境变量改为机构自定义初始密码。
// 硬编码 123456 意味着任何拿到 MIT 源码的人都可尝试「已知手机号 + 123456」接管员工账号；
// 正式部署务必设置自定义值，并在创建员工后通过私密渠道告知本人尽快修改。
// 常量本身已收敛至 utils/security.js，登录 / 改密 / 强制拦截共用同一份定义。

function syncCoachAccount(phone, name, status) {
  if (!phone) return;
  const existing = db.prepare('SELECT id, role FROM users WHERE phone = ?').get(phone);
  if (existing) {
    // 已存在账号：仅同步昵称，保留既有角色（管理员权限不被覆盖）；
    // status 只在显式传入时写入，避免「编辑档案」意外恢复登录权限。
    if (status) {
      db.prepare('UPDATE users SET nickname = COALESCE(?, nickname), status = ?, updated_at = ? WHERE id = ?')
        .run(name || null, status, now(), existing.id);
    } else {
      db.prepare('UPDATE users SET nickname = COALESCE(?, nickname), updated_at = ? WHERE id = ?')
        .run(name || null, now(), existing.id);
    }
  } else {
    db.prepare(`
      INSERT INTO users (id, openid, phone, nickname, avatar, role, password, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, '', 'coach', ?, ?, ?, ?)
    `).run(generateId('user_'), `coach_${phone}`, phone, name || '教练', hashPassword(getStaffDefaultPassword()), status || 'active', now(), now());
  }
}

/**
 * GET /api/admin/audit-logs — 操作日志查询（只读）
 *
 * 为什么要有这个接口：audit_log 此前**只写不读**——全仓没有任何查询接口，前端也没有
 * 页面，管理员出事后只能靠「数据备份」导出整表再人工翻找。对小机构来说等于没留痕，
 * 前面几十处 recordAudit 的留痕投入无法兑现。本接口让「谁在什么时候改了什么」可查。
 *
 * 为什么必须 adminOnly：审计行含全机构操作者标识（actor_id）与业务主键，且能反推
 * 经营动作（退款、结算、停用），属敏感数据；教练/销售一律不可见。
 *
 * 查询参数（全部可选）：entity / action / actorId / start / end（'YYYY-MM-DD'）/ page / pageSize
 */
router.get('/audit-logs', adminOnly, (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    // 上限 100：避免前端误传大值把整表拉回来（审计表只增不减，会持续增长）
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 20));
    const conds = [];
    const args = [];
    // 所有用户输入一律走绑定参数，不做字符串拼接（SQL 注入面）
    if (req.query.entity) { conds.push('entity = ?'); args.push(String(req.query.entity)); }
    if (req.query.action) { conds.push('action = ?'); args.push(String(req.query.action)); }
    if (req.query.actorId) { conds.push('actor_id = ?'); args.push(String(req.query.actorId)); }
    // created_at 是 epoch 毫秒；日期区间取半开 [start, end)，与看板口径一致
    if (req.query.start) { conds.push('created_at >= ?'); args.push(dayStartMs(String(req.query.start))); }
    if (req.query.end) { conds.push('created_at < ?'); args.push(dayEndMs(String(req.query.end))); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

    const total = db.prepare(`SELECT COUNT(*) AS c FROM audit_log ${where}`).get(...args).c;
    const rows = db.prepare(`
      SELECT id, entity, entity_id, action, actor_id, actor_role, before_state, after_state, created_at
      FROM audit_log ${where}
      ORDER BY created_at DESC, id DESC
      LIMIT ? OFFSET ?
    `).all(...args, pageSize, (page - 1) * pageSize);

    // before_state / after_state 存的是 JSON 串，解析后返回以便前端直接渲染；
    // 解析失败（历史脏数据）保留原串，绝不让一条坏记录把整页查询打成 500。
    const parse = (s) => {
      if (!s) return null;
      try { return JSON.parse(s); } catch (e) { return s; }
    };
    res.json(success({
      list: rows.map((r) => ({
        id: r.id,
        entity: r.entity,
        entity_id: r.entity_id,
        action: r.action,
        actor_id: r.actor_id,
        actor_role: r.actor_role,
        created_at: r.created_at,
        before: parse(r.before_state),
        after: parse(r.after_state),
      })),
      total,
      page,
      pageSize,
      // 下拉候选：entity/action 会随代码演进增加，前端硬编码必然过期，故由库里反查。
      // 审计表小且有 idx_audit_entity 支撑，每次顺带查出代价可忽略。
      filters: {
        entities: db.prepare('SELECT DISTINCT entity FROM audit_log ORDER BY entity').all().map((r) => r.entity),
        actions: db.prepare('SELECT DISTINCT action FROM audit_log ORDER BY action').all().map((r) => r.action),
      },
    }));
  } catch (err) {
    console.error('[admin audit-logs]', err);
    res.status(500).json(safeFail('查询操作日志失败'));
  }
});

/**
 * GET /api/admin/backup — 下载数据库备份（SQLite 一致性快照）
 * 用于机构数据安全：建议每周备份一次，可下载后存放在本地/网盘
 */
router.get('/backup', adminOnly, (req, res) => {
  try {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const dest = path.join(os.tmpdir(), `edu-admin-backup-${Date.now()}.db`);
    db.backup(dest)
      .then(() => {
        const filename = `edu-admin-backup-${new Date().toISOString().slice(0, 10)}.db`;
        res.download(dest, filename, () => {
          fs.unlink(dest, () => {});
        });
      })
      .catch((err) => {
        console.error('[backup]', err);
        res.status(500).json(safeFail('备份失败，请稍后重试'));
      });
  } catch (err) {
    console.error('[backup]', err);
    res.status(500).json(safeFail('备份失败，请稍后重试'));
  }
});
