/**
 * 设置路由 — 机构信息、积分规则、推送规则、退费规则
 * GET /api/settings          — 获取全部设置（JSON 字符串解析为对象）
 * PUT /api/settings          — 批量保存设置
 */
const express = require('express');
const router = express.Router();
const db = require('../db');
const path = require('path');
const fs = require('fs');
const os = require('os');
const Database = require('better-sqlite3');
const bodyParser = require('body-parser');
const { success, fail, safeFail, getOpenId, getActor, recordAudit, now, isAdminReq, isStaffReq } = require('../utils');
const { getBackupConfig, createBackup, listBackups, deleteBackup, BACKUP_DIR } = require('../utils/backup');
const { getModulesMeta, exportData, importData, FORBIDDEN_TABLES } = require('../utils/dataio');
const termsUtil = require('../utils/terms');
// 推送规则默认值取自 utils/reminders.js —— 与定时任务实际发送时使用的兜底文案是同一份，
// 避免「设置页显示一套、实际发送另一套」的配置欺骗。
const { DEFAULT_NOTIFICATION_RULES } = require('../utils/reminders');

// 公开端点：返回机构当前称呼方案与解析后的术语表（无任何敏感信息，供管理端/家长端/微信通知共用）
// 置于 router.use 守卫之前，确保无需鉴权也可访问（机构术语纯展示用）。
// 同时作为顶层 /api/terms 暴露（见 server.js），小程序端直接 GET /api/terms。
function termsHandler(req, res) {
  try {
    const { scheme, overrides, terms } = termsUtil.getTerms(db);
    const concepts = termsUtil.CONCEPTS.map((c) => ({
      key: c.key,
      label: c.label,
      preset: (termsUtil.SCHEMES[scheme] && termsUtil.SCHEMES[scheme].terms[c.key]) || '',
      override: overrides[c.key] || '',
      value: terms[c.key] || '',
    }));
    res.json(success({
      scheme,
      terms,
      concepts,
      schemes: Object.values(termsUtil.SCHEMES).map((s) => ({ key: s.key, name: s.name, desc: s.desc })),
    }));
  } catch (err) {
    console.error('[settings terms]', err && err.stack ? err.stack : err);
    res.status(500).json(safeFail('获取称呼方案失败'));
  }
}
router.get('/terms', termsHandler);

// 读取：根路径 /api/settings 公开（机构名称、规则展示等，登录页与启动需要）；
// 其余 GET 子路由（导出/备份/数据模块等）仍需员工身份。写入：仅管理员。
router.use((req, res, next) => {
  if (req.method === 'GET') {
    // 根路径设置公开读取，无需鉴权（机构级配置，无敏感信息）
    if (req.path === '/') return next();
    if (req.userRole === 'admin' || req.userRole === 'coach' || req.userRole === 'sales') return next();
    const openid = getOpenId(req);
    if (openid) {
      const u = db.prepare('SELECT role FROM users WHERE openid = ?').get(openid);
      if (u && (u.role === 'admin' || u.role === 'coach' || u.role === 'sales')) return next();
    }
    return res.status(403).json({ code: 403, data: null, message: '无权访问设置' });
  }
  if (req.userRole === 'admin') return next();
  const openid = getOpenId(req);
  if (openid) {
    const u = db.prepare('SELECT role FROM users WHERE openid = ?').get(openid);
    if (u && u.role === 'admin') return next();
  }
  return res.status(403).json({ code: 403, data: null, message: '仅管理员可修改设置' });
});

const KEYS = ['org_info', 'points_rules', 'notification_rules', 'refund_rules', 'leave_rules', 'uniform_price', 'service_phone', 'students_columns', 'orders_columns', 'term_scheme', 'term_overrides', 'churn_rules'];

// 推送规则规范默认值（DEFAULT_NOTIFICATION_RULES）已上移至 utils/reminders.js：
// 存储为空/畸形时兜底返回，保证设置页可读可配、定时任务有默认档位，且两处共用同一份。

// 积分规则规范默认值：存储为空/畸形时兜底返回，保证设置页可读可配、积分规则展示有默认档位
const DEFAULT_POINTS_RULES = [
  { name: '训练签到', enabled: true, points: 10, description: '参与活动训练由管理端/教练端点名签到，每次+10分' },
  { name: '分享训练', enabled: true, points: 20, description: '分享训练至微信好友/群，每周1次+20分' },
  { name: '购买产品送积分', enabled: true, points: 120, description: '管理端销售登记收款时自动发放：体验10/月卡20/季卡50/年卡120' },
];

// 退费规则默认值：未配置时兜底，保证退款预览有合理规则
const DEFAULT_REFUND_RULES = {
  beforeStart: 'full',
  beforeStartPercent: 10,
  afterStart: 'unused',
  afterStartPercent: 20,
  needApproval: true,
  processDays: 7,
};

