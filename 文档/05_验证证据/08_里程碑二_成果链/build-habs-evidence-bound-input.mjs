import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const evidence = {
  plan: "b6d7638b-1392-49e7-a4fb-85accaef51ae",
  elevation: "a334d881-2752-4294-9c0a-701cf810cbfb",
  section: "862c1c0a-6c69-4c29-b20d-0293eb0cc9d2",
  framing: "52bab979-fd23-4225-9ad9-5eeabd98b884",
};
const unknown = (stableKey, reasonCode, description, requiredEvidence) => ({
  reasonCode, description, requiredEvidence, affectedStableKeys: [stableKey],
  blocksProxyOutcome: false, blocksFormalEligibility: true,
});
const component = (stableKey, componentType, displayNameZh, materialCode, solid, sourceLocation, evidenceRefs, unknowns = []) => ({
  stableKey, parentStableKey: null, componentType, displayNameZh, materialCode, solid,
  parameters: [], sourceLocation, evidenceRefs, unknowns,
});

const components = [];
const addBox = (key, type, label, material, size, center, source, refs, unknowns = []) => components.push(component(
  key, type, label, material,
  { kind: "box", sizeX: String(size[0]), sizeY: String(size[1]), sizeZ: String(size[2]), centerMm: center },
  source, refs, unknowns,
));

const postUnknown = (key) => unknown(key, "POST_SECOND_DIMENSION_VARIES", "图纸注明木柱厚 5 英寸、另一方向宽度随构件变化；本代理几何以 5 英寸方柱表达定位关系，不能作为构件断面实测。", ["逐柱转写 sheet 10 中变化宽度", "现场或原始调查记录"]);
for (const [key, x, y] of [
  ["post:nw", -4702.175, 4400.55], ["post:ne", 4702.175, 4400.55],
  ["post:sw", -4702.175, -4400.55], ["post:se", 4702.175, -4400.55],
]) addBox(key, "support", `主屋木柱 ${key.slice(-2).toUpperCase()}`, "cypress-documented", [127, 127, 2520.95], [x, y, 1260.475], "sheet 3 floor plan post positions; sheet 10 wall framing isometric 5-inch post callout", [evidence.plan, evidence.framing], [postUnknown(key)]);

for (const [index, x] of [-4702.175, -1971.675, 58.575, 2331.875, 4624.225].entries()) {
  const key = `gallery-post:${index + 1}`;
  addBox(key, "gallery", `前廊木柱 ${index + 1}`, "cypress-documented", [127, 127, 2578.1], [x, -6972.3, 1289.05], "sheet 3 front gallery chain dimensions and post symbols; sheet 4 gallery description", [evidence.plan, evidence.elevation], [postUnknown(key)]);
}

const wallUnknown = (key) => unknown(key, "WALL_BUILDUP_PARTIALLY_TRANSCRIBED", "墙体位置和 7 英寸构造厚度来自平面详图；墙内木骨架、苔藓泥填充和外覆板逐层连接尚未完整转写。", ["sheet 6 wall sections逐层构造", "构件近景或原始调查记录"]);
for (const [key, width, x] of [
  ["wall:south:1", 3165.675, -3182.8375], ["wall:south:2", 1119, -59.5],
  ["wall:south:3", 1768, 2116], ["wall:south:4", 927.675, 4301.8375],
]) addBox(key, "wall", `南侧苔藓泥填充墙段 ${key.slice(-1)}`, "bousillage-documented", [width, 177.8, 2520.95], [x, -4375.15, 1260.475], "sheet 3 floor plan, south wall door openings and 7-inch plan detail", [evidence.plan], [wallUnknown(key)]);
addBox("wall:north", "wall", "北侧苔藓泥填充墙体代理段", "bousillage-documented", [9531.35, 177.8, 2520.95], [0, 4375.15, 1260.475], "sheet 3 floor plan north wall outline and plan detail", [evidence.plan], [wallUnknown("wall:north"), unknown("wall:north", "NORTH_OPENINGS_NOT_SUBTRACTED", "北墙门窗洞口尚未逐一从墙体代理段中扣除。", ["sheet 3 opening schedule and exact opening positions"])]);
for (const [side, x] of [["east", 4676.775], ["west", -4676.775]]) {
  for (const [index, length, y] of [[1, 1964.05, -3482.025], [2, 3400, 0], [3, 1964.05, 3482.025]]) {
    const key = `wall:${side}:${index}`;
    addBox(key, "wall", `${side === "east" ? "东" : "西"}侧苔藓泥填充墙段 ${index}`, "bousillage-documented", [177.8, length, 2520.95], [x, y, 1260.475], "sheet 3 floor plan side openings and 7-inch plan detail", [evidence.plan], [wallUnknown(key)]);
  }
}

