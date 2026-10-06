/**
 * 数据体检与一次性清理（存量脏数据治理）
 *
 * 背景：此前若干缺陷只防住了「新增」，但真实库已积累的脏数据仍在（审计报告 2026-10-06）：
 *   · 无绑定的孤儿家长账号（建档/导入凭手机号自动建账号，删除学员却未清理）
 *   · 时效卡种 valid_days<=0 → 一旦售出即「买来即过期」（P1-1 的存量面）
 *   · 0 元 / 重名卡种、教练表混入非教练账号
 *
 * 设计原则：**能自动修的只有「无歧义」的两类**，其余仅报告，交由运营决策。
 *   · 孤儿家长账号：确定无任何绑定 → 可安全删除（仅 phone_ 前缀，绝不碰 wx_）
 *   · 非法卡种：下架（is_active=0）而非删除 —— 已售出的卡仍需可追溯
 * 0 元 / 重名卡种、教练表混入销售：涉及定价与人事语义，只报告不自动改。
 */
const db = require('../db');
const { now, recordAudit } = require('../utils');

// 报告里「孤儿家长账号」的判定：parent 角色 + 手机号自动建号（phone_ 前缀）+ 无任何绑定
const ORPHAN_PARENT_WHERE = `
  u.role = 'parent' AND u.openid LIKE 'phone_%'
  AND NOT EXISTS (SELECT 1 FROM parent_bindings pb WHERE pb.parent_openid = u.openid)
`;

/** 扫描存量脏数据（只读，不修改任何数据） */
function scanDirtyData() {
  const orphanParents = db.prepare(`
    SELECT u.id, u.openid, u.nickname, u.phone, u.created_at FROM users u
    WHERE ${ORPHAN_PARENT_WHERE}
    ORDER BY u.created_at DESC
  `).all();

  const invalidCardTypes = db.prepare(`
    SELECT id, name, billing_mode, valid_days, total_classes, price, is_active FROM membership_cards
    WHERE (billing_mode = 'time' AND (valid_days IS NULL OR valid_days <= 0))
       OR (billing_mode = 'count' AND (total_classes IS NULL OR total_classes <= 0))
    ORDER BY name
  `).all();

  const zeroPriceCardTypes = db.prepare(`
    SELECT id, name, price, is_active FROM membership_cards
    WHERE (price IS NULL OR price <= 0) AND is_active = 1
      AND (product_type IS NULL OR product_type = 'membership')
    ORDER BY name
  `).all();

  const duplicateCardNames = db.prepare(`
    SELECT name, COUNT(*) AS c FROM membership_cards GROUP BY name HAVING c > 1 ORDER BY c DESC, name
  `).all();

  // 教练表混入非教练账号：teachers 按手机号关联 users，角色不是 coach 即为混入
  const salesInTeachers = db.prepare(`
    SELECT t.id, t.name, t.phone, u.role, u.openid FROM teachers t
    JOIN users u ON u.phone = t.phone
    WHERE u.role <> 'coach'
    ORDER BY t.name
  `).all();

  const cap = (arr) => ({ count: arr.length, samples: arr.slice(0, 20) });
  return {
    orphanParents: cap(orphanParents),
    invalidCardTypes: cap(invalidCardTypes),
    zeroPriceCardTypes: cap(zeroPriceCardTypes),
    duplicateCardNames: cap(duplicateCardNames),
    salesInTeachers: cap(salesInTeachers),
  };
}

/**
 * 执行安全清理。actions 为白名单子集：
 *   · 'orphan_parents'    → 删除无绑定的手机号家长账号
 *   · 'invalid_card_types'→ 将非法卡种下架（is_active=0，不删除，保留可追溯）
 * @returns {{ orphanParents:number, invalidCardTypes:number }}
 */
function applyCleanup(actions, req) {
  const list = Array.isArray(actions) ? actions : [];
  const out = { orphanParents: 0, invalidCardTypes: 0 };

  db.transaction(() => {
    if (list.includes('orphan_parents')) {
      // 采集 → 删除：先取 id 快照，避免与「无绑定」判据在同一事务内互相影响
      const rows = db.prepare(`SELECT u.id FROM users u WHERE ${ORPHAN_PARENT_WHERE}`).all();
      const del = db.prepare('DELETE FROM users WHERE id = ? AND role = \'parent\'');
      for (const r of rows) del.run(r.id);
      out.orphanParents = rows.length;
    }
    if (list.includes('invalid_card_types')) {
      const rows = db.prepare(`
        SELECT id FROM membership_cards
        WHERE is_active = 1 AND (
          (billing_mode = 'time' AND (valid_days IS NULL OR valid_days <= 0))
          OR (billing_mode = 'count' AND (total_classes IS NULL OR total_classes <= 0)))
      `).all();
      // membership_cards 无 updated_at 列（仅 created_at），故只改 is_active
      const upd = db.prepare('UPDATE membership_cards SET is_active = 0 WHERE id = ?');
      for (const r of rows) upd.run(r.id);
      out.invalidCardTypes = rows.length;
    }
  })();

  // 数据治理属敏感操作，留痕以便追溯「谁在什么时候清理了什么」
  if (req && (out.orphanParents || out.invalidCardTypes)) {
    const actor = require('../utils').getActor(req);
    recordAudit(db, {
      entity: 'data_cleanup',
      entityId: '',
      action: 'cleanup',
      actorId: actor.id,
      actorRole: actor.role,
      after: out,
    });
  }
  return out;
}

module.exports = { scanDirtyData, applyCleanup };
