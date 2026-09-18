/**
 * 三角色实时冒烟（针对已运行的线上后端 http://localhost:3001）
 * 覆盖：健康检查、管理员/教练/家长三角色登录与各自接口、越权隔离、
 *       以及"家长请假申请 → 管理员审批"真实业务链路（验证 P2-1 approve 主路径）。
 *
 * 运行：node backend/tests/live-smoke-3role.mjs
 * 前置：bash start.sh 已拉起后端（加载新代码）
 */

const B = process.env.API_BASE || 'http://localhost:3001/api';

let pass = 0;
let fail = 0;
const failures = [];
const tokens = {}; // role -> token
const openids = {}; // role -> openid

/**
 * @param {string[]} allow      预期成功、但消息可能非 `code:0` 时的可接受消息
 *                              （如幂等重复提交「已报名该活动」）
 * @param {boolean} expectFail  该用例预期**被拒绝**（越权类）。置 true 时只有
 *                              `code !== 0` 才算通过；若同时给出 `allow`，拒绝消息
 *                              还必须命中该列表。
 *                              旧实现只有 `code === 0 || allow.includes(message)` 一种语义，
 *                              于是「越权」用例在**真的越权成功**时反而记为 PASS —— 假绿。
 */
async function api(name, method, path, body, role, allow = [], expectFail = false) {
  const headers = { 'Content-Type': 'application/json' };
  const token = role ? tokens[role] : undefined;
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (role && openids[role]) headers['x-openid'] = openids[role];
  try {
    const res = await fetch(B + path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({ code: 1, message: '非JSON响应' }));
    const ok = expectFail
      ? json.code !== 0 && (allow.length === 0 || allow.includes(json.message))
      : (json.code === 0 || allow.includes(json.message));
    if (ok) pass++;
    else {
      fail++;
      failures.push(expectFail
        ? `${name}: 预期被拒绝但请求成功（code=${json.code}）`
        : `${name}: ${json.message || res.status}`);
    }
    return json;
  } catch (err) {
    fail++; failures.push(`${name}: 网络错误 ${err.message}`);
    return { code: 1 };
  }
}

async function login(role, phone, password) {
  const res = await api(`${role}登录`, 'POST', '/auth/login', { phone, role, password }, null);
  if (res.code === 0 && res.data?.token) {
    tokens[role] = res.data.token;
    if (res.data.openid) openids[role] = res.data.openid;
  }
  return res;
}

const tomorrow = new Date(Date.now() + 86400000);
const tStr = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`;

console.log('== 健康检查 ==');
await api('健康检查', 'GET', '/health');

console.log('== 管理员角色 ==');
const admin = await login('admin', '13800000001', '123456');
await api('看板', 'GET', '/admin/dashboard', null, 'admin');
await api('成员列表', 'GET', '/students?page=1&pageSize=5', null, 'admin');
await api('排期列表', 'GET', `/schedules?startDate=${tStr}&endDate=${tStr}`, null, 'admin');
await api('教师列表(P2-9 脱敏)', 'GET', '/admin/teachers', null, 'admin');

console.log('== 教练角色 ==');
const coach = await login('coach', '13800000011', '123456');
await api('教练课时统计', 'GET', '/schedules/coach/stats', null, 'coach');
await api('教练排期', 'GET', '/schedules/coach', null, 'coach');

console.log('== 家长角色 ==');
const parent = await login('parent', '13900000001', '');
await api('家长-绑定成员', 'GET', '/students/my', null, 'parent');
await api('家长-订单', 'GET', '/orders/my', null, 'parent');
await api('家长-通知', 'GET', '/notifications/list?limit=5', null, 'parent');

console.log('== 越权隔离 ==');
// 越权用例必须声明 expectFail=true：旧写法只要求「code===0 或消息命中白名单」，
// 于是家长/教练**真的拿到管理看板数据**时反而被记为 PASS（假绿）。
await api('家长访问管理看板(应拒绝)', 'GET', '/admin/dashboard', null, 'parent', ['仅管理员可访问管理接口'], true);
await api('教练访问管理看板(应拒绝)', 'GET', '/admin/dashboard', null, 'coach', ['仅管理员可访问管理接口'], true);

console.log('== 请假业务链路（P2-1 approve 主路径）==');
let sid = null, lid = null;
const course = (await api('课程列表', 'GET', '/admin/courses', null, 'admin')).data?.list?.[0];
const teacher = (await api('教师列表', 'GET', '/admin/teachers', null, 'admin')).data?.list?.[0];
if (course && teacher) {
  const created = await api('创建测试排课', 'POST', '/schedules', {
    courseId: course.id, teacherId: teacher.id, classroomId: '',
    date: tStr, startTime: '19:00', endTime: '20:00', maxStudents: 12, remark: '三角色冒烟',
  }, 'admin');
  sid = created.data?.id;
}
if (sid) {
  await api('家长报名', 'POST', `/schedules/${sid}/enroll`, {}, 'parent', ['已报名该活动']);
  const apply = await api('家长提交请假', 'POST', '/leave/apply', { scheduleId: sid, reason: '冒烟请假' }, 'parent', ['该活动已有请假申请，请勿重复提交']);
  const leaves = await api('管理员查待审请假', 'GET', '/leave?status=pending', null, 'admin');
  lid = leaves.data?.list?.find(l => l.schedule_id === sid)?.id || leaves.data?.list?.[0]?.id;
  if (lid) {
    const ap = await api('管理员批准请假', 'PUT', `/leave/${lid}/approve`, { action: 'approve', note: '冒烟通过' }, 'admin');
    // 校验：审批后该排期下存在 leave 考勤记录（P2-1 状态机）
    // GET /schedules/:id 的考勤以 students[].checkin_status 形式返回（无 attendances 字段）
    const att = await api('查询考勤', 'GET', `/schedules/${sid}`, null, 'admin');
    const students = Array.isArray(att.data?.students) ? att.data.students : [];
    const hasLeave = students.some(s => s.checkin_status === 'leave');
    if (hasLeave) pass++; else { fail++; failures.push('P2-1 审批后未生成 leave 考勤'); }
    await api('家长查请假记录', 'GET', '/leave/my', null, 'parent');
  } else {
    fail++; failures.push('P2-1 未取到待审请假 ID');
  }
  // 清理测试排课
  await api('清理测试排课', 'DELETE', `/schedules/${sid}`, null, 'admin');
}

const ok = fail === 0;
console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
if (failures.length) { console.log('失败明细:'); failures.forEach(f => console.log('  -', f)); }
process.exit(ok ? 0 : 1);
