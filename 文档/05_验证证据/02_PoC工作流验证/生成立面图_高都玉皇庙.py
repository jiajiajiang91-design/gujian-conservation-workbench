# -*- coding: utf-8 -*-
# 盲测样本B：读部件识别 JSON，生成高都玉皇庙主殿正立面简化线划图（DXF）+ PNG 预览
# 基于 生成立面图_南禅寺大殿.py 改写。复用：框架/图层/辅助函数/标注/标高/布局/输出段。
# 改写：立面构成（敞廊石柱露明、雀替、彩绘额枋带、清式密斗拱示意带、悬山+脊刹）。
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
with open(os.path.join(HERE, "部件识别_高都玉皇庙正立面.json"), encoding="utf-8") as f:
    data = json.load(f)
D = data["核心尺寸_mm"]

# 关键坐标（Y 基准：台基顶面 = 0）。改写段：三开间敞廊
BAY_C, BAY_S = D["明间面阔_估"], D["次间面阔_估"]
AX = [0, BAY_S, BAY_S + BAY_C, 2 * BAY_S + BAY_C]
W = AX[3]
CX = W / 2
COL_H, COL_W = D["基准假设_柱高"], D["柱宽_方柱_估"]
CB_H = D["柱础高_估"]
FANG_H = D["额枋带高_估"]                    # 彩绘额枋带（大额枋+平板枋）
DG_H = D["斗拱层高_估"]                      # 清式斗拱层
Y_FANG0 = COL_H                              # 额枋带下皮
Y_DG0 = COL_H + FANG_H                       # 斗拱层下皮
Y_LE = Y_DG0 + DG_H                          # 挑檐桁
Y_EAVE_MID = D["檐口中部高_估"]
Y_RIDGE = D["脊线高_估"]
SHA_H = D["脊刹高_估"]
EAVE = D["檐出_自柱中_估"]
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

# ---- 轴线（复用，4 根）----
for i, x in enumerate(AX):
    line((x, -TJ_H - 600), (x, COL_H + 600), "01轴线")
    msp.add_circle((x, -TJ_H - 900), 220, dxfattribs={"layer": "01轴线"})
    txt(str(i + 1), (x, -TJ_H - 900), 220, "01轴线")

# ---- 台基与踏步（改写：三级踏步居中）----
pl([(-TJ_OUT, -TJ_H), (W + TJ_OUT, -TJ_H), (W + TJ_OUT, 0), (-TJ_OUT, 0)], "02台基", closed=True)
line((-TJ_OUT - 2500, -TJ_H), (W + TJ_OUT + 2500, -TJ_H), "02台基")
tw = D["踏步宽_估"] / 2
for k in range(1, 3):
    y = -TJ_H * k / 3
    line((CX - tw, y), (CX + tw, y), "02台基")
line((CX - tw, -TJ_H), (CX - tw, 0), "02台基")
line((CX + tw, -TJ_H), (CX + tw, 0), "02台基")

# ---- 方形石檐柱（改写：方柱露明+柱础+雀替）----
for x in AX:
    pl([(x - COL_W / 2 - 90, 0), (x + COL_W / 2 + 90, 0), (x + COL_W / 2 + 90, CB_H),
        (x - COL_W / 2 - 90, CB_H)], "03柱", closed=True)               # 石柱础
    pl([(x - COL_W / 2, CB_H), (x - COL_W / 2, COL_H), (x + COL_W / 2, COL_H),
        (x + COL_W / 2, CB_H)], "03柱")                                  # 方柱身
def queti(x, sgn):                                                       # 雀替（简化轮廓）
    pl([(x + sgn * COL_W / 2, COL_H - 120), (x + sgn * (COL_W / 2 + 620), COL_H - 120),
        (x + sgn * (COL_W / 2 + 620), COL_H - 300), (x + sgn * (COL_W / 2 + 200), COL_H - 560),
        (x + sgn * COL_W / 2, COL_H - 560)], "03柱")
for x in AX:
    if x > 0:
        queti(x, -1)
    if x < W:
        queti(x, +1)

# ---- 彩绘额枋带（改写：大额枋+平板枋两层）----
pl([(AX[0] - 300, Y_FANG0), (AX[3] + 300, Y_FANG0), (AX[3] + 300, Y_FANG0 + FANG_H * 0.6),
    (AX[0] - 300, Y_FANG0 + FANG_H * 0.6)], "04额枋", closed=True)       # 大额枋（彩绘）
