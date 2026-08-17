# T0-B v3 · 古建局部构造合同独立审查 v0.1

本审查用于冻结下一轮团队自有古建局部构造样板的领域边界。当前 T0-B v2 已证明同源几何、投影、剖切和跨格式输出的技术路径，但四个局部节点仍不足以称为 L1 成品样板。结论为：必须建立新的 GeometryRevision，补齐构件层级、构造界面、事实依据和未知项，再重建视图与图纸成果。

本文是团队 demo 的领域审查输入，不是测绘结论、保护方案或专业签发。文中尺寸类别和构造关系只定义数据结构与验收方式，不提供真实建筑数值。

## 一、审查边界

### 1. 已读项目文件

- `.claude/agents/heritage-domain-reviewer.md`
- `.claude/agents/doc-writer.md`
- `.claude/agents/templates/文档书写规范.md`
- `.claude/context/pm-context.md`
- `文档/02_技术/02_专业制图与建模质量基准.md`（原 13-12）
- `workers/cad/t0b_v2/VIEW_CONTRACT.md`
- `workers/cad/t0b_v2/geometry.py`
- `文档/05_验证证据/04_T0_CAD可行性与资产保全/t0b-v2-resolved-local-assembly.json`
- `文档/05_验证证据/04_T0_CAD可行性与资产保全/t0b-v2-outputs/geometry-manifest.json`
- `文档/05_验证证据/04_T0_CAD可行性与资产保全/t0b-v2-outputs/details/eaveDetail.view-geometry.json.gz`
- `文档/05_验证证据/04_T0_CAD可行性与资产保全/t0b-v2-outputs/details/bracketDetail.view-geometry.json.gz`
- `文档/05_验证证据/04_T0_CAD可行性与资产保全/t0b-v2-outputs/details/columnBaseDetail.view-geometry.json.gz`
- `文档/05_验证证据/04_T0_CAD可行性与资产保全/t0b-v2-outputs/details/doorWindowDetail.view-geometry.json.gz`
- `文档/05_验证证据/04_T0_CAD可行性与资产保全/t0b-v2-outputs/details/detail-verification.json`
- `文档/05_验证证据/04_T0_CAD可行性与资产保全/t0b-v2-outputs/geometry-verification.json`
- `文档/05_验证证据/04_T0_CAD可行性与资产保全/t0b-v2-outputs/drawing-package-artifacts/sheet-output-verification.json`
- `文档/05_验证证据/04_T0_CAD可行性与资产保全/T0B_L1验收撤销记录.md`
- `文档/05_验证证据/04_T0_CAD可行性与资产保全/T0_CAD可行性与质量验证报告.md`
- `文档/05_验证证据/04_T0_CAD可行性与资产保全/外部DWG参照检查_寺庙古建筑设计方案图.md`
- `文档/05_验证证据/04_T0_CAD可行性与资产保全/外部参考_一套完整的古建施工图_只读审查.md`
- `文档/05_验证证据/04_T0_CAD可行性与资产保全/t0b-v2-blender-preview.png`
- `文档/05_验证证据/04_T0_CAD可行性与资产保全/t0b-v2-roof-side-preview.png`
- `文档/05_验证证据/04_T0_CAD可行性与资产保全/t0b-v2-outputs/details/previews/t0b-v2-eaveDetail-clean.png`
- `文档/05_验证证据/04_T0_CAD可行性与资产保全/t0b-v2-outputs/details/previews/t0b-v2-bracketDetail-clean.png`
- `文档/05_验证证据/04_T0_CAD可行性与资产保全/t0b-v2-outputs/details/previews/t0b-v2-columnBaseDetail-clean.png`
- `文档/05_验证证据/04_T0_CAD可行性与资产保全/t0b-v2-outputs/details/previews/t0b-v2-doorWindowDetail-clean.png`
- `文档/05_验证证据/04_T0_CAD可行性与资产保全/t0b-v2-outputs/drawing-package-artifacts/independent-review/T0B-01-review-full.png`
- `文档/05_验证证据/04_T0_CAD可行性与资产保全/t0b-v2-outputs/drawing-package-artifacts/independent-review/T0B-02-review-full.png`

### 2. 外部参考隔离

两份外部 DWG 和用户提供的参考截图只用于比较图种、表达层级、信息密度和专业可读性。其来源、许可、尺寸、构造依据和字体条件不能支持项目生成。下一轮不得复制其图元、尺寸、图层、图签、文字、术语或构造事实，也不得把文件哈希、路径或渲染图放入生成依赖。

