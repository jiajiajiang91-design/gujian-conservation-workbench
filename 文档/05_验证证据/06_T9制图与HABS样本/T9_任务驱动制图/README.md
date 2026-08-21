# T9 任务驱动制图验证

## 验证边界

本目录验证制图链的通用技术能力，不证明当前三构件团队样例达到古建专业图纸质量。

- 输入：当前项目 `GeometryRevision 0d14b417-b785-5408-8b27-06a052932619`
- 要求：项目任务矩阵指定七类视图、两张 A1、比例、布局、中文图名和未签发状态
- 输出：`ViewGeometry → Drawing IR → DXF / SVG / PDF / PNG`
- 状态：`generated-not-qualified`、`L1=false`、代理成果、未签发、不可正式使用
- 大型成果位置：`apps/server/.data/acceptance/milestone-two/t9-drawings`
- Git 仅保留合同、哈希清单、验证报告和两张必要预览

## 已验证能力

1. 平面、屋顶平面、立面、横剖、纵剖、轴测和节点详图来自同一 GeometryRevision。
2. 独立验证器从 GLB 重新计算剖切、候选边和遮挡可见线，并与 ViewGeometry 的完整几何集合比较。
3. 两种不同成果目录和布局通过合同测试；运行代码不固定项目 ID、项目名称或旧十视图、两张 A1 组合。
4. DXF 为 R2018、毫米、模型空间 1:1，含原生 LINE、DIMENSION、MTEXT、HATCH、INSERT、LAYOUT 和锁定 VIEWPORT。
5. 结构 CAD 对象带来源 XDATA，并通过 NDJSON 映射回 `sourceEntityId`、`geometryRevisionId` 和 `viewId`。
6. SVG、两页 A1 PDF 和 300 dpi PNG 与同一 Drawing IR 闭合；PDF 使用嵌入的字重 400 中文字体和 ToUnicode。
7. 图面不显示 `targetViewId`、完整 UUID、内部英文状态或假业务日期；病害候选图层非空。
8. 同一输入的完整成果包逐文件字节一致。
9. AutoCAD 2024 Core Console 对隔离副本审计结果为零错误、零修复、零删除，项目字体未替换。
10. QCAD 3.32.9 仅完成打开、查看和两布局打印；未另存，也未覆盖规范 DXF。

## 证据索引

| 文件 | 内容 |
|---|---|
| `artifact-requirement-matrix.json` | 动态图种、比例、图幅、布局和状态要求 |
| `drawing-output-manifest.json` | 大型成果逐文件 SHA-256 与字节数 |
| `drawing-artifacts-verification.json` | 22 项独立检查及输入、输出、工具摘要哈希 |
| `autocad-audit-summary.json` | 当前 DXF 的 AutoCAD 隔离审计摘要 |
| `qcad-compatibility-summary.json` | 当前 DXF 的 QCAD 打开、查看和打印摘要 |
| `P-01-preview.png`、`P-02-preview.png` | 与成果 PNG 字节相同的两张 300 dpi 预览 |

## 尚未满足

- 当前输入只是 T8b 通用内核的三构件团队样例，图面稀疏，不计专业成果。
- 还没有把完整 HABS 资料转为当前项目事实，也没有生成 HABS 成组代理成果。
- 还没有完成高都资料不足路径和代理交付 ZIP。
- 专业古建复核、责任签发和正式交付能力均未完成。
