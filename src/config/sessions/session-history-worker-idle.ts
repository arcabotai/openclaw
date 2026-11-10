import { setImmediate } from "node:timers/promises";
import { normalizeAgentId } from "../../routing/session-key.js";
import { historyDatabases } from "./session-transcript-worker-resources.js";

/** In-flight history reads and their host effects. Does not abort or close them. */
export async function awaitSessionHistoryWorkerIdle(options: {
  agentId: string;
  paths: readonly string[];
}): Promise<void> {
  const agentId = normalizeAgentId(options.agentId);
  const wanted = new Set(options.paths);
  for (;;) {
    const selected = [...historyDatabases.values()].filter(
      (resource) =>
        resource.database.agentId === agentId &&
        [...wanted].some((pathname) => resource.matchesPath(pathname)),
    );
    const pending = selected.flatMap((resource) => [
      ...resource.hostEffects,
      ...(resource.closing ? [resource.closing] : []),
    ]);
    const busy = selected.some((resource) => resource.pending > 0);
    if (!busy && pending.length === 0) {
      return;
    }
    if (pending.length > 0) {
      await Promise.allSettled(pending);
      continue;
    }
    await setImmediate();
  }
}
