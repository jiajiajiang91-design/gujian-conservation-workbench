# 项目驱动几何内核

该模块只接收 `GeometrySpec 2.0`，从类型化参数生成同一 `GeometryRevision` 下的 IFC、GLB、manifest、来源映射、技术报告和预览。

边界：

- 浏览器冻结项目版本、输入结构和哈希；
- Node 只创建受控作业目录并传递服务端路径；
- worker 不接收任意 URL、提示词、项目名称或用户提供的文件路径；
- 内部几何与 IFC 使用 Z-up、毫米；GLB 使用 Y-up、米；
- 技术验证只证明格式、哈希、实体闭包和声明接口，不授予专业资格；
- 所有新成果保持 `generated-not-qualified`、`L1=false`、未签发。

运行：

```powershell
workers/cad/.venv/Scripts/python.exe -m workers.cad.project_geometry.probe_environment
workers/cad/.venv/Scripts/python.exe -m unittest workers.cad.project_geometry.test_project_geometry workers.cad.project_geometry.test_verify_job
```
