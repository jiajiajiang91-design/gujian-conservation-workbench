# t0b v2/v3 证据状态与失效说明

> 日期：2026-08-14
> 范围：2026-08-11 产生、经 T0b 保全的 v2 成图与 v3 几何历史证据
> 状态基线：这些资产全部属于失败或历史证据。当前有效的 CAD 资格证据是里程碑二的 `apps/server/.data/acceptance/milestone-two/autocad-audit-current` 与对应验证记录。

## 1. 结论

5 项旧 AutoCAD/QCAD 证据文件正式删除并在此记录失效原因；11 项大体积可重建产物不进入 Git 主线，仅保留哈希；其余小型记录、审查截图和 3 项已跟踪大文件随本提交进入 Git 作为历史证据。所有涉及成果保持 `generated-not-qualified / L1=false / 代理成果 / 未签发`。

## 2. 已删除证据（5 项）

删除原因（引自 T0b 分类清单）：当前 DXF 不属于 v3 同源链，独立双构建和 AutoCAD 复审未对当前哈希闭合，QCAD 无损往返失败。补充依据：QCAD 3.32.9 保存副本会重建 33 个原生尺寸并解除 10 个视口锁定，按 `13-12_专业制图与建模质量基准.md` v0.4，QCAD 只承担打开、查看、选择和打印兼容检查，其往返结果不再作为资格证据。

| 原路径（`t0b-v2-outputs/native-dxf/` 下） | Git headBlob |
|---|---|
| qcad-roundtrip-compatibility.json | `4f59342629648e5bac8145deed3a0a3009a16e0c` |
| qcad-roundtrip-compatibility.log | `24122aea9528256a7123e88e794484a9c6ee2e0e` |
| qcad-roundtrip-verifier-tests.log | `6c298821601801ae54807a7384da82a7c964ff06` |
| T0B-autocad-audit-summary.json | `32369cc7e8480d08a21ba710bec7873e61f98bf7` |
| T0B-dxf-verifier-tests.log | `662adbb2dee218fb2ad5153d1cad37f782eac567` |

文件内容仍可通过上述 blob ID 从 Git 历史取回，也保存在 `归档/recovery/2026-08-13-pre-t0b` 恢复包中。

## 3. 不进入 Git 主线的大体积产物（11 项）

以下产物可由已提交的生成器和 IR 重建，按 T0b 分类建议保留在本地忽略目录，公开发布时进入 GitHub Release。逐字节副本在 T0b 恢复包内，SHA-256 与 `验证材料/07_T0b资产保全/t0b-classified-asset-inventory.json` 一致：

| 路径 | 大小 | SHA-256 |
|---|---:|---|
| t0b-v2-outputs/drawing-package-artifacts/T0B-01.svg | 24,544,850 B | `7615bbb017505614a040ba72c799cb22d12b0b2921f9f65f73b0a7cf9ad321f0` |
| t0b-v2-outputs/drawing-package-artifacts/T0B-02.svg | 14,677,487 B | `29980d47e313f58f50d1157663216ee94fc0935a607744897c3656bde9756d69` |
| t0b-v2-outputs/drawing-package-artifacts/T0B.pdf | 1,469,508 B | `9d50f760c95e9534afba528640b4daa4598c967b5ab597aceaab2e9f3aa8d022` |
| t0b-v2-outputs/drawing-package-artifacts/T0B-01-300dpi.png | 661,870 B | `f9bd74b7e95ae3d1b0e70a0aee64fc3ee938f52aa347c6a306141462d03a15b7` |
| t0b-v2-outputs/drawing-package-artifacts/T0B-02-300dpi.png | 512,617 B | `5113e26ca684d46bec7b71789d807aa4b0e795b1d64fcaf31fdc93b26bdaa060` |
| t0b-v3-outputs/geometry/geometry-manifest.json | 4,536,751 B | `89743ec3e91cb66d5bbb400472d3db0ddae2836c73832a9e4a513eb3a69942c0` |
| t0b-v3-outputs/geometry/local-construction-sample.glb | 3,363,516 B | `e31038ef18e5b94f8007c68ec9c1d4bb0428348ba8fb0b3059badb7264012551` |
| t0b-v3-outputs/geometry/source-meshes.ndjson.gz | 3,165,469 B | `697a7ea14de10c7fcfc4e55a6f302747417229f413e08375b56d75039ab820b0` |
| t0b-v3-outputs/prefreeze-geometry/geometry-manifest.json | 10,833,398 B | `8821b800723453b40598cc78c05f5494bdf467ff5d4bc853b85bfb28094c992d` |
| t0b-v3-outputs/prefreeze-geometry/local-construction-sample.glb | 3,184,428 B | `059b254d9c9bf4eb0fbd187075f0826ade7cb7c52e73f89049281ee8b7c0d22f` |
| t0b-v3-outputs/prefreeze-geometry/source-meshes.ndjson.gz | 3,133,135 B | `8695bb739bdc3465c75fbfddf6420253a1d78ab2e7f4b9f85fd2c0ce3002cad6` |

## 4. 随本提交进入 Git 的历史证据状态

1. v2 成组图纸（drawing-package-ir、native-dxf 的 3 个大文件与小型记录、drawing-package-artifacts 小型记录与审查截图）：独立专业审查结论为拒绝，状态 `rejected`。已知问题包括图内英文内部 ID、文字碰撞、固定构建日期、病害与保护层为空、承托构造简化。
2. v3 旧 `geometry/` 输出记录（881 实体、24 接口）：已被 886 实体、2118 接口的 prefreeze 输出取代，状态 `superseded`。
3. v3 `prefreeze-verification.json`：引用上一版构建哈希，结论失效，状态 `invalidated`。里程碑二 T8a 已完成重验，见提交 `0b1c65d`。

## 5. 测试环境记录

2026-08-14 在 `workers/cad/.venv`（Python 3.12.13）复跑 v2 流水线测试：test_drawing_contract、test_drawing_ir、test_dxf_generation、test_sheet_outputs 共 49 项 unittest 全部通过；test_sheet_output_verifier 因 lxml 未在 `requirements.in` 声明而无法导入（Codex 原运行环境为 Python 3.14，依赖未回写锁定文件）。lxml 依赖补齐留待该流水线在后续任务中被正式启用时处理。
