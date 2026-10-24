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
  if (!nameVal) return '成员姓名不能为空';
  if (nameVal.length > NAME_MAX) return `成员姓名不能超过 ${NAME_MAX} 个字`;
  if (!GENDER_VALUES.includes(genderVal)) return '性别只能填「男」或「女」';
  return '';
}

module.exports = { GENDER_VALUES, NAME_MAX, validateStudentBasics };
