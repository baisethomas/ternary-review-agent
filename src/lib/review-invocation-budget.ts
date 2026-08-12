import { AsyncLocalStorage } from "node:async_hooks";

const invocationStartedAt = new AsyncLocalStorage<number>();

/** Bind the worker/request start time for OpenRouter budget calculations. */
export function withInvocationStartedAt<T>(startedAt: number, run: () => T): T {
  return invocationStartedAt.run(startedAt, run);
}

/** Worker/request start time when set; otherwise undefined outside a bound invocation. */
export function getInvocationStartedAt() {
  return invocationStartedAt.getStore();
}
