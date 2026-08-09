# -*- coding: utf-8 -*-
# PoC 路线1：读部件识别 JSON，生成南禅寺大殿正立面简化线划图（DXF）+ PNG 预览
import json, os, sys
import ezdxf
from ezdxf.enums import TextEntityAlignment
from ezdxf.addons.drawing import RenderContext, Frontend
from ezdxf.addons.drawing.matplotlib import MatplotlibBackend
from ezdxf.addons.drawing.config import Configuration, BackgroundPolicy
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

HERE = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(HERE, "部件识别_南禅寺大殿正立面.json"), encoding="utf-8") as f:
    data = json.load(f)
D = data["核心尺寸_mm"]

# 关键坐标（Y 基准：台基顶面 = 0）
BAY_C, BAY_S = D["明间面阔"], D["次间面阔"]
AX = [0, BAY_S, BAY_S + BAY_C, 2 * BAY_S + BAY_C]      # 柱轴 X
W = AX[3]                                               # 通面阔（轴线）
CX = W / 2
COL_H, COL_D, SHENGQI = D["平柱高"], D["柱径"], D["角柱生起"]
PZ_H = D["铺作高"]                                      # 铺作高
JU_H = D["举高_至脊槫"]
Y_LE = COL_H + PZ_H                                     # 撩檐槫中心
Y_JI_HEN = Y_LE + JU_H                                  # 脊槫中心（结构）
Y_RIDGE = D["脊线高_估"]                                # 屋面脊线（含瓦作，估）
EAVE = D["檐出_自柱中"]
Y_EAVE_MID = D["檐口中部高_估"]
UPTURN = D["翼角起翘_估"]
TJ_H, TJ_OUT = D["台基高_估"], D["台基挑出_估"]

doc = ezdxf.new("R2018", setup=True)
doc.styles.add("CN", font="msyh.ttc")
msp = doc.modelspace()

LAYERS = [
    ("01轴线", 1, "CENTER"), ("02台基", 8, "CONTINUOUS"), ("03柱", 5, "CONTINUOUS"),
    ("04额枋", 3, "CONTINUOUS"), ("05铺作", 30, "CONTINUOUS"), ("06屋面", 4, "CONTINUOUS"),
    ("07门窗", 6, "CONTINUOUS"), ("08墙体", 8, "CONTINUOUS"), ("09标注", 3, "CONTINUOUS"),
    ("10文字", 7, "CONTINUOUS"),
]
for name, color, lt in LAYERS:
    doc.layers.add(name, color=color, linetype=lt)

def pl(points, layer, closed=False):
    msp.add_lwpolyline(points, dxfattribs={"layer": layer}, close=closed)

def line(p1, p2, layer):
    msp.add_line(p1, p2, dxfattribs={"layer": layer})

def txt(s, pos, h=280, layer="10文字", align=TextEntityAlignment.MIDDLE_CENTER):
    msp.add_text(s, dxfattribs={"layer": layer, "style": "CN", "height": h}).set_placement(pos, align=align)

# ---- 轴线 ----
for i, x in enumerate(AX):
    line((x, -TJ_H - 600), (x, COL_H + 600), "01轴线")
    msp.add_circle((x, -TJ_H - 900), 220, dxfattribs={"layer": "01轴线"})
    txt(str(i + 1), (x, -TJ_H - 900), 220, "01轴线")

# ---- 台基与踏道 ----
pl([(-TJ_OUT, -TJ_H), (W + TJ_OUT, -TJ_H), (W + TJ_OUT, 0), (-TJ_OUT, 0)], "02台基", closed=True)
line((-TJ_OUT - 2500, -TJ_H), (W + TJ_OUT + 2500, -TJ_H), "02台基")   # 室外地坪线
tw = D["踏道宽_估"] / 2
for k in range(1, 5):                                                  # 五级踏步（示意）
    y = -TJ_H * k / 5
    line((CX - tw, y), (CX + tw, y), "02台基")
line((CX - tw, -TJ_H), (CX - tw, 0), "02台基")
line((CX + tw, -TJ_H), (CX + tw, 0), "02台基")

# ---- 檐柱（角柱含生起）----
for i, x in enumerate(AX):
    h = COL_H + (SHENGQI if i in (0, 3) else 0)
    pl([(x - COL_D / 2, 0), (x - COL_D / 2, h), (x + COL_D / 2, h), (x + COL_D / 2, 0)], "03柱")

