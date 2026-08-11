# T0-B v2


## 当前实现：剖切与可见线 ViewGeometry

六个主视图已从同一套三维网格生成中间视图数据：

- 平面在 `z=1800 mm` 真剖，并投影切面以下的台基、台阶和地层。
- 横剖在 `x=-1750 mm` 真剖，穿过一榀柱架、承托、檩、椽、屋面、柱础和基础。
- 纵剖在 `y=0` 真剖，基础底标高只作剖后参照，不冒充切面。
- 遮挡通过线段与投影三角面的覆盖区间及深度差解析计算，不依赖固定间距采样。
- 每条结构线保留来源构件、几何版本、视图合同版本、生成方式和坐标变换。
- 源网格包使用固定 SHA-256 绑定顶点、面索引和面方向；构件类型、来源或关系变化也会阻断生成。
- 屋顶平面只表达瓦作、屋脊和屋面边界，不透出屋面下木构。
- 南立面表达屋面、檐口、承托、前柱、南侧门窗、台基和踏步，不透出北排构件。
- 轴测表达两坡瓦作、屋脊、木构、门窗和台基层次，并按真实深度消隐。

独立验证器不读取生成器答案。剖面验证器重新计算切面边界、构件集合、闭合区域、来源边和遮挡；投影验证器重新建立完整候选边和可见区间，检查应见线、禁入线、来源、坐标绑定、镜像和重边。篡改顶点、面方向、构件类型、关系、来源、二维坐标、视图框架、剖面材料或投影线均会失败。

当前结果为 `passed-section-geometry-only` 和 `passed-projection-geometry-only`，仍是 `generated-not-qualified / not-drawing-output / L1=false`。各视图线数只记录冻结结果，不是质量指标。四张详图、DXF、SVG、PDF、尺寸、标高和专业复核尚未完成。

```powershell
workers\cad\.venv\Scripts\python.exe -m workers.cad.t0b_v2.build_sections `
  --fixture <fixture> --manifest <manifest> --source-meshes <source-meshes> --output-dir <sections>

workers\cad\.venv\Scripts\python.exe -m workers.cad.t0b_v2.verify_sections `
  --fixture <fixture> --manifest <manifest> --source-meshes <source-meshes> `
  --sections-dir <sections> --output <report>

workers\cad\.venv\Scripts\python.exe -m workers.cad.t0b_v2.build_projections `
  --fixture <fixture> --manifest <manifest> --source-meshes <source-meshes> `
  --output-dir <projections>

workers\cad\.venv\Scripts\python.exe -m workers.cad.t0b_v2.verify_projections `
  --fixture <fixture> --manifest <manifest> --source-meshes <source-meshes> `
  --projections-dir <projections> --output <report>
```
本目录重建 T0-B，不扩展旧 `t0b_generate.py`。

## 原则

1. 冻结样本只保存构造数据、来源、要求和已知答案，不保存人工补画的二维建筑几何。
2. 语义三维构件只建立一次。平面、立面和剖面由同一 `geometryRevisionId` 投影或求交。
3. DXF、SVG 和 PDF 只负责图层、标注、图签和布图，不建立第二套建筑形体。
4. 生成器只输出事实和诊断，不自行授予 L1 资格。
5. 对象数、图元数和文件大小不能作为专业通过条件。

## 实施顺序

1. `contracts.py` 验证冻结样本、构件拓扑、视图矩阵和验收要求。
2. 几何模块建立可选择的构件、稳定 ID、连接关系和来源状态。
3. 视图模块从同一构件网格生成真实剖切，以及完成遮挡判断的可见线投影；不得直接投影三角网内部边。
4. 制图模块生成 DXF、SVG 和 PDF，并附图纸要求覆盖矩阵。
5. 独立验证器重算剖切和尺寸；专业人员完成成组预览复核。

当前目录已完成第 1、2 步、视图合同，以及平面、屋顶平面、南立面、横剖、纵剖和轴测的中间 ViewGeometry。生成记录固定为 `generated-not-qualified`，十个视图、成组图纸和专业复核全部通过前不得申请 L1。

视图合同补齐十个视图的坐标框架、观察方向、裁切范围、标注安全区、纸面变换和逐视图金标准。横剖面固定在稳定的 `x=-1750 mm`，穿过同一榀的柱、柱础、基础、承托、檩和屋面，并通过 `±0.5 mm` 扰动复算。四个详图均绑定一个稳定构件实例和局部范围。现有生成器只能读取剥离 oracle 后的白名单输入。合同说明见 `VIEW_CONTRACT.md`。

主剖面的真实切面不筛构件；剖后投影按冻结的语义类型集合处理，排除重复瓦件、椽网格和三角内部边。CAD 图层先按几何线类确定，隐藏状态只作覆盖，避免可见线覆盖外轮廓与内部特征的基础线宽。

```powershell
workers\cad\.venv\Scripts\python.exe -m workers.cad.t0b_v2.build_geometry `
  --fixture 验证材料\06_T0_CAD可行性验证\t0b-v2-resolved-local-assembly.json `
  --output-dir 验证材料\06_T0_CAD可行性验证\t0b-v2-outputs
```

当前几何输出包含稳定构件 ID、材料、来源、连接关系、冻结几何签名、GLB 和 JSON 清单。生成器只读取团队 `demo` fixture；外部参考图和 DWG 不进入输入或输出。

当前冻结版本为 `3788f4e4-339c-568d-aa58-f74b36b23c5a`，几何签名为 `55954253257e...`。版本 UUID 由冻结签名确定，几何变化不能复用旧版本号。

独立几何验证器 2.0.0 不导入生成器，直接核对导出前网格包与 GLB。当前检查包括：

- 双坡在正脊处 C0 相接，保留非零坡度转折；每侧内部曲线连续。
- 板瓦和筒瓦保持独立短瓦实体、100 mm 纵向搭接和可见行缝。
- 1,925 个屋面法向首交样点均先接触瓦作，没有连续露出木基层。
- 檩条、承块、内柱和承托臂核对槽口误差、横向偏移和承压面积。
- 1,166 个构件逐项核对来源网格哈希、顶点、面索引、坐标和边界。
- 11 个负例覆盖外部来源、导出篡改、瓦类互换、共面搭接、缺瓦和承托错位。

三张 Blender 预览分别检查整体、双坡正交侧视和瓦作搭接近景。每张预览的 JSON 侧车文件记录 GLB 哈希、Blender 版本、脚本哈希、相机和输出哈希。预览通过不等于专业资格通过。

受控局部样本使用 trimesh 和 Shapely 完成真实剖切、剖后投影，以及屋顶平面、南立面和轴测的同源轮廓边、特征边、构件边界和解析遮挡。下一步生成四张局部详图；ezdxf 制图尚未开始。T10 / L2 继续保留 IfcOpenShell / OpenCascade HLR 路线。
