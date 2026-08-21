// confirm 级动作的确认条：只有明确点击允许才放行一次；拒绝与撤回分开上报；
// 页面关闭等异常不经过这里，由服务端按通道不可用兜底。
export function ConfirmBar({
  onDecision,
  disabled,
}: {
  onDecision: (decision: "allow_once" | "deny" | "user_withdrawn") => void;
  disabled: boolean;
}) {
  return (
    <div className="assistant-confirm-bar">
      <button type="button" disabled={disabled} onClick={() => onDecision("allow_once")}>
        允许执行一次
      </button>
      <button type="button" disabled={disabled} onClick={() => onDecision("deny")}>
        拒绝
      </button>
      <button type="button" disabled={disabled} onClick={() => onDecision("user_withdrawn")}>
        先不执行
      </button>
    </div>
  );
}
