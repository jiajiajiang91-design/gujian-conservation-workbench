# -*- coding: utf-8 -*-
# 盲测样本A：读部件识别 JSON，生成东呈古佛堂正立面简化线划图（DXF）+ PNG 预览
# 基于 生成立面图_南禅寺大殿.py 改写。复用：框架/图层/辅助函数/标注/标高/布局/输出段。
# 改写：立面构成（墙包柱无露明柱、五开间、补间铺作、双下昂示意、歇山+脊刹+吻兽）。
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
with open(os.path.join(HERE, "部件识别_东呈古佛堂正立面.json"), encoding="utf-8") as f:
    data = json.load(f)
D = data["核心尺寸_mm"]

# 关键坐标（Y 基准：台基顶面 = 0）。改写段：五开间轴系
BAY_M, BAY_C, BAY_S = D["明间面阔_估"], D["次间面阔_估"], D["稍间面阔_估"]
AX = [0, BAY_S, BAY_S + BAY_C, BAY_S + BAY_C + BAY_M,
      BAY_S + 2 * BAY_C + BAY_M, 2 * BAY_S + 2 * BAY_C + BAY_M]   # 6 柱轴
W = AX[5]
CX = W / 2
WALL_H = D["檐墙顶高_估"]                    # 檐墙顶 = 大额枋下皮
FANG_H = D["额枋普拍枋高_估"]                # 大额枋+普拍枋带
PZ_Y0 = WALL_H + FANG_H                      # 铺作下皮（普拍枋上皮）
PZ_H = D["铺作高_估"]
Y_LE = PZ_Y0 + PZ_H                          # 撩檐槫
Y_EAVE_MID = D["檐口中部高_估"]
Y_RIDGE = D["脊线高_估"]
SHA_H = D["脊刹高_估"]
EAVE = D["檐出_自墙面_估"]
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

# ---- 轴线（复用，6 根）----
for i, x in enumerate(AX):
    line((x, -TJ_H - 600), (x, WALL_H + 600), "01轴线")
    msp.add_circle((x, -TJ_H - 900), 220, dxfattribs={"layer": "01轴线"})
    txt(str(i + 1), (x, -TJ_H - 900), 220, "01轴线")

# ---- 台基与踏步（改写：两级踏步）----
pl([(-TJ_OUT, -TJ_H), (W + TJ_OUT, -TJ_H), (W + TJ_OUT, 0), (-TJ_OUT, 0)], "02台基", closed=True)
line((-TJ_OUT - 2500, -TJ_H), (W + TJ_OUT + 2500, -TJ_H), "02台基")   # 室外地坪线
tw = D["踏步宽_估"] / 2
line((CX - tw, -TJ_H / 2), (CX + tw, -TJ_H / 2), "02台基")             # 两级踏步分级线
line((CX - tw, -TJ_H), (CX - tw, 0), "02台基")
line((CX + tw, -TJ_H), (CX + tw, 0), "02台基")

# ---- 前檐砖墙（改写：柱身包砌不露明，画通长墙体；柱头位置以短线示意）----
WT = 250                                                               # 墙厚出轴（估）
pl([(-WT, 0), (W + WT, 0), (W + WT, WALL_H), (-WT, WALL_H)], "08墙体", closed=True)
line((-WT, 900), (W + WT, 900), "08墙体")                              # 下碱线（估）
for x in AX:                                                            # 包砌柱头位置示意
    line((x - 180, WALL_H - 400), (x - 180, WALL_H), "03柱")
    line((x + 180, WALL_H - 400), (x + 180, WALL_H), "03柱")

# ---- 大额枋 + 普拍枋（改写：南禅寺无普拍枋，此处两层叠置）----
pl([(-WT, WALL_H), (W + WT, WALL_H), (W + WT, WALL_H + 320), (-WT, WALL_H + 320)], "04额枋", closed=True)   # 大额枋
pl([(-WT - 120, WALL_H + 320), (W + WT + 120, WALL_H + 320),
    (W + WT + 120, PZ_Y0), (-WT - 120, PZ_Y0)], "04额枋", closed=True)  # 普拍枋（端部出头）

