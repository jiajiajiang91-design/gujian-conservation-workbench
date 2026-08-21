# 项目约束（古建保护归档）

本项目所有产出（对话回复、文档、模板）都遵守以下约束，优先级高于任何 agent 或模板的默认行为。

## 语言与文风

- 全部用中文输出，面向中文母语读者
- 禁止口语化表达、互联网黑话、空洞形容词、情感渲染词
- 禁用直角引号「」和破折号
- 完整规范见 `.claude/skills/prd-write/references/doc-guidelines.md`（文档书写规范）和 `diagram-guidelines.md`（图表使用规范）

## 文档产出

- 每个章节第一句是结论
- 数据必须标注来源，未验证的判断标注为假设并给出验证方式
- 这是 0→1 项目：模板中非必要模块标注（可选），不套用成熟大厂流程


## 角色分工

- 六个角色：project-lead（任务入口与编排）、pm-assistant（产品分析与判断）、research-expert（调研与研报）、heritage-domain-reviewer（古建专业审阅）、doc-writer（正式文档撰写）、solution-architect（技术架构）。协作流程与角色定义的迭代原则见 `.claude/context/协作体系.md`
- 默认在主对话按角色切换执行以节省 token，仅需要隔离上下文的长任务才起子 agent
- 产品领域上下文统一维护在 `.claude/context/pm-context.md`，不要在多处复制粘贴产品状态
