import path from 'node:path';
/**
 * 薪资计算验证：规则引擎单元测试 + 薪资 API 集成测试
 * 前置：后端运行在 localhost:3001
 * 用法：node tools/payroll-test.mjs
 */
import { createRequire } from 'module';
const __ROOT = (() => {
  const p = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  return p;
})();
const req = createRequire(`${__ROOT}/backend/package.json`);
const { calcLessonPay, normalizeRule, ruleSummary, calcText, TYPES } = req('../backend/utils/payroll.js');

const base = 'http://localhost:3001/api';
const results = [];
const ok = (name, cond, extra = '') => {
  results.push(`${cond ? '✓' : '✗'} ${name}${extra ? ' | ' + extra : ''}`);
};

// ==================== 规则引擎单元测试 ====================
function unitTests() {
  const r1 = normalizeRule({ type: 'fixed', baseRate: 80 });
  ok('fixed：5 人 = 80 元', calcLessonPay(r1, 5) === 80, `got ${calcLessonPay(r1, 5)}`);
  ok('fixed：15 人 = 80 元（未达阶梯）', calcLessonPay(r1, 15) === 80);

  const r2 = normalizeRule({ type: 'fixed', baseRate: 80, tiers: [{ minStudents: 16, rate: 120 }] });
  ok('fixed+阶梯：15 人 = 80 元', calcLessonPay(r2, 15) === 80);
  ok('fixed+阶梯：16 人 = 120 元', calcLessonPay(r2, 16) === 120);
  ok('fixed+阶梯：30 人 = 120 元', calcLessonPay(r2, 30) === 120);
  ok('fixed+阶梯 规则摘要含档位', ruleSummary(r2).includes('120 元/节'));
  ok('fixed+阶梯 说明（16人）', calcText(r2, 16).includes('120 元/节'));

  const r3 = normalizeRule({ type: 'per_head', perHeadRate: 5 });
  ok('per_head：12 人 = 60 元', calcLessonPay(r3, 12) === 60);
  ok('per_head：0 人 = 0 元', calcLessonPay(r3, 0) === 0);
  // 断言改为包含匹配：ruleSummary 会追加口径注记（请假人头是否计入、consume_classes 是否乘），
  // 全等断言会与产品意图冲突（「口径必须写清楚」正是本次修复目标）。
  ok('per_head 摘要', ruleSummary(r3).includes('5 元/人'));
  ok('per_head 说明', calcText(r3, 12) === '5 元/人 × 12 人');

  const r4 = normalizeRule({ type: 'hybrid', baseRate: 60, freeHeadCount: 6, extraPerHead: 5 });
  ok('hybrid：6 人 = 60 元', calcLessonPay(r4, 6) === 60);
  ok('hybrid：5 人 = 60 元', calcLessonPay(r4, 5) === 60);
  ok('hybrid：10 人 = 80 元', calcLessonPay(r4, 10) === 80);
  ok('hybrid：20 人 = 130 元', calcLessonPay(r4, 20) === 130);
  ok('hybrid 摘要含规则', ruleSummary(r4).includes('60 元/节'));
  ok('hybrid 说明（10人）', calcText(r4, 10).includes('(10 - 6) × 5'));

  const bad = normalizeRule({ type: 'hourly', baseRate: -5, perHeadRate: -1, freeHeadCount: -3, tiers: [{ minStudents: 'x', rate: 10 }] });
  ok('非法类型回退 fixed', bad.type === 'fixed');
  ok('负数归零', bad.baseRate === 0 && bad.perHeadRate === 0 && bad.freeHeadCount === 0);
  ok('非法档位被过滤', bad.tiers.length === 0);
  ok('TYPES 定义完整', TYPES.length === 3);
}