# ---- 铺作（改写：双下昂简化示意；柱头+补间均布）----
def puzuo(x, ang=True):
    y0 = PZ_Y0
    pl([(x - 260, y0), (x + 260, y0), (x + 180, y0 + 280), (x - 180, y0 + 280)], "05铺作", closed=True)      # 栌斗
    if ang:                                                             # 双下昂嘴（斜向示意）
        pl([(x - 520, y0 + 280), (x - 300, y0 + 430), (x + 300, y0 + 430), (x + 520, y0 + 280),
            (x + 300, y0 + 560), (x - 300, y0 + 560)], "05铺作", closed=True)
        pl([(x - 620, y0 + 560), (x - 340, y0 + 740), (x + 340, y0 + 740), (x + 620, y0 + 560),
            (x + 340, y0 + 900), (x - 340, y0 + 900)], "05铺作", closed=True)
    pl([(x - 150, y0 + 900), (x + 150, y0 + 900), (x + 150, y0 + PZ_H), (x - 150, y0 + PZ_H)], "05铺作", closed=True)  # 耍头至槫
# 柱头铺作 6 朵（两端为转角铺作）
for x in AX:
    puzuo(x)
# 补间铺作：明间 2、次间稍间各 1（识别 JSON P07）
BUJIAN = [BAY_S / 2, BAY_S + BAY_C / 2,
          AX[2] + BAY_M / 3, AX[2] + 2 * BAY_M / 3,
          AX[3] + BAY_C / 2, AX[4] + BAY_S / 2]
for x in BUJIAN:
    puzuo(x)
line((AX[0] - 620, PZ_Y0 + 900), (AX[5] + 620, PZ_Y0 + 900), "05铺作")   # 柱头枋
line((AX[0] - 620, Y_LE), (AX[5] + 620, Y_LE), "05铺作")                  # 撩檐槫下皮

# ---- 檐口与歇山屋面（改写：歇山 + 雕花脊筒 + 楼阁式脊刹 + 吻兽）----
eL, eR = -WT - EAVE, W + WT + EAVE
eave_lo = [(eL, Y_EAVE_MID + UPTURN), (AX[0], Y_EAVE_MID + 80), (CX, Y_EAVE_MID),
           (AX[5], Y_EAVE_MID + 80), (eR, Y_EAVE_MID + UPTURN)]
pl(eave_lo, "06屋面")
pl([(x, y + 150) for x, y in eave_lo], "06屋面")                        # 飞椽上缘
rL, rR = CX - D["正脊长_估"] / 2, CX + D["正脊长_估"] / 2
pl([(rL, Y_RIDGE - 350), (rR, Y_RIDGE - 350), (rR, Y_RIDGE), (rL, Y_RIDGE)], "06屋面", closed=True)  # 雕花脊筒（示意）
def wenshou(x, sgn):                                                    # 吻兽（尾内卷简化）
    h = D["吻兽高_估"]
    pl([(x, Y_RIDGE - 350), (x, Y_RIDGE + h), (x - sgn * 260, Y_RIDGE + h - 120),
        (x - sgn * 380, Y_RIDGE + h - 420), (x - sgn * 430, Y_RIDGE - 350)], "06屋面")
wenshou(rL, +1)
wenshou(rR, -1)
def jisha(x):                                                           # 楼阁式脊刹（多层塔示意）
    y = Y_RIDGE
    for i, (hw, hh) in enumerate([(420, 380), (330, 340), (240, 300), (150, 260)]):
        pl([(x - hw, y), (x + hw, y), (x + hw * 0.72, y + hh), (x - hw * 0.72, y + hh)], "06屋面", closed=True)
        y += hh
    line((x, y), (x, y + SHA_H - 1280), "06屋面")                       # 刹杆
    msp.add_circle((x, y + SHA_H - 1180), 90, dxfattribs={"layer": "06屋面"})
jisha(CX)
# 垂脊与戗脊（歇山正视投影，简化）
line((rL - 430, Y_RIDGE - 350), (rL - 900, Y_EAVE_MID + UPTURN + 900), "06屋面")
line((rR + 430, Y_RIDGE - 350), (rR + 900, Y_EAVE_MID + UPTURN + 900), "06屋面")
line((rL - 900, Y_EAVE_MID + UPTURN + 900), (eL, Y_EAVE_MID + UPTURN + 150), "06屋面")
line((rR + 900, Y_EAVE_MID + UPTURN + 900), (eR, Y_EAVE_MID + UPTURN + 150), "06屋面")

# ---- 明间板门（改写：石框、门砧、四门簪示意）----
dw, dh = D["门洞宽_估"], D["门洞高_估"]
x1, x2 = CX - dw / 2, CX + dw / 2
pl([(x1, 0), (x2, 0), (x2, dh), (x1, dh)], "07门窗", closed=True)
pl([(x1 - 150, 0), (x2 + 150, 0), (x2 + 150, dh + 150), (x1 - 150, dh + 150)], "07门窗", closed=True)  # 石门框
line((CX, 0), (CX, dh), "07门窗")                                       # 双扇分缝
for k in range(4):                                                      # 门簪 4 枚
    x = x1 + dw * (k + 1) / 5
    pl([(x - 70, dh + 150), (x + 70, dh + 150), (x + 70, dh + 290), (x - 70, dh + 290)], "07门窗", closed=True)