/**
 * GET /api/settings
 * 非员工（未登录、或家长 token）只返回公开展示子集：
 * 称呼方案 + 机构展示信息（名称/Logo/客服电话）。
 * 积分/退费/请假/推送规则、表格列配置属经营数据，仅员工（管理员/教练/销售）可见。
 */
router.get('/', (req, res) => {
  try {
    const isPublicReq = !isStaffReq(req);
    const rows = db.prepare('SELECT key, value FROM settings').all();
    const raw = {};
    rows.forEach((r) => { raw[r.key] = r.value; });

    const result = {};
    for (const key of KEYS) {
      const val = raw[key];
      if (val === undefined || val === null) {
        result[key] = null;
      } else if (key === 'service_phone' || key === 'uniform_price') {
        // 纯字符串配置（客服电话/球服价格）：保持字符串原样，避免 JSON.parse 把数字字符串转成数字
        result[key] = val;
      } else {
        try {
          result[key] = JSON.parse(val);
        } catch (e) {
          result[key] = val;
        }
      }
      // 推送规则：空数组/非数组时返回规范默认值，避免设置页空白、定时任务无档位
      if (key === 'notification_rules') {
        const rules = Array.isArray(result[key]) ? result[key] : [];
        result[key] = rules.length > 0 ? rules : DEFAULT_NOTIFICATION_RULES;
      }
      // 积分规则：空数组/非数组时返回规范默认值，避免设置页空白
      if (key === 'points_rules') {
        const rules = Array.isArray(result[key]) ? result[key] : [];
        result[key] = rules.length > 0 ? rules : DEFAULT_POINTS_RULES;
      }
      if (key === 'refund_rules') {
        result[key] = result[key] && typeof result[key] === 'object' ? { ...DEFAULT_REFUND_RULES, ...result[key] } : DEFAULT_REFUND_RULES;
      }
      // 称呼方案：缺失时回退默认教培版；自定义覆盖缺失时回退空对象
      if (key === 'term_scheme') {
        result[key] = (result[key] && typeof result[key] === 'string' && (result[key] === 'edu' || result[key] === 'fitness')) ? result[key] : 'edu';
      }
      if (key === 'term_overrides') {
        result[key] = (result[key] && typeof result[key] === 'object') ? result[key] : {};
      }
    }
    if (isPublicReq) {
      // 未登录只回公开展示子集，其余键（规则/列配置）置 null 不泄露
      const org = result.org_info && typeof result.org_info === 'object' ? result.org_info : {};
      return res.json(success({
        org_info: { name: org.name || '', logo: org.logo || '' },
        service_phone: result.service_phone || '',
        term_scheme: result.term_scheme,
        term_overrides: result.term_overrides,
      }));
    }
    res.json(success(result));
  } catch (err) {
    console.error('[settings get]', err && err.stack ? err.stack : err);
    res.status(500).json(safeFail('获取设置失败'));
  }
});

/**
 * PUT /api/settings — 批量保存
 * Body: { org_info: {...}, points_rules: [...], ... }
 */
router.put('/', (req, res) => {
  try {
    const body = req.body || {};
    const currentTime = now();
    const upsert = db.prepare(`
      INSERT INTO settings (key, label, value, description, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `);

    const labels = {
      org_info: '机构信息',
      points_rules: '积分规则',
      notification_rules: '推送规则',
      refund_rules: '退费规则',
      uniform_price: '球服价格',
      service_phone: '客服电话',
      students_columns: '成员表格字段',
      orders_columns: '销售表格字段',
      term_scheme: '称呼方案',
      term_overrides: '称呼自定义',
      churn_rules: '流失与召回规则',
    };

    for (const key of KEYS) {
      if (body[key] !== undefined) {
        const value = typeof body[key] === 'string' ? body[key] : JSON.stringify(body[key]);
        upsert.run(key, labels[key] || key, value, '', currentTime);
      }
    }
    res.json(success({ saved: true }));
  } catch (err) {
    console.error('[settings save]', err && err.stack ? err.stack : err);
    res.status(500).json(safeFail('保存设置失败'));
  }
});

/**
 * GET /api/settings/data-modules — 列出可导入/导出的数据模块（仅管理员）
 */
router.get('/data-modules', (req, res) => {
  try {
    if (!isAdminReq(req)) return res.status(403).json({ code: 403, data: null, message: '仅管理员可操作' });
    res.json(success({ modules: getModulesMeta() }));
  } catch (err) {
    console.error('[data-modules]', err && err.stack ? err.stack : err);
    res.status(500).json(safeFail('获取模块列表失败'));
  }
});

