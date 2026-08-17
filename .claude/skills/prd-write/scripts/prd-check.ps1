# PRD 机器校验：检查骨架、表达与图表规范。
# 用法：pwsh -File prd-check.ps1 -Path <PRD文件路径> [-ProductLevel]
# 退出码 0 表示全过，1 表示存在 issue。

param(
    [Parameter(Mandatory = $true)][string]$Path,
    [switch]$ProductLevel
)

$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $Path)) { throw "文件不存在: $Path" }

$text = Get-Content -LiteralPath $Path -Raw -Encoding UTF8
$lines = $text -split "`r?`n"
$issues = @()
$warnings = @()

function Add-Issue([string]$m) { $script:issues += $m }
function Add-Warn([string]$m) { $script:warnings += $m }

# 1 骨架完整性
$required = @(
    @{ p = '^##\s*1\.\s*文档信息'; n = '1. 文档信息' },
    @{ p = '^###\s*1\.1\s*需求摘要'; n = '1.1 需求摘要' },
    @{ p = '^###\s*1\.2\s*流程概览'; n = '1.2 流程概览' },
    @{ p = '^##\s*2\.\s*需求背景'; n = '2. 需求背景' },
    @{ p = '^###\s*2\.3\s*现状与问题'; n = '2.3 现状与问题' },
    @{ p = '^###\s*2\.5\s*目标与价值'; n = '2.5 目标与价值' },
    @{ p = '^##\s*3\.\s*业务流程'; n = '3. 业务流程' },
    @{ p = '^###\s*3\.2\s*用户故事'; n = '3.2 用户故事' },
    @{ p = '^##\s*4\.\s*功能规划'; n = '4. 功能规划' },
    @{ p = '^###\s*4\.3\s*功能清单'; n = '4.3 功能清单' }
)
foreach ($r in $required) {
    if (-not ($lines | Where-Object { $_ -match $r.p })) { Add-Issue "缺少章节：$($r.n)" }
}
if ($ProductLevel) {
    foreach ($r in @(
        @{ p = '^###\s*2\.1\s*愿景'; n = '2.1 愿景' },
        @{ p = '^###\s*2\.6\s*市场和竞品分析'; n = '2.6 市场和竞品分析' })) {
        if (-not ($lines | Where-Object { $_ -match $r.p })) { Add-Issue "产品层 PRD 缺少章节：$($r.n)" }
    }
}

# 2 核心业务条数
$coreStart = ($lines | Select-String -Pattern '^\*\*核心业务' | Select-Object -First 1).LineNumber
if ($coreStart) {
    $count = 0
    for ($i = $coreStart; $i -lt [Math]::Min($coreStart + 12, $lines.Count); $i++) {
        if ($lines[$i] -match '^\s*\d+\.\s+') { $count++ }
        elseif ($lines[$i] -match '^#{2,3}\s') { break }
    }
    if ($count -lt 3 -or $count -gt 5) { Add-Issue "核心业务应为 3 至 5 条，当前 $count 条" }
} else {
    Add-Issue '流程概览缺少核心业务段落'
}

# 3 占位符残留
$ph = $lines | Select-String -Pattern '\[(模块名|业务要点|维度标签|人群或机构|产品名|功能名|角色|描述|同上)' -AllMatches
if ($ph) { Add-Issue "存在未替换的模板占位符 $($ph.Count) 处（首处第 $($ph[0].LineNumber) 行）" }

# 4 禁用词
$banned = @{
    '赋能|抓手|闭环生态|打法|组合拳|对齐水位|颗粒度|拉通|引爆点' = '互联网黑话'
    '攻坚|抢滩|狙击|集中火力|杀手锏|护城河|降维打击|决胜'      = '军事武侠类词汇'
    '强大的|极致的|无缝的|全方位的|一站式|遥遥领先|行业标杆'    = '空洞形容词或自我吹捧'
    '令人震惊|史无前例|颠覆性|划时代'                          = '情感渲染词'
}
foreach ($k in $banned.Keys) {
    $hit = $lines | Select-String -Pattern $k
    if ($hit) { Add-Issue "$($banned[$k])：第 $($hit[0].LineNumber) 行 $($hit[0].Matches[0].Value)" }
}

# 5 禁用标点
foreach ($p in @(@{ c = '——'; n = '破折号' }, @{ c = '「'; n = '直角引号' }, @{ c = '」'; n = '直角引号' })) {
    $hit = $lines | Select-String -Pattern ([regex]::Escape($p.c))
    if ($hit) { Add-Issue "$($p.n)：第 $($hit[0].LineNumber) 行" }
}

# 6 技术方案泄漏
$tech = $lines | Select-String -Pattern '(React|Vue|PostgreSQL|IndexedDB|TypeScript|Python|SQLite|Node\.js|Docker|Redis|framework|数据库表结构)'
if ($tech) { Add-Warn "疑似技术实现细节：第 $($tech[0].LineNumber) 行 $($tech[0].Matches[0].Value)（PRD 不写技术方案）" }

# 7 表格列数
foreach ($i in 0..($lines.Count - 1)) {
    if ($lines[$i] -match '^\|' -and $lines[$i] -match '\|\s*$') {
        $cols = ($lines[$i].TrimEnd('|').Split('|').Count) - 1
        if ($cols -gt 6) { Add-Issue "表格列数 $cols 超过 6：第 $($i + 1) 行"; break }
    }
}

# 8 Mermaid 规范
$mm = [regex]::Matches($text, '(?s)```mermaid(.*?)```')
if ($mm.Count -eq 0) {
    Add-Issue '缺少 Mermaid 流程图'
} else {
    foreach ($m in $mm) {
        $body = $m.Groups[1].Value
        $nodes = ([regex]::Matches($body, '(?m)^\s*[A-Za-z][A-Za-z0-9_]*\s*[\[\({]')).Count
        if ($nodes -gt 12) { Add-Issue "Mermaid 节点 $nodes 个超过 12" }
        foreach ($d in [regex]::Matches($body, 'classDef\s+\w+\s+([^\r\n]+)')) {
            $decl = $d.Groups[1].Value
            foreach ($attr in @('fill', 'stroke', 'color')) {
                if ($decl -notmatch "$attr\s*:") { Add-Issue "classDef 缺少 $attr 属性" }
            }
        }
    }
}

# 9 中英文空格
$sp = $lines | Select-String -Pattern '[一-龥][A-Za-z0-9]|[A-Za-z0-9][一-龥]' |
    Where-Object { $_.Line -notmatch '^\s*\||`|\]\(|^\s*-\s*\[' }
if ($sp) { Add-Warn "中英文之间缺空格：第 $($sp[0].LineNumber) 行" }

# 输出
Write-Output "PRD 校验：$Path"
Write-Output ('-' * 50)
if ($issues.Count -eq 0 -and $warnings.Count -eq 0) {
    Write-Output '全部通过，0 issues / 0 warnings'
    exit 0
}
foreach ($i in $issues) { Write-Output "[issue]   $i" }
foreach ($w in $warnings) { Write-Output "[warning] $w" }
Write-Output ('-' * 50)
Write-Output "$($issues.Count) issues / $($warnings.Count) warnings"
if ($issues.Count -gt 0) { exit 1 } else { exit 0 }