pl([(AX[0] - 380, Y_FANG0 + FANG_H * 0.6), (AX[3] + 380, Y_FANG0 + FANG_H * 0.6),
    (AX[3] + 380, Y_DG0), (AX[0] - 380, Y_DG0)], "04额枋", closed=True)  # 平板枋
txt("彩绘", (CX, Y_FANG0 + FANG_H * 0.3), 220, "04额枋")

# ---- 清式斗拱层（改写：不逐攒绘制，连续示意带+攒位刻度）----
pl([(AX[0] - 380, Y_DG0), (AX[3] + 380, Y_DG0), (AX[3] + 380, Y_LE), (AX[0] - 380, Y_LE)], "05铺作", closed=True)
n_zan = 14                                                               # 攒位示意（数量为示意非实测）
for k in range(n_zan + 1):
    x = AX[0] + W * k / n_zan
    line((x, Y_DG0), (x, Y_DG0 + DG_H * 0.45), "05铺作")
line((AX[0] - 380, Y_DG0 + DG_H * 0.45), (AX[3] + 380, Y_DG0 + DG_H * 0.45), "05铺作")

# ---- 檐口与悬山屋面（改写：无翼角起翘，正脊近通长+脊刹+吻兽）----
eL, eR = -EAVE, W + EAVE
line((eL, Y_EAVE_MID), (eR, Y_EAVE_MID), "06屋面")
line((eL, Y_EAVE_MID + 150), (eR, Y_EAVE_MID + 150), "06屋面")           # 飞椽上缘
rL, rR = CX - D["正脊长_估"] / 2, CX + D["正脊长_估"] / 2
pl([(rL, Y_RIDGE - 300), (rR, Y_RIDGE - 300), (rR, Y_RIDGE), (rL, Y_RIDGE)], "06屋面", closed=True)
def wenshou(x, sgn):
    h = D["吻兽高_估"]
    pl([(x, Y_RIDGE - 300), (x, Y_RIDGE + h), (x - sgn * 240, Y_RIDGE + h - 110),
        (x - sgn * 360, Y_RIDGE + h - 400), (x - sgn * 420, Y_RIDGE - 300)], "06屋面")
wenshou(rL, +1)
wenshou(rR, -1)
def jisha(x):                                                            # 脊刹（宝顶简化）
    pl([(x - 260, Y_RIDGE), (x + 260, Y_RIDGE), (x + 170, Y_RIDGE + SHA_H * 0.55),
        (x - 170, Y_RIDGE + SHA_H * 0.55)], "06屋面", closed=True)
    msp.add_circle((x, Y_RIDGE + SHA_H * 0.8), SHA_H * 0.22, dxfattribs={"layer": "06屋面"})
jisha(CX)
line((rL, Y_RIDGE - 300), (eL, Y_EAVE_MID + 150), "06屋面")              # 垂脊（正视投影）
line((rR, Y_RIDGE - 300), (eR, Y_EAVE_MID + 150), "06屋面")

# ---- 敞廊（改写：无门窗墙，画廊内地面线与神龛示意轮廓）----
line((AX[0] + COL_W / 2, 0), (AX[3] - COL_W / 2, 0), "07门窗")           # 廊内地面线
NK_W, NK_H = 2600, 2400
pl([(CX - NK_W / 2, 150), (CX + NK_W / 2, 150), (CX + NK_W / 2, NK_H), (CX - NK_W / 2, NK_H)], "07门窗", closed=True)
txt("廊内神龛(示意)", (CX, NK_H - 350), 220, "07门窗")   # 标签置于龛框内，避免与雀替标签重叠（目检修正）

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

BAYS = [BAY_S, BAY_C, BAY_S]
for i in range(3):
    hdim(AX[i], AX[i + 1], -TJ_H, -700, text=f"{int(BAYS[i])}(估)")
hdim(AX[0], AX[3], -TJ_H, -1350, text=f"{int(W)}(估)")
XR = W + EAVE + 500
vdim(-TJ_H, 0, XR, 500, f"{int(TJ_H)}(估)")
vdim(0, COL_H, XR, 500, f"{int(COL_H)}(估·基准)")
vdim(COL_H, Y_LE, XR, 500, f"{int(Y_LE - COL_H)}(估)")
vdim(Y_LE, Y_RIDGE, XR, 500, f"{int(Y_RIDGE - Y_LE)}(估)")

