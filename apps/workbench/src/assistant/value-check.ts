// 修改建议的数值合理性核查：AI 提议与人工确认之间的第三道防线。
// 五条规则移植自旧原型 交互原型/02_AI工作台/js/editcheck.js。
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
): string[] {
  const warnings: string[] = [];
  const oldValue = maxNumber(edit.oldValueText);
  const newValue = maxNumber(edit.newValueText);
  const measured = measurements.filter((m) => m.measured);
  const eaveColumn = measured.find((m) => m.part === "檐柱高");

  if (oldValue && newValue && oldValue !== newValue) {
    const ratio = newValue / oldValue;
    if (ratio < 0.5) warnings.push(`数值缩小到原来的 ${Math.round(ratio * 100)}%，幅度较大`);
    else if (ratio > 2) warnings.push(`数值放大到原来的 ${Math.round(ratio * 100)}%，幅度较大`);
  }

  if (/檐口高/.test(edit.field) && eaveColumn && newValue && newValue <= eaveColumn.valueMm) {
    warnings.push(`檐口高 ${newValue}mm 不大于实测檐柱高 ${eaveColumn.valueMm}mm，几何上不成立`);
  }

  if (/台基/.test(edit.subjectName) && eaveColumn && newValue && newValue >= eaveColumn.valueMm) {
    warnings.push(`台基高不应达到或超过檐柱高 ${eaveColumn.valueMm}mm`);
  }

  const estimateMark = /（估）|\(估\)/;
  if (estimateMark.test(edit.oldValueText) && !estimateMark.test(edit.newValueText)) {
    const supported = newValue !== null && measured.some((m) => Math.abs(m.valueMm - newValue) < 1);
    if (!supported) warnings.push("去掉了估算标记，但实测记录里没有这个数值");
  }

  if (newValue) {
    const sameValue = measured.filter((m) => Math.abs(m.valueMm - newValue) < 1);
    const partMatches = sameValue.some((m) =>
      edit.subjectName.includes(m.part.replace(/高|宽|面阔/g, "")),
    );
    if (sameValue.length && !partMatches) {
      warnings.push(`这个数值与实测项「${sameValue[0]?.part}」相同，确认不是套错部位`);
    }
  }

  return warnings;
}
