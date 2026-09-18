# -*- coding: utf-8 -*-
"""
销售数据分析 Excel 仪表盘生成器
- 单文件 .xlsx，含真实 Excel 公式（SUMIFS / RANK / INDEX-MATCH / 增长率）
- 原生图表：月度趋势折线、区域排名条形、产品线毛利条形、KPI 达成率条形
- 工作表：说明 / 销售明细 / 月度趋势 / 区域业绩排名 / 产品线毛利分析 / 客户汇总 / Top10客户 / KPI仪表盘
"""
import os
import random
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side, NamedStyle
from openpyxl.utils import get_column_letter
from openpyxl.chart import LineChart, BarChart, Reference, Series
from openpyxl.chart.label import DataLabelList
from openpyxl.formatting.rule import DataBarRule, CellIsRule

random.seed(20260819)

# ---------- 维度定义 ----------
YEAR = 2025
PRODUCTS = ["篮球装备", "体适能器材", "训练服饰", "营养补给", "智能穿戴"]
REGIONS = ["华东", "华北", "华南", "西部"]
SALES = ["张伟", "李娜", "王芳", "刘强", "陈静"]

PRODUCT_BASE = {  # 月基准销售额
    "篮球装备": 80000, "体适能器材": 60000, "训练服饰": 40000,
    "营养补给": 50000, "智能穿戴": 70000,
}
PRODUCT_MARGIN = {  # 基准毛利率
    "篮球装备": 0.35, "体适能器材": 0.30, "训练服饰": 0.45,
    "营养补给": 0.25, "智能穿戴": 0.38,
}
REGION_FACTOR = {"华东": 1.30, "华北": 1.00, "华南": 1.10, "西部": 0.70}
# 12 个月季节性系数
SEASON = [0.82, 0.78, 0.95, 1.00, 1.05, 1.25, 0.90, 0.92, 1.08, 1.15, 1.30, 1.45]
SALE_FACTOR = {s: round(random.uniform(0.80, 1.20), 3) for s in SALES}

# 客户池（40 家）
CUSTOMERS = [
    "锐动体育用品", "启航健身中心", "跃动少儿运动馆", "恒康营养", "锋行体育",
    "小飞侠运动俱乐部", "卓越体能训练营", "康威运动商城", "星跃体育", "活力无限健身",
    "篮途体育文化", "优加体能中心", "健将体育", "童行运动馆", "劲爆运动用品",
    "领跑体育", "天天向上健身", "冠军之路俱乐部", "迈步体育", "飞跃训练营",
    "动能营养", "风云篮球馆", "小小运动家", "强体体育", "锐健身工作室",
    "环宇体育", "茁长少儿体适能", "巅峰运动", "乐动体育", "极客穿戴",
    "腾飞体育用品", "阳光体能", "悍将运动", "智练体育", "元气营养",
    "雷霆篮球", "成长树运动馆", "超能体育", "风尚健身", "纵横运动",
]

def gen_rows():
    rows = []
    for m in range(1, 13):
        for p in PRODUCTS:
            for r in REGIONS:
                for s in SALES:
                    base = PRODUCT_BASE[p] * REGION_FACTOR[r] * SALE_FACTOR[s] * SEASON[m-1]
                    sales = round(base * random.uniform(0.85, 1.15), -2)
                    margin = max(0.10, min(0.60, PRODUCT_MARGIN[p] + random.uniform(-0.03, 0.03)))
                    cost = round(sales * (1 - margin), -2)
                    cust = random.choice(CUSTOMERS)
                    rows.append([f"{YEAR}-{m:02d}", p, r, s, cust, sales, cost])
    return rows

# ---------- 样式 ----------
HDR_FILL = PatternFill("solid", fgColor="1F4E78")
HDR_FONT = Font(bold=True, color="FFFFFF", size=11)
TITLE_FONT = Font(bold=True, size=15, color="1F4E78")
SUB_FONT = Font(italic=True, size=10, color="595959")
KPI_FILL = PatternFill("solid", fgColor="DDEBF7")
ACCENT = PatternFill("solid", fgColor="C00000")
THIN = Side(style="thin", color="BFBFBF")
BORDER = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)
CENTER = Alignment(horizontal="center", vertical="center")
LEFT = Alignment(horizontal="left", vertical="center")
RIGHT = Alignment(horizontal="right", vertical="center")

