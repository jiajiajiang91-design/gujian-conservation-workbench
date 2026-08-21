import {
  EvidenceSketchInputSchema,
  ProxyDrawingInputSchema,
  type EvidenceSketchInput,
  type ProjectSnapshot,
  type ProxyDrawingInput,
  type Quantity,
} from '../domain'

export interface GeneratedArtifactFile {
  kind: 'elevation-svg' | 'elevation-dxf' | 'evidence-sketch-svg' | 'check-report' | 'delivery-manifest'
  fileName: string
  mime: 'image/svg+xml' | 'application/dxf' | 'text/plain' | 'application/json'
  bytes: Uint8Array
}

const encoder = new TextEncoder()

function escapeXml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => {
    const replacements: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&apos;',
      '"': '&quot;',
    }
    return replacements[character]
  })
}

function safeDxfText(value: string): string {
  return value.replace(/[\r\n\0-\x1f]/g, ' ').slice(0, 200)
}

function millimetres(quantity: Quantity): number {
  if (quantity.unit === 'mm') return quantity.value
  if (quantity.unit === 'cm') return quantity.value * 10
  if (quantity.unit === 'm') return quantity.value * 1_000
  throw new Error('角度不能作为立面长度')
}

function dxfLine(x1: number, y1: number, x2: number, y2: number, layer = 'OUTLINE'): string {
  return `0\nLINE\n8\n${layer}\n10\n${x1}\n20\n${y1}\n30\n0\n11\n${x2}\n21\n${y2}\n31\n0\n`
}

function dxfText(x: number, y: number, height: number, text: string, layer = 'ANNOTATION'): string {
  return `0\nTEXT\n8\n${layer}\n10\n${x}\n20\n${y}\n30\n0\n40\n${height}\n1\n${safeDxfText(text)}\n`
}

