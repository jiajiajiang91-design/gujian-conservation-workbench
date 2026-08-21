// 动作卡片：展示一次动作调用的名称与参数摘要。确认界面（ConfirmBar）引用
// 本卡片，不复制参数副本（确认机制规则 4）。
export interface ActionCardData {
  actionName: string;
  displayNameZh: string;
  argsSummaryZh: string;
  costlyEstimateZh: string | null;
  warnings: readonly string[];
}

export function ActionCard({ data }: { data: ActionCardData }) {
  return (
    <div className="assistant-action-card">
      <div className="assistant-action-card-title">{data.displayNameZh}</div>
      <div className="assistant-action-card-args">{data.argsSummaryZh}</div>
      {data.costlyEstimateZh && (
        <div className="assistant-action-card-estimate">{data.costlyEstimateZh}</div>
      )}
      {data.warnings.map((warning) => (
        <div key={warning} className="assistant-action-card-warning" role="alert">
          {warning}
        </div>
      ))}
    </div>
  );
}