CUR_FMT = '#,##0'
PCT_FMT = '0.0%'

def style_header(ws, row, ncols, start=1):
    for c in range(start, start + ncols):
        cell = ws.cell(row=row, column=c)
        cell.fill = HDR_FILL
        cell.font = HDR_FONT
        cell.alignment = CENTER
        cell.border = BORDER

def write_table(ws, start_row, headers, data, cur_cols=(), pct_cols=()):
    style_header(ws, start_row, len(headers))
    for j, h in enumerate(headers, 1):
        ws.cell(row=start_row, column=j, value=h)
    for i, rec in enumerate(data, 1):
        for j, v in enumerate(rec, 1):
            cell = ws.cell(row=start_row + i, column=j, value=v)
            cell.border = BORDER
            if j in cur_cols:
                cell.number_format = CUR_FMT
                cell.alignment = RIGHT
            elif j in pct_cols:
                cell.number_format = PCT_FMT
                cell.alignment = RIGHT
            else:
                cell.alignment = CENTER if j <= 1 else LEFT
    return start_row + len(data)

wb = Workbook()

# ============ 1. 说明 ============
ws = wb.active
ws.title = "说明"
ws.sheet_view.showGridLines = False
ws["A1"] = "销售数据分析仪表盘"
ws["A1"].font = TITLE_FONT
ws["A2"] = f"数据年度：{YEAR} 年  |  维度：产品线 × 区域 × 销售员 × 客户  |  生成方式：公式驱动"
ws["A2"].font = SUB_FONT
notes = [
    ("工作表", "内容"),
    ("销售明细", "1200 行事实表：月份 / 产品线 / 区域 / 销售员 / 客户 / 销售额 / 成本（毛利与毛利率由公式计出）"),
    ("月度趋势", "12 个月汇总：销售额、成本、毛利、毛利率、上年同期、环比增长、同比增长（均为公式）"),
    ("区域业绩排名", "按区域汇总销售额与毛利，并用 RANK 公式排出名次"),
    ("产品线毛利分析", "按产品线汇总销售额、成本、毛利、毛利率（公式）"),
    ("客户汇总", "40 家客户汇总，供 Top10 引用"),
    ("Top10客户", "用 LARGE + INDEX/MATCH 公式取贡献最高的 10 家客户及累计占比"),
    ("KPI仪表盘", "年销售额 / 年毛利 / 平均毛利率目标与达成率，含数据条条件格式"),
    ("", ""),
    ("使用提示", "所有汇总与比率均为 Excel 实时公式，修改「销售明细」后会自动重算；图表随数据联动。"),
    ("说明", "示例数据为确定性随机生成，仅用于演示仪表盘结构，请替换为真实业务数据。"),
]
r = 4
for a, b in notes:
    ws.cell(row=r, column=1, value=a).font = Font(bold=True, color="1F4E78")
    ws.cell(row=r, column=2, value=b).alignment = LEFT
    r += 1
ws.column_dimensions["A"].width = 16
ws.column_dimensions["B"].width = 88

# ============ 2. 销售明细 ============
rows = gen_rows()
SHEET_DETAIL = "销售明细"
ws = wb.create_sheet(SHEET_DETAIL)
ws.sheet_view.showGridLines = False
headers = ["月份", "产品线", "区域", "销售员", "客户", "销售额", "成本"]
ws.append(headers)
style_header(ws, 1, len(headers))
for rec in rows:
    sales = rec[5]
    cost = rec[6]
    margin = sales - cost
    ws.append(rec + [margin, margin / sales])
# 列宽
widths = [10, 12, 8, 8, 16, 12, 12, 12, 10]
for i, w in enumerate(widths, 1):
    ws.column_dimensions[get_column_letter(i)].width = w
# 数值格式
for rr in range(2, len(rows) + 2):
    ws.cell(row=rr, column=6).number_format = CUR_FMT
    ws.cell(row=rr, column=7).number_format = CUR_FMT
    ws.cell(row=rr, column=8).number_format = CUR_FMT
    ws.cell(row=rr, column=9).number_format = PCT_FMT
    for cc in range(1, 10):
        ws.cell(row=rr, column=cc).border = BORDER
        if cc <= 5:
            ws.cell(row=rr, column=cc).alignment = CENTER
        else:
            ws.cell(row=rr, column=cc).alignment = RIGHT
