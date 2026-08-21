import { randomBytes } from "node:crypto";

export interface ConfirmationGrant {
  confirmId: string;
  actionName: string;
  argsHash: string;
  expiresAt: number;
}

export type RedeemResult =
  | { ok: true; grant: ConfirmationGrant }
  | { ok: false; code: "TOKEN_UNKNOWN" | "TOKEN_EXPIRED" };

// confirm 级动作的一次性令牌：询问时签发，确认时兑付，兑付即销毁。
// 过期、未知、重复兑付一律拒绝（fail-closed）。
export class ConfirmationTokenStore {
  readonly #grants = new Map<string, ConfirmationGrant>();
  readonly #ttlMs: number;
  readonly #now: () => number;

  constructor(options: { ttlMs?: number; now?: () => number } = {}) {
    this.#ttlMs = options.ttlMs ?? 10 * 60 * 1000;
    this.#now = options.now ?? Date.now;
  }

  issue(input: { confirmId: string; actionName: string; argsHash: string }): string {
    const token = randomBytes(24).toString("base64url");
    this.#grants.set(token, {
      confirmId: input.confirmId,
      actionName: input.actionName,
      argsHash: input.argsHash,
      expiresAt: this.#now() + this.#ttlMs,
    });
    return token;
  }

  redeem(token: string): RedeemResult {
    const grant = this.#grants.get(token);
    if (!grant) return { ok: false, code: "TOKEN_UNKNOWN" };
    this.#grants.delete(token);
    if (this.#now() > grant.expiresAt) return { ok: false, code: "TOKEN_EXPIRED" };
    return { ok: true, grant };
  }

  // 当前 user_withdrawn 走 redeem 后记决定的路径，本方法暂无调用点；
  // 保留给后续服务端主动作废场景（如会话过期批量回收），勿删。
  withdraw(confirmId: string): void {
    for (const [token, grant] of this.#grants) {
      if (grant.confirmId === confirmId) this.#grants.delete(token);
    }
  }
}