南禅寺等公开案例只能说明专业成果通常需要成套平、立、剖、详图、连续尺寸和构件分层。没有项目可核查的测量资料时，不能据此判断本样板的真实形制、材料、尺寸、年代、病害或保护措施。

## 二、当前证据与责任

### 1. 当前可确认事实

当前 GeometryRevision 为 `3788f4e4-339c-568d-aa58-f74b36b23c5a`，ViewContractRevision 为 `04d00093-0bec-5f2a-bc68-def2a292c932`。几何清单含 1,166 个团队 demo 实体，全部被标记为 `geometryStatus=resolved`。该状态只说明文件内网格已生成，不能说明构造、类型和专业表达已经解决。

独立验证已证明实体 ID、网格、投影、剖切和来源关系可重复计算。四张详图的 `73/73` 和几何报告的 `8/8` 属于技术验证。现有报告仍明确 `generated-not-qualified`、`L1=false`，不能改写为专业通过。

### 2. 事实责任三分法

| 事实类别 | 可记录内容 | 责任与限制 |
|---|---|---|
| 团队 demo 参数 | 冻结的几何尺寸、构件数量、材料演示码、屋面曲线、病害观察候选 | `producerType=demo`；仅用于验证；不得用于正式成果 |
| 同源几何推导 | 网格、边界、体积、剖切、投影、接触、搭接、承托关系和哈希 | 只对该版 demo 几何成立；不得外推为真实建筑事实 |
| 未知事实 | 真实类型、材料品种、年代、隐蔽榫接、实测尺寸、病害成因与程度、保护决定、适用规范和容差 | 必须由测量证据、规则来源或专业人员确认；当前不得补写 |

通用责任字段应沿用产品数据口径：

```json
{
  "producerType": "demo | model | rule | human | system",
  "factBasis": "demoParameter | derivedGeometry | measuredEvidence | expertDecision | unknown",
  "formalEligibility": "eligible | ineligible",
  "sourceRefs": [],
  "evidenceRefs": []
}
```

人工确认不会把 demo 参数或模型候选变成实测事实。`formalEligibility=eligible` 只能由正式产品流程根据真实证据、责任身份和权限决定，本样板固定为 `ineligible`。

## 三、术语冻结

现有 `bracketSeat`、`bracketArm` 和 `bearingBlock` 没有类型证据，不得称为斗栱，也不得使用栌斗、栱、昂等具体构件名。下一轮界面、图名和标注统一使用中性术语。

| 稳定键 | 中文显示名 | 类型状态 |
|---|---|---|
| `bracketSeat` | 承托座（团队演示） | 未知 |
| `bracketArm` | 承托臂（团队演示） | 未知；方向另记横向或纵向 |
| `bearingBlock` | 檩下承块（团队演示） | 未知 |
| 上述组合 | 檐下承托组合（团队演示，类型未判定） | 未知 |

领域术语使用以下字段：

```json
{
  "domainTerm": {
    "stableKey": "bracketArm",
    "displayNameZh": "承托臂（团队演示）",
    "typologyStatus": "neutralRole | evidenceConfirmed | unknown",
    "typologyClaim": null,
    "typologyEvidenceRefs": []
  }
}
```

若后续需要声明斗栱类型，必须提供团队自有且经过领域复核的构造定义，或提供可核查的项目证据，并新建 GeometryRevision。

## 四、GeometryContract 最小字段

### 1. 几何与构造状态

构件状态必须拆分，不再用一个 `resolved` 同时代表网格存在和构造成立。

```json
{
  "resolution": {
    "geometric": "resolved | simplified | placeholder | unknown",
    "construction": "demoDefined | evidenceResolved | unknown | notApplicable",
    "l1DemoEligibility": "eligible | blocked"
  },
  "assemblyRole": "...",
  "parentAssemblyId": "...",
  "memberRole": "...",
  "featureIds": [],
  "requiredFeatureProfile": "..."
}
```

`l1DemoEligibility=eligible` 只表示团队 demo 局部样板达到本合同，不改变 `formalEligibility=ineligible`。

### 2. 构造界面

每个承托、搭接、榫接、收口和间隙必须成为可追踪对象。

```json
{
  "interfaceId": "...",
  "fromEntityId": "...",
  "toEntityId": "...",
  "fromSurfaceRef": "...",
  "toSurfaceRef": "...",
  "interfaceKind": "bearing | lap | grooveSeat | mortiseTenon | halfLap | clearance | containment | closure | unknown",
  "contactMode": "surface | line | overlapZone | clearance | none",
  "interfaceStatus": "demoDefined | evidenceResolved | unknown | notApplicable",
  "direction": [0, 0, 1],
  "expectedGapMm": null,
  "maximumGapMm": null,
  "maximumUnexpectedOverlapMm3": null,
  "dimensionRefs": [],
  "factBasis": "demoParameter | derivedGeometry | measuredEvidence | expertDecision | unknown",
  "sourceRefs": []
}
```