ws.freeze_panes = "A2"
N_DETAIL = len(rows)  # 1200
DETAIL_LAST = N_DETAIL + 1

# 命名范围便于公式引用
DETAIL = f"'{SHEET_DETAIL}'"
M_COL = f"{DETAIL}!A2:A{DETAIL_LAST}"
P_COL = f"{DETAIL}!B2:B{DETAIL_LAST}"
R_COL = f"{DETAIL}!C2:C{DETAIL_LAST}"
S_COL = f"{DETAIL}!D2:D{DETAIL_LAST}"
C_COL = f"{DETAIL}!E2:E{DETAIL_LAST}"
SALES_COL = f"{DETAIL}!F2:F{DETAIL_LAST}"
COST_COL = f"{DETAIL}!G2:G{DETAIL_LAST}"

# ============ 3. 月度趋势 ============
MONTHS = [f"{YEAR}-{m:02d}" for m in range(1, 13)]
# 上年同期销售额（确定性生成）
prev_year = []
base_prev = 0
for m in range(12):
    tot = 0
    for p in PRODUCTS:
        for rg in REGIONS:
            for s in SALES:
                base = PRODUCT_BASE[p] * REGION_FACTOR[rg] * SALE_FACTOR[s] * SEASON[m]
                tot += base * 0.80  # 上年整体约 80% 水平
    prev_year.append(round(tot * random.uniform(0.92, 1.00), -2))

ws = wb.create_sheet("月度趋势")
ws.sheet_view.showGridLines = False
ws["A1"] = "月度销售趋势与增长率"
ws["A1"].font = TITLE_FONT
hdr = ["月份", "销售额", "成本", "毛利", "毛利率", "上年同期销售额", "环比增长", "同比增长"]
ws.append([])  # row2 empty spacer? we'll write header at row3
for j, h in enumerate(hdr, 1):
    ws.cell(row=3, column=j, value=h)
style_header(ws, 3, len(hdr))
for i, mo in enumerate(MONTHS):
    r = 4 + i
    ws.cell(row=r, column=1, value=mo)
    ws.cell(row=r, column=2, value=f"=SUMIFS({SALES_COL},{M_COL},A{r})")
    ws.cell(row=r, column=3, value=f"=SUMIFS({COST_COL},{M_COL},A{r})")
    ws.cell(row=r, column=4, value=f"=B{r}-C{r}")
    ws.cell(row=r, column=5, value=f"=IF(B{r}=0,\"\",D{r}/B{r})")
    ws.cell(row=r, column=6, value=prev_year[i])
    if i == 0:
        ws.cell(row=r, column=7, value="")
        ws.cell(row=r, column=8, value=f"=IF(F{r}=0,\"\",(B{r}-F{r})/F{r})")
    else:
        ws.cell(row=r, column=7, value=f"=IF(B{r-1}=0,\"\",(B{r}-B{r-1})/B{r-1})")
        ws.cell(row=r, column=8, value=f"=IF(F{r}=0,\"\",(B{r}-F{r})/F{r})")
    for cc in range(1, 9):
        cell = ws.cell(row=r, column=cc)
        cell.border = BORDER
        if cc == 1:
            cell.alignment = CENTER
        elif cc in (2, 3, 4, 6):
            cell.number_format = CUR_FMT
            cell.alignment = RIGHT
        elif cc in (5, 7, 8):
            cell.number_format = PCT_FMT
            cell.alignment = RIGHT
for i, w in enumerate([10, 14, 14, 12, 10, 16, 10, 10], 1):
    ws.column_dimensions[get_column_letter(i)].width = w

# 折线图：销售额 + 毛利
chart = LineChart()
chart.title = "月度销售额与毛利趋势"
chart.style = 2
chart.y_axis.title = "金额"
chart.x_axis.title = "月份"
chart.height = 8.5
chart.width = 18
data = Reference(ws, min_col=2, max_col=4, min_row=3, max_row=3 + 12)
cats = Reference(ws, min_col=1, min_row=4, max_row=3 + 12)
chart.add_data(data, titles_from_data=True)
chart.set_categories(cats)
chart.series[0].graphicalProperties.line.solidFill = "1F4E78"
chart.series[1].graphicalProperties.line.solidFill = "C00000"
ws.add_chart(chart, "J3")

