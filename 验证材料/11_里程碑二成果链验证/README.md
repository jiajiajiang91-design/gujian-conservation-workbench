# 里程碑二：真实成果链验证

> 验收日期：2026-08-14
> 实现范围：T8a、T8b、T9、T9a、T10
> 资格状态：`generated-not-qualified / L1=false / 代理成果 / 未签发 / 不可用于正式交付或施工`

## 验收结果

里程碑二已实现两条诚实分离的项目路径：

- HABS Badin-Roque House：完成官方资料导入、真实 Kimi K2.6 流式运行、人工确认尺寸候选、GeometryRevision、IFC/GLB、任务驱动图纸、代理交付、JSON/ZIP 空库回导，以及回导后继续生成新版本。
- 高都玉皇庙：只使用高都自身照片与已登记尺寸，识别 4400 mm 尺寸冲突和测量元数据缺失；完整 IFC、GLB、DXF、SVG、PDF 与正式交付被阻断。

HABS 路径只证明资料到代理成果的工程闭包，不证明中国古建语义能力。高都路径不使用 HABS、东呈、南禅寺或团队 demo 几何补造缺失事实。

## 可操作入口

```powershell
pnpm install --frozen-lockfile
$env:KIMI_API_KEY = "<仅服务端注入>"
$env:KIMI_BASE_URL = "https://api.moonshot.ai/v1"
pnpm run dev
```

- 工作台：`http://127.0.0.1:5173/`
- 本地服务：`http://127.0.0.1:8787/`

浏览器演示顺序：选择 HABS 项目，依次查看 AI 候选、问题处理、三维模型、成组图纸和成果交付；执行空库回导后仍可建立新 GeometryRevision、重新生成图纸并建立新的代理交付草案。切换高都项目后，交付页显示尺寸冲突、缺失资料和阻断结果。

## HABS 真实运行摘要

| 字段 | 值 |
|---|---|
| 项目 | Badin-Roque House，HABS LA-1294 |
| 官方资料 | 9 张照片、10 张实测图、1 份资料 PDF、1 份照片说明 PDF |
| Kimi runId | `3d902f69-56b7-4d31-8b6c-94de4dec8ef5` |
| 供应商 / 模型 | `moonshot / kimi-k2.6` |
| 事件 | queued 1、running 1、stream 528、succeeded 1 |
| 用量 | prompt 4144、completion 534、total 4678、cached 0 |
| 尺寸事实 | 总宽 9531.35 mm、总深 11506.2 mm、台基 457.2 mm、墙高 2755.9 mm、脊高 6884.9875 mm |
| 当前项目版本前缀 | `657c2a4e` |
| 当前交付草案前缀 | `a7e1ce78` |

模型候选的来源保持 `producerType=model`。人工接受候选只建立人工决定和确认状态，不补造现场测量人、时间、方法或原始记录。

## CAD 兼容检查

- 规范 DXF：R2018 / AC1032，`$INSUNITS=4`，模型空间 1:1 mm。
- 原生对象：`LINE`、`DIMENSION`、`MTEXT`、`HATCH`；两个纸空间布局 `P-01`、`P-02`，7 个锁定用户视口。
- ezdxf：0 个错误，0 个修复。
- AutoCAD 2024 Core Console U.61.0.0：对哈希一致的临时副本执行 `OPEN + AUDIT`，0 个错误、0 个修复、0 个删除；项目许可字体在隔离支持路径中被识别。
- QCAD Professional Trial 3.32.9：成功打开规范 DXF，并从 `P-01`、`P-02` 打印两页临时 PDF。只作为打开、查看和打印兼容性证据，不保存回写，不替代规范 DXF。

外部两份 DWG 没有进入生成输入、项目包、代码、字体、图层、块、尺寸或图签。

## 大型成果位置

大型 IFC、GLB、DXF、SVG、PDF、PNG、IR、来源映射和 HABS 原始文件不进入 Git 主线：

`apps/server/.data/acceptance/milestone-two/`

Git 只保留本目录中的哈希清单、验证报告、截图和必要证据。GitHub Release 留到里程碑三。

## 证据索引

- `habs-kimi-real-run.json`：真实 Kimi 运行和完整事件链。
- `habs-end-to-end-record.json`：HABS 端到端与回导后继续生成摘要。
- `gaodu-evidence-boundary.json`：高都资料边界与 4400 mm 冲突。
- `artifact-sha256-manifest.json`：里程碑二大型成果哈希。
- `cad-compatibility.json`：AutoCAD 与 QCAD 检查。
- `t0b-81项资产里程碑二迁移对应表.json`：81 项逐行迁移关系。
- `测试矩阵.json`：代码、几何、制图、交付、浏览器和进程测试。
- `最初目标验收矩阵.md`：最初目标、PRD 与当前完成边界。
- `数据字典.md`：几何、成果、检查和交付对象的责任边界。
- `screenshots/`：当前工作台真实页面。

## 仍未完成

- 未进行真实组织身份、法定权限、正式签名和责任签发。
- 未获得中国古建完整成功样本；高都仍是资料不足阻断样本。
- HABS 的现场笔记 N613 未数字化，部分测量元数据只能记录缺失。
- 当前代理成果需独立技术审查和古建专业审查；测试数量和文件规模不作为专业合格证明。