# ---- 阑额（无普拍枋）----
pl([(AX[0] + COL_D / 2, COL_H - 350), (AX[3] - COL_D / 2, COL_H - 350),
    (AX[3] - COL_D / 2, COL_H), (AX[0] + COL_D / 2, COL_H)], "04额枋", closed=True)

# ---- 柱头铺作（简化示意：栌斗+泥道栱+散斗+柱头枋）----
def puzuo(x):
    y0 = COL_H
    pl([(x - 275, y0), (x + 275, y0), (x + 190, y0 + 300), (x - 190, y0 + 300)], "05铺作", closed=True)  # 栌斗
    pl([(x - 620, y0 + 300), (x + 620, y0 + 300), (x + 560, y0 + 520), (x - 560, y0 + 520)], "05铺作", closed=True)  # 泥道栱
    for dx in (-500, 0, 500):                                          # 散斗
        pl([(x + dx - 130, y0 + 520), (x + dx + 130, y0 + 520), (x + dx + 100, y0 + 680), (x + dx - 100, y0 + 680)], "05铺作", closed=True)
    pl([(x - 160, y0 + 680), (x + 160, y0 + 680), (x + 160, y0 + 1100), (x - 160, y0 + 1100)], "05铺作", closed=True)  # 耍头（正视）
for x in AX:
    puzuo(x)
line((AX[0] - 620, COL_H + 680), (AX[3] + 620, COL_H + 680), "05铺作")   # 柱头枋
line((AX[0] - 620, COL_H + PZ_H), (AX[3] + 620, COL_H + PZ_H), "05铺作")  # 撩檐槫下皮

# ---- 檐口（含翼角起翘）与屋面 ----
eL, eR = -EAVE, W + EAVE
eave_lo = [(eL, Y_EAVE_MID + UPTURN), (AX[0], Y_EAVE_MID + 90), (CX, Y_EAVE_MID),
           (AX[3], Y_EAVE_MID + 90), (eR, Y_EAVE_MID + UPTURN)]
pl(eave_lo, "06屋面")
pl([(x, y + 160) for x, y in eave_lo], "06屋面")                       # 飞椽上缘
rL, rR = CX - D["正脊长_估"] / 2, CX + D["正脊长_估"] / 2
line((rL, Y_RIDGE), (rR, Y_RIDGE), "06屋面")                            # 正脊
line((rL, Y_RIDGE - 260), (rR, Y_RIDGE - 260), "06屋面")
def chiwei(x, sgn):                                                     # 鸱尾（简化）
    h = D["鸱尾高_估"]
    pl([(x, Y_RIDGE - 260), (x, Y_RIDGE + h), (x - sgn * 220, Y_RIDGE + h - 130),
        (x - sgn * 420, Y_RIDGE + h - 480), (x - sgn * 480, Y_RIDGE - 260)], "06屋面")
chiwei(rL, +1)
chiwei(rR, -1)
line((rL - 480, Y_RIDGE - 260), (eL, Y_EAVE_MID + UPTURN + 160), "06屋面")  # 垂脊（正视投影，简化）
line((rR + 480, Y_RIDGE - 260), (eR, Y_EAVE_MID + UPTURN + 160), "06屋面")

# ---- 明间板门 ----
dw, dh = D["门洞宽_估"], D["门洞高_估"]
x1, x2 = CX - dw / 2, CX + dw / 2
pl([(x1, 0), (x2, 0), (x2, dh), (x1, dh)], "07门窗", closed=True)
pl([(x1 - 130, 0), (x2 + 130, 0), (x2 + 130, dh + 130), (x1 - 130, dh + 130)], "07门窗", closed=True)  # 门框
line((CX, 0), (CX, dh), "07门窗")                                       # 双扇分缝

# ---- 次间直棂窗与槛墙 ----
ww, wh, sill = D["窗宽_估"], D["窗高_估"], D["窗台高_估"]
for cx in (BAY_S / 2, W - BAY_S / 2):
    wx1, wx2 = cx - ww / 2, cx + ww / 2
    pl([(wx1, sill), (wx2, sill), (wx2, sill + wh), (wx1, sill + wh)], "07门窗", closed=True)
    n = 15
    for k in range(1, n):
        x = wx1 + (wx2 - wx1) * k / n
        line((x, sill), (x, sill + wh), "07门窗")