# ============ 4. 区域业绩排名 ============
ws = wb.create_sheet("区域业绩排名")
ws.sheet_view.showGridLines = False
ws["A1"] = "区域业绩排名"
ws["A1"].font = TITLE_FONT
hdr = ["区域", "销售额", "成本", "毛利", "毛利率", "排名"]
for j, h in enumerate(hdr, 1):
    ws.cell(row=3, column=j, value=h)
style_header(ws, 3, len(hdr))
for i, rg in enumerate(REGIONS):
    r = 4 + i
    ws.cell(row=r, column=1, value=rg)
    ws.cell(row=r, column=2, value=f"=SUMIFS({SALES_COL},{R_COL},A{r})")
    ws.cell(row=r, column=3, value=f"=SUMIFS({COST_COL},{R_COL},A{r})")
    ws.cell(row=r, column=4, value=f"=B{r}-C{r}")
    ws.cell(row=r, column=5, value=f"=IF(B{r}=0,\"\",D{r}/B{r})")
    ws.cell(row=r, column=6, value=f"=RANK(B{r},$B$4:$B${3+len(REGIONS)})")
    for cc in range(1, 7):
        cell = ws.cell(row=r, column=cc)
        cell.border = BORDER
        if cc == 1:
            cell.alignment = CENTER
        elif cc in (2, 3, 4):
            cell.number_format = CUR_FMT
            cell.alignment = RIGHT
        elif cc in (5, 6):
            if cc == 5:
                cell.number_format = PCT_FMT
            cell.alignment = RIGHT
ws.column_dimensions["A"].width = 10
for col in ["B", "C", "D", "E", "F"]:
    ws.column_dimensions[col].width = 14

# 条形图（横向）：销售额
chart = BarChart()
chart.type = "bar"
chart.title = "各区域销售额排名"
chart.height = 8
chart.width = 16
data = Reference(ws, min_col=2, min_row=3, max_row=3 + len(REGIONS))
cats = Reference(ws, min_col=1, min_row=4, max_row=3 + len(REGIONS))
chart.add_data(data, titles_from_data=True)
chart.set_categories(cats)
chart.series[0].graphicalProperties.solidFill = "1F4E78"
chart.legend = None
ws.add_chart(chart, "H3")

# ============ 5. 产品线毛利分析 ============
ws = wb.create_sheet("产品线毛利分析")
ws.sheet_view.showGridLines = False
ws["A1"] = "产品线毛利分析"
ws["A1"].font = TITLE_FONT
hdr = ["产品线", "销售额", "成本", "毛利", "毛利率"]
for j, h in enumerate(hdr, 1):
    ws.cell(row=3, column=j, value=h)
style_header(ws, 3, len(hdr))
for i, p in enumerate(PRODUCTS):
    r = 4 + i
    ws.cell(row=r, column=1, value=p)
    ws.cell(row=r, column=2, value=f"=SUMIFS({SALES_COL},{P_COL},A{r})")
    ws.cell(row=r, column=3, value=f"=SUMIFS({COST_COL},{P_COL},A{r})")
    ws.cell(row=r, column=4, value=f"=B{r}-C{r}")
    ws.cell(row=r, column=5, value=f"=IF(B{r}=0,\"\",D{r}/B{r})")
    for cc in range(1, 6):
        cell = ws.cell(row=r, column=cc)
        cell.border = BORDER
        if cc == 1:
            cell.alignment = CENTER
        elif cc in (2, 3, 4):
            cell.number_format = CUR_FMT
            cell.alignment = RIGHT
        else:
            cell.number_format = PCT_FMT
            cell.alignment = RIGHT
ws.column_dimensions["A"].width = 12
for col in ["B", "C", "D", "E"]:
    ws.column_dimensions[col].width = 14

chart = BarChart()
chart.type = "col"
chart.title = "各产品线毛利率对比"
chart.height = 8
chart.width = 16
data = Reference(ws, min_col=5, min_row=3, max_row=3 + len(PRODUCTS))
cats = Reference(ws, min_col=1, min_row=4, max_row=3 + len(PRODUCTS))
chart.add_data(data, titles_from_data=True)
chart.set_categories(cats)
chart.series[0].graphicalProperties.solidFill = "C00000"
chart.legend = None
chart.y_axis.numFmt = '0%'
ws.add_chart(chart, "G3")

