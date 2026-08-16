import type { ModificationCheckConfig } from "@gujian/domain";
import { HERITAGE_BASELINE_RULE_DATA, modificationCheckConfig } from "@gujian/infrastructure";

// 修改建议的数值合理性核查：AI 提议与人工确认之间的第三道防线。
// 五条规则的关系与阈值来自规则数据文件（heritage-baseline），不再硬编码。
// 只产警示不拦截（表 10：核对不通过仍出建议但附警示）。

export interface ModificationToCheck {
  subjectName: string;
  field: string;
  oldValueText: string;
  newValueText: string;
}

export interface MeasurementForCheck {
  part: string;
  valueMm: number;
  measured: boolean;
}

const DEFAULT_CONFIG = modificationCheckConfig(HERITAGE_BASELINE_RULE_DATA);

function positiveNumbers(text: string): number[] {
  return (String(text).match(/\d+(\.\d+)?/g) ?? []).map(Number).filter((n) => n > 0);
}

function maxNumber(text: string): number | null {
  const values = positiveNumbers(text);
  return values.length ? Math.max(...values) : null;
}

export function checkModification(
  edit: ModificationToCheck,
  measurements: readonly MeasurementForCheck[],
  config: ModificationCheckConfig = DEFAULT_CONFIG,
): string[] {
  const warnings: string[] = [];
  const oldValue = maxNumber(edit.oldValueText);
  const newValue = maxNumber(edit.newValueText);
  const measured = measurements.filter((m) => m.measured);
  const anchor = measured.find((m) => m.part === config.anchorPart);
  const matchTolerance = config.measurementMatchToleranceMm;

  if (oldValue && newValue && oldValue !== newValue) {
    const ratio = newValue / oldValue;
    if (ratio < config.magnitudeBand.minRatio) warnings.push(`数值缩小到原来的 ${Math.round(ratio * 100)}%，幅度较大`);
    else if (ratio > config.magnitudeBand.maxRatio) warnings.push(`数值放大到原来的 ${Math.round(ratio * 100)}%，幅度较大`);
  }

  if (anchor && newValue) {
    if (config.mustExceedAnchor.some((part) => edit.field.includes(part)) && newValue <= anchor.valueMm) {
      warnings.push(`${edit.field} ${newValue}mm 不大于实测${config.anchorPart} ${anchor.valueMm}mm，几何上不成立`);
    }
    if (config.mustStayBelowAnchor.some((part) => edit.subjectName.includes(part)) && newValue >= anchor.valueMm) {
      warnings.push(`${edit.subjectName}高不应达到或超过${config.anchorPart} ${anchor.valueMm}mm`);
    }
  }

  const estimateMark = new RegExp(config.estimateMarkPattern);
  if (estimateMark.test(edit.oldValueText) && !estimateMark.test(edit.newValueText)) {
    const supported = newValue !== null && measured.some((m) => Math.abs(m.valueMm - newValue) < matchTolerance);
    if (!supported) warnings.push("去掉了估算标记，但实测记录里没有这个数值");
  }

  if (newValue) {
    const sameValue = measured.filter((m) => Math.abs(m.valueMm - newValue) < matchTolerance);
    const partMatches = sameValue.some((m) =>
      edit.subjectName.includes(m.part.replace(/高|宽|面阔/g, "")),
    );
    if (sameValue.length && !partMatches) {
      warnings.push(`这个数值与实测项 ${sameValue[0]?.part} 相同，确认不是套错部位`);
    }
  }

  return warnings;
}