# 槛墙（两次间窗下砖墙）
for a, b in ((AX[0] + COL_D / 2, AX[1] - COL_D / 2), (AX[2] + COL_D / 2, AX[3] - COL_D / 2)):
    pl([(a, 0), (b, 0), (b, sill), (a, sill)], "08墙体", closed=True)

# ---- 尺寸标注 ----
def hdim(p1x, p2x, y, dy=-450):
    msp.add_linear_dim(base=(0, y + dy), p1=(p1x, y), p2=(p2x, y), dimstyle="EZDXF",
                       override={"dimtxt": 300, "dimasz": 180, "dimdec": 0, "dimlfac": 1, "dimtxsty": "CN",
                                 "dimclrd": 3, "dimclre": 3, "dimexo": 120}).render()
def vdim(p1y, p2y, x, dx=700, text=None):
    d = msp.add_linear_dim(base=(x + dx, 0), p1=(x, p1y), p2=(x, p2y), angle=90, dimstyle="EZDXF",
                           override={"dimtxt": 300, "dimasz": 180, "dimdec": 0, "dimlfac": 1, "dimtxsty": "CN",
                                     "dimclrd": 3, "dimclre": 3, "dimexo": 120})
    if text:
        d.dimension.dxf.text = text
    d.render()

for i in range(3):
    hdim(AX[i], AX[i + 1], -TJ_H, -700)
msp.add_linear_dim(base=(0, -TJ_H - 1350), p1=(AX[0], -TJ_H), p2=(AX[3], -TJ_H), dimstyle="EZDXF",
                   override={"dimtxt": 300, "dimasz": 180, "dimdec": 0, "dimlfac": 1, "dimtxsty": "CN"}).render()
XR = W + EAVE + 500
vdim(-TJ_H, 0, XR, 500, "800(估)")
vdim(0, COL_H, XR, 500)
vdim(COL_H, Y_LE, XR, 500)
vdim(Y_LE, Y_JI_HEN, XR, 500)
line((W - 300, Y_JI_HEN), (XR + 300, Y_JI_HEN), "09标注")               # 脊槫中心参考线

# ---- 部件标签 ----
labels = [
    ("正脊", (CX, Y_RIDGE + 350)), ("鸱尾", (rR + 700, Y_RIDGE + 500)),
    ("垂脊", ((rR + eR) / 2 + 300, (Y_RIDGE + Y_EAVE_MID) / 2 + 500)),
    ("飞椽/檐口", (eL + 400, Y_EAVE_MID - 700)),
    ("柱头铺作(五铺作双杪·简化示意)", (CX, COL_H + PZ_H + 350)),
    ("阑额(无普拍枋)", (CX - 3200, COL_H - 170)),
    ("檐柱 D384", (AX[0] - 900, COL_H / 2)), ("直棂窗", (BAY_S / 2, sill + wh + 300)),
    ("板门(双扇)", (CX, dh + 420)), ("槛墙", (W - BAY_S / 2, sill / 2 - 500)),
    ("台基(尺寸估)", (W + TJ_OUT - 1500, -TJ_H / 2)), ("踏道", (CX + 2100, -TJ_H / 2)),
]
for s, pos in labels:
    txt(s, pos)

# ---- 标高符号（等腰直角三角形 + 引出线，数值以米计）----
def biaogao(px, py, val_m, est=False):
    s = 150                                            # 符号半宽（1:50 出图约 3 mm）
    pl([(px - s, py + s), (px, py), (px + s, py + s)], "09标注")
    line((px - s, py + s), (px + s + 900, py + s), "09标注")
    v = "±0.000" if val_m == 0 else f"{val_m:+.3f}"
    txt(v + ("(估)" if est else ""), (px + s + 450, py + s + 200), 250, "09标注")

biaogao(-TJ_OUT - 900, 0, 0.0)                          # 台基顶 ±0.000
biaogao(-TJ_OUT - 900, -TJ_H, -TJ_H / 1000, est=True)   # 室外地坪
biaogao(eL - 600, Y_EAVE_MID + UPTURN + 160, (Y_EAVE_MID + UPTURN + 160) / 1000, est=True)  # 檐口
biaogao(rR + 1200, Y_RIDGE, Y_RIDGE / 1000, est=True)   # 屋脊

