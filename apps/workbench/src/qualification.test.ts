import { describe, expect, it } from "vitest";

import { QUALIFICATION_CHIP_LABEL, QUALIFICATION_LIMITS, describeBlocker } from "./qualification";

// 资格标签要说全三层限制：成果等级、使用禁区、身份性质。
// 只写签发状态一层会让界面比图纸图签和交付草案的限制条件说得松。

const CODE_TOKEN = /\b[A-Z][A-Z0-9]*(_[A-Z0-9]+)+\b/;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

describe("资格限制说明", () => {
  it("三层限制齐全且各自对应一个正式资格阻断码", () => {
    expect(QUALIFICATION_LIMITS.map((limit) => limit.layerZh)).toEqual(["成果等级", "使用禁区", "身份性质"]);
    expect(QUALIFICATION_LIMITS.map((limit) => limit.code).sort()).toEqual([
      "FORMAL_SIGNOFF_UNAVAILABLE", "L1_ELIGIBILITY_FALSE", "PROFESSIONAL_REVIEW_REQUIRED",
    ]);
  });

  it("使用禁区写明施工与法定档案入库", () => {
    const forbidden = QUALIFICATION_LIMITS.find((limit) => limit.layerZh === "使用禁区")!;
    expect(forbidden.textZh).toContain("施工");
    expect(forbidden.textZh).toContain("法定档案");
  });

  it("身份性质写明本机身份不具备签发资格", () => {
    const identity = QUALIFICATION_LIMITS.find((limit) => limit.layerZh === "身份性质")!;
    expect(identity.textZh).toContain("本机身份");
    expect(identity.textZh).toContain("签发");
  });

  it("常驻标签同时说出代理性质、签发状态与成果等级", () => {
    expect(QUALIFICATION_CHIP_LABEL).toContain("代理成果");
    expect(QUALIFICATION_CHIP_LABEL).toContain("未签发");
    expect(QUALIFICATION_CHIP_LABEL).toContain("未达专业样板等级");
  });

  it("限制说明本身不出现内部码", () => {
    for (const limit of QUALIFICATION_LIMITS) {
      expect(CODE_TOKEN.test(limit.textZh), limit.code).toBe(false);
    }
    expect(CODE_TOKEN.test(QUALIFICATION_CHIP_LABEL)).toBe(false);
  });
});

describe("阻断原因翻译", () => {
  const cases = [
    "PROFESSIONAL_REVIEW_REQUIRED",
    "FORMAL_SIGNOFF_UNAVAILABLE",
    "L1_ELIGIBILITY_FALSE",
    "UNVERIFIED_DIMENSION_CANDIDATES",
    "MEASUREMENT_METADATA_MISSING",
    "GEOMETRY_EVIDENCE_FACTS_MISSING",
    "missingEvidence",
    "ruleConflict",
    "professionalUncertainty",
    "highRisk",
    "OPEN_ISSUE:professionalUncertainty:3b241101-e2bb-4255-8caf-4136c566a962",
    "CHECK_BLOCKED:PROFESSIONAL_REVIEW_REQUIRED",
    "UNKNOWN:MISSING_DIMENSION",
    "PROJECT_INPUT_BLOCKED:1",
    "SOME_UNMAPPED_CODE",
  ];

  for (const code of cases) {
    it(`${code} 翻成中文且不带码与项目号`, () => {
      const text = describeBlocker(code);
      expect(text.length).toBeGreaterThan(0);
      expect(CODE_TOKEN.test(text)).toBe(false);
      expect(UUID.test(text)).toBe(false);
      expect(/[a-zA-Z]/.test(text)).toBe(false);
    });
  }

  it("事项类阻断保留问题类型", () => {
    expect(describeBlocker("OPEN_ISSUE:missingEvidence:3b241101-e2bb-4255-8caf-4136c566a962"))
      .toBe("未处理事项：缺资料");
  });
});
