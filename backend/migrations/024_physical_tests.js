/**
 * 迁移 024：体测记录表 + 课程教案字段
 *
 * 背景（业务适配审计 P1-1 / P1-2，全量实测审计 P1-D4 / P1-D5）：
 *   · 全库无体测模块（grep physical_test 零命中）。学员只有单值 height/weight/bmi，
 *     没有历史、没有趋势 —— 而「看得见的训练进步」正是儿童体育培训的核心卖点，
 *     家长为效果续费、教练靠体测对比建立专业信任，这些数据目前只能留在系统外。
 *   · courses 的内容字段只有 description，教案/训练内容无处挂载；同时 min_age /
 *     max_age 虽在库中，但课程表单未暴露，无法按 3-5 / 6-8 / 9-12 / 13-15 分层建班。
 *
 * 处理（刻意保持轻量，避免过度设计 —— 审计报告亦如此建议）：
 *   1. 新建 physical_tests 表：一次体测一行。身高/体重/BMI + 三个最常用的体适能
 *      指标（纵跳 / 坐位体前屈 / 折返跑），外加一个自由备注。指标列可空 ——
 *      不同年龄段测的项目不同，强制填满会逼出假数据。
 *   2. courses 补 training_plan 文本列：存放教案要点或教案文件链接。
 *      不做富文本编辑器，先做到「课程—年龄段—教案」三者关联即可。
 *
 * 指标单位（写入侧与展示侧必须一致，避免「同一个字段两种单位」）：
 *   · height_cm        厘米
 *   · weight_kg        千克
 *   · bmi              kg/m²（可由身高体重推导，允许直接录入）
 *   · jump_cm          立定纵跳，厘米
 *   · sit_reach_cm     坐位体前屈，厘米（负数表示未达脚尖）
 *   · shuttle_run_s    折返跑，秒（越小越好 —— 展示侧需据此反转趋势方向）
 *
 * 幂等性：CREATE TABLE / ALTER 前均有存在性判断，重复执行安全。
 */

function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS physical_tests (
      id             TEXT PRIMARY KEY,
      student_id     TEXT NOT NULL,
      student_name   TEXT,
      test_date      TEXT NOT NULL,
      height_cm      REAL,
      weight_kg      REAL,
      bmi            REAL,
      jump_cm        REAL,
      sit_reach_cm   REAL,
      shuttle_run_s  REAL,
      remark         TEXT DEFAULT '',
      tester         TEXT DEFAULT '',
      created_at     INTEGER,
      updated_at     INTEGER,
      FOREIGN KEY (student_id) REFERENCES students(id)
    );
  `);

  // 学员维度按时间取趋势（学员档案页的体测趋势图）
  db.exec('CREATE INDEX IF NOT EXISTS idx_physical_tests_student_date ON physical_tests(student_id, test_date)');

  const courseCols = db.prepare("SELECT name FROM pragma_table_info('courses')").all().map((c) => c.name);
  if (!courseCols.includes('training_plan')) {
    db.exec("ALTER TABLE courses ADD COLUMN training_plan TEXT DEFAULT ''");
  }
}

module.exports = { up };