export function generateElevationProxy(
  inputValue: ProxyDrawingInput,
  project: ProjectSnapshot,
): GeneratedArtifactFile[] {
  const input = ProxyDrawingInputSchema.parse(inputValue)
  if (input.projectId !== project.project.id) throw new Error('代理制图输入不属于当前项目')

  const spans = input.geometry.baySpans.map((span) => ({
    ...span,
    width: millimetres(span.width),
  }))
  const totalWidth = spans.reduce((sum, span) => sum + span.width, 0)
  const baseHeight = millimetres(input.geometry.baseHeight)
  const columnHeight = millimetres(input.geometry.columnHeight)
  const roofRise = millimetres(input.geometry.roofRise)
  const scale = 900 / totalWidth
  const left = 100
  const baseline = 620
  const baseY = baseline - baseHeight * scale
  const eaveY = baseY - columnHeight * scale
  const ridgeY = eaveY - roofRise * scale
  const right = left + totalWidth * scale
  const centre = (left + right) / 2
  const boundaries = [left]
  for (const span of spans) boundaries.push(boundaries.at(-1)! + span.width * scale)

  const columns = boundaries
    .map(
      (x) =>
        `<line x1="${x.toFixed(2)}" y1="${baseY.toFixed(2)}" x2="${x.toFixed(2)}" y2="${eaveY.toFixed(2)}" />`,
    )
    .join('')
  const dimensions = spans
    .map((span, index) => {
      const x1 = boundaries[index]
      const x2 = boundaries[index + 1]
      const y = baseline + 54
      return `<g><line x1="${x1.toFixed(2)}" y1="${y}" x2="${x2.toFixed(2)}" y2="${y}" marker-start="url(#arrow)" marker-end="url(#arrow)"/><text x="${((x1 + x2) / 2).toFixed(2)}" y="${y - 8}" text-anchor="middle">${span.width.toFixed(0)} mm</text></g>`
    })
    .join('')
  const limitations = input.limitations.map((item) => `<li>${escapeXml(item)}</li>`).join('')
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="820" viewBox="0 0 1200 820" role="img" aria-labelledby="title desc" data-provenance="demo:${input.fixtureId}">
  <title id="title">${escapeXml(project.project.name)}代理立面成果</title>
  <desc id="desc">使用独立演示几何生成，不代表现场实测。</desc>
  <defs><marker id="arrow" markerWidth="6" markerHeight="6" refX="3" refY="3" orient="auto"><path d="M6 0L0 3L6 6" fill="none" stroke="#475467"/></marker></defs>
  <rect width="1200" height="820" fill="#fff"/>
  <g fill="none" stroke="#101828" stroke-width="2">
    <line x1="${left}" y1="${baseline}" x2="${right}" y2="${baseline}"/>
    <line x1="${left}" y1="${baseY}" x2="${right}" y2="${baseY}"/>
    ${columns}
    <polyline points="${left},${eaveY.toFixed(2)} ${centre.toFixed(2)},${ridgeY.toFixed(2)} ${right},${eaveY.toFixed(2)}"/>
    <line x1="${left}" y1="${eaveY.toFixed(2)}" x2="${right}" y2="${eaveY.toFixed(2)}"/>
  </g>
  <g fill="none" stroke="#475467" stroke-width="1" font-family="Noto Sans SC, Microsoft YaHei, sans-serif" font-size="13" fill-rule="evenodd">${dimensions}</g>
  <g font-family="Noto Sans SC, Microsoft YaHei, sans-serif" fill="#101828">
    <text x="100" y="70" font-size="24" font-weight="700">${escapeXml(project.project.name)} · 代理立面成果</text>
    <text x="100" y="98" font-size="14" fill="#b54708">演示几何 / 不可用于正式成果</text>
    <text x="100" y="748" font-size="13">总开间宽度：${totalWidth.toFixed(0)} mm　柱高：${columnHeight.toFixed(0)} mm　屋面举高：${roofRise.toFixed(0)} mm</text>
    <foreignObject x="100" y="762" width="1000" height="50"><ul xmlns="http://www.w3.org/1999/xhtml" style="margin:0;padding-left:18px;font:12px sans-serif;color:#667085">${limitations}</ul></foreignObject>
  </g>
</svg>`

  let x = 0
  const dxfBoundaries = [0]
  for (const span of spans) {
    x += span.width
    dxfBoundaries.push(x)
  }
  let entities = dxfLine(0, 0, totalWidth, 0)
  entities += dxfLine(0, baseHeight, totalWidth, baseHeight)
  for (const boundary of dxfBoundaries) {
    entities += dxfLine(boundary, baseHeight, boundary, baseHeight + columnHeight)
  }
  entities += dxfLine(0, baseHeight + columnHeight, totalWidth / 2, baseHeight + columnHeight + roofRise, 'ROOF')
  entities += dxfLine(totalWidth / 2, baseHeight + columnHeight + roofRise, totalWidth, baseHeight + columnHeight, 'ROOF')
  entities += dxfLine(0, baseHeight + columnHeight, totalWidth, baseHeight + columnHeight, 'ROOF')
  entities += dxfText(0, -700, 220, `${project.project.name} PROXY / DEMO GEOMETRY`)
  for (let index = 0; index < spans.length; index += 1) {
    entities += dxfText(
      (dxfBoundaries[index] + dxfBoundaries[index + 1]) / 2,
      -350,
      160,
      `${spans[index].width.toFixed(0)} mm`,
      'DIMENSION',
    )
  }
  const dxf = `0\nSECTION\n2\nHEADER\n9\n$ACADVER\n1\nAC1015\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n${entities}0\nENDSEC\n0\nEOF\n`

  const issueLines = project.issues.map(
    (issue) => `- ${issue.severity.toUpperCase()} / ${issue.type} / ${issue.blockerCodes.join(', ') || '无阻断码'}`,
  )
  const report = `# ${project.project.name}代理成果检查报告

- 项目版本：${project.revision.id}
- 生成器：proxy-elevation/1.0.0
- 来源类型：demo
- 演示输入：${input.id}
- 正式资格：不具备

## 几何检查

- 开间数：${spans.length}
- 开间合计：${totalWidth.toFixed(0)} mm
- 柱高：${columnHeight.toFixed(0)} mm
- 屋面举高：${roofRise.toFixed(0)} mm
- 完整性：通过代理制图输入 schema

## 项目原始问题

${issueLines.length ? issueLines.join('\n') : '- 当前版本没有登记问题。'}

## 限制

${input.limitations.map((item) => `- ${item}`).join('\n')}
`

  return [
    { kind: 'elevation-svg', fileName: 'proxy-elevation.svg', mime: 'image/svg+xml', bytes: encoder.encode(svg) },
    { kind: 'elevation-dxf', fileName: 'proxy-elevation.dxf', mime: 'application/dxf', bytes: encoder.encode(dxf) },
    { kind: 'check-report', fileName: 'proxy-check-report.md', mime: 'text/plain', bytes: encoder.encode(report) },
  ]
}

export function generateEvidenceSketchProxy(
  inputValue: EvidenceSketchInput,
  project: ProjectSnapshot,
): GeneratedArtifactFile[] {
  const input = EvidenceSketchInputSchema.parse(inputValue)
  if (input.projectId !== project.project.id) throw new Error('证据草图输入不属于当前项目')
  const boxes = input.boxes
    .map((box, index) => {
      const x = 80 + box.x * 1_040
      const y = 130 + box.y * 520
      const width = box.width * 1_040
      const height = box.height * 520
      return `<g><rect x="${x}" y="${y}" width="${width}" height="${height}"/><text x="${x + 6}" y="${y + 18}">${index + 1}. ${escapeXml(box.label)}</text></g>`
    })
    .join('')
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="760" viewBox="0 0 1200 760" role="img" aria-labelledby="title desc" data-provenance="demo:${input.fixtureId}">
  <title id="title">${escapeXml(project.project.name)}五开间证据草图</title>
  <desc id="desc">基于已有照片框选位置生成，不包含实测尺寸。</desc>
  <rect width="1200" height="760" fill="#fff"/><rect x="80" y="130" width="1040" height="520" fill="#f2f4f7" stroke="#d0d5dd"/>
  <g font-family="Noto Sans SC, Microsoft YaHei, sans-serif"><text x="80" y="65" font-size="24" font-weight="700">${escapeXml(project.project.name)} · 五开间证据草图</text><text x="80" y="94" font-size="14" fill="#b54708">照片框选草图 / 无实测尺寸 / 不生成立面 DXF</text><text x="100" y="160" fill="#667085">${escapeXml(input.photoLabel)}</text></g>
  <g fill="none" stroke="#2563eb" stroke-width="2" font-family="Noto Sans SC, Microsoft YaHei, sans-serif" font-size="13">${boxes}</g>
</svg>`
  const report = `# ${project.project.name}资料不足检查报告

- 项目版本：${project.revision.id}
- 生成器：proxy-evidence-sketch/1.0.0
- 来源类型：demo
- 已识别框选数量：${input.boxes.length}
- 尺寸立面 SVG：阻断
- 尺寸立面 DXF：阻断
- 可输出：五开间证据草图 SVG、结构化项目数据、检查报告

## 阻断原因

- MEASUREMENT_RECORD_MISSING
- EVIDENCE_MISSING

## 限制

${input.limitations.map((item) => `- ${item}`).join('\n')}
`
  return [
    { kind: 'evidence-sketch-svg', fileName: 'five-bay-evidence-sketch.svg', mime: 'image/svg+xml', bytes: encoder.encode(svg) },
    { kind: 'check-report', fileName: 'missing-data-check-report.md', mime: 'text/plain', bytes: encoder.encode(report) },
  ]
}

export function generateDeliveryManifestFile(value: unknown): GeneratedArtifactFile {
  return {
    kind: 'delivery-manifest',
    fileName: 'delivery-manifest.json',
    mime: 'application/json',
    bytes: encoder.encode(JSON.stringify(value, null, 2)),
  }
}
