// 资格标签与图面限制说明两个组件，取词一律来自 qualification.ts。

import type { ReactElement } from "react";
import { useState } from "react";

import { QUALIFICATION_CHIP_LABEL, QUALIFICATION_LIMITS } from "./qualification";

// 常驻资格标签：一直显示结论，展开显示成果等级、使用禁区、身份性质三层限制。
export function QualificationChip({ className }: { className?: string }): ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <div className={`qualification-block ${className ?? ""}`.trim()}>
      <button
        type="button"
        className="qualification-chip"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {QUALIFICATION_CHIP_LABEL}
      </button>
      {open && (
        <dl className="qualification-limits">
          {QUALIFICATION_LIMITS.map((limit) => (
            <div key={limit.code}>
              <dt>{limit.layerZh}</dt>
              <dd>{limit.textZh}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

// 图面限制说明：与图纸图签上印的内容一致，防止界面说得比图纸松。
export function DrawingLimitationNote(): ReactElement {
  return (
    <div className="drawing-limitation">
      <strong>图面限制</strong>
      <p>每张图的图签都印有代理成果与未签发状态，日期栏留空。{QUALIFICATION_LIMITS.map((limit) => limit.textZh).join("")}</p>
    </div>
  );
}
