import "fake-indexeddb/auto";

import { ProjectCommandService } from "@gujian/application";
import { ConceptEntriesFileSchema, broaderClosure, type ConceptEntry } from "@gujian/domain";
import { describe, expect, it } from "vitest";

import { IndexedDbProjectRepository, LocalAuthorization, openWorkbenchDatabase } from "./indexeddb-project-repository.js";
import { conceptLabel, matchesGeometryRole, resolveVocabulary } from "./vocabulary-resolver.js";
import { HERITAGE_CONCEPTS_V1 } from "./vocabulary/heritage-concepts-v1.js";

describe("种子词表", () => {
  it("通过全表校验：conceptId 唯一、broader 可解析、不自引用", () => {
    expect(() => ConceptEntriesFileSchema.parse(HERITAGE_CONCEPTS_V1)).not.toThrow();
  });

  it("覆盖 v3 团队 demo 的 27 个构件类型", () => {
    const v3Types = [
      "groundLayer", "foundationLayer", "terrace", "step", "columnBase", "column",
      "eaveBeam", "tieBeam", "interiorPost", "bracketSeat", "bracketArm", "bearingBlock",
      "purlin", "rafter", "flyRafter", "eaveClosure", "roofBoard", "panTile", "coverTile",
      "ridgeTile", "wall", "doorFrameMember", "doorLeafStile", "doorLeafRail", "doorLeafPanel",
      "latticeFrameMember", "latticeBar",
    ];
    const ids = new Set<string>(HERITAGE_CONCEPTS_V1.entries.map((entry) => entry.conceptId));
    for (const type of v3Types) expect(ids.has(type), type).toBe(true);
  });

  it("同物异名实证入表：檐柱又称小檐柱", () => {
    const eaveColumn = HERITAGE_CONCEPTS_V1.entries.find((entry) => entry.conceptId === "eave-column");
    expect(eaveColumn?.altLabels).toContain("小檐柱");
    expect(eaveColumn?.sourceText).toContain("jiangshu");
  });
});

describe("词表解析与匹配", () => {
  it("overlay 按 conceptId 覆盖种子条目", () => {
    const overlay: ConceptEntry[] = [{
      conceptId: "column", prefLabelZh: "柱（项目确认）", altLabels: [], broader: "column-family",
      sourceText: "项目专业确认", roleZh: null, descZh: null,
      confirmedBy: { actorId: "3b241101-e2bb-4255-8caf-4136c566a962", reasonZh: "现场核对", confirmedAt: "2026-08-16T00:00:00Z" },
    }];
    const merged = resolveVocabulary(overlay);
    expect(conceptLabel(merged, "column")).toBe("柱（项目确认）");
    expect(conceptLabel(merged, "purlin")).toBe("檩");
  });

  it("别名可解析到首选名", () => {
    const vocabulary = resolveVocabulary();
    expect(conceptLabel(vocabulary, "小檐柱")).toBe("檐柱");
  });

  it("上位概念闭包用于角色匹配，无命中时回退前缀规则", () => {
    const vocabulary = resolveVocabulary();
    expect(broaderClosure(vocabulary, "eave-column").has("column-family")).toBe(true);
    expect(matchesGeometryRole(vocabulary, "eave-column", undefined, "column-family")).toBe(true);
    expect(matchesGeometryRole(vocabulary, "panTile", undefined, "tile-family")).toBe(true);
    expect(matchesGeometryRole(vocabulary, "panTile", undefined, "column-family")).toBe(false);
    expect(matchesGeometryRole(vocabulary, "custom:left", undefined, "custom")).toBe(true);
    expect(matchesGeometryRole(vocabulary, "unknownType", undefined, "role")).toBe(false);
  });
});

describe("词表条目提交与持久化", () => {
  it("CommitConceptEntries 写入词表库并进入审计，项目快照不变", async () => {
    const repository = new IndexedDbProjectRepository(openWorkbenchDatabase(`gujian-vocab-${crypto.randomUUID()}`));
    const commands = new ProjectCommandService({ repository, authorization: new LocalAuthorization() });
    const projectId = crypto.randomUUID();
    const actorId = crypto.randomUUID();
    await commands.execute({
      commandType: "CreateProject", commandId: crypto.randomUUID(), projectId, actorId, expectedRevisionId: null,
      issuedAt: "2026-08-16T00:00:00Z",
      payload: {
        project: { id: projectId, name: "词表测试", status: "active", locationText: null, createdAt: "2026-08-16T00:00:00Z" },
        building: { id: crypto.randomUUID(), projectId, name: "正殿", periodText: null, addressText: null, status: "existing" },
      },
    });
    const head = await repository.getProjectHead(projectId);
    await commands.execute({
      commandType: "CommitConceptEntries", commandId: crypto.randomUUID(), projectId, actorId,
      expectedRevisionId: head!.revisionId, issuedAt: "2026-08-16T00:01:00Z",
      payload: { entries: [{
        conceptId: "que-ti", prefLabelZh: "雀替", altLabels: [], broader: null,
        sourceText: "项目专业确认", roleZh: "梁柱交接处的承托与装饰构件", descZh: null,
        confirmedBy: { actorId, reasonZh: "王工确认入库", confirmedAt: "2026-08-16T00:01:00Z" },
      }] },
    });
    const entries = await repository.getConceptEntries();
    expect(entries.find((entry) => entry.conceptId === "que-ti")?.prefLabelZh).toBe("雀替");
    const updated = await repository.getProjectHead(projectId);
    expect(updated?.snapshot.project.name).toBe("词表测试");
    expect(updated?.revisionId).not.toBe(head!.revisionId);
  });
});
