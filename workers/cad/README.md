# T0 CAD 可行性与质量验证

本目录是制图 worker 的前置验证，不是正式产品运行时。

- T0-A / L0 验证 IFC、GLB、DXF、SVG 和 PDF 链路。
- 当前 T0-B / L0+ 只验证古建对象分类、曲线、图层和多格式生成；它没有实现同源剖切，不通过 L1。
- L2 完整专业成果留给 T10 和 T14，必须符合 `../../文档/02_技术/02_专业制图与建模质量基准.md`。

所有试验数据均为 `demo`，不表示现场实测或正式成果。现有 T0-B 只具备“古建语义技术样例”资格，不具备“局部专业样板”“专业交付”或“正式签发”资格。

当前 T0-A 通过，T0-B 未通过，T0 总门槛未通过。现有 T0-B 输出保留为验收撤销证据。

## 环境

Python 3.12 / Windows x86-64 使用带 SHA-256 的锁文件：

```powershell
python -m venv workers\cad\.venv
workers\cad\.venv\Scripts\python.exe -m pip install `
  --require-hashes -r workers\cad\requirements.lock
```

`.venv` 和外部 CAD 安装包不进入 Git。外部软件版本、用途和限制见 `toolchain-lock.json`。

## 自动验证

```powershell
workers\cad\.venv\Scripts\python.exe -m unittest discover `
  -s workers\cad -p "test_*.py" -v
```

T0-A：

```powershell
workers\cad\.venv\Scripts\python.exe workers\cad\t0_generate.py `
  --spec "文档\05_验证证据\04_T0_CAD可行性与资产保全\minimal-hall.json" `
  --output "文档\05_验证证据\04_T0_CAD可行性与资产保全\outputs"

workers\cad\.venv\Scripts\python.exe workers\cad\t0_verify.py `
  --spec "文档\05_验证证据\04_T0_CAD可行性与资产保全\minimal-hall.json" `
  --output "文档\05_验证证据\04_T0_CAD可行性与资产保全\outputs"
```

T0-B：

```powershell
workers\cad\.venv\Scripts\python.exe workers\cad\t0b_generate.py `
  --spec "文档\05_验证证据\04_T0_CAD可行性与资产保全\professional-hall.json" `
  --output "文档\05_验证证据\04_T0_CAD可行性与资产保全\t0b-outputs"

workers\cad\.venv\Scripts\python.exe workers\cad\t0b_verify.py `
  --spec "文档\05_验证证据\04_T0_CAD可行性与资产保全\professional-hall.json" `
  --output "文档\05_验证证据\04_T0_CAD可行性与资产保全\t0b-outputs"
```

AutoCAD、Blender 和 QCAD 是外部验证工具，不是 worker 的产品依赖。QCAD 往返文件只作兼容性证据，系统生成的 DXF 才是规范文件。