# ---- 部件标签（改写）----
labels = [
    ("正脊", (CX - 2600, Y_RIDGE + 420)), ("脊刹(宝顶)", (CX + 1500, Y_RIDGE + SHA_H + 280)),
    ("吻兽", (rR + 700, Y_RIDGE + 550)), ("垂脊", ((rR + eR) / 2, (Y_RIDGE + Y_EAVE_MID) / 2 + 400)),
    ("飞椽/檐口", (eL + 500, Y_EAVE_MID - 550)),
    ("斗拱层(清式密布·示意带)", (CX, Y_DG0 + DG_H + 320)),
    ("彩绘大额枋", (AX[1] - 500, Y_FANG0 - 260)),
    ("雀替", (AX[1] + BAY_C * 0.18, COL_H - 780)),
    ("方形石柱(楹联)", (AX[0] - 950, COL_H / 2)),
    ("敞廊(无门窗墙)", (CX - BAY_C / 2 - 900, 900)),
    ("台基(尺寸估)", (W + TJ_OUT - 1500, -TJ_H / 2)), ("踏步(3级)", (CX + 1700, -TJ_H / 2)),
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
biaogao(eL - 600, Y_EAVE_MID + 150, (Y_EAVE_MID + 150) / 1000, est=True)
biaogao(rR + 1200, Y_RIDGE, Y_RIDGE / 1000, est=True)

# ---- 图名 ----
txt("高都玉皇庙主殿 正立面现状示意图（盲测·全图尺寸为照片估算）", (CX, Y_RIDGE + SHA_H + 1000), 520)

# ---- A3 布局（复用框架；1:100，图签字段更新）----
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
    ("测绘单位：Jiajia+AI 工作流", 2, 0), ("项目名称：古建归档 MVP 盲测", 2, 1), ("图名：高都玉皇庙主殿正立面示意图", 2, 2),
    ("项目负责：Jiajia", 1, 0), ("测量：无实测(照片估算)", 1, 1), ("绘图：Claude AI · 校对/审核：待签", 1, 2),
    ("图号：测绘 02-01", 0, 0), ("比例 1:100 · 日期 2026-07-10", 0, 1), ("版本 v0.1 · 单位 mm", 0, 2),
]
for s, r, c in cells:
    ptxt(s, (TB_X + c * 60 + 2, TB_Y + r * TB_H / 3 + TB_H / 6), 2.2)
ptxt("说明：盲测样本，无实测尺寸，全图尺寸为照片比例估算（基准假设柱高3400）；照片 CC BY-SA 4.0 Windmemories", (TB_X - 208, TB_Y + 3), 2.0)

layout.add_viewport(center=(220, 165), size=(380, 240), view_center_point=(CX, 3600), view_height=14500)

# ---- 输出 ----
dxf_path = os.path.join(HERE, "高都玉皇庙主殿_正立面现状示意图.dxf")
doc.saveas(dxf_path)

auditor = doc.audit()
print(f"DXF 审计：errors={len(auditor.errors)} fixes={len(auditor.fixes)}")
print(f"模型空间实体数：{len(msp)}")

cfg = Configuration(background_policy=BackgroundPolicy.WHITE)
ctx = RenderContext(doc)
fig = plt.figure(figsize=(16, 10))
ax = fig.add_axes([0, 0, 1, 1])
Frontend(ctx, MatplotlibBackend(ax), config=cfg).draw_layout(msp, finalize=True)
png_path = os.path.join(HERE, "高都玉皇庙_正立面_预览.png")
fig.savefig(png_path, dpi=130)

fig2 = plt.figure(figsize=(16.8, 11.88))
ax2 = fig2.add_axes([0, 0, 1, 1])
Frontend(RenderContext(doc), MatplotlibBackend(ax2), config=cfg).draw_layout(layout, finalize=True)
png2_path = os.path.join(HERE, "高都玉皇庙_A3布局_预览.png")
fig2.savefig(png2_path, dpi=130)
print(f"输出：{dxf_path}")
print(f"预览：{png_path}")
print(f"布局预览：{png2_path}")