# ---- 直棂窗 4 樘（改写：次间稍间各 1）----
ww, wh, sill = D["窗宽_估"], D["窗高_估"], D["窗台高_估"]
WIN_CX = [BAY_S / 2, BAY_S + BAY_C / 2, AX[3] + BAY_C / 2, AX[4] + BAY_S / 2]
for cx in WIN_CX:
    wx1, wx2 = cx - ww / 2, cx + ww / 2
    pl([(wx1, sill), (wx2, sill), (wx2, sill + wh), (wx1, sill + wh)], "07门窗", closed=True)
    pl([(wx1 - 90, sill - 90), (wx2 + 90, sill - 90), (wx2 + 90, sill + wh + 90), (wx1 - 90, sill + wh + 90)], "07门窗", closed=True)
    n = 11
    for k in range(1, n):
        x = wx1 + (wx2 - wx1) * k / n
        line((x, sill), (x, sill + wh), "07门窗")

# ---- 尺寸标注（复用；全部数值带（估）后缀）----
def hdim(p1x, p2x, y, dy=-450, text=None):
    d = msp.add_linear_dim(base=(0, y + dy), p1=(p1x, y), p2=(p2x, y), dimstyle="EZDXF",
                           override={"dimtxt": 300, "dimasz": 180, "dimdec": 0, "dimlfac": 1, "dimtxsty": "CN",
                                     "dimclrd": 3, "dimclre": 3, "dimexo": 120})
    if text:
        d.dimension.dxf.text = text
    d.render()
def vdim(p1y, p2y, x, dx=700, text=None):
    d = msp.add_linear_dim(base=(x + dx, 0), p1=(x, p1y), p2=(x, p2y), angle=90, dimstyle="EZDXF",
                           override={"dimtxt": 300, "dimasz": 180, "dimdec": 0, "dimlfac": 1, "dimtxsty": "CN",
                                     "dimclrd": 3, "dimclre": 3, "dimexo": 120})
    if text:
        d.dimension.dxf.text = text
    d.render()

BAYS = [BAY_S, BAY_C, BAY_M, BAY_C, BAY_S]
for i in range(5):
    hdim(AX[i], AX[i + 1], -TJ_H, -700, text=f"{int(BAYS[i])}(估)")
hdim(AX[0], AX[5], -TJ_H, -1350, text=f"{int(W)}(估)")
XR = W + WT + EAVE + 500
vdim(-TJ_H, 0, XR, 500, f"{int(TJ_H)}(估)")
vdim(0, WALL_H, XR, 500, f"{int(WALL_H)}(估)")
vdim(WALL_H, Y_LE, XR, 500, f"{int(Y_LE - WALL_H)}(估)")
vdim(Y_LE, Y_RIDGE, XR, 500, f"{int(Y_RIDGE - Y_LE)}(估)")

# ---- 部件标签（改写）----
labels = [
    ("雕花脊筒·正脊", (CX - 3200, Y_RIDGE + 500)), ("楼阁式脊刹", (CX + 1800, Y_RIDGE + SHA_H + 300)),
    ("吻兽", (rR + 800, Y_RIDGE + 700)), ("戗脊", ((rR + eR) / 2 + 500, (Y_RIDGE + Y_EAVE_MID) / 2 + 700)),
    ("飞椽/檐口", (eL + 500, Y_EAVE_MID - 650)),
    ("铺作(双下昂·简化示意/柱头+补间)", (CX, PZ_Y0 + PZ_H + 350)),
    ("普拍枋", (AX[1], WALL_H + 560)), ("大额枋", (AX[4], WALL_H + 160)),
    ("前檐砖墙(包柱不露明)", (AX[1], 500)), ("直棂窗", (WIN_CX[0], sill + wh + 350)),   # 墙标签移至下碱区空白，避免压窗（目检修正）
    ("板门(双扇·石框·门簪4)", (CX, dh + 620)),
    ("台基(尺寸估)", (W + TJ_OUT - 1600, -TJ_H / 2)), ("踏步(2级)", (CX + 1900, -TJ_H / 2)),
]
for s, pos in labels:
    txt(s, pos)

# ---- 标高符号（复用；全部标（估））----
def biaogao(px, py, val_m, est=False):
    s = 150
    pl([(px - s, py + s), (px, py), (px + s, py + s)], "09标注")
    line((px - s, py + s), (px + s + 900, py + s), "09标注")
    v = "±0.000" if val_m == 0 else f"{val_m:+.3f}"
    txt(v + ("(估)" if est else ""), (px + s + 450, py + s + 200), 250, "09标注")