所有容差必须在团队 demo fixture 中单独冻结。外部图纸不得提供数值。

### 3. 材料、尺寸和未知项

```json
{
  "materialFact": {
    "materialCode": "timber-demo",
    "displayNameZh": "木材演示材质",
    "factBasis": "demoParameter",
    "actualMaterialStatus": "demoDefined | evidenceResolved | unknown",
    "layerRole": "...",
    "sourceRefs": []
  },
  "dimensionFacts": [
    {
      "dimensionId": "...",
      "category": "...",
      "value": null,
      "unit": "mm",
      "factBasis": "demoParameter | derivedGeometry | measuredEvidence | expertDecision | unknown",
      "sourceRefs": [],
      "reviewStatus": "unreviewed | confirmed | rejected | superseded"
    }
  ],
  "unknowns": [
    {
      "unknownId": "...",
      "fieldPath": "...",
      "reasonCode": "NO_MEASURED_EVIDENCE",
      "requiredEvidence": "...",
      "blocksProfessionalClaim": true
    }
  ]
}
```

## 五、四个局部节点最低构造合同

### 1. 檐口节点

檐口样板必须表达从瓦面到柱的连续构件关系，而不是只显示瓦片和木构轮廓。

必备构件层级：凹面瓦、覆瓦、屋面板、主椽、檐部续接椽、檩、檩下承块、檐下承托组合、檐部横向木构件、柱，以及檐端收口构件或经过复核的 `notApplicable` 记录。

必备构造界面：

- 同类瓦的上下坡搭接、铺设次序和搭接区。
- 覆瓦对相邻凹面瓦的跨接关系。
- 瓦与屋面基层、基层与椽、椽与檩的接触关系。
- 檐部续接椽与主椽的连接，不得只做相交体块。
- 檩与檩下承块、承托组合和柱的连续承托关系。
- 檐端收口和排水方向；未知时必须列入 `unknowns`。

必备尺寸类别：瓦长、宽、厚度、搭接长度、行距，屋面板厚度，椽截面和间距，檩截面，出檐尺寸及承槽深度。具体数值使用团队 demo 参数，不得引用外部参考。

### 2. 檐下承托节点

承托样板必须表达檐部横向木构件、承托座、两向承托臂、檩下承块、檩和柱之间的受力次序。当前两根正交承托臂位于同一标高且没有交接构造，是 P0。

必备构造界面：柱与檐部横向木构件、横向木构件与承托座、承托座与两向承托臂、两向承托臂之间、承托臂与檩下承块、檩下承块与檩。每个界面必须给出接触面、连接类型和允许间隙。

必备视图：两个互相垂直的正投影视图，以及至少一个穿过两向承托臂交接处的局部剖面。单张正投影不能验收三维交接。

必备尺寸类别：组合总挑出、各构件截面、承槽或榫接深度、关键标高和有效承压面积。

### 3. 柱脚节点

柱脚样板必须表达柱、柱下承托石构件、台基层次、基础层体和室外地面的连续关系。柱下构件的具体类型没有证据，应使用“柱下承托石构件（演示类型未判定）”。

必备构造界面：柱与柱下承托石构件、石构件与台基、台基层次之间、台基与基础、基础与地基层体。承托链应同轴，设计接触面不得出现间隙，非设计区域不得互相穿入。

隐蔽固定方式没有证据时保持 `unknown`，不得添加螺栓、榫孔、灌浆或其他做法。当前 `steppedStoneFooting` 表示名称与 `earth-demo` 材料码矛盾，必须修正后才能进入新版本。

必备尺寸类别：柱径或截面、柱下构件高度和接触直径、台基层厚度和出挑、基础层宽高及关键标高。

### 4. 门窗节点

门窗样板必须以真实洞口、边框、扇框、格心和墙体收口构成，不得用相交方盒代表榫接。

必备构件层级：墙体洞口与洞口侧面、门框左右框和上框及下部边界、两扇门的边梃和横档及板心、窗外框、横竖格条、窗洞收口。

必备构造界面：门框转角连接、门扇边梃与横档连接、板心嵌槽、门扇与门框间隙、格条交接、窗框与墙体洞口收口。当前门框延长体、门扇构件重叠、格条相交和缺少窗洞不能作为 `mortiseTenonFrame` 的专业证据。

