/**
 * 成员基础字段值域 —— 建档 / 编辑 / 批量导入 / 线索转化建档 **四条路径同一判据**。
 *
 * 为什么单独成文件：这些校验原先内联在 routes/students.js，而线索转化的建档旁路
 * （routes/growth.js 的 convert）拿不到，于是「正门拦住、旁路放行」——
 * 实测 60 字姓名与 gender='hacker' 可从 convert 直接入库。
 *
 * 需要新规则时只改这里，不要在任何调用方另写一份。
 */
const GENDER_VALUES = ['', '男', '女'];
const NAME_MAX = 50;

/** 合法返回 ''，否则返回可直接展示的错误文案 */
function validateStudentBasics(nameVal, genderVal) {
  // P1-13：姓名必须是字符串。此前直接 String(name||'')，传对象/数组会静默入库为
  // 「[object Object]」「1,2」这类脏值，学员列表与导出全部被污染且无从追溯。
  if (typeof nameVal !== 'string') return '成员姓名格式不正确';
  const name = nameVal.trim();
  if (!name) return '成员姓名不能为空';
  if (name.length > NAME_MAX) return `成员姓名不能超过 ${NAME_MAX} 个字`;
  // 性别允许留空（历史数据大量为空，强制必填会阻断导入/线索转化），
  // 但只要填了就必须是枚举值。文案与实现保持一致，避免「说要填男/女、实际允许空」的矛盾。
  if (!GENDER_VALUES.includes(genderVal === undefined || genderVal === null ? '' : String(genderVal))) {
    return '性别只能填「男」或「女」，也可留空';
  }
  return '';
}

module.exports = { GENDER_VALUES, NAME_MAX, validateStudentBasics };
