import type { ConceptEntriesFile } from "@gujian/domain";

// 种子词表：单一对象字面量，专业人员逐条审阅，不含任何逻辑。
// 覆盖 v3 团队 demo 的 27 个构件类型（conceptId 与 componentType 字符串一致，
// 双写迁移零成本映射）加族层级与规则层引用的概念。
// 同物异名实证转引自 jiangshu aliases.json（见 文档/01_产品/04_开源代码借鉴与现状评估.md 第 3.5 节）；
// demo 构件沿用 v3 合同的中性术语，未经专业确认不补类型学名称。

export const HERITAGE_CONCEPTS_V1 = {
  schemaVersion: "concept-entries-1",
  vocabularyId: "heritage-concepts",
  sourceText: "v3 团队 demo 构件类型（中性术语）加 jiangshu aliases.json 同物异名实证",
  version: "1.0.0",
  entries: [
    { conceptId: "base-family", prefLabelZh: "台基与基础", altLabels: [], broader: null, sourceText: "族层级（本项目整理）", roleZh: "承托整座建筑并传递荷载至地基", descZh: null, confirmedBy: null },
    { conceptId: "column-family", prefLabelZh: "柱类", altLabels: [], broader: null, sourceText: "族层级（本项目整理）", roleZh: "竖向承重构件", descZh: null, confirmedBy: null },
    { conceptId: "beam-family", prefLabelZh: "梁枋类", altLabels: [], broader: null, sourceText: "族层级（本项目整理）", roleZh: "水平联系与承重构件", descZh: null, confirmedBy: null },
    { conceptId: "bracket-family", prefLabelZh: "承托组合", altLabels: [], broader: null, sourceText: "族层级（本项目整理，沿用 v3 中性术语）", roleZh: "柱顶与檩之间的过渡承托", descZh: null, confirmedBy: null },
    { conceptId: "roof-frame", prefLabelZh: "屋架", altLabels: [], broader: null, sourceText: "族层级（本项目整理）", roleZh: "承托屋面的骨架体系", descZh: null, confirmedBy: null },
    { conceptId: "tile-family", prefLabelZh: "瓦作", altLabels: [], broader: null, sourceText: "族层级（本项目整理）", roleZh: "屋面防水与压顶", descZh: null, confirmedBy: null },
    { conceptId: "fitment-family", prefLabelZh: "装修构件", altLabels: [], broader: null, sourceText: "族层级（本项目整理）", roleZh: "围护与门窗装修", descZh: null, confirmedBy: null },

    { conceptId: "groundLayer", prefLabelZh: "地基层", altLabels: [], broader: "base-family", sourceText: "v3 团队 demo 中性术语", roleZh: null, descZh: null, confirmedBy: null },
    { conceptId: "foundationLayer", prefLabelZh: "基础层", altLabels: [], broader: "base-family", sourceText: "v3 团队 demo 中性术语", roleZh: null, descZh: null, confirmedBy: null },
    { conceptId: "terrace", prefLabelZh: "台基", altLabels: [], broader: "base-family", sourceText: "v3 团队 demo 中性术语", roleZh: null, descZh: null, confirmedBy: null },
    { conceptId: "step", prefLabelZh: "踏步", altLabels: [], broader: "base-family", sourceText: "v3 团队 demo 中性术语", roleZh: null, descZh: null, confirmedBy: null },
    { conceptId: "columnBase", prefLabelZh: "柱下承托构件", altLabels: ["柱础"], broader: "base-family", sourceText: "v3 团队 demo 中性术语；别名为通行叫法", roleZh: null, descZh: null, confirmedBy: null },

    { conceptId: "column", prefLabelZh: "柱", altLabels: [], broader: "column-family", sourceText: "v3 团队 demo 中性术语", roleZh: null, descZh: null, confirmedBy: null },
    { conceptId: "eave-column", prefLabelZh: "檐柱", altLabels: ["小檐柱"], broader: "column-family", sourceText: "jiangshu aliases.json：檐柱又称小檐柱", roleZh: "檐口下最外圈承重柱", descZh: null, confirmedBy: null },
    { conceptId: "jin-column", prefLabelZh: "金柱", altLabels: ["老檐柱"], broader: "column-family", sourceText: "jiangshu aliases.json：金柱又称老檐柱", roleZh: null, descZh: null, confirmedBy: null },
    { conceptId: "interiorPost", prefLabelZh: "室内立柱", altLabels: [], broader: "column-family", sourceText: "v3 团队 demo 中性术语", roleZh: null, descZh: null, confirmedBy: null },

    { conceptId: "eaveBeam", prefLabelZh: "檐部横梁", altLabels: [], broader: "beam-family", sourceText: "v3 团队 demo 中性术语", roleZh: null, descZh: null, confirmedBy: null },
    { conceptId: "tieBeam", prefLabelZh: "联系梁", altLabels: [], broader: "beam-family", sourceText: "v3 团队 demo 中性术语", roleZh: null, descZh: null, confirmedBy: null },
    { conceptId: "crescent-beam", prefLabelZh: "月梁", altLabels: ["顶梁"], broader: "beam-family", sourceText: "jiangshu aliases.json：月梁又称顶梁", roleZh: null, descZh: null, confirmedBy: null },

    { conceptId: "bracketSeat", prefLabelZh: "承托座", altLabels: [], broader: "bracket-family", sourceText: "v3 团队 demo 中性术语", roleZh: null, descZh: null, confirmedBy: null },
    { conceptId: "bracketArm", prefLabelZh: "承托臂", altLabels: [], broader: "bracket-family", sourceText: "v3 团队 demo 中性术语", roleZh: null, descZh: null, confirmedBy: null },
    { conceptId: "bearingBlock", prefLabelZh: "檩下承块", altLabels: [], broader: "bracket-family", sourceText: "v3 团队 demo 中性术语", roleZh: null, descZh: null, confirmedBy: null },

    { conceptId: "purlin", prefLabelZh: "檩", altLabels: ["桁"], broader: "roof-frame", sourceText: "v3 团队 demo 中性术语；别名为通行叫法", roleZh: null, descZh: null, confirmedBy: null },
    { conceptId: "rafter", prefLabelZh: "椽", altLabels: [], broader: "roof-frame", sourceText: "v3 团队 demo 中性术语", roleZh: null, descZh: null, confirmedBy: null },
    { conceptId: "flyRafter", prefLabelZh: "檐端续接椽", altLabels: ["飞椽"], broader: "roof-frame", sourceText: "v3 团队 demo 中性术语；别名为通行叫法", roleZh: null, descZh: null, confirmedBy: null },
    { conceptId: "eaveClosure", prefLabelZh: "檐口封闭构件", altLabels: [], broader: "roof-frame", sourceText: "v3 团队 demo 中性术语", roleZh: null, descZh: null, confirmedBy: null },
    { conceptId: "roofBoard", prefLabelZh: "屋面板", altLabels: ["望板"], broader: "roof-frame", sourceText: "v3 团队 demo 中性术语；别名为通行叫法", roleZh: null, descZh: null, confirmedBy: null },

    { conceptId: "panTile", prefLabelZh: "凹面瓦件", altLabels: ["板瓦"], broader: "tile-family", sourceText: "v3 团队 demo 中性术语；别名为通行叫法", roleZh: null, descZh: null, confirmedBy: null },
    { conceptId: "coverTile", prefLabelZh: "盖瓦件", altLabels: ["筒瓦"], broader: "tile-family", sourceText: "v3 团队 demo 中性术语；别名为通行叫法", roleZh: null, descZh: null, confirmedBy: null },
    { conceptId: "ridgeTile", prefLabelZh: "屋脊构件", altLabels: [], broader: "tile-family", sourceText: "v3 团队 demo 中性术语", roleZh: null, descZh: null, confirmedBy: null },

    { conceptId: "wall", prefLabelZh: "墙体", altLabels: [], broader: "fitment-family", sourceText: "v3 团队 demo 中性术语", roleZh: null, descZh: null, confirmedBy: null },
    { conceptId: "doorFrameMember", prefLabelZh: "门框构件", altLabels: [], broader: "fitment-family", sourceText: "v3 团队 demo 中性术语", roleZh: null, descZh: null, confirmedBy: null },
    { conceptId: "doorLeafStile", prefLabelZh: "门扇边梃", altLabels: [], broader: "fitment-family", sourceText: "v3 团队 demo 中性术语", roleZh: null, descZh: null, confirmedBy: null },
    { conceptId: "doorLeafRail", prefLabelZh: "门扇横档", altLabels: [], broader: "fitment-family", sourceText: "v3 团队 demo 中性术语", roleZh: null, descZh: null, confirmedBy: null },
    { conceptId: "doorLeafPanel", prefLabelZh: "门扇板", altLabels: [], broader: "fitment-family", sourceText: "v3 团队 demo 中性术语", roleZh: null, descZh: null, confirmedBy: null },
    { conceptId: "latticeFrameMember", prefLabelZh: "格栅框构件", altLabels: [], broader: "fitment-family", sourceText: "v3 团队 demo 中性术语", roleZh: null, descZh: null, confirmedBy: null },
    { conceptId: "latticeBar", prefLabelZh: "格栅条", altLabels: [], broader: "fitment-family", sourceText: "v3 团队 demo 中性术语", roleZh: null, descZh: null, confirmedBy: null },
  ],
} as const satisfies ConceptEntriesFile;
