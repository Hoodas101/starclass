/**
 * 管理路由 — 数据看板、导出报表
 * GET /api/admin/dashboard — 数据看板
 * GET /api/admin/export    — 导出报表
 */
const express = require('express');
const router = express.Router();
const db = require('../db');
const { success, fail, safeFail, generateId, getOpenId, formatDate, now, hashPassword, resolvePerms, hasPerm, getReqUser, attendanceRate, isAdminReq } = require('../utils');

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
    // 数据范围：all=全机构 / me=仅当前用户（CRM OverviewScopeToggle 思想）
    const scope = req.query.scope === 'me' ? 'me' : 'all';
    const u = getReqUser(req);
    let spName = '';
    if (scope === 'me' && u) {
      if (u.phone) {
        const t = db.prepare('SELECT name FROM teachers WHERE phone = ?').get(u.phone);
        if (t && t.name) spName = t.name;
      }
      if (!spName) spName = u.nickname || u.name || '';
    }
    const spSql = spName ? ' AND salesperson = ?' : '';
    const spParams = spName ? [spName] : [];

    // 核心指标
    const totalStudents = db.prepare("SELECT COUNT(*) as count FROM students WHERE status = 'active'").get().count;
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
      WHERE status IN ('paid', 'refunded') AND date(paid_at/1000, 'unixepoch', 'localtime') = ?${spSql}
    `).get(today, ...spParams);
    const todayRevenue = todayRevenueRow?.total || 0;

    // 昨日收入（涨跌对比）
    const yesterdayRevenueRow = db.prepare(`
      SELECT COALESCE(SUM(payable_amount - COALESCE(refunded_amount, 0)), 0) as total FROM orders
      WHERE status IN ('paid', 'refunded') AND date(paid_at/1000, 'unixepoch', 'localtime') = date('now', 'localtime', '-1 day')${spSql}
    `).get(...spParams);
    const yesterdayRevenue = yesterdayRevenueRow?.total || 0;
    const pct = (cur, prev) => (prev > 0 ? Math.round(((cur - prev) / prev) * 1000) / 10 : null);

    // 本周收入（周一为一周起点）
    const dayOfWeek = new Date().getDay();
    const weekStartMs = now() - ((dayOfWeek + 6) % 7) * 86400000;
    const weekStart = formatDate(weekStartMs);
    const weekRevenueRow = db.prepare(`
      SELECT COALESCE(SUM(payable_amount - COALESCE(refunded_amount, 0)), 0) as total FROM orders
      WHERE status IN ('paid', 'refunded') AND date(paid_at/1000, 'unixepoch', 'localtime') >= ? AND date(paid_at/1000, 'unixepoch', 'localtime') <= ?${spSql}
    `).get(weekStart, today, ...spParams);
    const weekRevenue = weekRevenueRow?.total || 0;

    // 上周收入（周一为一周起点，上周同期）
    const prevWeekStartMs = weekStartMs - 7 * 86400000;
    const prevWeekStart = formatDate(prevWeekStartMs);
    const prevWeekEnd = formatDate(weekStartMs - 86400000);
    const prevWeekRevenueRow = db.prepare(`
      SELECT COALESCE(SUM(payable_amount - COALESCE(refunded_amount, 0)), 0) as total FROM orders
      WHERE status IN ('paid', 'refunded') AND date(paid_at/1000, 'unixepoch', 'localtime') >= ? AND date(paid_at/1000, 'unixepoch', 'localtime') <= ?${spSql}
    `).get(prevWeekStart, prevWeekEnd, ...spParams);
    const prevWeekRevenue = prevWeekRevenueRow?.total || 0;

    // 本月收入
    const monthStart = today.slice(0, 7); // YYYY-MM
    const monthRevenueRow = db.prepare(`
      SELECT COALESCE(SUM(payable_amount - COALESCE(refunded_amount, 0)), 0) as total FROM orders
      WHERE status IN ('paid', 'refunded') AND strftime('%Y-%m', paid_at/1000, 'unixepoch', 'localtime') = ?${spSql}
    `).get(monthStart, ...spParams);
    const monthRevenue = monthRevenueRow?.total || 0;

    // 上月收入
    const prevMonthKey = new Date(new Date().getFullYear(), new Date().getMonth() - 1, 1);
    const prevMonthStart = `${prevMonthKey.getFullYear()}-${String(prevMonthKey.getMonth() + 1).padStart(2, '0')}`;
    const prevMonthRevenueRow = db.prepare(`
      SELECT COALESCE(SUM(payable_amount - COALESCE(refunded_amount, 0)), 0) as total FROM orders
      WHERE status IN ('paid', 'refunded') AND strftime('%Y-%m', paid_at/1000, 'unixepoch', 'localtime') = ?${spSql}
    `).get(prevMonthStart, ...spParams);
    const prevMonthRevenue = prevMonthRevenueRow?.total || 0;

    // 本年 / 去年收入
    const yearStart = `${today.slice(0, 4)}-01-01`;
    const yearRevenueRow = db.prepare(`
      SELECT COALESCE(SUM(payable_amount - COALESCE(refunded_amount, 0)), 0) as total FROM orders
      WHERE status IN ('paid', 'refunded') AND date(paid_at/1000, 'unixepoch', 'localtime') >= ?${spSql}
    `).get(yearStart, ...spParams);
    const yearRevenue = yearRevenueRow?.total || 0;
    const prevYearStart = `${String(Number(today.slice(0, 4)) - 1)}-01-01`;
    const prevYearEnd = `${String(Number(today.slice(0, 4)) - 1)}-12-31`;
    const prevYearRevenueRow = db.prepare(`
      SELECT COALESCE(SUM(payable_amount - COALESCE(refunded_amount, 0)), 0) as total FROM orders
      WHERE status IN ('paid', 'refunded') AND date(paid_at/1000, 'unixepoch', 'localtime') >= ? AND date(paid_at/1000, 'unixepoch', 'localtime') <= ?${spSql}
    `).get(prevYearStart, prevYearEnd, ...spParams);
    const prevYearRevenue = prevYearRevenueRow?.total || 0;

    // 本月签单人排名
    const monthSales = db.prepare(`
      SELECT salesperson, COALESCE(SUM(payable_amount - COALESCE(refunded_amount, 0)), 0) as amount, COUNT(*) as count
      FROM orders
      WHERE status IN ('paid', 'refunded') AND salesperson != '' AND strftime('%Y-%m', paid_at/1000, 'unixepoch', 'localtime') = ?${spSql}
      GROUP BY salesperson ORDER BY amount DESC LIMIT 10
    `).all(monthStart, ...spParams);

    // 本周签单人排名（与小程序管理端一致：按签单人聚合金额与单数）
    const weekSales = db.prepare(`
      SELECT salesperson, COALESCE(SUM(payable_amount - COALESCE(refunded_amount, 0)), 0) as amount, COUNT(*) as count
      FROM orders
      WHERE status IN ('paid', 'refunded') AND salesperson != ''
        AND date(paid_at/1000, 'unixepoch', 'localtime') >= ? AND date(paid_at/1000, 'unixepoch', 'localtime') <= ?${spSql}
      GROUP BY salesperson ORDER BY amount DESC LIMIT 10
    `).all(weekStart, today, ...spParams);

    // 本年签单人排名
    const yearSales = db.prepare(`
      SELECT salesperson, COALESCE(SUM(payable_amount - COALESCE(refunded_amount, 0)), 0) as amount, COUNT(*) as count
      FROM orders
      WHERE status IN ('paid', 'refunded') AND salesperson != '' AND date(paid_at/1000, 'unixepoch', 'localtime') >= ?${spSql}
      GROUP BY salesperson ORDER BY amount DESC LIMIT 10
    `).all(`${today.slice(0, 4)}-01-01`, ...spParams);

    // 1v1 销售金额（is_1v1 标记）
    const oneToOneRow = db.prepare(`
      SELECT COALESCE(SUM(payable_amount - COALESCE(refunded_amount, 0)), 0) as total, COUNT(*) as count
      FROM orders
      WHERE status IN ('paid', 'refunded') AND is_1v1 = 1 AND strftime('%Y-%m', paid_at/1000, 'unixepoch', 'localtime') = ?${spSql}
    `).get(monthStart, ...spParams);
    const oneToOne = { amount: oneToOneRow?.total || 0, count: oneToOneRow?.count || 0 };

    // 本月购买项目统计（按订单项名称聚合，取 Top5）
    // 刻意保留 status='paid' 毛额口径：退款是订单级的，无法分摊到具体商品项，
    // 纳入已全额退款订单会高估单品热度（与 CSV 导出 sales 分支同一取舍）。
    let itemStats = [];
    try {
      itemStats = db.prepare(`
        SELECT json_extract(je.value, '$.itemName') AS item_name,
               COUNT(DISTINCT o.id) AS order_count,
               SUM(o.payable_amount) AS amount
        FROM orders o, json_each(o.items) je
        WHERE o.status = 'paid'
          AND strftime('%Y-%m', o.paid_at/1000, 'unixepoch', 'localtime') = ?
          ${spSql.replace('salesperson', 'o.salesperson')}
          AND json_extract(je.value, '$.itemName') IS NOT NULL
        GROUP BY item_name
        ORDER BY order_count DESC, amount DESC
        LIMIT 5
      `).all(monthStart, ...spParams).map((r) => ({
        itemName: r.item_name,
        count: r.order_count || 0,
        amount: r.amount || 0,
      }));
    } catch (e) {
      itemStats = [];
    }

    // 即将到期卡（7天内）
    const expiringCards = db.prepare(
      "SELECT COUNT(*) as count FROM member_cards WHERE status = 'active' AND expires_at < ? AND expires_at > ?"
    ).get(currentTime + 7 * 86400000, currentTime).count;

    // 到场率：统一口径见 utils.attendanceRate（迟到计到场，请假不计入分母）
    const attendanceRatePct = attendanceRate({ present: todayCheckins, late: todayLate, absent: todayAbsent });

    // 总会员卡数
    // 有效会员卡：仅统计进行中且未过期的卡（过期卡不计入有效统计）
    const totalCards = db.prepare("SELECT COUNT(*) as count FROM member_cards WHERE status = 'active' AND expires_at > ?").get(currentTime).count;
    // 有效会员：持有进行中且未过期会员卡的学员人数（去重；区别于“在读成员”全量统计）
    const validMembers = db.prepare(`
      SELECT COUNT(DISTINCT student_id) as count FROM member_cards
      WHERE status = 'active' AND expires_at > ?
    `).get(currentTime).count;

    // 总积分发放
    const totalPointsRow = db.prepare('SELECT COALESCE(SUM(total_earned), 0) as total FROM points').get();
    const totalPoints = totalPointsRow?.total || 0;

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
      },
    }));
  } catch (err) {
    res.status(500).json(safeFail("操作失败，请稍后重试"));
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
    const productSales = db.prepare(`
      SELECT COALESCE(NULLIF(json_extract(it.value, '$.itemName'), ''), '其他') AS name,
             SUM(CASE WHEN json_extract(it.value, '$.quantity') > 0
                      THEN json_extract(it.value, '$.quantity') ELSE 1 END) AS count
      FROM orders o, json_each(CASE WHEN json_valid(o.items) AND json_type(o.items) = 'array'
                                    THEN o.items ELSE '[]' END) AS it
      WHERE o.status = 'paid'
      GROUP BY name
      ORDER BY count DESC
    `).all().map((r) => ({ name: r.name, count: Number(r.count) }));

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
    let data = [];
    let filename = '';
    const t = now();
    const range = (col) => {
      const parts = [];
      const params = [];
      if (startDate) { parts.push(`date(${col}/1000, 'unixepoch', 'localtime') >= ?`); params.push(startDate); }
      if (endDate) { parts.push(`date(${col}/1000, 'unixepoch', 'localtime') <= ?`); params.push(endDate); }
      return { sql: parts.length ? ` AND ${parts.join(' AND ')}` : '', params };
    };

    switch (type) {
      case 'students': {
        const r = range('created_at');
        data = db.prepare(`SELECT s.*, 
            (SELECT pb.parent_name FROM parent_bindings pb WHERE pb.student_id = s.id AND pb.is_main = 1 LIMIT 1) as parent_name,
            (SELECT pb.parent_phone FROM parent_bindings pb WHERE pb.student_id = s.id AND pb.is_main = 1 LIMIT 1) as parent_phone
          FROM students s WHERE s.status = ?${r.sql} ORDER BY s.created_at DESC`).all('active', ...r.params);
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
        const r = range('checkin_time');
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
      case 'points':
        data = db.prepare('SELECT * FROM points ORDER BY balance DESC').all();
        filename = 'points.csv';
        break;
      case 'member_cards':
        data = db.prepare('SELECT * FROM member_cards ORDER BY created_at DESC').all();
        filename = 'member_cards.csv';
        break;
      case 'sales': {
        // 销售排名 + 产品统计（自定义时间段，供看板导出）
        const dayFrom = startDate || '1970-01-01';
        const dayTo = endDate || formatDate(t);
        // 金额口径：含已全额退款订单并冲减退款额（与看板 KPI 一致）
        const where = `WHERE status IN ('paid', 'refunded') AND date(paid_at/1000, 'unixepoch', 'localtime') >= ? AND date(paid_at/1000, 'unixepoch', 'localtime') <= ?`;
        // 产品统计另用窄口径：退款是订单级的，无法分摊到具体商品项，
        // 纳入已全额退款订单会高估单品销量，故单品统计仍只取未退款订单的毛额。
        const wherePaid = `WHERE status = 'paid' AND date(paid_at/1000, 'unixepoch', 'localtime') >= ? AND date(paid_at/1000, 'unixepoch', 'localtime') <= ?`;
        const rank = db.prepare(`
          SELECT salesperson, COALESCE(SUM(payable_amount - COALESCE(refunded_amount, 0)), 0) as amount, COUNT(*) as count
          FROM orders ${where} AND salesperson != ''
          GROUP BY salesperson ORDER BY amount DESC
        `).all(dayFrom, dayTo);
        const revenue = db.prepare(`SELECT COALESCE(SUM(payable_amount - COALESCE(refunded_amount, 0)), 0) as amount, COUNT(*) as count FROM orders ${where}`).get(dayFrom, dayTo);
        const itemMap = {};
        // 解析 items：历史数据存在「数组元素为 JSON 字符串」的双重编码，且元素未必是对象。
        // 逐项兜底，避免整批计入「未命名产品」或金额恒为 0。
        // 此前用不存在的 i.price 字段，导致单品金额恒为 0；现改用实收字段 totalPrice，
        // 缺失时回退 unitPrice × 数量（面值），与看板商品统计口径一致。
        const parseItems = (raw) => {
          let arr;
          try { arr = JSON.parse(raw || '[]'); } catch { return []; }
          if (!Array.isArray(arr)) return [];
          return arr
            .map((x) => {
              if (typeof x === 'string') { try { return JSON.parse(x); } catch { return null; } }
              return (x && typeof x === 'object') ? x : null;
            })
            .filter(Boolean);
        };
        for (const o of db.prepare(`SELECT items FROM orders ${wherePaid}`).all(dayFrom, dayTo)) {
          for (const i of parseItems(o.items)) {
            const name = i.itemName || '未命名产品';
            itemMap[name] = itemMap[name] || { count: 0, amount: 0 };
            const qty = (typeof i.quantity === 'number' && i.quantity > 0) ? i.quantity : 1;
            itemMap[name].count += qty;
            itemMap[name].amount += Number(i.totalPrice || (i.unitPrice * qty) || 0);
          }
        }
        const itemStats = Object.entries(itemMap).map(([itemName, v]) => ({ itemName, ...v })).sort((a, b) => b.amount - a.amount);
        const oneToOne = db.prepare(`
          SELECT COALESCE(SUM(payable_amount - COALESCE(refunded_amount, 0)), 0) as amount, COUNT(*) as count FROM orders
          ${where} AND is_1v1 = 1
        `).get(dayFrom, dayTo);
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
    const existing = db.prepare('SELECT id, name, phone FROM teachers WHERE id = ?').get(req.params.id);
    if (!existing) return res.json(fail('教师不存在'));

    // 防护：目标账号是管理员时，禁止停用/降级最后一位管理员，也禁止停用当前登录账号
    const targetPhone = phone || existing.phone;
    const targetUser = targetPhone ? db.prepare('SELECT id, openid, role, status FROM users WHERE phone = ?').get(targetPhone) : null;
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
      if (newPhone) syncCoachAccount(newPhone, name || existing.name);
    } else {
      // 手机号未变更：保持/确保登录账号为启用状态
      syncCoachAccount(newPhone || oldPhone, name || existing.name);
    }
    if (status === 'inactive') {
      db.prepare("UPDATE users SET status = 'inactive', token_version = COALESCE(token_version,0) + 1, updated_at = ? WHERE phone = ?").run(now(), newPhone || oldPhone);
    }

    // Update permissions: sync the login account's role (coach / admin / sales)
    // and custom permissions. Role and permissions update independently so a
    // permissions-only call still takes effect.
    const hasValidRole = role && ['coach', 'admin', 'sales'].includes(role);
    const permUser = targetUser || (targetPhone ? db.prepare('SELECT id FROM users WHERE phone = ?').get(targetPhone) : null);
    if (permUser) {
      const updates = [];
      const params = [];
      if (hasValidRole) { updates.push('role = ?'); params.push(role); }
      if (permissions !== undefined) {
        updates.push('permissions = ?');
        params.push(Array.isArray(permissions) ? JSON.stringify(permissions) : '');
      }
      // Role changes must revoke old tokens — role is baked into the JWT payload
      if (hasValidRole && targetUser && targetUser.role !== role) {
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
        hashPassword(STAFF_DEFAULT_PASSWORD), now(), now());
    }

    // 重置登录密码为初始密码（STAFF_DEFAULT_PASSWORD 可配，默认 123456）
    if (resetPassword) {
      const targetPhone = newPhone || oldPhone;
      if (targetPhone) {
        // bump token_version：重置后该账号旧 Token 全部失效
        db.prepare("UPDATE users SET password = ?, token_version = COALESCE(token_version,0) + 1, updated_at = ? WHERE phone = ?")
          .run(hashPassword(STAFF_DEFAULT_PASSWORD), now(), targetPhone);
      }
    }
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
    // 该教师未来的排课置空待重新分配（保留课程，避免家长端显示已停用教师）
    db.prepare(`
      UPDATE schedules SET teacher_id = '', teacher_name = '', updated_at = ?
      WHERE teacher_id = ? AND status = 'scheduled' AND date >= ?
    `).run(now(), req.params.id, new Date().toISOString().slice(0, 10));
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
 * GET /api/admin/courses — 活动列表
 */
router.get('/courses', (req, res) => {
  try {
    // includeInactive=1 时同时返回停用/归档活动（管理页需要看到以便恢复）；
    // 默认仅返回在售且未归档的活动，归档后的班级从可报名/可选列表中隐藏
    const where = req.query.includeInactive === '1' ? '' : 'WHERE is_active = 1 AND archived = 0';
    const list = db.prepare(`
      SELECT id, name, category, description, duration, consume_classes, color,
             min_age, max_age, max_students, price_per_class, is_active, archived,
             (SELECT COUNT(*) FROM student_class WHERE class_id = courses.id) AS member_count
      FROM courses ${where} ORDER BY created_at ASC
    `).all();
    res.json(success({ list, total: list.length }));
  } catch (err) {
    res.status(500).json(safeFail('获取活动列表失败'));
  }
});

/**
 * POST /api/admin/courses — 新建活动
 */
router.post('/courses', adminOnly, (req, res) => {
  try {
    const { name, category, description, duration, consumeClasses, color, maxStudents, pricePerClass } = req.body;
    if (!name || !name.trim()) return res.json(fail('活动名称必填'));

    const id = generateId('course_');
    db.prepare(`
      INSERT INTO courses (id, name, category, description, duration, consume_classes, color,
        max_students, price_per_class, is_active, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
    `).run(id, name.trim(), category || '常规训练', description || '', duration || 90,
      consumeClasses || 1, color || '#FF6B35', maxStudents || 0, pricePerClass || 0, now());

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

    res.json(success({ id: req.params.id }));
  } catch (err) {
    console.error('[admin courses update]', err);
    res.status(500).json(safeFail('更新活动失败'));
  }
});

/**
 * DELETE /api/admin/courses/:id — 停用活动
 */
router.delete('/courses/:id', adminOnly, (req, res) => {
  try {
    const existing = db.prepare('SELECT * FROM courses WHERE id = ?').get(req.params.id);
    if (!existing) return res.json(fail('活动不存在'));
    const scheds = db.prepare('SELECT id FROM schedules WHERE course_id = ?').all(req.params.id);
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
        `).all(...ids).filter((a) => (a.total || 0) > 0);
        db.prepare('DELETE FROM enrollments WHERE schedule_id IN (' + ph + ')').run(...ids);
        db.prepare('DELETE FROM attendances WHERE schedule_id IN (' + ph + ')').run(...ids);
        db.prepare('DELETE FROM leave_requests WHERE schedule_id IN (' + ph + ')').run(...ids);
        db.prepare('DELETE FROM deduction_logs WHERE schedule_id IN (' + ph + ')').run(...ids);
        db.prepare('DELETE FROM point_logs WHERE reference_id IN (' + ph + ')').run(...ids);
        db.prepare('DELETE FROM coach_comments WHERE schedule_id IN (' + ph + ')').run(...ids);
        db.prepare('DELETE FROM schedules WHERE id IN (' + ph + ')').run(...ids);
        for (const a of affected) {
          db.prepare(`
            UPDATE points SET
              total_earned = MAX(0, total_earned - ?),
              balance = MAX(0, balance - ?),
              updated_at = ?
            WHERE student_id = ?
          `).run(a.total, a.total, now(), a.student_id);
        }
      }
      db.prepare('DELETE FROM courses WHERE id = ?').run(req.params.id);
    })();
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
    const list = db.prepare(`
      SELECT sc.id AS link_id, sc.student_id, sc.role, sc.joined_at,
             st.name, st.avatar, st.gender, st.age
      FROM student_class sc
      LEFT JOIN students st ON st.id = sc.student_id
      WHERE sc.class_id = ?
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
      const stu = db.prepare('SELECT id FROM students WHERE id = ?').get(sid);
      if (!stu) continue;
      added += ins.run(generateId('sc_'), sid, req.params.id, t).changes;
    }
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
    const stu = db.prepare('SELECT id FROM students WHERE id = ?').get(req.params.id);
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
    res.json(success({ ...result, studentId: req.params.id }));
  } catch (err) {
    console.error('[admin student classes update]', err);
    res.status(500).json(safeFail('更新学员班级失败'));
  }
});

module.exports = router;

/**
 * 同步教练登录账号：根据手机号创建或启用 users 表中 role=coach 的记录
 * @param {string} phone
 * @param {string} name
 */
// 员工初始/重置密码：可通过 STAFF_DEFAULT_PASSWORD 环境变量改为机构自定义初始密码。
// 硬编码 123456 意味着任何拿到 MIT 源码的人都可尝试「已知手机号 + 123456」接管员工账号；
// 正式部署务必设置自定义值，并在创建员工后通过私密渠道告知本人尽快修改。
const STAFF_DEFAULT_PASSWORD = process.env.STAFF_DEFAULT_PASSWORD || '123456';

function syncCoachAccount(phone, name) {
  if (!phone) return;
  const existing = db.prepare('SELECT id, role FROM users WHERE phone = ?').get(phone);
  if (existing) {
    // 已存在账号：仅同步昵称与启用状态，保留既有角色（管理员权限不被覆盖）
    db.prepare("UPDATE users SET nickname = COALESCE(?, nickname), status = 'active', updated_at = ? WHERE id = ?")
      .run(name || null, now(), existing.id);
  } else {
    db.prepare(`
      INSERT INTO users (id, openid, phone, nickname, avatar, role, password, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, '', 'coach', ?, 'active', ?, ?)
    `).run(generateId('user_'), `coach_${phone}`, phone, name || '教练', hashPassword(STAFF_DEFAULT_PASSWORD), now(), now());
  }
}

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