/**
 * GET /api/settings/export — 导出数据为 JSON
 * Query: modules=students,orders（可选，缺省导出全部）
 * 返回 application/json 并带 Content-Disposition 触发下载（仅管理员）
 */
router.get('/export', (req, res) => {
  try {
    if (!isAdminReq(req)) return res.status(403).json({ code: 403, data: null, message: '仅管理员可操作' });
    const from = req.query.from ? Number(req.query.from) : null;
    const to = req.query.to ? Number(req.query.to) : null;
    const payload = exportData(req.query.modules, { dateFrom: from, dateTo: to });
    const json = JSON.stringify(payload);
    const ts = new Date();
    const stamp = `${ts.getFullYear()}${String(ts.getMonth() + 1).padStart(2, '0')}${String(ts.getDate()).padStart(2, '0')}-${String(ts.getHours()).padStart(2, '0')}${String(ts.getMinutes()).padStart(2, '0')}`;
    const filename = `edu-data-${stamp}.json`;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(json);
  } catch (err) {
    console.error('[export]', err && err.stack ? err.stack : err);
    res.status(500).json(safeFail('导出失败'));
  }
});

// 大体积请求体解析器只挂在 /import 路由上（位于本路由守卫与全局 JWT 鉴权之后），
// 避免未认证客户端用 100mb 请求体拖垮进程（T5，原挂在 server.js 鉴权之前）。
const importJson = bodyParser.json({ limit: '100mb' });

/**
 * POST /api/settings/import — 导入数据（JSON）
 * Body: 导出文件内容 { meta, data }
 * Query: modules=a,b（可选，限制导入模块）；replace=true（可选，先清空所选模块再写入）
 * 仅管理员
 *
 * 受保护表（users / settings）由 utils/dataio 的 FORBIDDEN_TABLES 拦截，不会写入；
 * 被跳过的表会在返回的 errors 中说明。导入动作记入审计日志。
 */
router.post('/import', importJson, (req, res) => {
  try {
    if (!isAdminReq(req)) return res.status(403).json({ code: 403, data: null, message: '仅管理员可操作' });
    const body = req.body;
    const modules = req.query.modules
      ? String(req.query.modules).split(',').map((s) => s.trim()).filter(Boolean)
      : null;
    const replace = req.query.replace === 'true' || req.query.replace === '1';
    const result = importData(body, { modules, replace });
    // 导入属批量改写业务数据的高危操作，必须留痕（谁、何时、导了哪些模块、是否覆盖模式、跳过了什么）
    const actor = getActor(req);
    recordAudit(db, {
      entity: 'data_import',
      entityId: (result.meta && Array.isArray(result.meta.modules) ? result.meta.modules.join(',') : ''),
      action: 'import',
      actorId: actor.id,
      actorRole: actor.role,
      after: { modules: result.meta && result.meta.modules, replace, errors: result.errors },
    });
    res.json(success(result));
  } catch (err) {
    console.error('[import]', err && err.stack ? err.stack : err);
    // 详细错误只进日志：err.message 可能携带 SQLite 原生报错（表结构/文件路径）
    res.status(400).json(safeFail('导入失败，请查看服务端日志'));
  }
});

/**
 * POST /api/settings/db-restore — 从 .db 备份文件恢复整库（仅管理员）
 *
 * 通过 ATTACH 把上传的 SQLite 文件挂载为 src，将其中数据复制进当前数据库，
 * 服务无需重启、无需手动替换文件。恢复前自动备份当前库，便于回滚。
 * 注意：头像等上传文件在 backend/uploads/，不在 .db 内，需另行拷贝。
 */
const rawUpload = bodyParser.raw({ type: 'application/octet-stream', limit: '300mb' });

