// Transmit boundary placeholder (spec fixed decision 7).
//
// This is the ONLY module that may ever import an HTTP client, and its only
// permitted outbound operation will be submitting already-finalized canonical
// bytes to the configured endpoint (with the client-side timeout of spec
// section 6). In this phase it is deliberately unimplemented and imported by
// NOTHING — the module-graph test in zero-network.test.ts enforces that the
// dry-run/manifest entry path can never reach it.

export function transmitCanonicalPayload(): never {
  throw new Error(
    "transmission is not implemented in this phase (TER-35); the collector is offline-only",
  );
}
