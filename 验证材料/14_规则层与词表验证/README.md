# 14 规则层与词表验证（R1 至 R4）

本目录记录 PRD 线四个提交单元（声明式规则层、多方案停靠、受控词表、形制参数层）的验证证据。依据 13-8 PRD v1.3 的 R012 至 R014 与 13-9 架构 v1.4 的 5.5 至 5.7 节。验证日期 2026-08-16，分支 codex/professional-workbench-rebuild。

## 一、结论

四个提交单元全部实现并通过验证。规则数据版本 heritage-baseline-1.0.0@2fe163ae046f0e8c；全仓门禁（typecheck、packages 73 测试、server 57 测试、workbench 32 测试、legacy 31 测试）全绿；两项浏览器端到端验证（形制登记与应然实测对照、举架系数多方案选择）完成。

## 二、测试矩阵

| 验证对象 | 测试文件 | 用例数 | 覆盖点 |
| --- | --- | --- | --- |
| 表达式求值器与规则集 | packages/infrastructure/src/rule-engine.ts 的 rule-engine.test.ts | 9 | 公式解析、跨规则依赖拓扑、循环依赖拒绝、按实计映射 unknown、双规则集并列求值 |
| 规则数据文件 | rules/heritage-baseline-v1.ts（经 RuleDataFileSchema 全表校验） | 含于上 | schemaVersion、公式标识符合法性、出处必填 |
| 受控词表 | vocabulary-resolver.test.ts | 7 | 种子词表 Zod 校验、broader 闭包匹配、别名解析、无词表回退前缀规则 |
| 形制参数派生 | archetype-derivation.test.ts | 4 | 网表解析、清做法系数组应然值（通进深 3600、均分步架 600、金步举高 390、檐柱高按实计）、同输入同输出哈希、实测对照差值与容差判定 |
| 多方案停靠 | workflow-service.test.ts | 5 内含 1 | roofFrame 事实触发 lift-ratio-selection 问题、两方案各带出处、选定后关闭不重建 |
| 项目包词表往返 | project-package-service.test.ts | 6 内含 2 | 含词表条目导出导入往返、旧包无词表字段兼容导入 |

## 三、浏览器端到端证据

### 3.1 形制登记与应然实测对照（R4）

在 团队演示构造项目（fixture r2，导入自 apps/server/.data/acceptance/milestone-three/third-project）测量与尺寸依据页登记形制参数：逐间面阔 4800，逐间进深 1800,1800，步架数 3，模数基参 D 380，系数组清工程做法，柱网 4 柱，枋连接 4 条。

登记后对照表渲染结果：通面阔应然 4800 mm、通进深 3600 mm、均分步架 600 mm、檐步举高 300 mm（±15mm）、金步举高 390 mm（±19.5mm）、上金步举高 450 mm（±22.5mm）、脊步举高 540 mm（±27mm）、檐柱高按实计；每项带出处文本；无实测项如实显示"无实测记录"，未用应然值补齐。派生以 RuleRun 入来源链（模型/规则运行 1 项已关联）。

### 3.2 举架系数多方案选择（R2）

用 fixtures/lift-ratio-demo.project.json（生成脚本 packages/infrastructure/scripts/build-lift-ratio-demo-package.mjs，走真实 CreateProject、CommitFacts、workflow.evaluate 命令路径）导入含已确认 roofFrame.totalDepthMm 3600 与 roofFrame.stepCount 3 事实的项目。问题队列出现 lift-ratio-selection 停靠，两方案并列：梁思成图纸系数组与清工程做法系数组，各带四架举高数值与出处（转引自 ACA-Builder const.py 系数注释）。

选定清工程做法系数组并填写理由后：问题关闭，界面提示"方案已选定并记录出处"。IndexedDB decisions 表核对：outcome accepted、selectedOptionId qing-gongcheng-zuofa、理由完整持久化。

## 四、开发环境问题记录

浏览器 127.0.0.1:5173 源的 IndexedDB 后端在开发中因 HMR 残留连接卡死（v6 到 v7 升级被永久阻塞，删除库亦被占用，重启开发服务器无效，属浏览器进程级状态）。修复：openWorkbenchDatabase 为连接挂 versionchange 处理，升级发起时旧连接主动关闭（提交 281dd70）。onblocked 场景的界面文案（数据库升级被其他工作台页面阻止）此前已有。本次端到端验证在 localhost:5173 源完成，该源 v6 到 v7 升级一次成功，验证了升级代码本身正确。

## 五、文件清单

- fixtures/lift-ratio-demo.project.json：多方案停靠演示项目包（含 2 条已确认 roofFrame 事实与 1 个开放双方案问题）
- 生成脚本：packages/infrastructure/scripts/build-lift-ratio-demo-package.mjs（需先构建 packages dist）
