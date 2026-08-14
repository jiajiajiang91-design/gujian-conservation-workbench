# 里程碑二：专业成果链验证

> 验收日期：2026-08-14
> 范围：T8a、T8b、T9、T9a、T10
> 状态：`generated-not-qualified / L1=false / 代理成果 / 未签发 / 不可用于正式交付或施工`

## 结论

里程碑二已完成两条诚实隔离的项目路径，并通过一次独立技术审查和一次独立古建专业审查。两类审查在唯一一次 P0 定向复核后均为 `P0=0`。

- HABS Badin-Roque House：完成官方资料登记、真实 Kimi K2.6 运行、证据约束的 GeometrySpec、同一 GeometryRevision 绑定的 IFC/GLB/成组图纸、代理交付、空库回导和回导后继续生成。该路径只证明工程链可运行，不证明正式测绘、施工或中国古建专业资格。
- 高都玉皇庙：只登记高都自身四张照片。历史数值缺少原始登记记录，已降为 `producerType=demo / dataStatus=unverified`；4400 mm 仅用于演示规则与阻断流程。完整几何、完整图纸和正式交付均被阻断。

旧 HABS 默认体块、重复详图和旧交付草案继续作为 `invalidated` 失败证据保留，没有覆盖或改名。T0b 恢复快照、原始脏资产和历史失败证据均未删除。

## 启动

```powershell
pnpm install --frozen-lockfile
$env:KIMI_API_KEY = "<仅注入服务端>"
$env:KIMI_BASE_URL = "https://api.moonshot.ai/v1"
pnpm run dev
```

- 工作台：`http://127.0.0.1:5173/`
- 本地服务：`http://127.0.0.1:8787/`

密钥、系统提示、任务模板和供应商路由不进入浏览器、项目包、截图或 Git。

## HABS 代理路径

### 资料与模型运行

- 官方资料：9 张照片、10 张实测图、1 份资料 PDF、1 份照片说明 PDF。
- Kimi runId：`3d902f69-56b7-4d31-8b6c-94de4dec8ef5`。
- 供应商与模型：`moonshot / kimi-k2.6`。
- 用量：prompt 4144、completion 534、total 4678、cached 0。
- 模型输出保持 `producerType=model`；人工接受仅建立决定，不补造现场事实或测量元数据。

### 当前 GeometryRevision

- ID：`7fb78654-d45c-57f2-aeb5-cdb27d893fdb`。
- 42 个证据定位构件、9 个声明接口、38 个结构化未知项。
- 每个构件只绑定自身事实、具体 HABS 图纸位置和 evidenceRef。
- 未使用百分比出檐、默认墙厚、默认层厚或默认材料补造事实。
- IFC、GLB、manifest、BREP、报告和预览绑定同一 GeometryRevision。

### 当前成组图纸

成果要求来自项目 TaskDefinition 和持久化 ArtifactRequirementMatrix，不是固定十视图或固定两张 A1。当前成果包含任务要求的平面、屋架平面投影、立面、横纵剖和局部证据节点，以及 DXF、SVG、PDF、PNG、Drawing IR、ViewGeometry 和来源映射。

规范 DXF 为 R2018、毫米模型空间，包含原生业务线型、TEXT/MTEXT、HATCH、INSERT、布局和锁定视口；结构对象保留来源 XDATA。图纸仍带有专业复核、现场笔记未数字化和正式签发阻断。

### CAD 检查

- ezdxf：0 error / 0 fix。
- AutoCAD 2024 Core Console：对哈希相同临时副本执行 OPEN + AUDIT，0 error / 0 fix / 0 delete，项目字体未替换。
- QCAD Professional Trial 3.32.9：只执行打开、查看和两布局打印，未保存回写；不能替代规范 DXF 的 AutoCAD 资格检查。

## 空库回导

- JSON：恢复结构化记录，未携带二进制的资源明确标记为 `missing`。
- ZIP：恢复真实文件、模型运行、规则运行、人工决定、GeometryRevision、ArtifactRequirementMatrix、成果、检查、交付和审计关系。
- 回导后：继续生成新的 GeometryRevision、新矩阵、图纸、检查和代理交付草案。

浏览器证据见 `screenshots-p0/04_HABS_JSON_ZIP空库回导.png` 和 `screenshots-p0/05_HABS回导后新版本与交付.png`；命令级闭包由 `测试矩阵.json` 中的空库回导测试覆盖。

## 高都阻断路径

`gaodu-redacted-ledger.json` 只保留脱敏 ID、MIME、字节数、SHA-256、来源声明和关系，不提交私有原文件。

- 4 张照片仅支持 visual-observation 和 asset-identity，不支持精确尺寸。
- 15800 mm 与 4200 + 3600 + 3600 mm 均为无原始登记记录的 demo/unverified 候选，evidenceRefs 为空。
- 4400 mm 规则结果为 `demonstration-only`，不是现场事实。
- 阻断码包含 `UNVERIFIED_DIMENSION_CANDIDATES`、`MEASUREMENT_METADATA_MISSING` 和 `GEOMETRY_EVIDENCE_FACTS_MISSING`。
- 几何和完整成果数量为 0；HABS、东呈、南禅寺、团队 demo 和 proxy-input 交叉扫描为 0 命中。

## 大型成果与证据

大型 IFC、GLB、BREP、DXF、SVG、PDF、PNG、IR、来源映射和 HABS 原始文件位于忽略目录：

`apps/server/.data/acceptance/milestone-two/`

Git 仅提交 manifest、逐文件 SHA-256、验证报告和必要截图。详见：

- `artifact-sha256-manifest.json`
- `habs-end-to-end-record.json`
- `habs-current-geometry-verification.json`
- `habs-current-drawing-verification.json`
- `habs-current-autocad-audit-summary.json`
- `habs-current-qcad-compatibility-summary.json`
- `gaodu-evidence-boundary.json`
- `gaodu-redacted-ledger.json`
- `t0b-81项资产里程碑二迁移对应表.json`
- `独立技术审查.md`
- `独立古建专业审查.md`

## 未关闭限制

- 未实现真实组织身份、法定权限、正式电子签名和责任签发。
- 未验证中国古建完整成功样本；高都仍是资料不足阻断样本。
- HABS 现场笔记 N613 未数字化，结构化未知项仍需专业复核或补充证据。
- HABS 只能证明工程成果链可运行，不能证明中国古建语义能力。
- 测试数量、文件大小、图元数量和截图不作为专业合格证明。
