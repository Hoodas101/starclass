/**
 * 种子数据 — 填充完整的示例数据
 *
 * 包含：
 * - 1 个管理员 + 3 个教师 + 12 个家长
 * - 8 位成员
 * - 3 位教师档案
 * - 3 间场地
 * - 3 门活动
 * - 2 种会员卡类型 + 5 张会员卡实例
 * - 本周 7 天排期
 * - 今日签到记录
 * - 积分账户 + 流水
 * - 订单 + 支付
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
  ];

  const insertStudent = db.prepare(`
    INSERT INTO students (id, name, gender, birthday, school, grade, hobby, remark, height, weight, bmi, status, join_date, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
  `);
  students.forEach(s => insertStudent.run(s.id, s.name, s.gender, s.birthday, s.school, s.grade, s.hobby, s.remark, s.height || 0, s.weight || 0, s.bmi || 0, NOW, NOW, NOW));

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
  ];

  const insertBinding = db.prepare(`
    INSERT INTO parent_bindings (student_id, student_name, parent_name, parent_openid, parent_phone, relation, is_main, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  bindings.forEach(b => insertBinding.run(b.student_id, b.student_name, b.parent_name, b.parent_openid, b.parent_phone, b.relation, b.is_main, NOW));

  // ========= 4. 教师表 =========
  console.log('[Seed] 创建教师...');
  const teachers = [
    { id: 'teacher_001', user_id: 'user_teacher_001', name: '王教练', phone: '13800000011', gender: 'male', specialty: '篮球', bio: '国家一级篮球运动员，教龄8年', hire_date: '2020-09-01' },
    { id: 'teacher_002', user_id: 'user_teacher_002', name: '李教练', phone: '13800000012', gender: 'female', specialty: '体适能', bio: '体育教育专业毕业，专注儿童体适能，教龄5年', hire_date: '2021-03-15' },
    { id: 'teacher_003', user_id: 'user_teacher_003', name: '张教练', phone: '13800000013', gender: 'male', specialty: '篮球', bio: '青少年篮球教练员，教龄3年', hire_date: '2022-09-01' },
  ];

  const insertTeacher = db.prepare(`
    INSERT INTO teachers (id, user_id, name, phone, gender, avatar, specialty, bio, status, hire_date, created_at)
    VALUES (?, ?, ?, ?, ?, '', ?, ?, 'active', ?, ?)
  `);
  teachers.forEach(t => insertTeacher.run(t.id, t.user_id, t.name, t.phone, t.gender, t.specialty, t.bio, t.hire_date, NOW));

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

  // ========= 9. 本周排期（7天）==========
  console.log('[Seed] 创建本周排期...');
  const schedules = [];
  const today = new Date();
  for (let i = 0; i < 7; i++) {
    const date = new Date(today);
    date.setDate(today.getDate() + i);
    const dateStr = formatDate(date.getTime());
    const dayOfWeek = date.getDay();

    // 周一三五：篮球课 16:00-17:30
    if (dayOfWeek === 1 || dayOfWeek === 3 || dayOfWeek === 5) {
      schedules.push({
        id: `sch_${dateStr}_bb`,
        course_id: 'course_001', course_name: '篮球训练基础班',
        teacher_id: 'teacher_001', teacher_name: '王教练',
        classroom_id: 'room_001', classroom_name: '篮球馆',
        date: dateStr, start_time: '16:00', end_time: '17:30',
        max_students: 20, enrolled_count: 0, status: 'scheduled',
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
        max_students: 15, enrolled_count: 0, status: 'scheduled',
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
        max_students: 12, enrolled_count: 0, status: 'scheduled',
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
        max_students: 20, enrolled_count: 0, status: 'scheduled',
      });
    }
  }

  const insertSchedule = db.prepare(`
    INSERT INTO schedules (id, course_id, course_name, teacher_id, teacher_name, classroom_id, classroom_name,
      date, start_time, end_time, max_students, enrolled_count, status, is_recursive, remark, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, '', ?, ?)
  `);
  schedules.forEach(s => insertSchedule.run(s.id, s.course_id, s.course_name, s.teacher_id, s.teacher_name, s.classroom_id, s.classroom_name, s.date, s.start_time, s.end_time, s.max_students, s.enrolled_count, s.status, NOW, NOW));

  // ========= 10. 登记（enrollments）==========
  console.log('[Seed] 创建登记记录...');
  const enrollments = [
    { id: 'enr_001', student_id: 'stu_001', student_name: '张小明', course_id: 'course_001', course_name: '篮球训练基础班', schedule_id: null, member_card_id: 'mc_001', enroll_type: 'course' },
    { id: 'enr_002', student_id: 'stu_002', student_name: '李小红', course_id: 'course_002', course_name: '少儿体适能班', schedule_id: null, member_card_id: 'mc_002', enroll_type: 'course' },
    { id: 'enr_003', student_id: 'stu_003', student_name: '王刚', course_id: 'course_001', course_name: '篮球训练基础班', schedule_id: null, member_card_id: 'mc_003', enroll_type: 'course' },
    { id: 'enr_004', student_id: 'stu_004', student_name: '赵丽丽', course_id: 'course_002', course_name: '少儿体适能班', schedule_id: null, member_card_id: 'mc_004', enroll_type: 'course' },
    { id: 'enr_005', student_id: 'stu_005', student_name: '刘华', course_id: 'course_003', course_name: '篮球提高班', schedule_id: null, member_card_id: 'mc_005', enroll_type: 'course' },
  ];

  const insertEnrollment = db.prepare(`
    INSERT INTO enrollments (id, student_id, student_name, course_id, course_name, schedule_id, member_card_id, enroll_type, status, enrolled_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
  `);
  enrollments.forEach(e => insertEnrollment.run(e.id, e.student_id, e.student_name, e.course_id, e.course_name, e.schedule_id, e.member_card_id, e.enroll_type, NOW, NOW, NOW));

  // ========= 11. 今日签到记录 =========
  console.log('[Seed] 创建今日签到记录...');
  const todayStr = formatDate(NOW);
  const todaySchedulesList = schedules.filter(s => s.date === todayStr);

  const attendances = [];
  if (todaySchedulesList.length > 0) {
    const firstSchedule = todaySchedulesList[0];
    const enrolledStudents = enrollments.filter(e => e.course_id === firstSchedule.course_id);

    enrolledStudents.forEach((e, idx) => {
      const statuses = ['present', 'present', 'late', 'present', 'leave'];
      const status = statuses[idx % statuses.length];
      attendances.push({
        id: `att_${todayStr}_${e.student_id}`,
        schedule_id: firstSchedule.id,
        student_id: e.student_id,
        student_name: e.student_name,
        course_id: e.course_id,
        course_name: e.course_name,
        status,
        checkin_method: 'manual',
        checkin_time: NOW - (idx + 1) * 300000,
        checkin_by: 'teacher',
        consume_classes: 1,
        member_card_id: e.member_card_id,
        points_earned: status === 'present' ? 10 : (status === 'late' ? 5 : 0),
        date: todayStr,
      });
    });
  }

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
  console.log('[Seed] 创建订单和支付...');
  const orders = [
    { id: 'order_001', order_no: `ORD${Date.now()}`, user_id: 'wx_parent_001', student_id: 'stu_001', student_name: '张小明', order_type: 'membership', items: JSON.stringify([{ itemType: 'membershipCard', itemId: 'ct_002', itemName: '季卡', quantity: 1, unitPrice: 1299, totalPrice: 1299 }]), total_amount: 1299, discount_amount: 0, payable_amount: 1299, status: 'paid', paid_at: NOW - 30 * 86400000 },
    { id: 'order_002', order_no: `ORD${Date.now() + 1}`, user_id: 'wx_parent_002', student_id: 'stu_002', student_name: '李小红', order_type: 'membership', items: JSON.stringify([{ itemType: 'membershipCard', itemId: 'ct_001', itemName: '月卡', quantity: 1, unitPrice: 699, totalPrice: 699 }]), total_amount: 699, discount_amount: 0, payable_amount: 699, status: 'paid', paid_at: NOW - 15 * 86400000 },
    { id: 'order_003', order_no: `ORD${Date.now() + 2}`, user_id: 'wx_parent_005', student_id: 'stu_005', student_name: '刘华', order_type: 'membership', items: JSON.stringify([{ itemType: 'membershipCard', itemId: 'ct_003', itemName: '年卡', quantity: 1, unitPrice: 2999, totalPrice: 2999 }]), total_amount: 2999, discount_amount: 0, payable_amount: 2999, status: 'paid', paid_at: NOW - 60 * 86400000 },
  ];

  const insertOrder = db.prepare(`
    INSERT INTO orders (id, order_no, user_id, student_id, student_name, order_type, items, total_amount, discount_amount, payable_amount, status, paid_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  orders.forEach(o => insertOrder.run(o.id, o.order_no, o.user_id, o.student_id, o.student_name, o.order_type, o.items, o.total_amount, o.discount_amount, o.payable_amount, o.status, o.paid_at, NOW, NOW));

  // 支付记录
  console.log('[Seed] 创建支付记录...');
  const payments = [
    { id: 'pay_001', order_id: 'order_001', order_no: orders[0].order_no, user_id: 'wx_parent_001', amount: 3200, channel: 'wechat', transaction_id: `WX${Date.now()}`, status: 'success', paid_at: NOW - 30 * 86400000 },
    { id: 'pay_002', order_id: 'order_002', order_no: orders[1].order_no, user_id: 'wx_parent_002', amount: 1200, channel: 'wechat', transaction_id: `WX${Date.now() + 1}`, status: 'success', paid_at: NOW - 15 * 86400000 },
    { id: 'pay_003', order_id: 'order_003', order_no: orders[2].order_no, user_id: 'wx_parent_005', amount: 11000, channel: 'wechat', transaction_id: `WX${Date.now() + 2}`, status: 'success', paid_at: NOW - 60 * 86400000 },
  ];

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

  // ========= 汇总 =========
  console.log('');
  console.log('╔═══════════════════════════════════════════════════════════════╗');
  console.log('║  🌱 种子数据填充完成！                                         ║');
  console.log('╠═══════════════════════════════════════════════════════════════╣');
  console.log(`║  用户：${users.length} 个（1 管理员 + 3 教师 + 12 家长）`);
  console.log(`║  成员：${students.length} 位`);
  console.log(`║  家长绑定：${bindings.length} 条`);
  console.log(`║  教师：${teachers.length} 位`);
  console.log(`║  场地：${classrooms.length} 间`);
  console.log(`║  活动：${courses.length} 门`);
  console.log(`║  会员卡类型：${cardTypes.length} 种`);
  console.log(`║  会员卡实例：${memberCards.length} 张`);
  console.log(`║  排期：${schedules.length} 节（本周 7 天）`);
  console.log(`║  登记：${enrollments.length} 条`);
  console.log(`║  签到：${attendances.length} 条（今日）`);
  console.log(`║  积分账户：${pointsData.length} 个`);
  console.log(`║  积分流水：${pointLogs.length} 条`);
  console.log(`║  订单：${orders.length} 个`);
  console.log(`║  支付记录：${payments.length} 条`);
  console.log(`║  消息通知：${notifications.length} 条`);
  console.log(`║  扣课记录：${deductionLogs.length} 条`);
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
