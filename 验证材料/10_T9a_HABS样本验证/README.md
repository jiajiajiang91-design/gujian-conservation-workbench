# T9a HABS 样本冻结与最低资料审查

## 结论

Badin-Roque House（HABS LA-1294）满足本轮代理工程样本的最低资料要求。样本包含 9 张官方照片、10 张实测图、1 份资料 PDF 和 1 份照片说明 PDF。所有原始文件来自 Library of Congress 官方存储地址，并已记录字节数与 SHA-256。

该结论只确认资料来源、许可提示和输入完整度，不能证明中国古建语义能力，也不能授予专业资格。样本仍为 `proxy-engineering-benchmark-only`、`L1=false`、不可正式签发。

## 来源与权利边界

- 官方记录：[Library of Congress：Badin-Roque House](https://www.loc.gov/pictures/item/la0415/)
- 调查号：`HABS LA-1294`
- 官方记录列出：9 张照片、10 张实测图、1 页照片说明。
- 权利提示：美国政府制作的图像无已知限制；复制自其他来源的图像可能另有限制。
- 本轮不扩大该提示，不把资料表述为无条件公有领域。

官方目录 JSON 接口在冻结时持续返回 HTTP 429，因此没有把限流响应伪装成官方文件。目录字段保存为系统元数据审查记录；21 个可下载原始文件仍全部来自 LOC 官方域名。

## 最低资料矩阵

| 要求 | 结果 | 证据 |
|---|---|---|
| 官方来源与权利提示 | 通过 | `badin-roque-record-review.json` |
| 多方向照片 | 通过 | 东、北、东北、东南视图 |
| 构件近景 | 通过 | 门、墙体填充与尺度照片 |
| 平面 | 通过 | sheet 03 |
| 立面 | 通过 | sheet 04、05 |
| 剖面 | 通过 | sheet 06、07、08 |
| 节点与构造 | 通过 | sheet 06、07、09、10 |
| 带单位尺寸 | 通过 | 英尺、英寸、毫米比例尺及尺寸链 |
| 调查或测量元数据 | 通过但有限制 | 调查号、制图人员、制图年份、摄影师与摄影年份可查；现场笔记 N613 未数字化 |
| 每文件 SHA-256 | 通过 | `badin-roque-asset-manifest.json` |

## 数据责任

`badin-roque-dimension-candidates.json` 中的尺寸是从实测图转写的模型候选，不冒充人工确认事实。每项保留原始字符串、图号、位置、单位换算和证据引用。进入项目后必须由责任人确认，确认也不会补造缺失的测量人、时间或方法。

## 文件说明

- `badin-roque-source-plan.json`：受控下载计划。
- `badin-roque-asset-manifest.json`：21 个官方原始文件的哈希清单。
- `badin-roque-record-review.json`：官方记录、来源和未知项。
- `badin-roque-sheet-review.json`：十张实测图的图种覆盖。
- `badin-roque-dimension-candidates.json`：可追溯的尺寸候选。
- `badin-roque-verification.json`：独立验证报告，54 项检查，失败 0。
- `badin-roque-drawings-contact.png`、`badin-roque-photos-contact.png`：人工成组检查图。
- `badin-roque-preview-record.json`：审查渲染尺寸记录。

原始 TIFF/PDF 位于 `apps/server/.data/acceptance/milestone-two/samples/habs-la0415/raw`，不进入 Git 主线。
