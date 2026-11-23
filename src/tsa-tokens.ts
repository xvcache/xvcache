import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Local ledger of qualified TSA tokens consumed by the hosted server (qualified timestamp packs are prepaid).
 * - Every token actually obtained from the provider is counted (first stamp or requalification).
 * - `stock` = tokens left on the provider account when the operator last set it (env XVCACHE_TSA_TOKEN_STOCK
 *   seeds it once, `xvcache-remote --tsa-stock <n>` resets it). remaining = stock - consumed_since_stock.
 * - Below the alert threshold (env XVCACHE_TSA_TOKEN_ALERT_BELOW, default 20) every consumption logs an
 *   operator alert. The ledger is an estimate: the provider's own account remains the reference.
 */

export const DEFAULT_TOKEN_ALERT_BELOW = 20;

export type TokenLedgerState = {
  version: 1;
  provider: string;
  consumed_total: number;
  stock: number | null;
  stock_set_at: string | null;
  consumed_since_stock: number;
  last_token_at: string | null;
};

export type TokenLedgerView = TokenLedgerState & { remaining: number | null; alert_below: number; low: boolean };

export class TsaTokenLedger {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private file: string,
    private o: { provider: string; alertBelow?: number; initialStock?: number | null; onAlert?: (message: string) => void; now?: () => Date },
  ) {}

  get alertBelow(): number {
    const n = this.o.alertBelow;
    return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : DEFAULT_TOKEN_ALERT_BELOW;
  }

  private now(): Date {
    return this.o.now ? this.o.now() : new Date();
  }

  private async load(): Promise<TokenLedgerState> {
    try {
      return JSON.parse(await fs.readFile(this.file, "utf8")) as TokenLedgerState;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      const seeded = typeof this.o.initialStock === "number" && Number.isFinite(this.o.initialStock) && this.o.initialStock >= 0;
      return {
        version: 1, provider: this.o.provider, consumed_total: 0,
        stock: seeded ? this.o.initialStock! : null, stock_set_at: seeded ? this.now().toISOString() : null,
        consumed_since_stock: 0, last_token_at: null,
      };
    }
  }

  private async save(s: TokenLedgerState): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(s, null, 2), { mode: 0o600 });
    await fs.rename(tmp, this.file);
  }

  private tx<T>(fn: (s: TokenLedgerState) => T, write = true): Promise<T> {
    const run = this.chain.then(async () => {
      const s = await this.load();
      const out = fn(s);
      if (write) await this.save(s);
      return out;
    });
    this.chain = run.catch(() => {});
    return run;
  }

  private view(s: TokenLedgerState): TokenLedgerView {
    const remaining = s.stock === null ? null : Math.max(0, s.stock - s.consumed_since_stock);
    return { ...s, remaining, alert_below: this.alertBelow, low: remaining !== null && remaining < this.alertBelow };
  }

  /** Count `n` tokens just obtained from the provider; logs an alert below the threshold. */
  async consumed(n = 1): Promise<TokenLedgerView> {
    const v = await this.tx((s) => {
      s.consumed_total += n;
      s.consumed_since_stock += n;
      s.last_token_at = this.now().toISOString();
      return this.view(s);
    });
    if (v.low) {
      this.o.onAlert?.(`TSA ${v.provider} token stock low: about ${v.remaining} token(s) left (alert below ${v.alert_below}; local estimate, check the provider account and top up).`);
    }
    return v;
  }

  /** Operator: the provider account shows `stock` tokens left right now. */
  setStock(stock: number): Promise<TokenLedgerView> {
    if (!Number.isInteger(stock) || stock < 0) return Promise.reject(new Error("stock must be a non-negative integer"));
    return this.tx((s) => {
      s.stock = stock;
      s.stock_set_at = this.now().toISOString();
      s.consumed_since_stock = 0;
      return this.view(s);
    });
  }

  status(): Promise<TokenLedgerView> {
    return this.tx((s) => this.view(s), false);
  }
}