biaogao(-TJ_OUT - 900, 0, 0.0)
biaogao(-TJ_OUT - 900, -TJ_H, -TJ_H / 1000, est=True)
biaogao(eL - 600, Y_EAVE_MID + UPTURN + 150, (Y_EAVE_MID + UPTURN + 150) / 1000, est=True)
biaogao(rR + 1500, Y_RIDGE, Y_RIDGE / 1000, est=True)

# ---- 图名 ----
txt("东呈古佛堂 正立面现状示意图（盲测·全图尺寸为照片估算）", (CX, Y_RIDGE + SHA_H + 1100), 560)

# ---- A3 布局（复用框架；改比例 1:100 适配五开间面阔，图签字段更新）----
layout = doc.layouts.new("A3立面")
layout.page_setup(size=(420, 297), margins=(0, 0, 0, 0))
doc.layers.add("11图框", color=7)

def ptxt(s, pos, h=2.5, align=TextEntityAlignment.MIDDLE_LEFT):
    layout.add_text(s, dxfattribs={"layer": "11图框", "style": "CN", "height": h}).set_placement(pos, align=align)

layout.add_lwpolyline([(25, 5), (415, 5), (415, 292), (25, 292)], dxfattribs={"layer": "11图框"}, close=True)

TB_X, TB_Y, TB_W, TB_H = 235, 5, 180, 32
layout.add_lwpolyline([(TB_X, TB_Y), (TB_X + TB_W, TB_Y), (TB_X + TB_W, TB_Y + TB_H), (TB_X, TB_Y + TB_H)],
                      dxfattribs={"layer": "11图框"}, close=True)
for r in (1, 2):
    layout.add_line((TB_X, TB_Y + r * TB_H / 3), (TB_X + TB_W, TB_Y + r * TB_H / 3), dxfattribs={"layer": "11图框"})
for c in (60, 120):
    layout.add_line((TB_X + c, TB_Y), (TB_X + c, TB_Y + TB_H), dxfattribs={"layer": "11图框"})
cells = [
    ("测绘单位：Jiajia+AI 工作流", 2, 0), ("项目名称：古建归档 MVP 盲测", 2, 1), ("图名：东呈古佛堂正立面现状示意图", 2, 2),
    ("项目负责：Jiajia", 1, 0), ("测量：无实测(照片估算)", 1, 1), ("绘图：Claude AI · 校对/审核：待签", 1, 2),
    ("图号：测绘 02-01", 0, 0), ("比例 1:100 · 日期 2026-07-10", 0, 1), ("版本 v0.1 · 单位 mm", 0, 2),
]
for s, r, c in cells:
    ptxt(s, (TB_X + c * 60 + 2, TB_Y + r * TB_H / 3 + TB_H / 6), 2.2)
ptxt("说明：盲测样本，无实测尺寸，全图尺寸为照片比例估算（基准假设门高2500）；照片 CC BY-SA 4.0 仙女传奇", (TB_X - 208, TB_Y + 3), 2.0)

# 1:100 视口：240 mm × 100 = 24000 mm 模型窗口
layout.add_viewport(center=(220, 165), size=(380, 240), view_center_point=(CX, 4200), view_height=17000)

# ---- 输出 ----
dxf_path = os.path.join(HERE, "东呈古佛堂_正立面现状示意图.dxf")
doc.saveas(dxf_path)

auditor = doc.audit()
print(f"DXF 审计：errors={len(auditor.errors)} fixes={len(auditor.fixes)}")
print(f"模型空间实体数：{len(msp)}")

cfg = Configuration(background_policy=BackgroundPolicy.WHITE)
ctx = RenderContext(doc)
fig = plt.figure(figsize=(16, 10))
ax = fig.add_axes([0, 0, 1, 1])
Frontend(ctx, MatplotlibBackend(ax), config=cfg).draw_layout(msp, finalize=True)
png_path = os.path.join(HERE, "东呈古佛堂_正立面_预览.png")
fig.savefig(png_path, dpi=130)

fig2 = plt.figure(figsize=(16.8, 11.88))
ax2 = fig2.add_axes([0, 0, 1, 1])
Frontend(RenderContext(doc), MatplotlibBackend(ax2), config=cfg).draw_layout(layout, finalize=True)
png2_path = os.path.join(HERE, "东呈古佛堂_A3布局_预览.png")
fig2.savefig(png2_path, dpi=130)
print(f"输出：{dxf_path}")
print(f"预览：{png_path}")
print(f"布局预览：{png2_path}")
