#!/usr/bin/env node
/**
 * 存量脏数据体检 / 一次性清理（CLI）
 *
 * 用法：
 *   node backend/db/cleanup-dirty-data.js            # 仅体检（只读，默认）
 *   node backend/db/cleanup-dirty-data.js --apply    # 执行安全清理
 *
 * 安全清理只覆盖两类「无歧义」脏数据：
 *   · 孤儿家长账号：role='parent' 且 openid LIKE 'phone_%' 且无任何 parent_bindings → 删除
 *   · 非法卡种：时效卡 valid_days<=0 / 次数卡 total_classes<=0 → 下架（is_active=0，不删除）
 * 其余（0 元卡种、重名卡种、教练表混入销售账号）只报告，需运营决策。
 *
 * 建议先备份：sqlite3 backend/db/data.db ".backup 'backup-$(date +%F).db'"
 */
'use strict';

const path = require('path');
// 允许在项目根或 backend/ 下执行：显式指向 backend/db/data.db（可用 DB_PATH 覆盖）
if (!process.env.DB_PATH) {
  process.env.DB_PATH = path.resolve(__dirname, 'data.db');
}

const db = require('../db');
const { scanDirtyData, applyCleanup } = require('../utils/data-health');

const APPLY = process.argv.includes('--apply');

function line(label, bucket) {
  const mark = bucket.count > 0 ? '●' : '○';
  console.log(`  ${mark} ${label}：${bucket.count} 项`);
  (bucket.samples || []).slice(0, 8).forEach((s) => {
    console.log('      -', JSON.stringify(s));
  });
  if (bucket.count > (bucket.samples || []).length) {
    console.log(`      … 其余 ${bucket.count - bucket.samples.length} 项略`);
  }
}

console.log('\n=== 存量脏数据体检 ===');
console.log('数据库：', process.env.DB_PATH);
console.log('\n【需运营决策，仅报告】');
const report = scanDirtyData();
line('0 元卡种（前台列表污染）', report.zeroPriceCardTypes);
line('重名卡种（对账易混）', report.duplicateCardNames);
line('教练表混入非教练账号（排课易误选）', report.salesInTeachers);

console.log('\n【可安全清理】');
line('孤儿家长账号（无绑定，可删除）', report.orphanParents);
line('非法卡种（valid_days/total_classes<=0，可下架）', report.invalidCardTypes);

if (!APPLY) {
  console.log('\n（当前为体检模式，未做任何修改。加 --apply 执行安全清理）\n');
  db.close();
  process.exit(0);
}

const need = [];
if (report.orphanParents.count) need.push('orphan_parents');
if (report.invalidCardTypes.count) need.push('invalid_card_types');
if (!need.length) {
  console.log('\n无需清理：可安全清理项均为 0。\n');
  db.close();
  process.exit(0);
}

const result = applyCleanup(need, null);
console.log('\n=== 清理完成 ===');
console.log(`  孤儿家长账号已删除：${result.orphanParents}`);
console.log(`  非法卡种已下架：${result.invalidCardTypes}`);
console.log('\n复查：');
const after = scanDirtyData();
console.log(`  孤儿家长账号：${after.orphanParents.count}（应为 0）`);
console.log(`  非法卡种（启用中）：${after.invalidCardTypes.samples.filter((c) => c.is_active).length}`);
console.log('');
db.close();