必备尺寸类别：洞口宽高、框料截面、门槛和上框标高、门扇厚度和间隙、板心分格和嵌槽、窗格截面与间距、窗台和窗上口标高。

## 六、现有实体状态与重建要求

### 1. 立即降级并重建

| 现有实体 | 数量 | 新状态 | 处理要求 |
|---|---:|---|---|
| `bracketSeat` | 4 | `geometric=simplified`；`construction=unknown` | 以中性承托术语重建接触面和连接特征 |
| `bracketArm` | 8 | `geometric=simplified`；`construction=unknown` | 重建两向构件及其交接构造 |
| `eaveBeam` | 2 | `geometric=simplified`；`construction=unknown` | 补柱、承托座和横向木构件的连接区域 |
| `doorFrame` | 1 | `geometric=simplified`；`construction=unknown` | 建立真实转角连接和洞口关系 |
| `doorLeaf` | 2 | `geometric=simplified`；`construction=unknown` | 重建边梃、横档、板心槽和门缝 |
| `latticeWindow` | 2 | `geometric=simplified`；`construction=unknown` | 重建外框、格条交接和墙体洞口 |
| `wall` | 2 | 门窗节点范围内 `geometric=simplified` | 建立洞口、侧面和收口 |
| `foundation` | 12 | `geometric=simplified`；`construction=unknown` | 解决名称与材质矛盾，重建层次和接触关系 |
| 主椽与 `flyRafter` 的交接区 | 32 组 | 局部 `construction=unknown` | 为选定 L1 实例增加真实连接特征 |
| 檐端收口 | 缺失 | `geometric=unknown`；`construction=unknown` | 新建构件或提交经复核的 `notApplicable` 记录 |

### 2. 可保留网格，但必须进入新版本复核

| 现有实体 | 数量 | 保留条件 |
|---|---:|---|
| `bearingBlock` | 4 | 鞍形槽几何可复用；类型和构造仍为 `unknown`；必须补齐界面并重新验证 |
| `panTile` | 504 | 几何可保留；补齐上下坡搭接、铺设次序和瓦面接触关系 |
| `coverTile` | 476 | 几何可保留；补齐跨接相邻凹面瓦和搭接关系 |
| `roofBoard` | 32 | 几何可保留；补基层与椽的界面 |
| `purlin` | 7 | 几何可保留；补承托链和槽口关系 |
| `column` | 4 | 几何可保留；补柱头和柱脚界面 |
| `columnBase` | 4 | 中性几何可保留；具体类型保持 `unknown` |
| `terrace` | 3 | 几何可保留；补材料层次和上下界面 |
| `groundLayer` | 2 | 几何可保留；补与基础的关系和事实依据 |

所有保留网格都要随新 GeometryRevision 重新计算签名、来源和独立验证结果。旧版实体不能直接继承 `l1DemoEligibility=eligible`。

## 七、病害与保护候选

当前 `COND-DEMO-001` 只有柱脚表面开裂的演示文字，没有目标实体、表面位置、尺度、图像或专业判断。它不能称为真实病害记录。

最小观察候选应为：

```json
{
  "observationCandidateId": "...",
  "targetEntityId": "...",
  "targetSurfaceRef": "...",
  "locationGeometry": {},
  "producerType": "demo",
  "factBasis": "demoParameter",
  "observationTextZh": "演示观察候选：柱脚表面线状异常；未完成现场复核",
  "diagnosis": null,
  "cause": null,
  "severity": null,
  "candidateStatus": "unreviewed | acceptedAsDemo | rejected | superseded",
  "formalEligibility": "ineligible",
  "evidenceRefs": []
}
```

保护建议只能作为候选，并关联观察候选：

```json
{
  "protectionRecommendationCandidateId": "...",
  "observationCandidateRef": "...",
  "recommendationTextZh": "补充近景、尺度和现场复核后，由专业人员决定是否形成保护措施",
  "candidateStatus": "unreviewed",
  "formalEligibility": "ineligible",
  "responsibleReviewerRef": null
}
```

不得在 demo 中给出真实病害成因、等级、材料处方、施工方法、工程量或保护结论。

## 八、ViewContract 修订

四张详图需增加以下字段：

```text
domainPurpose
requiredComponentRoles[]
requiredInterfaceIds[]
requiredFeatureIds[]
requiredSubViews[]
requiredSectionInterfaces[]
requiredDimensionFactIds[]
requiredMaterialFactIds[]
requiredUnknownIds[]
requiredObservationCandidateIds[]
displayTermMap{}
sourceStateLegend{}
interfaceVisibilityMatrix{}
```

