export class ReviewInvocationTracker {
  private readonly ids = new Map<string, string>();
  private readonly createId: () => string;

  constructor(createId: () => string = () => crypto.randomUUID()) {
    this.createId = createId;
  }

  current(reviewKey: string) {
    const existing = this.ids.get(reviewKey);
    if (existing) return existing;
    const created = this.createId();
    this.ids.set(reviewKey, created);
    return created;
  }

  confirm(reviewKey: string) {
    this.ids.delete(reviewKey);
  }
}
