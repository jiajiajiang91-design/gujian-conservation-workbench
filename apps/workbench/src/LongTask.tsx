// 长任务的加载表现（07 界面视觉规范表 7 第三档）：
// 进度、预计耗时、取消三样齐全。总量未知时用不确定态，不伪造百分比；
// 没有同类作业的历史耗时记录时显示耗时未知，不显示估算值。

import type { ReactElement } from "react";
import { useEffect, useState } from "react";

// 表 7 第一档：短于 300 ms 不显示指示器，显示反而造成闪烁。
export const INDICATOR_DELAY_MS = 300;

export function useDelayedIndicator(active: boolean, delayMs = INDICATOR_DELAY_MS): boolean {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!active) {
      setVisible(false);
      return;
    }
    const timer = setTimeout(() => setVisible(true), delayMs);
    return () => clearTimeout(timer);
  }, [active, delayMs]);
  return visible;
}

export interface LongTaskProps {
  // 正在做什么，写具体动作，不写“处理中”
  labelZh: string;
  // 已完成与总数都已知时才给，缺一个就走不确定态
  progress?: { done: number; total: number };
  // 同类作业的历史耗时均值，单位秒。没有历史数据时不传。
  estimateSeconds?: number;
  onCancel?: () => void;
  cancelling?: boolean;
}

// 预计耗时不精确到秒以下（07 第 5.6 节）
function formatEta(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  if (minutes && rest) return `预计还需 ${minutes} 分 ${rest} 秒`;
  if (minutes) return `预计还需 ${minutes} 分`;
  return `预计还需 ${Math.max(1, rest)} 秒`;
}

export function etaText(estimateSeconds?: number): string {
  return estimateSeconds === undefined ? "耗时未知" : formatEta(estimateSeconds);
}

export function LongTask({ labelZh, progress, estimateSeconds, onCancel, cancelling }: LongTaskProps): ReactElement {
  const determinate = progress !== undefined && progress.total > 0;
  const percent = determinate ? Math.min(100, Math.round((progress.done / progress.total) * 100)) : 0;
  return (
    <div className="gj-task" role="status" aria-live="polite">
      <span className="gj-task-label">
        {labelZh}
        {determinate ? ` ${progress.done} / ${progress.total}` : ""}
      </span>
      <span className="gj-task-eta">{etaText(estimateSeconds)}</span>
      <div
        className={`gj-task-bar ${determinate ? "gj-task-bar--determinate" : "gj-task-bar--indeterminate"}`}
        role="progressbar"
        aria-label={labelZh}
        {...(determinate ? { "aria-valuenow": percent, "aria-valuemin": 0, "aria-valuemax": 100 } : {})}
      >
        <i style={determinate ? { width: `${percent}%` } : undefined} />
      </div>
      {onCancel && (
        <button
          className="gj-btn gj-btn--secondary"
          type="button"
          disabled={cancelling}
          onClick={onCancel}
        >
          {cancelling ? "正在取消" : "取消"}
        </button>
      )}
    </div>
  );
}