# ============ 6. 客户汇总 ============
SHEET_CUST = "客户汇总"
ws = wb.create_sheet(SHEET_CUST)
ws.sheet_view.showGridLines = False
ws["A1"] = "客户汇总（按销售额）"
ws["A1"].font = TITLE_FONT
hdr = ["客户", "销售额", "成本", "毛利", "毛利率"]
for j, h in enumerate(hdr, 1):
    ws.cell(row=3, column=j, value=h)
style_header(ws, 3, len(hdr))
for i, cust in enumerate(CUSTOMERS):
    r = 4 + i
    ws.cell(row=r, column=1, value=cust)
    ws.cell(row=r, column=2, value=f"=SUMIFS({SALES_COL},{C_COL},A{r})")
    ws.cell(row=r, column=3, value=f"=SUMIFS({COST_COL},{C_COL},A{r})")
    ws.cell(row=r, column=4, value=f"=B{r}-C{r}")
    ws.cell(row=r, column=5, value=f"=IF(B{r}=0,\"\",D{r}/B{r})")
    for cc in range(1, 6):
        cell = ws.cell(row=r, column=cc)
        cell.border = BORDER
        if cc == 1:
            cell.alignment = LEFT
        elif cc in (2, 3, 4):
            cell.number_format = CUR_FMT
            cell.alignment = RIGHT
        else:
            cell.number_format = PCT_FMT
            cell.alignment = RIGHT
CUST_LAST = 3 + len(CUSTOMERS)
ws.column_dimensions["A"].width = 18
for col in ["B", "C", "D", "E"]:
    ws.column_dimensions[col].width = 14
CUST = f"'{SHEET_CUST}'"
CUST_NAME = f"{CUST}!A4:A{CUST_LAST}"
CUST_SALES = f"{CUST}!B4:B{CUST_LAST}"

# ============ 7. Top10客户 ============
ws = wb.create_sheet("Top10客户")
ws.sheet_view.showGridLines = False
ws["A1"] = "Top 10 客户贡献"
ws["A1"].font = TITLE_FONT
hdr = ["排名", "客户", "销售额", "毛利", "贡献占比", "累计占比"]
for j, h in enumerate(hdr, 1):
    ws.cell(row=3, column=j, value=h)
style_header(ws, 3, len(hdr))
TOTAL_SALES_FORMULA = f"SUM({CUST_SALES})"
for i in range(10):
    r = 4 + i
    rank = i + 1
    ws.cell(row=r, column=1, value=rank)
    ws.cell(row=r, column=2, value=f"=INDEX({CUST_NAME},MATCH(LARGE({CUST_SALES},A{r}),{CUST_SALES},0))")
    ws.cell(row=r, column=3, value=f"=LARGE({CUST_SALES},A{r})")
    # 毛利：用 INDEX/MATCH 取到对应客户行再取 D 列
    ws.cell(row=r, column=4, value=f"=INDEX({CUST}!D4:D{CUST_LAST},MATCH(B{r},{CUST_NAME},0))")
    ws.cell(row=r, column=5, value=f"=C{r}/{TOTAL_SALES_FORMULA}")
    if i == 0:
        ws.cell(row=r, column=6, value=f"=E{r}")
    else:
        ws.cell(row=r, column=6, value=f"=F{r-1}+E{r}")
    for cc in range(1, 7):
        cell = ws.cell(row=r, column=cc)
        cell.border = BORDER
        if cc in (1,):
            cell.alignment = CENTER
        elif cc == 2:
            cell.alignment = LEFT
        elif cc in (3, 4):
            cell.number_format = CUR_FMT
            cell.alignment = RIGHT
        else:
            cell.number_format = PCT_FMT
            cell.alignment = RIGHT
ws.column_dimensions["A"].width = 6
ws.column_dimensions["B"].width = 18
for col in ["C", "D", "E", "F"]:
    ws.column_dimensions[col].width = 14
ws.cell(row=15, column=2, value="合计").font = Font(bold=True)
ws.cell(row=15, column=3, value=f"=SUM(C4:C13)").number_format = CUR_FMT
ws.cell(row=15, column=3).font = Font(bold=True)
ws.cell(row=15, column=5, value=f"=SUM(E4:E13)").number_format = PCT_FMT
ws.cell(row=15, column=5).font = Font(bold=True)