for (const [key, x, width, height, mark] of [
  ["door:south:1", -1059.5, 881.0625, 2127.25, "1"],
  ["door:south:2", 916, 831.85, 2105.025, "2"],
  ["door:south:3", 3419, 838.2, 2146.3, "3"],
]) addBox(key, "door", `南侧单扇木门 ${mark}`, "wood-documented", [width, 22.225, height], [x, -4464.05, height / 2], `sheet 3 door schedule mark ${mark} and floor-plan position`, [evidence.plan], [unknown(key, "DOOR_JOINERY_NOT_TRANSCRIBED", "门框、门扇板拼接及五金未形成可验证构造。", ["门节点详图", "构件近景"])]);

for (const [key, side, y, width, height, mark] of [
  ["opening:east:d", "east", 2100, 749.3, 1149.35, "D"], ["opening:east:e", "east", -2100, 736.6, 1146.175, "E"],
  ["opening:west:c", "west", 2100, 758.825, 1151.35, "C"], ["opening:west:b", "west", -2100, 717.55, 1247.775, "B"],
]) addBox(key, "opening", `${side === "east" ? "东" : "西"}侧木框百叶洞口 ${mark}`, "wood-documented", [22.225, width, height], [side === "east" ? 4765.675 : -4765.675, y, 1400], `sheet 3 opening schedule mark ${mark} and floor-plan position`, [evidence.plan], [unknown(key, "OPENING_FRAME_DETAIL_UNRESOLVED", "洞口框、单扇板百叶和墙体收口尚未形成构造节点。", ["洞口节点详图", "构件近景"])]);

addBox("plate:north", "plate", "北侧墙顶板", "cypress-documented", [9531.35, 107.95, 234.95], [0, 4410.075, 2638.425], "sheet 10 wall framing isometric, 4 1/4 by 9 1/4 inch top plate", [evidence.framing]);
addBox("plate:south", "plate", "南侧墙顶板", "cypress-documented", [9531.35, 107.95, 234.95], [0, -4410.075, 2638.425], "sheet 10 wall framing isometric, 4 1/4 by 9 1/4 inch top plate", [evidence.framing]);
addBox("plate:east", "plate", "东侧墙顶板", "cypress-documented", [107.95, 8928.1, 234.95], [4711.7, 0, 2638.425], "sheet 10 wall framing isometric, 4 1/4 by 9 1/4 inch top plate", [evidence.framing]);
addBox("plate:west", "plate", "西侧墙顶板", "cypress-documented", [107.95, 8928.1, 234.95], [-4711.7, 0, 2638.425], "sheet 10 wall framing isometric, 4 1/4 by 9 1/4 inch top plate", [evidence.framing]);
addBox("gallery-beam", "gallery", "前廊横梁", "cypress-documented", [9531.35, 101.6, 177.8], [0, -6972.3, 2667], "sheet 10 roof framing isometric, 4 by 7 inch gallery beam; sheet 3 front gallery", [evidence.plan, evidence.framing]);

const roofUnknown = (key) => unknown(key, "ROOF_MEMBER_INVENTORY_PARTIAL", "椽断面与屋脊标高已转写；当前仅按图纸位置表达代表性屋架，完整椽数、间距、连接和金属屋面厚度仍未知。", ["sheet 10逐根屋架转写", "sheet 6连接详图", "原始调查记录"]);
for (const [index, y] of [-4300, -2150, 0, 2150, 4300].entries()) {
  for (const side of ["west", "east"]) {
    const key = `rafter:${side}:${index + 1}`;
    const profile = side === "west"
      ? [[-4765.675, 2755.9], [0, 6884.9875], [0, 6751.6375], [-4660, 2755.9]]
      : [[0, 6884.9875], [4765.675, 2755.9], [4660, 2755.9], [0, 6751.6375]];
    components.push(component(key, "roofStructure", `${side === "west" ? "西" : "东"}坡代表性粗凿柏木椽 ${index + 1}`, "cypress-documented", {
      kind: "extrudedProfile", profileMm: profile, depth: "82.55", axis: "y", originMm: [0, y - 41.275, 0],
    }, "sheet 6 rafter callout 3 1/4 by 5 1/4 inches and roof ridge level; sheet 10 roof framing isometric", [evidence.section, evidence.framing], [roofUnknown(key)]));
  }
}

const interfaces = [];
const addInterface = (fromStableKey, toStableKey, fromSurface, toSurface, sourceLocation, refs) => interfaces.push({
  fromStableKey, toStableKey, interfaceType: "contact", fromSurface, toSurface, direction: [0, 0, 1],
  maximumGapMm: 0.5, maximumUnexpectedOverlapMm3: 0, minimumDeclaredOverlapMm3: null,
  sourceLocation, evidenceRefs: refs,
});
for (const [post, plate] of [["post:nw", "plate:north"], ["post:ne", "plate:north"], ["post:sw", "plate:south"], ["post:se", "plate:south"]]) {
  addInterface(post, plate, "zMax", "zMin", "sheet 10 wall framing isometric, post-to-top-plate bearing", [evidence.framing]);
}
for (let index = 1; index <= 5; index += 1) addInterface(`gallery-post:${index}`, "gallery-beam", "zMax", "zMin", "sheet 10 roof framing isometric and sheet 3 front gallery", [evidence.plan, evidence.framing]);