机器门槛：

- 每个必备界面至少在一个视图中可见，或有明确剖切表达。
- 视图必须引用新 GeometryRevision、构件 ID、界面 ID 和特征 ID。
- 必备尺寸、材料、未知项和观察候选的输出覆盖率为 100%。
- 剖切、遮挡和材料区继续由独立验证器复算，不得导入生成器或生成端答案。
- 合同和输出中不得出现外部参考路径、哈希、图元或文字。
- 负例至少覆盖缺构件、移位、删连接、改变类型声明、改变材料、镜像、遮挡错误和来源篡改。

人工门槛：

- 每个节点同时查看三维轴测、必要正投影和关键连接剖面。
- 使用来源状态图例区分 demo、同源推导、人工确认和未知项。
- 领域审阅人检查构件次序、接触与搭接、承托路径、术语和未知项，不以图元数量或文件大小代替判断。

## 九、DrawingPackageContract 修订

图纸合同需增加或收紧以下字段：

```text
displayIndex
sheetRef
issueState: unissued | issued
issueDate: null | ISO-8601 date
drawingRevisionShort
displayStatusZh
contentCoverageMatrix{}
annotationTextStyles{}
conditionLayer
protectionCandidateLayer
sourceStateLegend{}
```

`generatedAt` 是系统生成时间，不能显示为业务发行日期。团队 demo 的图签固定显示“代理成果，未签发”；完整 UUID 留在 XDATA、清单或审计记录中，不直接占用图签。索引符号使用短编号，不得显示 `targetViewId` 等内部键。

机器门槛：

- 两张 A1 的视图、尺寸、材料、观察候选和未知项均通过 `contentCoverageMatrix` 校验。
- 原始内部 ID 泄露、文字碰撞、视口裁切、缺字、替换字符和非预期空图层均为零。
- 图签的发行状态、日期和修订号通过业务字段校验。
- DXF、SVG、PDF 和 PNG 绑定同一合同、几何版本和来源记录。
- 第二 CAD 往返未通过时，`L1=false` 必须保持不变。

人工门槛：

- 以 300 dpi 整页预览检查信息层级、字号、留白、图名、索引、尺寸、材料和说明。
- 四个节点必须形成可成组阅读的构造表达，不得以单张轮廓图代替。
- 图签、状态和责任说明对中文用户可读，且不冒充签发。

## 十、问题分级

### P0

1. 承托组合缺少两向构件交接，现有几何又使用可能被理解为斗栱的表现形式。
2. 门框、门扇和窗格以相交或延长体代替真实连接，墙体缺少完整洞口和收口。
3. 基础表示名称与材质码矛盾，柱脚层次和隐蔽关系未分清已知与未知。
4. 檐口缺少续接椽连接、檐端收口和完整构造界面。
5. 单一 `geometryStatus=resolved` 混合了网格存在、构造成立和专业资格。
6. 图纸仍存在内部索引泄露、文字冲突、错误业务日期、观察候选缺失和第二 CAD 往返失败。

以上第 1 至 5 项需要新的 GeometryRevision。第 6 项属于 ViewContract 或 DrawingPackageContract 修订，但必须重新绑定新几何版本。

### P1

- 补齐四个节点的尺寸类别、材料事实、未知项和来源说明。
- 补齐承托节点的两向视图和交接剖面。
- 统一中文显示名、短修订号、图签文字层级和页面占用。
- 复核索引语义、方位表达、条件图层和保护候选图层。

### P2

- 增加承托组合的分解图或透明关系图。
- 增加局部构件表和界面表。
- 增加按事实来源着色的审查预览。

P2 可提高审查效率，但不能替代 P0 和 P1。

## 十一、实施与验收顺序

1. 冻结中性术语、事实责任、状态枚举和字段 schema。
2. 为四个节点建立一个新的 GeometryRevision；只复用经过重新验证的网格。
3. 独立验证构件层级、界面、接触、搭接、榫接、承托路径、来源和负例。
4. 新建 ViewContract，生成满足节点合同的正投影、剖面和详图。
5. 修订 DrawingPackageContract，重新生成 DXF、SVG、PDF 和 PNG。
6. 进行 300 dpi 成组人工审查和第二 CAD 往返验证。

任何一步未通过时，状态保持 `generated-not-qualified`、`not-drawing-output` 或对应的中间状态；不得授予 L1。只有上述机器门槛和人工门槛全部满足，才能申请团队 demo 的 L1 局部样板复核。正式成果仍需真实测量证据、专业责任身份和签发流程。
