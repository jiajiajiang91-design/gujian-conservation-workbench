# T8b 通用几何内核验证

## 结论

工作台已通过当前项目版本创建受控 CAD 作业，Node 只保存运行账本和临时输出，Python worker 从 `GeometrySpec 2.0` 生成同一 `GeometryRevision` 下的 IFC、GLB、manifest、来源映射、技术报告和预览。浏览器核对事件链与文件哈希后，才通过命令服务写入 IndexedDB。

当前结果只通过技术闭包检查，状态保持：

- `generated-not-qualified`
- `L1=false`
- 代理成果
- 未签发
- 不可用于正式交付或施工

## 浏览器路径

1. 新建项目“通用几何内核浏览器验收”。
2. 打开“三维模型”。
3. 浏览器冻结 GeometrySpec、项目版本和输入哈希。
4. Node 建立受控作业，Python 生成 IFC、GLB、来源映射、报告和预览。
5. 浏览器校验 SSE 事件链与输出哈希，提交 GeometryRevision。
6. 点击“演示柱”，显示稳定键、`demo` 来源、结构化未知项和正式资格阻断。

浏览器生成的正式技术验证记录为 `browser-geometry-verification.json`，8 项检查失败数为 0。成果哈希见 `browser-geometry-artifact-hashes.json`。大型原始输出保存在忽略目录 `apps/server/.data/cad-staging`，不进入 Git。

## 通用化门槛

- worker 不读取项目 ID、项目名称或样本名称分支；
- 输入禁止 URL、绝对路径、DWG/DWT、提示词和未知字段；
- length、angle、count、ratio、text 分别校验单位；
- 两套对象数量和形制不同的 GeometrySpec 使用同一内核生成；
- 接口以实际几何间隙和布尔重叠验证；
- 内部与 IFC 使用 Z-up、毫米，GLB 使用 Y-up、米；
- IFC、GLB、manifest、来源映射、报告和预览共享 GeometryRevision；
- 验证器只输出技术结果，不能授予专业资格。

## 测试

| 范围 | 结果 |
| --- | --- |
| 根领域、命令、存储 | 31/31 通过 |
| Node 服务 | 8/8 通过 |
| React 工作台 | 3/3 通过 |
| 旧行为保护 | 14/14 + 17/17 通过 |
| 项目驱动几何与攻击验证 | 6/6 通过 |
| Windows CAD 环境 | CadQuery 2.8.0、cadquery-ocp 7.9.3.1.1、IfcOpenShell 0.8.5，4/4 通过 |
| 类型检查与构建 | 通过；Three.js 主包拆分列入后续性能待办 |
| 进程 | 测试后 5173、8787 无监听 |

## 已修复的浏览器验收问题

1. 查看器 canvas 在高 DPI 下反复放大，已改为固定容器高度和 CSS 尺寸同步。
2. GLB 原先直接写入 Z-up 坐标，已在导出边界转换为 Y-up，并由独立验证器逆变换校验源 mesh hash。

截图 `浏览器_三维构件来源与阻断.png` 展示当前代理模型、构件选择、来源和资格阻断。它是界面证据，不替代专业质量判断。
