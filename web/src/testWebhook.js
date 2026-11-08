// The activity the Mock "Send test webhook" button posts to this app's own receiver: the real Ping Activity shape, with fixed fake ids.
const uuid = () => (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `00000000-0000-4000-8000-${String(Date.now()).padStart(12, "0").slice(-12)}`);
export function makeTestActivity(clientName = "test-sender") {
  const env = { id: "00000000-0000-4000-8000-0000000000e1" };
  return {
    id: uuid(), recordedAt: new Date().toISOString(), correlationId: uuid(),
    action: { type: "USER.ACCESS_ALLOWED", description: "user access allowed (test)" },
    actors: { client: { id: "00000000-0000-4000-8000-0000000000c1", name: clientName, environment: env }, user: { id: "00000000-0000-4000-8000-0000000000a1", name: "demo-user", environment: env } },
    resources: [{ id: "00000000-0000-4000-8000-0000000000aa", type: "USER", name: "test resource" }],
    result: { status: "SUCCESS" },
  };
}