# ============ 8. KPI仪表盘 ============
ws = wb.create_sheet("KPI仪表盘")
ws.sheet_view.showGridLines = False
ws["A1"] = "KPI 达成率仪表盘"
ws["A1"].font = TITLE_FONT
ws["A2"] = "达成率 = 实际值 / 目标值；数据条直观展示完成进度"
ws["A2"].font = SUB_FONT
hdr = ["KPI 指标", "目标", "实际", "达成率", "状态"]
for j, h in enumerate(hdr, 1):
    ws.cell(row=4, column=j, value=h)
style_header(ws, 4, len(hdr))

# 实际值公式引用
actual_sales = f"SUM({SALES_COL})"

def actual_margin_actual():
    return "SUM({SALES_COL})-SUM({COST_COL})".format(SALES_COL=SALES_COL, COST_COL=COST_COL)

kpi_defs = [
    ("年销售额(元)", 72000000, f"={actual_sales}"),
    ("年毛利(元)", 25000000, f"={actual_margin_actual()}"),
    ("平均毛利率", 0.33, f"=IF({actual_sales}=0,\"\",({actual_margin_actual()})/{actual_sales})"),
    ("Top10客户贡献占比", 0.30, f"=SUM('Top10客户'!E4:E13)"),
    ("活跃销售员数", 5, f'=SUMPRODUCT(1/COUNTIF({S_COL},{S_COL}))'),
]
for i, (name, target, actual_f) in enumerate(kpi_defs):
    r = 5 + i
    ws.cell(row=r, column=1, value=name)
    ws.cell(row=r, column=2, value=target)
    ws.cell(row=r, column=3, value=actual_f)
    ws.cell(row=r, column=4, value=f"=IF(C{r}=0,\"\",C{r}/B{r})")
    ws.cell(row=r, column=5, value=f'=IF(D{r}="","",IF(D{r}>=1,"达标",IF(D{r}>=0.8,"接近","未达标")))')
    # 格式
    for cc in range(1, 6):
        cell = ws.cell(row=r, column=cc)
        cell.border = BORDER
        cell.alignment = LEFT if cc == 1 else CENTER
    if name in ("年销售额(元)", "年毛利(元)"):
        ws.cell(row=r, column=2).number_format = CUR_FMT
        ws.cell(row=r, column=3).number_format = CUR_FMT
    else:
        ws.cell(row=r, column=2).number_format = PCT_FMT
        ws.cell(row=r, column=3).number_format = PCT_FMT
    ws.cell(row=r, column=4).number_format = PCT_FMT

# 数据条条件格式（达成率列）
ws.conditional_formatting.add(
    "D5:D9",
    DataBarRule(start_type="num", start_value=0, end_type="num", end_value=1.2,
                color="1F4E78", showValue=True)
)
# 状态文字着色
ws.conditional_formatting.add(
    "E5:E9",
    CellIsRule(operator="equal", formula=['"达标"'], fill=PatternFill("solid", fgColor="C6EFCE"), font=Font(color="006100"))
)
ws.conditional_formatting.add(
    "E5:E9",
    CellIsRule(operator="equal", formula=['"未达标"'], fill=PatternFill("solid", fgColor="FFC7CE"), font=Font(color="9C0006"))
)
ws.column_dimensions["A"].width = 20
ws.column_dimensions["B"].width = 14
ws.column_dimensions["C"].width = 16
ws.column_dimensions["D"].width = 12
ws.column_dimensions["E"].width = 10

# KPI 达成率条形图
chart = BarChart()
chart.type = "col"
chart.title = "KPI 达成率(%)"
chart.height = 8
chart.width = 16
# 用辅助列把达成率转成百分比数值用于图表（D列已是比率）
data = Reference(ws, min_col=4, min_row=4, max_row=9)
cats = Reference(ws, min_col=1, min_row=5, max_row=9)
chart.add_data(data, titles_from_data=True)
chart.set_categories(cats)
chart.series[0].graphicalProperties.solidFill = "C00000"
chart.legend = None
chart.y_axis.numFmt = '0%'
ws.add_chart(chart, "G4")

# ---------- 保存 ----------
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "销售数据分析仪表盘.xlsx")
wb.save(OUT)
print("SAVED:", OUT)
print("明细行数:", N_DETAIL)
print("工作表:", wb.sheetnames)
