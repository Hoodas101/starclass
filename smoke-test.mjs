/**
 * 端到端冒烟测试
 * 运行方式：node smoke-test.mjs（需先启动后端 http://localhost:3001）
 * 覆盖：健康检查、管理员/家长登录、数据看板、报名、请假申请与审批、
 *       考勤记录、通知接收、产品同步、越权拦截
 */

const B = process.env.API_BASE || 'http://localhost:3001/api';

let pass = 0;
let fail = 0;
const failures = [];
let bearerToken = ''; // 登录后写入，用于生产环境 Bearer 认证
const tokensByOpenid = {}; // openid → token，按用户身份精确认证

/**
 * 发起一次请求并记录断言结果。
 *
 * @param {string[]} allow      预期成功、但消息可能非 `code:0` 时的可接受消息
 *                              （如幂等重复提交「已报名该活动」）
 * @param {boolean} expectFail  该用例预期**被拒绝**（越权/校验类）。
 *                              置 true 时只有 `code !== 0` 才算通过；若同时给出
 *                              `allow`，则拒绝消息还必须命中该列表。
 *                              旧实现在两种语义下都用 `code===0 || allow.includes(message)`，
 *                              于是越权用例在**真的越权成功**时反而记为 PASS —— 假绿。
 */
async function api(name, method, path, body, openid, allow = [], expectFail = false) {
  const headers = { 'Content-Type': 'application/json' };
  const token = openid ? (tokensByOpenid[openid] || bearerToken) : bearerToken;
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (openid) headers['x-openid'] = openid;
  try {
    const res = await fetch(B + path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json();
    const ok = expectFail
      ? json.code !== 0 && (allow.length === 0 || allow.includes(json.message))
      : (json.code === 0 || allow.includes(json.message));
    if (ok) {
      pass++;
    } else {
      fail++;
      failures.push(expectFail
        ? `${name}: 预期被拒绝但请求成功（code=${json.code}）`
        : `${name}: ${json.message || res.status}`);
    }
    return json;
  } catch (err) {
    fail++;
    failures.push(`${name}: 网络错误 ${err.message}`);
    return { code: 1 };
  }
}

// 登录重试（限流时短暂等待后重试）
async function login(phone, role) {
  let res = { code: 1 }; // 循环外声明：三次全失败时下方 return res 曾因 const 块作用域抛 ReferenceError
  for (let i = 0; i < 3; i++) {
    res = await api(`${role}登录`, 'POST', '/auth/login', {
      phone,
      role,
      password: role === 'parent' ? '' : '123456'
    });
    if (res.code === 0 && res.data?.token) {
      bearerToken = res.data.token;
      if (res.data.openid) tokensByOpenid[res.data.openid] = res.data.token;
    }
    if (res.code === 0 || res.data?.openid) return res;
    if (i < 2) await new Promise((r) => setTimeout(r, 1500 * (i + 1))); // 末次失败无需再等
  }
  return res;
}

const today = new Date();
const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

console.log('== 健康检查 ==');
await api('健康检查', 'GET', '/health');

console.log('== 管理员流程 ==');
const admin = await login('13800000001', 'admin');
const aOpenid = admin.data?.openid || '';
await api('数据看板', 'GET', '/admin/dashboard', null, aOpenid);
await api('看板图表', 'GET', '/admin/charts', null, aOpenid);
await api('成员列表', 'GET', '/students?page=1&pageSize=5', null, aOpenid);
await api('成员按项目筛选', 'GET', '/students?page=1&pageSize=5&project=' + encodeURIComponent('月卡'), null, aOpenid);
await api('订单列表', 'GET', '/orders?page=1&pageSize=5', null, aOpenid);
await api('排期列表', 'GET', `/schedules?startDate=${todayStr}&endDate=${todayStr}`, null, aOpenid);
await api('产品类型', 'GET', '/membership/card-types', null, aOpenid);
await api('系统设置', 'GET', '/settings', null, aOpenid);
await api('请假列表', 'GET', '/leave?pageSize=10', null, aOpenid);
await api('家长通讯录', 'GET', '/admin/parents', null, aOpenid);
await api('反馈列表', 'GET', '/feedback?pageSize=10', null, aOpenid);

console.log('== 家长流程 ==');
const parent = await login('13900000001', 'parent');
const pOpenid = parent.data?.openid || '';
await api('家长-绑定成员', 'GET', '/students/my', null, pOpenid);
await api('家长-首页数据', 'GET', '/students/home/data', null, pOpenid);
await api('家长-产品服务', 'GET', '/membership/products', null, pOpenid);
await api('家长-积分', 'GET', '/points/balance', null, pOpenid);
await api('家长-订单', 'GET', '/orders/my', null, pOpenid);
await api('家长-通知', 'GET', '/notifications/list?limit=5', null, pOpenid);
await api('家长-我的反馈', 'GET', '/feedback/my', null, pOpenid);

// 自建明日活动用于报名/请假链路（不依赖 seed 固定日期，避免与其他测试残留冲突）
const tomorrow = new Date(Date.now() + 86400000);
const tomorrowStr = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`;
const smokeCourse = (await api('课程列表', 'GET', '/admin/courses', null, aOpenid)).data?.list?.[0];
const smokeTeacher = (await api('教师列表', 'GET', '/admin/teachers', null, aOpenid)).data?.list?.[0];
const created = smokeCourse
  ? await api('创建测试排课', 'POST', '/schedules', {
      courseId: smokeCourse.id,
      teacherId: smokeTeacher?.id || '',
      classroomId: '',
      date: tomorrowStr,
      startTime: '19:00',
      endTime: '20:00',
      maxStudents: 12,
      remark: '冒烟测试'
    }, aOpenid)
  : { code: 1 };
const sid = created.data?.id;
if (sid) {
  await api('家长报名', 'POST', `/schedules/${sid}/enroll`, {}, pOpenid, ['已报名该活动']);
  await api('报名状态详情', 'GET', `/schedules/${sid}`, null, pOpenid);
}

// 请假申请与审批
if (sid) {
  await api('家长提交请假', 'POST', '/leave/apply', { scheduleId: sid, reason: '冒烟测试请假' }, pOpenid, ['该活动已有请假申请，请勿重复提交']);
  const leaves = await api('管理员查看请假', 'GET', '/leave?status=pending', null, aOpenid);
  const lid = leaves.data?.list?.[0]?.id;
  if (lid) {
    await api('管理员批准请假', 'PUT', `/leave/${lid}/approve`, { action: 'approve', note: '冒烟测试通过' }, aOpenid);
    await api('家长请假记录', 'GET', '/leave/my', null, pOpenid);
    await api('家长审批通知', 'GET', '/notifications/list?limit=2', null, pOpenid);
  }
}

console.log('== 权限隔离 ==');
// expectFail=true：本例断言的是「家长访问管理接口必须被拒绝」。
// 传入的 allow 列表此时语义为「可接受的拒绝消息」，必须精确命中，
// 避免「换了别的错误也算过」。
await api('家长访问管理接口(应拒绝)', 'GET', '/admin/dashboard', null, pOpenid, ['仅管理员可访问管理接口'], true);

console.log('== 家长沟通与反馈 ==');
const parents = await api('获取家长列表', 'GET', '/admin/parents', null, aOpenid);
const firstParent = parents.data?.list?.[0];
if (firstParent?.parent_openid) {
  await api('发送个人通知', 'POST', '/messages/send', {
    userId: firstParent.parent_openid,
    title: '冒烟测试通知',
    content: '家长沟通链路验证',
  }, aOpenid);
}
await api('家长提交反馈', 'POST', '/feedback/apply', {
  content: '冒烟测试反馈',
  contact: '',
}, pOpenid);
const fb = await api('管理员查看反馈', 'GET', '/feedback?status=pending', null, aOpenid);
const fbId = fb.data?.list?.[0]?.id;
if (fbId) {
  await api('管理员标记反馈已处理', 'PUT', `/feedback/${fbId}/status`, { status: 'done' }, aOpenid);
}
await api('家长反馈状态', 'GET', '/feedback/my', null, pOpenid);

// 清理自建排课
if (sid) {
  await api('清理测试排课', 'DELETE', `/schedules/${sid}`, null, aOpenid);
}

const ok = fail === 0;
console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
if (failures.length) {
  console.log('失败明细:');
  failures.forEach((f) => console.log('  -', f));
}
process.exit(ok ? 0 : 1);
