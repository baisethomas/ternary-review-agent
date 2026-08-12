export type OpsAlertCooldownStore = {
  /** Returns true when this alert key may fire now (and records the fire). */
  claim(key: string, cooldownMs: number, now?: number): Promise<boolean>;
  /** Drop a claim so a failed delivery can retry on the next check. */
  release(key: string): Promise<void>;
};

export class InMemoryOpsAlertCooldownStore implements OpsAlertCooldownStore {
  private readonly until = new Map<string, number>();

  async claim(key: string, cooldownMs: number, now = Date.now()) {
    const activeUntil = this.until.get(key) ?? 0;
    if (activeUntil > now) return false;
    this.until.set(key, now + Math.max(0, cooldownMs));
    return true;
  }

  async release(key: string) {
    this.until.delete(key);
  }
}
