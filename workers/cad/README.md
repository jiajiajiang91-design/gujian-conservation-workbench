# T0 CAD 可行性与质量验证

本目录是制图 worker 的前置验证，不是正式产品运行时。

- T0-A / L0 验证 IFC、GLB、DXF、SVG 和 PDF 链路。
- T0-B / L1 验证曲面屋面、瓦作、木构、门窗、台基、同源剖切和局部专业图面。
- L2 完整专业成果留给 T10 和 T14，必须符合 `13-12_专业制图与建模质量基准.md`。

所有试验数据均为 `demo`，不表示现场实测或正式成果。T0-B 只具备“局部专业样板”资格，不具备“专业交付”或“正式签发”资格。

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
  --spec "验证材料\06_T0_CAD可行性验证\minimal-hall.json" `
  --output "验证材料\06_T0_CAD可行性验证\outputs"

workers\cad\.venv\Scripts\python.exe workers\cad\t0_verify.py `
  --spec "验证材料\06_T0_CAD可行性验证\minimal-hall.json" `
  --output "验证材料\06_T0_CAD可行性验证\outputs"
```

T0-B：

```powershell
workers\cad\.venv\Scripts\python.exe workers\cad\t0b_generate.py `
  --spec "验证材料\06_T0_CAD可行性验证\professional-hall.json" `
  --output "验证材料\06_T0_CAD可行性验证\t0b-outputs"

workers\cad\.venv\Scripts\python.exe workers\cad\t0b_verify.py `
  --spec "验证材料\06_T0_CAD可行性验证\professional-hall.json" `
  --output "验证材料\06_T0_CAD可行性验证\t0b-outputs"
```

AutoCAD、Blender 和 QCAD 是外部验证工具，不是 worker 的产品依赖。QCAD 往返文件只作兼容性证据，系统生成的 DXF 才是规范文件。