# ---- 图名 ----
txt("南禅寺大殿 正立面现状测绘图", (CX, Y_RIDGE + 1300), 560)

# ---- A3 布局：图框 + 图签（规范 5.4.8/5.4.9）+ 1:50 视口 ----
layout = doc.layouts.new("A3立面")
layout.page_setup(size=(420, 297), margins=(0, 0, 0, 0))
doc.layers.add("11图框", color=7)

def ptxt(s, pos, h=2.5, align=TextEntityAlignment.MIDDLE_LEFT):
    layout.add_text(s, dxfattribs={"layer": "11图框", "style": "CN", "height": h}).set_placement(pos, align=align)

layout.add_lwpolyline([(25, 5), (415, 5), (415, 292), (25, 292)], dxfattribs={"layer": "11图框"}, close=True)

# 图签：右下 180×32，三行
TB_X, TB_Y, TB_W, TB_H = 235, 5, 180, 32
layout.add_lwpolyline([(TB_X, TB_Y), (TB_X + TB_W, TB_Y), (TB_X + TB_W, TB_Y + TB_H), (TB_X, TB_Y + TB_H)],
                      dxfattribs={"layer": "11图框"}, close=True)
for r in (1, 2):
    layout.add_line((TB_X, TB_Y + r * TB_H / 3), (TB_X + TB_W, TB_Y + r * TB_H / 3), dxfattribs={"layer": "11图框"})
for c in (60, 120):
    layout.add_line((TB_X + c, TB_Y), (TB_X + c, TB_Y + TB_H), dxfattribs={"layer": "11图框"})
cells = [
    ("测绘单位：Jiajia+AI 工作流", 2, 0), ("项目名称：古建归档 MVP PoC", 2, 1), ("图名：南禅寺大殿正立面现状测绘图", 2, 2),
    ("项目负责：Jiajia", 1, 0), ("测量：文献核验（见 06 报告）", 1, 1), ("绘图：Claude AI · 校对/审核：待签", 1, 2),
    ("图号：测绘 02-01", 0, 0), ("比例 1:50 · 日期 2026-07-05", 0, 1), ("版本 v0.2 · 单位 mm", 0, 2),
]
for s, r, c in cells:
    ptxt(s, (TB_X + c * 60 + 2, TB_Y + r * TB_H / 3 + TB_H / 6), 2.2)
ptxt("说明：标（估）尺寸为照片估算待实测；轴线尺寸取文献核验值（营造尺 300 mm）；照片 CC BY-SA 4.0 Patrick20242023", (TB_X - 208, TB_Y + 3), 2.0)

# 1:50 视口：240 mm 视口高 × 50 = 12000 mm 模型窗口
layout.add_viewport(center=(220, 165), size=(380, 240), view_center_point=(CX, 3450), view_height=12000)

# ---- 输出（命名按规范表 7.2.3：编号_名称_图纸内容）----
dxf_path = os.path.join(HERE, "南禅寺大殿_正立面现状测绘图.dxf")
doc.saveas(dxf_path)

auditor = doc.audit()
print(f"DXF 审计：errors={len(auditor.errors)} fixes={len(auditor.fixes)}")
print(f"模型空间实体数：{len(msp)}")

cfg = Configuration(background_policy=BackgroundPolicy.WHITE)
ctx = RenderContext(doc)
fig = plt.figure(figsize=(16, 10))
ax = fig.add_axes([0, 0, 1, 1])
Frontend(ctx, MatplotlibBackend(ax), config=cfg).draw_layout(msp, finalize=True)
png_path = os.path.join(HERE, "南禅寺大殿_正立面_预览.png")
fig.savefig(png_path, dpi=130)

fig2 = plt.figure(figsize=(16.8, 11.88))
ax2 = fig2.add_axes([0, 0, 1, 1])
Frontend(RenderContext(doc), MatplotlibBackend(ax2), config=cfg).draw_layout(layout, finalize=True)
png2_path = os.path.join(HERE, "南禅寺大殿_A3布局_预览.png")
fig2.savefig(png2_path, dpi=130)
print(f"输出：{dxf_path}")
print(f"预览：{png_path}")
print(f"布局预览：{png2_path}")
