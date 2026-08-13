import { describe, expect, it } from "vitest";
import { ArtifactRequirementMatrixSchema } from "./drawings.js";

const ids = Array.from({ length: 5 }, (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`);

describe("artifact requirement matrix", () => {
  it("supports a task-defined sheet and view", () => {
    const value = ArtifactRequirementMatrixSchema.parse({
      schemaVersion: "1.0",
      id: ids[0], projectId: ids[1], projectRevisionId: ids[2], geometryRevisionId: ids[3],
      titleZh: "代理成果", buildingDisplayNameZh: "测试对象", issueState: "proxy-unissued", issueDate: null,
      revisionLabel: "P01", createdAt: "2026-08-13T12:00:00.000Z", observationCandidates: [],
      views: [{
        id: ids[4], key: "south", displayLabelZh: "南立面图", drawingRef: "立-01", kind: "elevation",
        scaleDenominator: 50, sheetId: ids[0], viewportRectMm: [20, 60, 360, 240],
        direction: [0, 1, 0], right: [1, 0, 0], up: [0, 0, 1], sourceTypes: [],
      }],
      sheets: [{ id: ids[0], drawingNumber: "P-01", displayLabelZh: "立面", pageMm: [841, 594], viewIds: [ids[4]] }],
    });
    expect(value.views).toHaveLength(1);
    expect(value.issueDate).toBeNull();
  });
});
