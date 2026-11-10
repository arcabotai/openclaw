import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { normalizeAgentId } from "../../routing/session-key.js";
import { historyDatabases } from "./session-transcript-worker-resources.js";

type NativeClosePool = {
  closeResources: (key?: string) => Promise<void>;
  canCloseNativeResources?: () => boolean;
};

function nativeClosePool(pool: { rotate: () => Promise<void> }): NativeClosePool | undefined {
  if (!("closeResources" in pool) || typeof pool.closeResources !== "function") {
    return undefined;
  }
  return pool as NativeClosePool;
}

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

/**
 * Close this agent's history connections without rotating the worker.
 * Rotation terminates the thread and leaves its WAL reader slot behind, so the
 * later main-handle close is not the last connection and cannot remove -wal/-shm.
 */
export async function releaseSessionHistoryWorkerDatabases(options: {
  agentId: string;
  paths: readonly string[];
}): Promise<void> {
  const agentId = normalizeAgentId(options.agentId);
  const wanted = new Set(options.paths.map((pathname) => path.resolve(pathname)));
  for (;;) {
    const selected = [...historyDatabases.values()].filter(
      (resource) =>
        resource.database.agentId === agentId &&
        [...wanted].some((pathname) => resource.matchesPath(pathname)),
    );
    if (selected.length === 0) {
      return;
    }
    await awaitSessionHistoryWorkerIdle({ agentId, paths: [...wanted] });
    let waiting = false;
    for (const resource of selected) {
      if (resource.pending > 0 || resource.hostEffects.size > 0) {
        waiting = true;
        continue;
      }
      for (const lane of Array.from(resource.nativeLanes)) {
        const pool = nativeClosePool(lane.pool);
        if (pool && pool.canCloseNativeResources?.() !== false) {
          resource.nativeLanes.delete(lane);
          await pool.closeResources(JSON.stringify([{ path: resource.database.path }]));
        }
      }
      if (resource.pending === 0 && resource.nativeLanes.size === 0) {
        await resource.retire();
      } else {
        waiting = true;
      }
    }
    if (!waiting) {
      return;
    }
    await setImmediate();
  }
}
