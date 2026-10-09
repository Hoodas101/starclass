/**
 * 种子数据 — 填充完整的示例数据
 *
 * 包含：
 * - 1 个管理员 + 3 个教师 + 1 个销售 + 28 个家长
 * - 24 位成员
 * - 3 位教师档案
 * - 3 间场地
 * - 3 门活动
 * - 4 种会员卡类型 + 6 张会员卡实例
 * - 本周 7 天排期
 * - 今日签到记录
 * - 积分账户 + 流水
 * - 订单 + 支付（覆盖近 90 天，含今日 / 本周 / 本月 / 退款单，看板各口径均有数字）
 * - 消息通知
 * - 系统设置
 * - 家长-成员绑定（含 parent_openid）
 *
 * 运行方式：node db/seed.js —— 仅空库可灌；库中已有账号时拒绝执行（防误清生产数据），
 * 确需重置为演示数据：node db/seed.js --force  或  npm run seed:force
 */
const db = require('./index');

function generateId(prefix = '') {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}${ts}${rand}`.toUpperCase();
}

function now() {
  return Date.now();
}

function formatDate(timestamp) {
  const d = new Date(timestamp);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function seed() {
  console.log('[Seed] 开始填充种子数据...');
  const NOW = now();

  // ========= 清空现有数据（按外键依赖倒序）==========
  console.log('[Seed] 清空现有数据...');
  const tables = [
    'point_logs', 'points', 'payments', 'orders', 'deduction_logs',
    'attendances', 'enrollments', 'member_cards', 'membership_cards',
    'schedule_rules', 'schedules', 'notifications', 'parent_bindings',
    // leave_requests / feedback / leads / follow_ups 此前不在清单里：它们没有外键依赖，
    // 但重复执行 seed 会让这些表越积越多（清不掉）。下面写入的演示数据必须可重入。
    'leave_requests', 'feedback', 'follow_ups', 'leads',
    'students', 'teachers', 'classrooms', 'courses', 'users', 'settings',
  ];
  tables.forEach(t => {
    try { db.exec(`DELETE FROM ${t}`); } catch (e) { /* ignore */ }
  });

  // ========= 1. 用户表（管理员 + 教师 + 家长）==========
  console.log('[Seed] 创建用户...');
  const users = [
    // 管理员
    { id: 'user_admin', openid: 'wx_admin_001', phone: '13800000001', nickname: '管理员', role: 'admin', avatar: '', password: '123456' },
    // 教师
    { id: 'user_teacher_001', openid: 'wx_teacher_001', phone: '13800000011', nickname: '王教练', role: 'coach', avatar: '', password: '123456' },
    { id: 'user_teacher_002', openid: 'wx_teacher_002', phone: '13800000012', nickname: '李教练', role: 'coach', avatar: '', password: '123456' },
    { id: 'user_teacher_003', openid: 'wx_teacher_003', phone: '13800000013', nickname: '张教练', role: 'coach', avatar: '', password: '123456' },
    // 销售（full-system CI 夹具依赖此身份做越权矩阵）
    { id: 'user_sales_001', openid: 'wx_sales_001', phone: '13700000001', nickname: '销售示例', role: 'sales', avatar: '', password: '123456' },
    // 家长（12 位）
    { id: 'user_parent_001', openid: 'wx_parent_001', phone: '13900000001', nickname: '小明爸爸', role: 'parent', avatar: '' },
    { id: 'user_parent_002', openid: 'wx_parent_002', phone: '13900000002', nickname: '小红妈妈', role: 'parent', avatar: '' },
    { id: 'user_parent_003', openid: 'wx_parent_003', phone: '13900000003', nickname: '小刚爸爸', role: 'parent', avatar: '' },
    { id: 'user_parent_004', openid: 'wx_parent_004', phone: '13900000004', nickname: '小丽妈妈', role: 'parent', avatar: '' },
    { id: 'user_parent_005', openid: 'wx_parent_005', phone: '13900000005', nickname: '小华爸爸', role: 'parent', avatar: '' },
    { id: 'user_parent_006', openid: 'wx_parent_006', phone: '13900000006', nickname: '小美妈妈', role: 'parent', avatar: '' },
    { id: 'user_parent_007', openid: 'wx_parent_007', phone: '13900000007', nickname: '小强爸爸', role: 'parent', avatar: '' },
    { id: 'user_parent_008', openid: 'wx_parent_008', phone: '13900000008', nickname: '小芳妈妈', role: 'parent', avatar: '' },
    { id: 'user_parent_009', openid: 'wx_parent_009', phone: '13900000009', nickname: '小军爸爸', role: 'parent', avatar: '' },
    { id: 'user_parent_010', openid: 'wx_parent_010', phone: '13900000010', nickname: '小雪妈妈', role: 'parent', avatar: '' },
    { id: 'user_parent_011', openid: 'wx_parent_011', phone: '13900000011', nickname: '小龙爸爸', role: 'parent', avatar: '' },
    { id: 'user_parent_012', openid: 'wx_parent_012', phone: '13900000012', nickname: '小凤妈妈', role: 'parent', avatar: '' },
    // ─── 扩充演示规模（与 stu_009~stu_024 一一对应）───
    { id: 'user_parent_013', openid: 'wx_parent_013', phone: '13900000013', nickname: '子豪妈妈', role: 'parent', avatar: '' },
    { id: 'user_parent_014', openid: 'wx_parent_014', phone: '13900000014', nickname: '雨桐爸爸', role: 'parent', avatar: '' },
    { id: 'user_parent_015', openid: 'wx_parent_015', phone: '13900000015', nickname: '浩然妈妈', role: 'parent', avatar: '' },
    { id: 'user_parent_016', openid: 'wx_parent_016', phone: '13900000016', nickname: '可欣爸爸', role: 'parent', avatar: '' },
    { id: 'user_parent_017', openid: 'wx_parent_017', phone: '13900000017', nickname: '俊杰妈妈', role: 'parent', avatar: '' },
    { id: 'user_parent_018', openid: 'wx_parent_018', phone: '13900000018', nickname: '思远爸爸', role: 'parent', avatar: '' },
    { id: 'user_parent_019', openid: 'wx_parent_019', phone: '13900000019', nickname: '雅静妈妈', role: 'parent', avatar: '' },
    { id: 'user_parent_020', openid: 'wx_parent_020', phone: '13900000020', nickname: '一鸣爸爸', role: 'parent', avatar: '' },
    { id: 'user_parent_021', openid: 'wx_parent_021', phone: '13900000021', nickname: '诗涵妈妈', role: 'parent', avatar: '' },
    { id: 'user_parent_022', openid: 'wx_parent_022', phone: '13900000022', nickname: '子轩爸爸', role: 'parent', avatar: '' },
    { id: 'user_parent_023', openid: 'wx_parent_023', phone: '13900000023', nickname: '雨萱妈妈', role: 'parent', avatar: '' },
    { id: 'user_parent_024', openid: 'wx_parent_024', phone: '13900000024', nickname: '明轩爸爸', role: 'parent', avatar: '' },
    { id: 'user_parent_025', openid: 'wx_parent_025', phone: '13900000025', nickname: '可盈妈妈', role: 'parent', avatar: '' },
    { id: 'user_parent_026', openid: 'wx_parent_026', phone: '13900000026', nickname: '泽宇爸爸', role: 'parent', avatar: '' },
    { id: 'user_parent_027', openid: 'wx_parent_027', phone: '13900000027', nickname: '佳怡妈妈', role: 'parent', avatar: '' },
    { id: 'user_parent_028', openid: 'wx_parent_028', phone: '13900000028', nickname: '宇航妈妈', role: 'parent', avatar: '' },
  ];

  const hashPassword = require('../utils').hashPassword;
  const insertUser = db.prepare(`
    INSERT INTO users (id, openid, phone, nickname, avatar, role, password, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
  `);
  users.forEach(u => insertUser.run(u.id, u.openid, u.phone, u.nickname, u.avatar, u.role, u.password ? hashPassword(u.password) : null, NOW, NOW));

  // ========= 2. 成员表 =========
  console.log('[Seed] 创建成员...');
  // 体育培训机构场景：兴趣标签/备注统一为体育类，避免演示数据里出现「钢琴/围棋/编程」等
  // 与机构定位不符的内容（仅展示性字段，id/数量/结构均未改动）
  const students = [
    { id: 'stu_001', name: '张小明', gender: 'male', birthday: '2015-03-15', school: '阳光小学', grade: '三年级', hobby: '篮球', remark: '活泼好动', height: 132, weight: 30, bmi: 17.2 },
    { id: 'stu_002', name: '李小红', gender: 'female', birthday: '2016-07-22', school: '阳光小学', grade: '二年级', hobby: '跳绳', remark: '协调性好', height: 128, weight: 27, bmi: 16.5 },
    { id: 'stu_003', name: '王刚', gender: 'male', birthday: '2014-11-08', school: '育才小学', grade: '四年级', hobby: '足球', remark: '体育特长', height: 145, weight: 38, bmi: 18.1 },
    { id: 'stu_004', name: '赵丽丽', gender: 'female', birthday: '2017-01-30', school: '育才小学', grade: '一年级', hobby: '体适能', remark: '刚接触体适能', height: 118, weight: 22, bmi: 15.8 },
    { id: 'stu_005', name: '刘华', gender: 'male', birthday: '2015-09-12', school: '实验小学', grade: '三年级', hobby: '篮球', remark: '爆发力强', height: 135, weight: 32, bmi: 17.6 },
    { id: 'stu_006', name: '陈美丽', gender: 'female', birthday: '2016-05-18', school: '实验小学', grade: '二年级', hobby: '体适能', remark: '柔韧性好', height: 130, weight: 28, bmi: 16.6 },
    { id: 'stu_007', name: '杨强', gender: 'male', birthday: '2014-08-25', school: '阳光小学', grade: '四年级', hobby: '篮球', remark: '校队候选', height: 152, weight: 42, bmi: 18.2 },
    { id: 'stu_008', name: '黄小芳', gender: 'female', birthday: '2015-12-03', school: '育才小学', grade: '三年级', hobby: '田径', remark: '耐力突出', height: 138, weight: 34, bmi: 17.8 },
    // ─── 扩充演示规模：仅追加，保留既有 8 位 ID 与字段不变（回归测试夹具依赖 stu_001~stu_008）───
    { id: 'stu_009', name: '周子豪', gender: 'male', birthday: '2015-06-11', school: '第一小学', grade: '三年级', hobby: '篮球', remark: '控球稳定', height: 136, weight: 31, bmi: 16.8 },
    { id: 'stu_010', name: '吴雨桐', gender: 'female', birthday: '2016-09-05', school: '外国语小学', grade: '二年级', hobby: '跳绳', remark: '节奏感好', height: 129, weight: 26, bmi: 15.6 },
    { id: 'stu_011', name: '郑浩然', gender: 'male', birthday: '2014-04-19', school: '阳光小学', grade: '五年级', hobby: '足球', remark: '校队主力', height: 148, weight: 40, bmi: 18.3 },
    { id: 'stu_012', name: '孙可欣', gender: 'female', birthday: '2017-02-27', school: '育才小学', grade: '一年级', hobby: '体适能', remark: '新学员', height: 122, weight: 23, bmi: 15.5 },
    { id: 'stu_013', name: '马俊杰', gender: 'male', birthday: '2015-10-16', school: '实验小学', grade: '三年级', hobby: '篮球', remark: '投篮手感好', height: 134, weight: 30, bmi: 16.7 },
    { id: 'stu_014', name: '朱思远', gender: 'male', birthday: '2016-01-08', school: '第一小学', grade: '二年级', hobby: '羽毛球', remark: '反应敏捷', height: 131, weight: 27, bmi: 15.7 },
    { id: 'stu_015', name: '胡雅静', gender: 'female', birthday: '2015-05-23', school: '外国语小学', grade: '四年级', hobby: '田径', remark: '短跑有天赋', height: 141, weight: 33, bmi: 16.6 },
    { id: 'stu_016', name: '林一鸣', gender: 'male', birthday: '2014-12-30', school: '阳光小学', grade: '五年级', hobby: '篮球', remark: '弹跳出色', height: 150, weight: 41, bmi: 18.2 },
    { id: 'stu_017', name: '何诗涵', gender: 'female', birthday: '2016-11-14', school: '育才小学', grade: '二年级', hobby: '体适能', remark: '柔韧性突出', height: 127, weight: 25, bmi: 15.5 },
    { id: 'stu_018', name: '高子轩', gender: 'male', birthday: '2015-08-02', school: '实验小学', grade: '三年级', hobby: '篮球', remark: '防守积极', height: 137, weight: 32, bmi: 17.1 },
    { id: 'stu_019', name: '罗雨萱', gender: 'female', birthday: '2017-04-21', school: '第一小学', grade: '一年级', hobby: '跳绳', remark: '连续跳绳破百', height: 121, weight: 22, bmi: 15.0 },
    { id: 'stu_020', name: '谢明轩', gender: 'male', birthday: '2014-07-09', school: '外国语小学', grade: '四年级', hobby: '足球', remark: '传球视野好', height: 146, weight: 39, bmi: 18.3 },
    { id: 'stu_021', name: '唐可盈', gender: 'female', birthday: '2016-03-26', school: '阳光小学', grade: '二年级', hobby: '体适能', remark: '核心力量好', height: 130, weight: 27, bmi: 16.0 },
    { id: 'stu_022', name: '韩泽宇', gender: 'male', birthday: '2015-11-30', school: '育才小学', grade: '三年级', hobby: '篮球', remark: '训练专注', height: 133, weight: 29, bmi: 16.4 },
    { id: 'stu_023', name: '曹佳怡', gender: 'female', birthday: '2015-01-17', school: '实验小学', grade: '四年级', hobby: '田径', remark: '耐力突出', height: 140, weight: 32, bmi: 16.3 },
    { id: 'stu_024', name: '邓宇航', gender: 'male', birthday: '2016-08-08', school: '第一小学', grade: '二年级', hobby: '羽毛球', remark: '步法灵活', height: 128, weight: 26, bmi: 15.9 },
  ];

  const insertStudent = db.prepare(`
    INSERT INTO students (id, name, gender, birthday, school, grade, hobby, remark, height, weight, bmi, status, join_date, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
  `);
  // join_date 为 TEXT 列：绑字符串（绑数字会落成 '...0'，前端解析失败显示 `-`）
  students.forEach(s => insertStudent.run(s.id, s.name, s.gender, s.birthday, s.school, s.grade, s.hobby, s.remark, s.height || 0, s.weight || 0, s.bmi || 0, String(NOW), NOW, NOW));

  // ========= 3. 家长-成员绑定表 =========
  console.log('[Seed] 创建家长绑定...');
  const bindings = [
    { student_id: 'stu_001', student_name: '张小明', parent_name: '小明爸爸', parent_openid: 'wx_parent_001', parent_phone: '13900000001', relation: '父亲', is_main: 1 },
    { student_id: 'stu_001', student_name: '张小明', parent_name: '小明妈妈', parent_openid: 'wx_parent_002', parent_phone: '13900000002', relation: '母亲', is_main: 0 },
    { student_id: 'stu_002', student_name: '李小红', parent_name: '小红妈妈', parent_openid: 'wx_parent_002', parent_phone: '13900000002', relation: '母亲', is_main: 1 },
    { student_id: 'stu_003', student_name: '王刚', parent_name: '小刚爸爸', parent_openid: 'wx_parent_003', parent_phone: '13900000003', relation: '父亲', is_main: 1 },
    { student_id: 'stu_004', student_name: '赵丽丽', parent_name: '小丽妈妈', parent_openid: 'wx_parent_004', parent_phone: '13900000004', relation: '母亲', is_main: 1 },
    { student_id: 'stu_005', student_name: '刘华', parent_name: '小华爸爸', parent_openid: 'wx_parent_005', parent_phone: '13900000005', relation: '父亲', is_main: 1 },
    { student_id: 'stu_006', student_name: '陈美丽', parent_name: '小美妈妈', parent_openid: 'wx_parent_006', parent_phone: '13900000006', relation: '母亲', is_main: 1 },
    { student_id: 'stu_007', student_name: '杨强', parent_name: '小强爸爸', parent_openid: 'wx_parent_007', parent_phone: '13900000007', relation: '父亲', is_main: 1 },
    { student_id: 'stu_008', student_name: '黄小芳', parent_name: '小芳妈妈', parent_openid: 'wx_parent_008', parent_phone: '13900000008', relation: '母亲', is_main: 1 },
    // 额外的非主绑定
    { student_id: 'stu_003', student_name: '王刚', parent_name: '小刚妈妈', parent_openid: 'wx_parent_009', parent_phone: '13900000009', relation: '母亲', is_main: 0 },
    { student_id: 'stu_005', student_name: '刘华', parent_name: '小华妈妈', parent_openid: 'wx_parent_010', parent_phone: '13900000010', relation: '母亲', is_main: 0 },
    { student_id: 'stu_007', student_name: '杨强', parent_name: '小强妈妈', parent_openid: 'wx_parent_011', parent_phone: '13900000011', relation: '母亲', is_main: 0 },
    { student_id: 'stu_002', student_name: '李小红', parent_name: '小红爸爸', parent_openid: 'wx_parent_012', parent_phone: '13900000012', relation: '父亲', is_main: 0 },
    // ─── 扩充演示规模：stu_009~stu_024 的主绑定 ───
    { student_id: 'stu_009', student_name: '周子豪', parent_name: '子豪妈妈', parent_openid: 'wx_parent_013', parent_phone: '13900000013', relation: '母亲', is_main: 1 },
    { student_id: 'stu_010', student_name: '吴雨桐', parent_name: '雨桐爸爸', parent_openid: 'wx_parent_014', parent_phone: '13900000014', relation: '父亲', is_main: 1 },
    { student_id: 'stu_011', student_name: '郑浩然', parent_name: '浩然妈妈', parent_openid: 'wx_parent_015', parent_phone: '13900000015', relation: '母亲', is_main: 1 },
    { student_id: 'stu_012', student_name: '孙可欣', parent_name: '可欣爸爸', parent_openid: 'wx_parent_016', parent_phone: '13900000016', relation: '父亲', is_main: 1 },
    { student_id: 'stu_013', student_name: '马俊杰', parent_name: '俊杰妈妈', parent_openid: 'wx_parent_017', parent_phone: '13900000017', relation: '母亲', is_main: 1 },
    { student_id: 'stu_014', student_name: '朱思远', parent_name: '思远爸爸', parent_openid: 'wx_parent_018', parent_phone: '13900000018', relation: '父亲', is_main: 1 },
    { student_id: 'stu_015', student_name: '胡雅静', parent_name: '雅静妈妈', parent_openid: 'wx_parent_019', parent_phone: '13900000019', relation: '母亲', is_main: 1 },
    { student_id: 'stu_016', student_name: '林一鸣', parent_name: '一鸣爸爸', parent_openid: 'wx_parent_020', parent_phone: '13900000020', relation: '父亲', is_main: 1 },
    { student_id: 'stu_017', student_name: '何诗涵', parent_name: '诗涵妈妈', parent_openid: 'wx_parent_021', parent_phone: '13900000021', relation: '母亲', is_main: 1 },
    { student_id: 'stu_018', student_name: '高子轩', parent_name: '子轩爸爸', parent_openid: 'wx_parent_022', parent_phone: '13900000022', relation: '父亲', is_main: 1 },
    { student_id: 'stu_019', student_name: '罗雨萱', parent_name: '雨萱妈妈', parent_openid: 'wx_parent_023', parent_phone: '13900000023', relation: '母亲', is_main: 1 },
    { student_id: 'stu_020', student_name: '谢明轩', parent_name: '明轩爸爸', parent_openid: 'wx_parent_024', parent_phone: '13900000024', relation: '父亲', is_main: 1 },
    { student_id: 'stu_021', student_name: '唐可盈', parent_name: '可盈妈妈', parent_openid: 'wx_parent_025', parent_phone: '13900000025', relation: '母亲', is_main: 1 },
    { student_id: 'stu_022', student_name: '韩泽宇', parent_name: '泽宇爸爸', parent_openid: 'wx_parent_026', parent_phone: '13900000026', relation: '父亲', is_main: 1 },
    { student_id: 'stu_023', student_name: '曹佳怡', parent_name: '佳怡妈妈', parent_openid: 'wx_parent_027', parent_phone: '13900000027', relation: '母亲', is_main: 1 },
    { student_id: 'stu_024', student_name: '邓宇航', parent_name: '宇航妈妈', parent_openid: 'wx_parent_028', parent_phone: '13900000028', relation: '母亲', is_main: 1 },
  ];

  const insertBinding = db.prepare(`
    INSERT INTO parent_bindings (student_id, student_name, parent_name, parent_openid, parent_phone, relation, is_main, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  bindings.forEach(b => insertBinding.run(b.student_id, b.student_name, b.parent_name, b.parent_openid, b.parent_phone, b.relation, b.is_main, NOW));

  // ========= 4. 教师表 =========
  console.log('[Seed] 创建教师...');
  // 薪资规则（pay_rule）覆盖三种计费类型，让「老师课时 / 薪资结算」页开箱即用。
  // 此前该列留空 → 课时费恒为 0、应发合计 ¥0，演示时看不出结算能力。
  // 口径见 utils/payroll.js 的 normalizeRule：
  //   fixed    按课时 —— baseRate 为单节价，tiers 按到场人数阶梯加价
  //   per_head 按人头 —— perHeadRate × 实到人数
  //   hybrid   混合   —— baseRate 每节基础费 + 超出 freeHeadCount 的部分按人头加价
  const teachers = [
    {
      id: 'teacher_001', user_id: 'user_teacher_001', name: '王教练', phone: '13800000011', gender: 'male',
      specialty: '篮球', bio: '国家一级篮球运动员，教龄8年', hire_date: '2020-09-01',
      class_fee: 120,
      pay_rule: { type: 'fixed', baseRate: 120, tiers: [{ minStudents: 10, rate: 150 }] },
    },
    {
      id: 'teacher_002', user_id: 'user_teacher_002', name: '李教练', phone: '13800000012', gender: 'female',
      specialty: '体适能', bio: '体育教育专业毕业，专注儿童体适能，教龄5年', hire_date: '2021-03-15',
      class_fee: 15,
      pay_rule: { type: 'per_head', perHeadRate: 15 },
    },
    {
      id: 'teacher_003', user_id: 'user_teacher_003', name: '张教练', phone: '13800000013', gender: 'male',
      specialty: '篮球', bio: '青少年篮球教练员，教龄3年', hire_date: '2022-09-01',
      class_fee: 80,
      pay_rule: { type: 'hybrid', baseRate: 80, freeHeadCount: 4, extraPerHead: 12 },
    },
  ];

  const insertTeacher = db.prepare(`
    INSERT INTO teachers (id, user_id, name, phone, gender, avatar, specialty, bio, status, hire_date, class_fee, pay_rule, created_at)
    VALUES (?, ?, ?, ?, ?, '', ?, ?, 'active', ?, ?, ?, ?)
  `);
  teachers.forEach(t => insertTeacher.run(
    t.id, t.user_id, t.name, t.phone, t.gender, t.specialty, t.bio, t.hire_date,
    t.class_fee, JSON.stringify(t.pay_rule), NOW
  ));

  // ========= 5. 场地表 =========
  console.log('[Seed] 创建场地...');
  const classrooms = [
    { id: 'room_001', name: '篮球馆', capacity: 20, area: 200, equipment: '篮球架、球鞋储物柜', location: '一楼东侧', color: '#FF6B6B' },
    { id: 'room_002', name: '体适能训练室', capacity: 15, area: 80, equipment: '软垫、敏捷梯、平衡垫', location: '二楼西侧', color: '#4ECDC4' },
    { id: 'room_003', name: '体能测试室', capacity: 12, area: 60, equipment: '纵跳仪、坐位体前屈测试仪', location: '三楼北侧', color: '#45B7D1' },
  ];

  const insertClassroom = db.prepare(`
    INSERT INTO classrooms (id, name, capacity, area, equipment, location, status, color, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)
  `);
  classrooms.forEach(c => insertClassroom.run(c.id, c.name, c.capacity, c.area, c.equipment, c.location, c.color, NOW));

  // ========= 6. 活动表 =========
  console.log('[Seed] 创建活动...');
  const courses = [
    { id: 'course_001', name: '篮球训练基础班', category: '体育', description: '适合6-12岁儿童，学习篮球基本技能', duration: 90, consume_classes: 1, color: '#FF6B6B', min_age: 6, max_age: 12, max_students: 20, price_per_class: 150 },
    { id: 'course_002', name: '少儿体适能班', category: '体育', description: '提升协调性、柔韧性与核心力量，打好运动基础', duration: 90, consume_classes: 1, color: '#4ECDC4', min_age: 5, max_age: 10, max_students: 15, price_per_class: 120 },
    { id: 'course_003', name: '篮球提高班', category: '体育', description: '进阶运球、投篮与战术配合，衔接校队训练', duration: 90, consume_classes: 1, color: '#45B7D1', min_age: 7, max_age: 14, max_students: 12, price_per_class: 180 },
  ];

  const insertCourse = db.prepare(`
    INSERT INTO courses (id, name, category, description, duration, consume_classes, color, min_age, max_age, max_students, price_per_class, is_active, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
  `);
  courses.forEach(c => insertCourse.run(c.id, c.name, c.category, c.description, c.duration, c.consume_classes, c.color, c.min_age, c.max_age, c.max_students, c.price_per_class, NOW));

  // ========= 7. 会员卡类型表 =========
  console.log('[Seed] 创建会员卡类型...');
  const cardTypes = [
    { id: 'ct_001', name: '时效月卡', total_classes: 0, valid_days: 30, billing_mode: 'time', points_reward: 20, price: 699, course_scope: '全活动通用', transferable: 0, refundable: 1 },
    { id: 'ct_002', name: '时效季卡', total_classes: 0, valid_days: 90, billing_mode: 'time', points_reward: 50, price: 1299, course_scope: '全活动通用', transferable: 0, refundable: 1 },
    { id: 'ct_003', name: '时效年卡', total_classes: 0, valid_days: 365, billing_mode: 'time', points_reward: 120, price: 2999, course_scope: '全活动通用', transferable: 1, refundable: 1 },
    { id: 'ct_004', name: '1v1私教次卡', total_classes: 10, valid_days: 90, billing_mode: 'count', points_reward: 0, price: 1500, course_scope: '一对一', transferable: 0, refundable: 1 },
  ];

  const insertCardType = db.prepare(`
    INSERT INTO membership_cards (id, name, total_classes, valid_days, billing_mode, points_reward, price, course_scope, transferable, refundable, is_active, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
  `);
  cardTypes.forEach(ct => insertCardType.run(ct.id, ct.name, ct.total_classes, ct.valid_days, ct.billing_mode, ct.points_reward || 0, ct.price, ct.course_scope, ct.transferable, ct.refundable, NOW));

  // ========= 8. 会员卡实例表 =========
  console.log('[Seed] 创建会员卡实例...');
  const memberCards = [
    { id: 'mc_001', card_type_id: 'ct_002', card_type_name: '时效季卡', billing_mode: 'time', student_id: 'stu_001', student_name: '张小明', total_classes: 0, remaining_classes: 0, used_classes: 0, activated_at: NOW - 30 * 86400000, expires_at: NOW + 60 * 86400000, status: 'active' },
    { id: 'mc_002', card_type_id: 'ct_001', card_type_name: '时效月卡', billing_mode: 'time', student_id: 'stu_002', student_name: '李小红', total_classes: 0, remaining_classes: 0, used_classes: 0, activated_at: NOW - 15 * 86400000, expires_at: NOW + 15 * 86400000, status: 'active' },
    { id: 'mc_003', card_type_id: 'ct_002', card_type_name: '时效季卡', billing_mode: 'time', student_id: 'stu_003', student_name: '王刚', total_classes: 0, remaining_classes: 0, used_classes: 0, activated_at: NOW - 20 * 86400000, expires_at: NOW + 70 * 86400000, status: 'active' },
    { id: 'mc_004', card_type_id: 'ct_001', card_type_name: '时效月卡', billing_mode: 'time', student_id: 'stu_004', student_name: '赵丽丽', total_classes: 0, remaining_classes: 0, used_classes: 0, activated_at: NOW - 5 * 86400000, expires_at: NOW + 25 * 86400000, status: 'active' },
    { id: 'mc_005', card_type_id: 'ct_003', card_type_name: '时效年卡', billing_mode: 'time', student_id: 'stu_005', student_name: '刘华', total_classes: 0, remaining_classes: 0, used_classes: 0, activated_at: NOW - 60 * 86400000, expires_at: NOW + 305 * 86400000, status: 'active' },
    { id: 'mc_006', card_type_id: 'ct_004', card_type_name: '1v1私教次卡', billing_mode: 'count', student_id: 'stu_006', student_name: '陈美丽', total_classes: 10, remaining_classes: 7, used_classes: 3, activated_at: NOW - 20 * 86400000, expires_at: NOW + 70 * 86400000, status: 'active' },
  ];

  const insertMemberCard = db.prepare(`
    INSERT INTO member_cards (id, card_type_id, card_type_name, billing_mode, student_id, student_name, total_classes, remaining_classes, used_classes, activated_at, expires_at, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  memberCards.forEach(mc => insertMemberCard.run(mc.id, mc.card_type_id, mc.card_type_name, mc.billing_mode, mc.student_id, mc.student_name, mc.total_classes, mc.remaining_classes, mc.used_classes, mc.activated_at, mc.expires_at, mc.status, NOW, NOW));

  // ========= 9. 排期（历史 27 天 + 未来 7 天）==========
  // 历史排期用于支撑看板的「到班趋势」「教练课时」与「报名分布」。
  // 此前只从今天起生成 7 天，趋势图过去的日子恒为 0%、教练课时累计恒为 0，
  // 是最容易被一眼看穿的演示破绽。
  console.log('[Seed] 创建排期（历史 27 天 + 未来 7 天）...');
  const schedules = [];
  const today = new Date();
  for (let offset = -27; offset <= 6; offset++) {
    const date = new Date(today);
    date.setDate(today.getDate() + offset);
    const dateStr = formatDate(date.getTime());
    const dayOfWeek = date.getDay();
    // 取值须与前端 views/schedule 的 scheduleStatusText 映射一致（scheduled / completed / cancelled）
    const status = offset < 0 ? 'completed' : 'scheduled';

    // 周一三五：篮球课 16:00-17:30
    if (dayOfWeek === 1 || dayOfWeek === 3 || dayOfWeek === 5) {
      schedules.push({
        id: `sch_${dateStr}_bb`,
        course_id: 'course_001', course_name: '篮球训练基础班',
        teacher_id: 'teacher_001', teacher_name: '王教练',
        classroom_id: 'room_001', classroom_name: '篮球馆',
        date: dateStr, start_time: '16:00', end_time: '17:30',
        max_students: 20, enrolled_count: 0, status,
      });
    }
    // 周二四：体适能课 16:00-17:30
    if (dayOfWeek === 2 || dayOfWeek === 4) {
      schedules.push({
        id: `sch_${dateStr}_art`,
        course_id: 'course_002', course_name: '少儿体适能班',
        teacher_id: 'teacher_002', teacher_name: '李教练',
        classroom_id: 'room_002', classroom_name: '体适能训练室',
        date: dateStr, start_time: '16:00', end_time: '17:30',
        max_students: 15, enrolled_count: 0, status,
      });
    }
    // 周六：篮球提高班 09:00-10:30
    if (dayOfWeek === 6) {
      schedules.push({
        id: `sch_${dateStr}_code`,
        course_id: 'course_003', course_name: '篮球提高班',
        teacher_id: 'teacher_003', teacher_name: '张教练',
        classroom_id: 'room_003', classroom_name: '体能测试室',
        date: dateStr, start_time: '09:00', end_time: '10:30',
        max_students: 12, enrolled_count: 0, status,
      });
    }
    // 周日：篮球课 10:00-11:30
    if (dayOfWeek === 0) {
      schedules.push({
        id: `sch_${dateStr}_bb2`,
        course_id: 'course_001', course_name: '篮球训练基础班',
        teacher_id: 'teacher_001', teacher_name: '王教练',
        classroom_id: 'room_001', classroom_name: '篮球馆',
        date: dateStr, start_time: '10:00', end_time: '11:30',
        max_students: 20, enrolled_count: 0, status,
      });
    }
  }

  // 今日课次的开课时间：若按常规时段尚未开课，就前移到最近一个已过去的时段。
  // 原因：签到页默认查「今天」——
  //   · 若今天是一张空表，新用户首次打开会误判为功能异常；
  //   · 但若强行给「未开始」的课次造签到，又会出现「状态：未开始 / 已签到 5 人」的自相矛盾。
  // 前移时段同时满足两者：今日有真实的签到数据，且状态与时间戳一致。
  // 凌晨部署时没有任何已开始的时段，则保持原时段（当日无签到，属真实语义）。
  const TODAY_SLOTS = [['08:00', '09:30'], ['10:00', '11:30'], ['13:30', '15:00'], ['16:00', '17:30'], ['19:00', '20:30']];
  schedules.filter((s) => s.date === formatDate(NOW)).forEach((s) => {
    const startMsOf = (hhmm) => new Date(`${s.date}T${hhmm}:00`).getTime();
    if (startMsOf(s.start_time) <= NOW) return; // 常规时段已开课，不动
    const started = TODAY_SLOTS.filter(([st]) => startMsOf(st) <= NOW);
    if (!started.length) return;
    const [st, et] = started[started.length - 1];
    s.start_time = st;
    s.end_time = et;
  });

  // 各班固定学员池（按学员兴趣标签归类）。签到名单与排期报名数都从这里派生，
  // 保证「到班趋势 / 报名分布 / 教练课时」三类统计出自同一份名单，不会互相打架。
  const COURSE_POOL = {
    course_001: ['stu_001', 'stu_005', 'stu_007', 'stu_009', 'stu_013', 'stu_016', 'stu_018', 'stu_022'],
    course_002: ['stu_002', 'stu_003', 'stu_004', 'stu_006', 'stu_008', 'stu_010', 'stu_011', 'stu_012',
      'stu_014', 'stu_015', 'stu_017', 'stu_019', 'stu_020', 'stu_021', 'stu_023', 'stu_024'],
    course_003: ['stu_007', 'stu_009', 'stu_013', 'stu_016', 'stu_018', 'stu_022'],
  };

  // 成员 / 会员卡索引：报名与签到都要用，提前建好
  const studentById = new Map(students.map((s) => [s.id, s]));
  const cardOfStudent = new Map(memberCards.map((mc) => [mc.student_id, mc.id]));

  // 确定性哈希（FNV-1a 32bit）—— 替代 Math.random，保证每次 seed 结果逐字一致，
  // 截图与回归测试不抖动。此处必须用雪崩性好的哈希，不能用 h = h*31 + c：
  // 31 ≡ 1 (mod 5)，于是 h % 5 退化成「字符码之和 % 5」，而排期 id 只差日期数字，
  // 取值分布极不均匀 —— 实测会让一周七天里六天的缺勤判定全部落在同一侧，
  // 到班趋势画出一条几乎恒为 100% 的直线。FNV 的乘法因子与 5 互质且混入 XOR，
  // 取模分布均匀。
  const hashOf = (s) => {
    let h = 2166136261;
    for (let i = 0; i < s.length; i += 1) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  };
  // 每节课名单：池子的 60%~100%，同时受场地容量与池子规模约束；起始位偏移让各天名单不同
  schedules.forEach((s) => {
    const pool = COURSE_POOL[s.course_id] || [];
    const ratio = 0.6 + (hashOf(s.id) % 5) / 10;
    const size = Math.max(4, Math.min(pool.length, s.max_students, Math.round(pool.length * ratio)));
    const start = hashOf(`${s.id}#`) % pool.length;
    s.roster = Array.from({ length: size }, (_, i) => pool[(start + i) % pool.length]);
    s.enrolled_count = s.roster.length;
  });

  const insertSchedule = db.prepare(`
    INSERT INTO schedules (id, course_id, course_name, teacher_id, teacher_name, classroom_id, classroom_name,
      date, start_time, end_time, max_students, enrolled_count, status, is_recursive, remark, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, '', ?, ?)
  `);
  schedules.forEach(s => insertSchedule.run(s.id, s.course_id, s.course_name, s.teacher_id, s.teacher_name, s.classroom_id, s.classroom_name, s.date, s.start_time, s.end_time, s.max_students, s.enrolled_count, s.status, NOW, NOW));

  // ========= 10. 登记（enrollments）==========
  // 报名按【排期】而非课程生成：排期详情取名单的口径是
  //   enrollments WHERE schedule_id = ? AND status = 'active'（见 routes/schedules.js）
  // 此前 5 条报名的 schedule_id 全为 null，于是签到页点开任何一节课都是空名单 ——
  // 签到功能在演示里完全不可用。同时该表还被消息推送的受众判定与报名数统计消费，
  // 故与排期名单（roster）严格一一对应，保证三处口径一致。
  console.log('[Seed] 创建登记记录...');
  const enrollments = [];
  schedules.forEach((sch) => {
    sch.roster.forEach((sid) => {
      const stu = studentById.get(sid);
      enrollments.push({
        id: `enr_${sch.id}_${sid}`,
        student_id: sid,
        student_name: stu ? stu.name : '',
        course_id: sch.course_id,
        course_name: sch.course_name,
        schedule_id: sch.id,
        member_card_id: cardOfStudent.get(sid) || '',
        enroll_type: 'course',
      });
    });
  });

  const insertEnrollment = db.prepare(`
    INSERT INTO enrollments (id, student_id, student_name, course_id, course_name, schedule_id, member_card_id, enroll_type, status, enrolled_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
  `);
  enrollments.forEach(e => insertEnrollment.run(e.id, e.student_id, e.student_name, e.course_id, e.course_name, e.schedule_id, e.member_card_id, e.enroll_type, NOW, NOW, NOW));

  // ========= 11. 签到记录（历史全部课次 + 今日）==========
  // 与看板「到班趋势」同源：该图按 attendances.date 聚合、口径见 utils.attendanceRate
  // （present/late 计到场，absent 进分母，leave 不进分母）。此前只造「今日签到」，
  // 导致趋势图历史全 0%，且与上面已结束的历史排期对不上。
  console.log('[Seed] 创建签到记录...');
  const attendances = [];
  // 生成范围 = 全部「已开课」的课次。今日课次的开课时间已在上面校正过，
  // 因此该集合恰好等于「应有签到」的集合 —— 未开课的课次不会有签到，
  // 也不会出现「未开始 / 已签到 N 人」这类自相矛盾的状态。
  schedules
    .filter((s) => new Date(`${s.date}T${s.start_time}:00`).getTime() <= NOW)
    .forEach((sch) => {
      const h = hashOf(sch.id);
      // 缺勤 / 请假 / 迟到人数：约八成课次有 1 人缺勤、两成全员到齐，
      // 仅 8 人以上的班在极少数课次出现 2 人缺勤 —— 到班率由此稳定落在 85%~100%，
      // 而不是一片 100% 的直线，也不是忽高忽低的乱数。
      const absentCount = (h % 5 === 0) ? 0 : (h % 9 === 0 && sch.roster.length >= 8 ? 2 : 1);
      // 请假约每 7 节课出现一次，保证「请假」筛选与状态标签在演示样本里有真实数据
      const leaveCount = h % 7 === 0 ? 1 : 0;
      const lateCount = h % 7 === 0 ? 2 : (h % 3 === 0 ? 1 : 0);
      const startMs = new Date(`${sch.date}T${sch.start_time}:00`).getTime();

      sch.roster.forEach((sid, idx) => {
        // 名单前段依次安排缺勤 / 请假 / 迟到，保证同一天里几种状态并存
        let status = 'present';
        if (idx < absentCount) status = 'absent';
        else if (idx < absentCount + leaveCount) status = 'leave';
        else if (idx < absentCount + leaveCount + lateCount) status = 'late';
        const attended = status === 'present' || status === 'late';
        const stu = studentById.get(sid);

        attendances.push({
          id: `att_${sch.date}_${sid}`,
          schedule_id: sch.id,
          student_id: sid,
          student_name: stu ? stu.name : '',
          course_id: sch.course_id,
          course_name: sch.course_name,
          status,
          checkin_method: attended ? 'manual' : 'auto',
          checkin_time: status === 'late' ? startMs + 8 * 60000 : startMs - (idx % 4) * 60000,
          checkin_by: attended ? 'teacher' : 'system',
          consume_classes: attended ? 1 : 0,
          member_card_id: cardOfStudent.get(sid) || '',
          points_earned: status === 'present' ? 10 : (status === 'late' ? 5 : 0),
          date: sch.date,
        });
      });
    });

  const insertAttendance = db.prepare(`
    INSERT INTO attendances (id, schedule_id, student_id, student_name, course_id, course_name,
      status, checkin_method, checkin_time, checkin_by, consume_classes, member_card_id, points_earned, date, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  attendances.forEach(a => insertAttendance.run(a.id, a.schedule_id, a.student_id, a.student_name, a.course_id, a.course_name, a.status, a.checkin_method, a.checkin_time, a.checkin_by, a.consume_classes, a.member_card_id, a.points_earned, a.date, NOW, NOW));

  // ========= 12. 积分账户 + 流水 =========
  console.log('[Seed] 创建积分账户和流水...');
  const pointsData = [
    { id: 'pts_001', student_id: 'stu_001', student_name: '张小明', total_earned: 120, total_consumed: 20, balance: 100 },
    { id: 'pts_002', student_id: 'stu_002', student_name: '李小红', total_earned: 80, total_consumed: 0, balance: 80 },
    { id: 'pts_003', student_id: 'stu_003', student_name: '王刚', total_earned: 150, total_consumed: 30, balance: 120 },
    { id: 'pts_004', student_id: 'stu_004', student_name: '赵丽丽', total_earned: 60, total_consumed: 0, balance: 60 },
    { id: 'pts_005', student_id: 'stu_005', student_name: '刘华', total_earned: 200, total_consumed: 50, balance: 150 },
    { id: 'pts_006', student_id: 'stu_006', student_name: '陈美丽', total_earned: 40, total_consumed: 0, balance: 40 },
    { id: 'pts_007', student_id: 'stu_007', student_name: '杨强', total_earned: 90, total_consumed: 10, balance: 80 },
    { id: 'pts_008', student_id: 'stu_008', student_name: '黄小芳', total_earned: 70, total_consumed: 0, balance: 70 },
  ];

  const insertPoints = db.prepare(`
    INSERT INTO points (id, student_id, student_name, total_earned, total_consumed, balance, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  pointsData.forEach(p => insertPoints.run(p.id, p.student_id, p.student_name, p.total_earned, p.total_consumed, p.balance, NOW));

  // 积分流水
  console.log('[Seed] 创建积分流水...');
  const pointLogs = [
    { id: 'plog_001', student_id: 'stu_001', type: 'earn', amount: 10, balance: 10, reason: '签到', reference_id: 'att_001', description: '签到获得积分' },
    { id: 'plog_002', student_id: 'stu_001', type: 'earn', amount: 10, balance: 20, reason: '签到', reference_id: 'att_002', description: '签到获得积分' },
    { id: 'plog_003', student_id: 'stu_001', type: 'earn', amount: 100, balance: 120, reason: '充值', reference_id: '', description: '购买季卡获得积分' },
    { id: 'plog_004', student_id: 'stu_001', type: 'consume', amount: 20, balance: 100, reason: '兑换', reference_id: '', description: '兑换小礼品' },
    { id: 'plog_005', student_id: 'stu_003', type: 'earn', amount: 150, balance: 150, reason: '充值', reference_id: '', description: '购买季卡获得积分' },
    { id: 'plog_006', student_id: 'stu_003', type: 'consume', amount: 30, balance: 120, reason: '兑换', reference_id: '', description: '兑换文具' },
    { id: 'plog_007', student_id: 'stu_005', type: 'earn', amount: 200, balance: 200, reason: '充值', reference_id: '', description: '购买年卡获得积分' },
    { id: 'plog_008', student_id: 'stu_005', type: 'consume', amount: 50, balance: 150, reason: '兑换', reference_id: '', description: '兑换篮球护具' },
    { id: 'plog_009', student_id: 'stu_007', type: 'earn', amount: 90, balance: 90, reason: '充值', reference_id: '', description: '购买季卡获得积分' },
    { id: 'plog_010', student_id: 'stu_007', type: 'consume', amount: 10, balance: 80, reason: '兑换', reference_id: '', description: '兑换贴纸' },
  ];

  const insertPointLog = db.prepare(`
    INSERT INTO point_logs (id, student_id, type, amount, balance, reason, reference_id, description, created_at, expire_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const POINT_EXPIRY_MS = 730 * 24 * 3600 * 1000;
  pointLogs.forEach(pl => insertPointLog.run(
    pl.id, pl.student_id, pl.type, pl.amount, pl.balance, pl.reason, pl.reference_id, pl.description, NOW,
    pl.type === 'earn' ? NOW + POINT_EXPIRY_MS : null
  ));

  // ========= 13. 订单 + 支付 =========
  // 覆盖近 90 天，让看板的「今日 / 本周 / 本月 / 本年收入」、环比与签单排名都有真实数字。
  // 此前只有 3 单、且都在 30/15/60 天前 —— 新用户部署后看到「今日收入 0 元」，
  // 会误以为系统是空的，这是演示数据最主要的劝退点。
  console.log('[Seed] 创建订单和支付...');

  const CARD_INFO = {
    ct_001: { name: '时效月卡', price: 699 },
    ct_002: { name: '时效季卡', price: 1299 },
    ct_003: { name: '时效年卡', price: 2999 },
    ct_004: { name: '1v1私教次卡', price: 1500 },
  };
  const SALES_TEAM = ['王教练', '李教练', '张教练', '销售示例'];

  // 学员序号（0-based）→ 家长 openid：stu_001~008 ↔ wx_parent_001~008，stu_009~024 ↔ wx_parent_013~028
  const parentOpenidOf = (idx) => {
    const n = idx + 1;
    return n <= 8 ? `wx_parent_${String(n).padStart(3, '0')}` : `wx_parent_${String(n + 4).padStart(3, '0')}`;
  };

  // [天数前, 学员序号, 卡型, 已退款金额] —— 固定序列，保证每次 seed 结果一致
  const ORDER_PLAN = [
    // 今日
    [0, 2, 'ct_001', 0], [0, 10, 'ct_002', 0], [0, 18, 'ct_001', 0],
    // 本周（1~6 天前）
    [1, 0, 'ct_001', 0], [1, 8, 'ct_002', 0], [2, 4, 'ct_004', 0], [2, 13, 'ct_001', 0],
    [3, 6, 'ct_002', 0], [4, 16, 'ct_001', 0], [5, 20, 'ct_002', 0],
    // 本月（7~29 天前）
    [8, 11, 'ct_003', 0], [10, 1, 'ct_001', 0], [12, 15, 'ct_002', 0], [14, 5, 'ct_001', 0],
    [16, 19, 'ct_004', 0], [18, 3, 'ct_002', 0], [21, 14, 'ct_001', 0], [24, 9, 'ct_003', 0],
    [27, 22, 'ct_002', 0], [29, 7, 'ct_001', 0],
    // 上月（30~59 天前）
    [32, 17, 'ct_001', 0], [36, 12, 'ct_002', 0], [40, 0, 'ct_002', 0], [45, 21, 'ct_001', 0],
    [49, 4, 'ct_003', 0], [52, 18, 'ct_004', 0], [56, 10, 'ct_001', 0], [59, 2, 'ct_002', 0],
    // 前两个月（60~89 天前）
    [63, 6, 'ct_001', 0], [68, 13, 'ct_002', 0], [73, 23, 'ct_003', 0], [78, 20, 'ct_001', 0],
    [84, 8, 'ct_002', 0], [89, 16, 'ct_001', 0],
    // 退款单：演示「本月净收入 = 收入 − 退款」口径
    [11, 5, 'ct_001', 400], [22, 19, 'ct_002', 600],
  ];

  const orders = [
    // 保留原有 3 条（id / 学员 / 金额不变，补签单人以让排名有数据）
    { id: 'order_001', order_no: `ORD${Date.now()}`, user_id: 'wx_parent_001', student_id: 'stu_001', student_name: '张小明', order_type: 'membership', items: JSON.stringify([{ itemType: 'membershipCard', itemId: 'ct_002', itemName: '季卡', quantity: 1, unitPrice: 1299, totalPrice: 1299 }]), total_amount: 1299, discount_amount: 0, payable_amount: 1299, status: 'paid', salesperson: '王教练', refunded_amount: 0, last_refunded_at: null, paid_at: NOW - 30 * 86400000 },
    { id: 'order_002', order_no: `ORD${Date.now() + 1}`, user_id: 'wx_parent_002', student_id: 'stu_002', student_name: '李小红', order_type: 'membership', items: JSON.stringify([{ itemType: 'membershipCard', itemId: 'ct_001', itemName: '月卡', quantity: 1, unitPrice: 699, totalPrice: 699 }]), total_amount: 699, discount_amount: 0, payable_amount: 699, status: 'paid', salesperson: '李教练', refunded_amount: 0, last_refunded_at: null, paid_at: NOW - 15 * 86400000 },
    { id: 'order_003', order_no: `ORD${Date.now() + 2}`, user_id: 'wx_parent_005', student_id: 'stu_005', student_name: '刘华', order_type: 'membership', items: JSON.stringify([{ itemType: 'membershipCard', itemId: 'ct_003', itemName: '年卡', quantity: 1, unitPrice: 2999, totalPrice: 2999 }]), total_amount: 2999, discount_amount: 0, payable_amount: 2999, status: 'paid', salesperson: '张教练', refunded_amount: 0, last_refunded_at: null, paid_at: NOW - 60 * 86400000 },
  ];

  ORDER_PLAN.forEach(([daysAgo, si, ctId, refunded], i) => {
    const info = CARD_INFO[ctId];
    const stu = students[si];
    const paidAt = NOW - daysAgo * 86400000;
    orders.push({
      id: `order_${String(i + 4).padStart(3, '0')}`,
      order_no: `ORD${formatDate(paidAt).replace(/-/g, '')}${String(1000 + i)}`,
      user_id: parentOpenidOf(si),
      student_id: stu.id,
      student_name: stu.name,
      order_type: 'membership',
      items: JSON.stringify([{ itemType: 'membershipCard', itemId: ctId, itemName: info.name, quantity: 1, unitPrice: info.price, totalPrice: info.price }]),
      total_amount: info.price,
      discount_amount: 0,
      payable_amount: info.price,
      status: refunded > 0 ? 'refunded' : 'paid',
      salesperson: SALES_TEAM[i % SALES_TEAM.length],
      refunded_amount: refunded,
      last_refunded_at: refunded > 0 ? paidAt + 5 * 86400000 : null,
      paid_at: paidAt,
    });
  });

  const insertOrder = db.prepare(`
    INSERT INTO orders (id, order_no, user_id, student_id, student_name, order_type, items, total_amount, discount_amount, payable_amount, status, salesperson, refunded_amount, last_refunded_at, paid_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  orders.forEach(o => insertOrder.run(o.id, o.order_no, o.user_id, o.student_id, o.student_name, o.order_type, o.items, o.total_amount, o.discount_amount, o.payable_amount, o.status, o.salesperson, o.refunded_amount, o.last_refunded_at, o.paid_at, NOW, NOW));

  // 支付记录：与订单严格一对一，金额等于订单应付额
  // （此前 pay_001~003 的金额写成 3200/1200/11000，与对应订单的 1299/699/2999 不一致，属演示数据缺陷）
  console.log('[Seed] 创建支付记录...');
  const payments = orders.map((o, i) => ({
    id: `pay_${String(i + 1).padStart(3, '0')}`,
    order_id: o.id,
    order_no: o.order_no,
    user_id: o.user_id,
    amount: o.payable_amount,
    channel: 'wechat',
    transaction_id: `WX${Date.now() + i}`,
    status: 'success',
    paid_at: o.paid_at,
  }));

  const insertPayment = db.prepare(`
    INSERT INTO payments (id, order_id, order_no, user_id, amount, channel, transaction_id, status, paid_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  payments.forEach(p => insertPayment.run(p.id, p.order_id, p.order_no, p.user_id, p.amount, p.channel, p.transaction_id, p.status, p.paid_at, NOW));

  // ========= 14. 消息通知 =========
  console.log('[Seed] 创建消息通知...');
  const notifications = [
    { id: 'msg_001', user_id: 'wx_parent_001', student_id: 'stu_001', title: '签到成功', content: '张小明今日篮球课签到成功，获得10积分', channel: 'inapp', status: 'sent', sent_at: NOW - 3600000 },
    { id: 'msg_002', user_id: 'wx_parent_001', student_id: 'stu_001', title: '训练时长提醒', content: '您的季卡剩余18训练时长，请及时安排训练', channel: 'inapp', status: 'sent', sent_at: NOW - 86400000 },
    { id: 'msg_003', user_id: 'wx_parent_002', student_id: 'stu_002', title: '签到成功', content: '李小红今日体适能课签到成功，获得10积分', channel: 'inapp', status: 'sent', sent_at: NOW - 7200000 },
    { id: 'msg_004', user_id: 'wx_parent_005', student_id: 'stu_005', title: '活动即将开始', content: '篮球课明天上午9点开始，请准时到达', channel: 'inapp', status: 'read', sent_at: NOW - 172800000 },
    { id: 'msg_005', user_id: 'wx_parent_003', student_id: 'stu_003', title: '会员卡即将到期', content: '您的季卡将在7天后到期，请及时续期', channel: 'inapp', status: 'sent', sent_at: NOW - 259200000 },
  ];

  const insertNotification = db.prepare(`
    INSERT INTO notifications (id, user_id, student_id, template_id, title, content, channel, status, sent_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  notifications.forEach(n => insertNotification.run(n.id, n.user_id, n.student_id, '', n.title, n.content, n.channel, n.status, n.sent_at, NOW));

  // ========= 15. 系统设置 =========
  console.log('[Seed] 创建系统设置...');
  const settings = [
    { key: 'site_name', label: '机构名称', value: '星课培训中心', description: '显示在页面顶部的机构名称' },
    { key: 'site_phone', label: '联系电话', value: '400-888-8888', description: '客服电话' },
    { key: 'site_address', label: '机构地址', value: '上海市浦东新区世纪大道100号', description: '机构详细地址' },
    { key: 'checkin_points', label: '签到积分', value: '10', description: '每次签到获得的积分' },
    { key: 'late_points', label: '迟到积分', value: '5', description: '迟到获得的积分' },
    { key: 'auto_absent_minutes', label: '自动缺席分钟数', value: '15', description: '活动开始后多少分钟未签到自动标记缺席' },
    { key: 'expire_remind_days', label: '到期提醒天数', value: '7', description: '会员卡到期前多少天提醒' },
    { key: 'points_rule', label: '积分规则', value: JSON.stringify({ signIn: 10, late: 5, consumePerYuan: 1, referral: 100 }), description: '积分规则配置' },
    { key: 'push_rule', label: '推送规则', value: JSON.stringify({ beforeClassMinutes: 30, beforeExpireDays: 7, lowRemainClasses: 5 }), description: '推送规则配置' },
    { key: 'refund_rule', label: '退费规则', value: JSON.stringify({ within7Days: 1.0, within30Days: 0.8, after30Days: 0.5 }), description: '退费规则配置' },
  ];

  const insertSetting = db.prepare(`
    INSERT INTO settings (key, label, value, description, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  settings.forEach(s => insertSetting.run(s.key, s.label, s.value, s.description, NOW));

  // ========= 16. 扣课记录 =========
  console.log('[Seed] 创建扣课记录...');
  const deductionLogs = [
    { schedule_id: schedules[0]?.id || 'sch_default_1', student_id: 'stu_001', card_id: 'mc_001', deducted_at: NOW - 7 * 86400000 },
    { schedule_id: schedules[1]?.id || 'sch_default_2', student_id: 'stu_002', card_id: 'mc_002', deducted_at: NOW - 5 * 86400000 },
    { schedule_id: schedules[2]?.id || 'sch_default_3', student_id: 'stu_003', card_id: 'mc_003', deducted_at: NOW - 3 * 86400000 },
    { schedule_id: schedules[3]?.id || 'sch_default_4', student_id: 'stu_001', card_id: 'mc_001', deducted_at: NOW - 2 * 86400000 },
    { schedule_id: schedules[4]?.id || 'sch_default_5', student_id: 'stu_005', card_id: 'mc_005', deducted_at: NOW - 1 * 86400000 },
  ];

  const insertDeduction = db.prepare(`
    INSERT INTO deduction_logs (schedule_id, student_id, card_id, deducted_at)
    VALUES (?, ?, ?, ?)
  `);
  deductionLogs.forEach(d => insertDeduction.run(d.schedule_id, d.student_id, d.card_id, d.deducted_at));

  // ========= 17. 请假申请 =========
  // 挂到未来课次上，三种审批状态齐备 —— 让「请假审批」页与看板「待处理事项 · 请假待审批」
  // 都有数据。此前该表为空，审批流在演示里完全不可见。
  console.log('[Seed] 创建请假申请...');
  const mainBindingOf = (sid) => bindings.find((b) => b.student_id === sid && b.is_main === 1)
    || bindings.find((b) => b.student_id === sid) || {};
  const futureSchedules = schedules.filter((s) => s.date > formatDate(NOW));

  // [未来课次序号, 学员, 事由, 状态, 审批备注]
  const leaveSeed = [
    [0, 'stu_006', '家中临时有事，本周需要请假一次', 'pending', ''],
    [1, 'stu_018', '孩子感冒发烧，医生建议在家休息', 'pending', ''],
    [2, 'stu_012', '学校组织集体活动，时间冲突', 'approved', '已批准，课时不扣除'],
    [3, 'stu_009', '家庭出行，提前报备', 'approved', '已批准，建议观看训练回放'],
    [4, 'stu_022', '轻微扭伤，遵医嘱休息一周', 'rejected', '伤势较轻，建议到场做恢复性训练'],
  ];

  const leaveRequests = leaveSeed.map(([schIdx, sid, reason, status, note], i) => {
    const sch = futureSchedules[schIdx];
    const stu = studentById.get(sid);
    const bd = mainBindingOf(sid);
    const applyAt = NOW - (i + 1) * 6 * 3600000; // 申请时间早于排期，且逐条错开
    return {
      id: `leave_${String(i + 1).padStart(3, '0')}`,
      student_id: sid,
      student_name: stu ? stu.name : '',
      schedule_id: sch ? sch.id : null,
      course_name: sch ? sch.course_name : '',
      date: sch ? sch.date : '',
      start_time: sch ? sch.start_time : '',
      reason,
      status,
      parent_openid: bd.parent_openid || '',
      parent_phone: bd.parent_phone || '',
      review_note: note,
      apply_at: applyAt,
    };
  });

  const insertLeave = db.prepare(`
    INSERT INTO leave_requests (id, student_id, student_name, schedule_id, course_name, date, start_time,
      reason, status, parent_openid, parent_phone, review_note, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  leaveRequests.forEach(r => insertLeave.run(
    r.id, r.student_id, r.student_name, r.schedule_id, r.course_name, r.date, r.start_time,
    r.reason, r.status, r.parent_openid, r.parent_phone, r.review_note, r.apply_at, NOW
  ));

  // ========= 18. 家长反馈 =========
  // 同样补齐空表：已回复 / 待处理两种状态互见，让反馈处理链路在演示中可读。
  console.log('[Seed] 创建家长反馈...');
  // [家长 openid, 关联学员, 内容, 状态, 回复]
  const feedbackSeed = [
    ['wx_parent_001', 'stu_001', '孩子上了两个月篮球课，体能和专注力都有明显提升，王教练很有耐心，感谢！', 'done', '感谢认可！我们会继续跟进孩子的训练进度，有任何建议随时提出。'],
    ['wx_parent_013', 'stu_009', '希望周六的篮球提高班能多开一个时段，现在名额很难抢到。', 'done', '已收到！十月起周六下午增开一个提高班时段，届时会在小程序推送通知。'],
    ['wx_parent_021', 'stu_017', '体适能训练室的地面有点滑，建议增加防滑垫，安全第一。', 'done', '已采购防滑垫并于本周完成铺设，感谢您的细心提醒。'],
    ['wx_parent_016', 'stu_012', '在小程序里看不到孩子的体测报告，能加一下这个功能吗？', 'pending', ''],
    ['wx_parent_027', 'stu_023', '上次课临时更换了教练，希望能提前一天通知家长。', 'pending', ''],
  ];

  const parentOf = (openid) => users.find((u) => u.openid === openid) || {};
  const feedbacks = feedbackSeed.map(([openid, sid, content, status, reply], i) => {
    const pu = parentOf(openid);
    const stu = studentById.get(sid);
    const at = NOW - (i + 1) * 26 * 3600000;
    return {
      id: `fb_${String(i + 1).padStart(3, '0')}`,
      user_id: openid,
      user_name: pu.nickname || (stu ? stu.name : ''),
      student_id: sid,
      content,
      contact: pu.phone || '',
      status,
      reply,
      reply_at: status === 'done' ? at + 12 * 3600000 : null,
      replied_by: status === 'done' ? '管理员' : '',
      at,
    };
  });

  const insertFeedback = db.prepare(`
    INSERT INTO feedback (id, user_id, user_name, student_id, content, contact, status,
      reply, reply_at, replied_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  feedbacks.forEach(f => insertFeedback.run(
    f.id, f.user_id, f.user_name, f.student_id, f.content, f.contact, f.status,
    f.reply, f.reply_at, f.replied_by, f.at, NOW
  ));

  // ========= 19. 销售线索（增长中心）==========
  // 覆盖「新线索 → 已联系 → 体验中 → 已成交 / 已流失」五个阶段，漏斗与转化率才有形状。
  // 口径（见 routes/growth.js）：已成交按 status='converted'、已流失按 status='lost' 计数，
  // 其余阶段按 stage 计数；stage 取值 new/contacted/trial/deal/lost，
  // source 取值 natural/referral/offline/online/other。
  console.log('[Seed] 创建销售线索...');
  // [姓名, 来源, 阶段, 意向度(1-5), 跟进人, 备注, 生命周期状态, 关联学员]
  const leadSeed = [
    ['陈雨桐', 'referral', 'new', 4, '销售示例', '邻居推荐，孩子 8 岁想学篮球，周末方便试课', '', ''],
    ['王一诺', 'online', 'new', 3, '销售示例', '线上广告留资，尚未确定到店时间', '', ''],
    ['李思远', 'offline', 'new', 2, '王教练', '地推活动登记，意向待进一步确认', '', ''],
    ['周雨桐', 'natural', 'contacted', 4, '销售示例', '到店咨询过，主要关注课时与收费方式', '', ''],
    ['吴子豪', 'referral', 'contacted', 5, '李教练', '老学员家长介绍，希望本周内安排试课', '', ''],
    ['郑可欣', 'online', 'trial', 4, '销售示例', '已完成一次体验课，家长反馈良好', '', ''],
    ['孙浩然', 'natural', 'trial', 3, '张教练', '体验课中，家长仍在比价，需持续跟进', '', ''],
    ['马俊杰', 'referral', 'deal', 5, '销售示例', '试课后当天报名季卡，已转为正式学员', 'converted', 'stu_013'],
    ['唐可盈', 'offline', 'deal', 4, '王教练', '体验课后报名月卡，已转为正式学员', 'converted', 'stu_021'],
    ['黄雅静', 'online', 'lost', 1, '销售示例', '最终选择了其他机构，价格为主要因素', 'lost', ''],
  ];

  const leads = leadSeed.map(([name, source, stage, intent, owner, note, status, sid], i) => {
    // 创建时间由近及远铺开，让列表排序有层次；成交线索的 converted_at 落在其后
    const createdAt = NOW - (i * 4 + 2) * 86400000;
    const converted = status === 'converted';
    return {
      id: `lead_${String(i + 1).padStart(3, '0')}`,
      name,
      phone: `136${String(10000000 + i * 137).slice(0, 8)}`,
      source,
      stage,
      intent_level: intent,
      // 待跟进的线索给出下次跟进时间；终态线索不再排期
      next_follow_at: (stage === 'lost') ? null : NOW + (i % 5 + 1) * 86400000,
      note,
      salesperson: owner,
      student_id: sid,
      converted_at: converted ? createdAt + 3 * 86400000 : null,
      status,
      stage_changed_at: createdAt + 2 * 86400000,
      certainty: null,
      created_at: createdAt,
    };
  });

  const insertLead = db.prepare(`
    INSERT INTO leads (id, name, phone, source, stage, intent_level, next_follow_at, note,
      salesperson, student_id, converted_at, status, stage_changed_at, certainty, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  leads.forEach(l => insertLead.run(
    l.id, l.name, l.phone, l.source, l.stage, l.intent_level, l.next_follow_at, l.note,
    l.salesperson, l.student_id, l.converted_at, l.status, l.stage_changed_at, l.certainty, l.created_at, NOW
  ));

  // ========= 20. 跟进任务 =========
  // 与线索挂钩，既让「增长中心 · 跟进任务」有内容，也让看板「待处理事项 · 待跟进」非空。
  // task_type 取值见 routes/followups.js 的 TASK_TYPE_TEXT；priority 为数字，越小越紧急。
  console.log('[Seed] 创建跟进任务...');
  // [线索序号, 任务类型, 事由, 跟进人, 距今到期天数（负=已逾期）, 优先级, 状态]
  const followSeed = [
    [1, 'lead_followup', '留资后未回复，需电话确认到店时间', '销售示例', 1, 1, 'pending'],
    [3, 'lead_followup', '到店咨询未成交，跟进课时方案', '销售示例', 0, 2, 'pending'],
    [4, 'lead_followup', '老学员家长介绍，尽快安排试课', '李教练', 2, 1, 'pending'],
    [5, 'trial_followup', '体验课回访，推动报名决策', '销售示例', 1, 2, 'pending'],
    [6, 'trial_followup', '体验课回访，家长仍在比价', '张教练', 3, 3, 'pending'],
    [3, 'lead_followup', '首次电话沟通已完成，记录意向', '销售示例', -2, 2, 'completed'],
    [4, 'lead_followup', '发送课程资料与价目表', '销售示例', -5, 3, 'completed'],
  ];

  const followUps = followSeed.map(([leadIdx, taskType, reason, owner, dueOffset, priority, status], i) => {
    const lead = leads[leadIdx];
    const dueAt = NOW + dueOffset * 86400000;
    return {
      id: `fu_${String(i + 1).padStart(3, '0')}`,
      target_type: 'lead',
      target_id: lead ? lead.id : '',
      target_name: lead ? lead.name : '',
      phone: lead ? lead.phone : '',
      task_type: taskType,
      reason,
      owner,
      due_at: dueAt,
      priority,
      status,
      note: status === 'completed' ? '已完成沟通，详见线索备注' : '',
      completed_at: status === 'completed' ? dueAt + 3600000 : null,
      created_by: '管理员',
      created_at: NOW - (i + 1) * 86400000,
    };
  });

  const insertFollowUp = db.prepare(`
    INSERT INTO follow_ups (id, target_type, target_id, target_name, phone, task_type, reason, owner,
      due_at, priority, status, note, completed_at, created_by, certainty, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
  `);
  followUps.forEach(f => insertFollowUp.run(
    f.id, f.target_type, f.target_id, f.target_name, f.phone, f.task_type, f.reason, f.owner,
    f.due_at, f.priority, f.status, f.note, f.completed_at, f.created_by, f.created_at
  ));

  // ========= 汇总 =========
  console.log('');
  console.log('╔═══════════════════════════════════════════════════════════════╗');
  console.log('║  🌱 种子数据填充完成！                                         ║');
  console.log('╠═══════════════════════════════════════════════════════════════╣');
  console.log(`║  用户：${users.length} 个（管理员 / 教师 / 销售 / 家长）`);
  console.log(`║  成员：${students.length} 位`);
  console.log(`║  家长绑定：${bindings.length} 条`);
  console.log(`║  教师：${teachers.length} 位`);
  console.log(`║  场地：${classrooms.length} 间`);
  console.log(`║  活动：${courses.length} 门`);
  console.log(`║  会员卡类型：${cardTypes.length} 种`);
  console.log(`║  会员卡实例：${memberCards.length} 张`);
  console.log(`║  排期：${schedules.length} 节（历史 27 天 + 未来 7 天）`);
  console.log(`║  登记：${enrollments.length} 条`);
  console.log(`║  签到：${attendances.length} 条（历史全部课次）`);
  console.log(`║  积分账户：${pointsData.length} 个`);
  console.log(`║  积分流水：${pointLogs.length} 条`);
  console.log(`║  订单：${orders.length} 个`);
  console.log(`║  支付记录：${payments.length} 条`);
  console.log(`║  消息通知：${notifications.length} 条`);
  console.log(`║  扣课记录：${deductionLogs.length} 条`);
  console.log(`║  请假申请：${leaveRequests.length} 条`);
  console.log(`║  家长反馈：${feedbacks.length} 条`);
  console.log(`║  销售线索：${leads.length} 条`);
  console.log(`║  跟进任务：${followUps.length} 条`);
  console.log(`║  系统设置：${settings.length} 项`);
  console.log('╚═══════════════════════════════════════════════════════════════╝');
}

// 如果直接运行此文件
// 破坏性守卫：seed() 会先清空 19 张表再写入，因此默认拒绝直接执行——
// 必须显式 `node db/seed.js --force`（或环境变量 SEED_FORCE=1）才真正清库灌数据，
// 防止误跑部署脚本/手动命令把生产库抹平。
if (require.main === module) {
  const forced = process.argv.includes('--force') || process.env.SEED_FORCE === '1'
  let hasData = 0
  try {
    hasData = db.prepare('SELECT COUNT(*) c FROM users').get().c
  } catch (e) { /* users 表不存在 = 空库 */ }
  if (hasData > 0 && !forced) {
    console.error(`[Seed] 已拒绝：库中存在 ${hasData} 个账号，seed 会清空全部数据。`)
    console.error('[Seed] 确需重置为演示数据请加 --force：node db/seed.js --force')
    process.exit(1)
  }
  seed();
}

module.exports = seed;