const allKeys = components.map((item) => item.stableKey);
const planKeys = allKeys.filter((key) => /^(post|gallery-post|wall|door|opening)/.test(key));
const roofKeys = allKeys.filter((key) => /^(rafter|plate|gallery-beam)/.test(key));
const requirements = {
  titleZh: "Badin-Roque House HABS 图纸转写代理成果",
  revisionLabel: "P2",
  geometryTargetRoles: ["support", "gallery", "wall", "door", "opening", "plate", "roofStructure"],
  sheets: [
    { key: "sheet-plan", drawingNumber: "P-01", displayLabelZh: "平面、屋顶与立面", pageMm: [841, 594] },
    { key: "sheet-section", drawingNumber: "P-02", displayLabelZh: "剖面与证据支持节点", pageMm: [841, 594] },
  ],
  views: [
    { key: "floor-plan", displayLabelZh: "平面图", drawingRef: "平-01", kind: "floorPlan", scaleDenominator: 50, sheetKey: "sheet-plan", viewportRectMm: [20, 310, 390, 249], direction: [0, 0, 1], right: [1, 0, 0], up: [0, 1, 0], sectionPlane: { normal: [0, 0, 1], offsetMm: 1400 }, targetStableKeys: planKeys, sourceEvidenceRefs: [evidence.plan] },
    { key: "roof-plan", displayLabelZh: "屋架平面投影", drawingRef: "屋-01", kind: "roofPlan", scaleDenominator: 50, sheetKey: "sheet-plan", viewportRectMm: [430, 310, 390, 249], direction: [0, 0, -1], right: [1, 0, 0], up: [0, 1, 0], targetStableKeys: roofKeys, sourceEvidenceRefs: [evidence.section, evidence.framing] },
    { key: "south-elevation", displayLabelZh: "南立面图", drawingRef: "立-01", kind: "elevation", scaleDenominator: 50, sheetKey: "sheet-plan", viewportRectMm: [20, 55, 390, 220], direction: [0, 1, 0], right: [1, 0, 0], up: [0, 0, 1], targetStableKeys: allKeys, sourceEvidenceRefs: [evidence.elevation] },
    { key: "east-elevation", displayLabelZh: "东立面图", drawingRef: "立-02", kind: "elevation", scaleDenominator: 50, sheetKey: "sheet-plan", viewportRectMm: [430, 55, 390, 220], direction: [-1, 0, 0], right: [0, 1, 0], up: [0, 0, 1], targetStableKeys: allKeys, sourceEvidenceRefs: [evidence.elevation] },
    { key: "transverse-section", displayLabelZh: "横剖面图", drawingRef: "剖-01", kind: "transverseSection", scaleDenominator: 50, sheetKey: "sheet-section", viewportRectMm: [20, 310, 390, 240], direction: [0, 1, 0], right: [1, 0, 0], up: [0, 0, 1], sectionPlane: { normal: [0, 1, 0], offsetMm: -82.55 }, targetStableKeys: allKeys, sourceEvidenceRefs: [evidence.section] },
    { key: "longitudinal-section", displayLabelZh: "纵剖面图", drawingRef: "剖-02", kind: "longitudinalSection", scaleDenominator: 50, sheetKey: "sheet-section", viewportRectMm: [430, 310, 390, 240], direction: [1, 0, 0], right: [0, 1, 0], up: [0, 0, 1], sectionPlane: { normal: [1, 0, 0], offsetMm: 58.575 }, targetStableKeys: allKeys, sourceEvidenceRefs: [evidence.section] },
    { key: "east-eave-detail", displayLabelZh: "东檐屋架与墙顶板证据节点", drawingRef: "详-01", kind: "detail", scaleDenominator: 12, sheetKey: "sheet-section", viewportRectMm: [260, 55, 320, 220], direction: [0, 1, 0], right: [1, 0, 0], up: [0, 0, 1], sectionPlane: { normal: [0, 1, 0], offsetMm: 4217.45 }, cropBoundsMm: [4300, 2350, 4900, 3300], targetStableKeys: ["rafter:east:5", "plate:east", "wall:east:3"], sourceEvidenceRefs: [evidence.section, evidence.framing] },
  ],
};

const output = { schemaVersion: "1.0", status: "human-transcription-for-proxy-review", l1Eligible: false, formalEligibility: false, evidence, components, interfaces, artifactRequirements: requirements };
const outputPath = join(dirname(fileURLToPath(import.meta.url)), "habs-evidence-bound-input.json");
writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ outputPath, components: components.length, interfaces: interfaces.length, views: requirements.views.length }));
