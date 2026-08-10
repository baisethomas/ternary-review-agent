import { readFile } from "node:fs/promises";
import { neon } from "@neondatabase/serverless";
import { describe, expect, it } from "vitest";
import { PostgresReviewEventLedger } from "./postgres-review-event-ledger";
import { ReviewEventAccessRevokedError, ReviewEventConflictError, type ReviewEvent } from "./review-event-ledger";

const enabled = process.env.RUN_POSTGRES_INTEGRATION_TESTS === "1";
const connectionString = process.env.DATABASE_URL;

describe.skipIf(!enabled)("PostgresReviewEventLedger", () => {
  it("persists idempotent repository-isolated events and deletes the exact scope", async () => {
    if (!connectionString) throw new Error("DATABASE_URL is required when RUN_POSTGRES_INTEGRATION_TESTS=1");
    const sql = neon(connectionString);
    const migration = await readFile(new URL("../../migrations/0001_review_event_ledger.sql", import.meta.url), "utf8");
    for (const statement of migration.split(";").map((value) => value.trim()).filter(Boolean)) await sql.query(statement);
    const ledger = new PostgresReviewEventLedger(sql);
    const installationId = Math.floor(Date.now() / 10) + Math.floor(Math.random() * 1_000);
    const event: ReviewEvent = {
      eventId: crypto.randomUUID(), idempotencyKey: `integration:${crypto.randomUUID()}`, reviewId: "ternary/ledger#1:head", type: "review.queued",
      occurredAt: new Date().toISOString(), scope: { installationId, owner: "Ternary", repo: "Ledger" }, pullNumber: 1, headSha: "head", payload: { jobId: "job-1" },
    };
    const otherScope = { ...event, eventId: crypto.randomUUID(), idempotencyKey: `integration:${crypto.randomUUID()}`, scope: { installationId, owner: "Ternary", repo: "Other" } } satisfies ReviewEvent;
    try {
      await expect(ledger.append(event)).resolves.toMatchObject({ event, inserted: true });
      await expect(ledger.append({ ...event, eventId: crypto.randomUUID() })).resolves.toMatchObject({ event, inserted: false });
      await expect(ledger.append({ ...event, eventId: crypto.randomUUID(), headSha: "conflict" })).rejects.toBeInstanceOf(ReviewEventConflictError);
      await ledger.append(otherScope);
      const concurrentEvent = { ...event, eventId: crypto.randomUUID(), idempotencyKey: `integration:${crypto.randomUUID()}`, payload: { jobId: "concurrent" } } satisfies ReviewEvent;
      const competingLedger = new PostgresReviewEventLedger(neon(connectionString));
      const concurrent = await Promise.all([
        ledger.append(concurrentEvent),
        competingLedger.append({ ...concurrentEvent, eventId: crypto.randomUUID() }),
      ]);
      expect(concurrent.map((result) => result.inserted).sort()).toEqual([false, true]);
      expect(concurrent[0].event.eventId).toBe(concurrent[1].event.eventId);
      await expect(ledger.list({ installationId, owner: "ternary", repo: "ledger" })).resolves.toMatchObject({ events: [event, concurrent[0].event] });
      await expect(ledger.deleteScope(event.scope)).resolves.toBe(2);
      await expect(ledger.append({ ...event, eventId: crypto.randomUUID(), idempotencyKey: `late:${crypto.randomUUID()}` })).rejects.toBeInstanceOf(ReviewEventAccessRevokedError);
      await ledger.restoreScope(event.scope);
      await expect(ledger.append({ ...event, eventId: crypto.randomUUID(), idempotencyKey: `restored:${crypto.randomUUID()}` })).resolves.toMatchObject({ inserted: true });
      await expect(ledger.list(otherScope.scope)).resolves.toMatchObject({ events: [otherScope] });
    } finally {
      await ledger.deleteInstallation(installationId);
      await sql.query("DELETE FROM review_event_revocations WHERE installation_id = $1", [installationId]);
    }
  });
});