router.post('/db-restore', rawUpload, async (req, res) => {
  try {
    if (!isAdminReq(req)) return res.status(403).json({ code: 403, data: null, message: '仅管理员可操作' });
    const buf = req.body;
    if (!Buffer.isBuffer(buf) || buf.length === 0) {
      return res.status(400).json(fail('未收到有效的备份文件'));
    }
    // 1) 校验 SQLite 文件头
    if (buf.slice(0, 15).toString('latin1') !== 'SQLite format 3') {
      return res.status(400).json(fail('文件不是有效的 SQLite 数据库（.db）文件'));
    }
    const tmp = path.join(os.tmpdir(), `edu-restore-${Date.now()}.db`);
    fs.writeFileSync(tmp, buf);
    // 2) 试打开以确认文件未损坏
    try {
      const probe = new Database(tmp, { readonly: true, fileMustExist: true });
      probe.close();
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch (_) {}
      return res.status(400).json(fail('备份文件已损坏或无法打开'));
    }
    // 3) 恢复前自动备份当前库（安全网）
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const safetyName = `restore-backup-${ts}.db`;
    try {
      await db.backup(path.join(BACKUP_DIR, safetyName));
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch (_) {} /* 清理临时文件，避免泄漏 */
      return res.status(500).json(safeFail('恢复前自动备份失败：' + e.message));
    }
    // 4) ATTACH 源库并复制数据（FK 关闭，事务包裹）
    const esc = tmp.replace(/'/g, "''");
    let summary = {};
    try {
      db.pragma('foreign_keys = OFF');
      db.exec(`ATTACH DATABASE '${esc}' AS src`);
      const copy = db.transaction(() => {
        const srcTables = db.prepare(
          "SELECT name FROM src.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
        ).all().map((r) => r.name);
        const result = {};
        // 受保护表：禁止通过还原覆盖鉴权与系统配置，防止重置管理员 / 植入后门。
        // 集合与 JSON 导入（/settings/import）共用同一份定义（utils/dataio 的 FORBIDDEN_TABLES），
        // 避免两个入口的保护范围再次分叉。
        for (const t of srcTables) {
          if (t.startsWith('sqlite_') || FORBIDDEN_TABLES.has(t)) {
            result[t] = 'skip(受保护表，禁止恢复)';
            continue;
          }
          const exists = db.prepare(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?"
          ).get(t);
          if (!exists) { result[t] = 'skip(目标库无此表)'; continue; }
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(t)) { result[t] = 'skip(非法表名)'; continue; }
          db.prepare(`DELETE FROM "${t}"`).run();
          db.prepare(`INSERT INTO "${t}" SELECT * FROM src."${t}"`).run();
          result[t] = db.prepare(`SELECT COUNT(*) c FROM "${t}"`).get().c;
        }
        return result;
      });
      // better-sqlite3：`.immediate` 本身就是「以 immediate 模式执行该事务」的入口，
      // 不是返回新事务函数的工厂 —— 故先构造事务再调用 copy.immediate()（T4）。
      summary = copy.immediate();
      db.exec('DETACH DATABASE src');
      db.pragma('foreign_keys = ON');
    } catch (e) {
      console.error('[db-restore copy]', e && e.stack ? e.stack : e);
      try { db.exec('DETACH DATABASE src'); } catch (_) {}
      db.pragma('foreign_keys = ON');
      try { fs.unlinkSync(tmp); } catch (_) {}
      return res.status(500).json(safeFail('恢复过程中出错，已中止'));
    }
    try { fs.unlinkSync(tmp); } catch (_) {}
    res.json(success({ summary, safetyBackup: safetyName }));
  } catch (err) {
    console.error('[db-restore]', err && err.stack ? err.stack : err);
    // 详细错误只进日志：err.message 可能携带文件路径/SQL 细节
    res.status(500).json(safeFail('恢复失败，请查看服务端日志'));
  }
});

/**
 * GET /api/settings/backups — 列出数据库备份（仅管理员）
 */
router.get('/backups', (req, res) => {
  try {
    if (!isAdminReq(req)) return res.status(403).json({ code: 403, data: null, message: '仅管理员可管理备份' });
    const config = getBackupConfig();
    const list = listBackups();
    res.json(success({ list, config, backupDir: path.basename(BACKUP_DIR) }));
  } catch (err) {
    console.error('[backups list]', err && err.stack ? err.stack : err);
    res.status(500).json(safeFail('获取备份列表失败'));
  }
});

/**
 * POST /api/settings/backups/create — 立即创建备份（仅管理员）
 */
router.post('/backups/create', async (req, res) => {
  try {
    if (!isAdminReq(req)) return res.status(403).json({ code: 403, data: null, message: '仅管理员可创建备份' });
    // createBackup 是 async：必须 await，否则拿到的是 Promise，
    // result.success 恒为 undefined，接口会永远返回「备份失败」（含校验结果也拿不到）
    const result = await createBackup();
    if (result.success) {
      res.json(success(result));
    } else {
      res.json(fail(result.error || '备份失败'));
    }
  } catch (err) {
    console.error('[backup create]', err && err.stack ? err.stack : err);
    res.status(500).json(safeFail('创建备份失败'));
  }
});

/**
 * DELETE /api/settings/backups/:filename — 删除指定备份（仅管理员）
 */
router.delete('/backups/:filename', (req, res) => {
  try {
    if (!isAdminReq(req)) return res.status(403).json({ code: 403, data: null, message: '仅管理员可删除备份' });
    const result = deleteBackup(req.params.filename);
    res.json(success({ deleted: true, filename: req.params.filename }));
  } catch (err) {
    console.error('[backup delete]', err && err.stack ? err.stack : err);
    res.json(fail('删除失败，请查看服务端日志'));
  }
});

module.exports = { router, termsHandler };