// ==================== API 集成测试 ====================
async function apiTests() {
  let openid = '';
  const login = await fetch(base + '/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phone: '13800000001', role: 'admin', password: '123456', nickname: '管理员' }),
  }).then((r) => r.json());
  if (login.code !== 0) throw new Error('管理员登录失败: ' + JSON.stringify(login));
  openid = login.data.openid;
  // 后端已不信任 x-openid 头（身份只认 JWT），改用 Authorization 携带 token
  const H = { 'content-type': 'application/json', Authorization: 'Bearer ' + login.data.token };

  const now = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  const j = async (path, opts = {}) => {
    const res = await fetch(base + path, { ...opts, headers: { ...H, ...(opts.headers || {}) } });
    return { status: res.status, body: await res.json() };
  };

  // 1. 管理员获取当月薪资结算
  const coaches = await j(`/payroll/coaches?month=${month}`);
  ok('GET /payroll/coaches 返回 200', coaches.status === 200);
  ok('GET /payroll/coaches code=0', coaches.body.code === 0, JSON.stringify(coaches.body).slice(0, 120));
  const list = coaches.body.data.list || [];
  ok('教练列表非空', list.length > 0);
  if (list.length) {
    ok('每行含规则摘要', list.every((c) => typeof c.ruleSummary === 'string'));
    ok('每行含应发金额', list.every((c) => typeof c.amount === 'number'));
    const total = list.reduce((s, c) => s + c.amount, 0);
    ok('应发合计为数字', Number.isFinite(total));
  }

  // 2. 非法月份
  const badMonth = await j('/payroll/coaches?month=2026-13');
  ok('非法月份被拒绝', badMonth.body.code !== 0);

  // 3. 未登录访问 403
  const anon = await fetch(base + '/payroll/coaches?month=' + month).then((r) => r.json());
  ok('未登录访问薪资被拒绝', anon.code === 403 || anon.code !== 0);

  // 4. 保存规则（三种模式）并验证读取回显
  const teacher = list[0];
  const teachersRes = await j('/admin/teachers?includeInactive=1');
  const teacherRow = (teachersRes.body.data.list || []).find((t) => t.id === teacher.teacherId) || {};
  const originalRule = teacherRow.payRule || null;

  const fixed = await j(`/payroll/coach/${teacher.teacherId}/rule`, {
    method: 'PUT',
    body: JSON.stringify({ payRule: { type: 'fixed', baseRate: 80, tiers: [{ minStudents: 16, rate: 120 }] } }),
  });
  ok('保存 fixed 阶梯规则', fixed.body.code === 0 && fixed.body.data.summary.includes('120 元/节'));

  const perHead = await j(`/payroll/coach/${teacher.teacherId}/rule`, {
    method: 'PUT',
    body: JSON.stringify({ payRule: { type: 'per_head', perHeadRate: 6 } }),
  });
  // 断言改为包含匹配：ruleSummary 会追加口径注记（请假人头是否计入、consume_classes 是否乘），
  // 全等断言会与产品意图冲突（「口径必须写清楚」正是本次修复目标）。
  ok('保存 per_head 规则', perHead.body.code === 0 && perHead.body.data.summary.includes('6 元/人'));

  const hybrid = await j(`/payroll/coach/${teacher.teacherId}/rule`, {
    method: 'PUT',
    body: JSON.stringify({ payRule: { type: 'hybrid', baseRate: 60, freeHeadCount: 6, extraPerHead: 5 } }),
  });
  ok('保存 hybrid 规则', hybrid.body.code === 0 && hybrid.body.data.summary.includes('60 元/节'));

  // 5. 明细：金额 = 引擎计算，且合计 = 各节之和
  const detail = await j(`/payroll/coach/${teacher.teacherId}?month=${month}`);
  ok('GET 明细 code=0', detail.body.code === 0, JSON.stringify(detail.body).slice(0, 120));
  const d = detail.body.data;
  if (d && Array.isArray(d.rows)) {
    ok('明细含计算说明', d.rows.every((r) => typeof r.calcText === 'string' && r.calcText.length > 0));
    ok('明细含每节金额', d.rows.every((r) => Number.isFinite(r.lessonAmount)));
    const sum = d.rows.reduce((s, r) => s + r.lessonAmount, 0);
    ok('合计 = 各节之和', d.totals.amount === sum, `${d.totals.amount} vs ${sum}`);
    const expect = d.rows.map((r) => calcLessonPay({ type: 'hybrid', baseRate: 60, freeHeadCount: 6, extraPerHead: 5 }, r.attended));
    ok('每节金额与引擎一致', d.rows.every((r, i) => r.lessonAmount === expect[i]));
  }

  // 6. 恢复原始规则
  const restore = await j(`/payroll/coach/${teacher.teacherId}/rule`, {
    method: 'PUT',
    body: JSON.stringify({ payRule: originalRule || { type: 'fixed', baseRate: 0 } }),
  });
  ok('恢复原始规则', restore.body.code === 0);
}

unitTests();
try {
  await apiTests();
} catch (e) {
  results.push('✗ API 测试异常: ' + String(e).slice(0, 300));
}

const failed = results.filter((r) => r.startsWith('✗')).length;
console.log('========================================');
console.log('  薪资计算验证');
console.log('========================================');
for (const r of results) console.log(r);
console.log('----------------------------------------');
console.log(failed ? `结果：${results.length - failed}/${results.length} 通过` : `结果：${results.length}/${results.length} 全部通过 ✅`);
process.exit(failed ? 1 : 0);
