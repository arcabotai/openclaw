import path from "node:path";
import { getSqliteRuntimeCapabilities } from "../../infra/bun-sqlite-library.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { historyDatabases } from "./session-transcript-worker-resources.js";

/** Reload must not wait longer than a normal config apply. */
const HISTORY_RELEASE_BUDGET_MS = 1_000;

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

/**
 * The pool latches false when its first worker started before close qualification
 * (`session-transcript-read-pools.ts` keeps that false until rotation). Once this
 * process is allowed to close native handles, `closeResources` is a real sqlite
 * close for the lanes still attached.
 */
function poolAllowsNativeClose(pool: NativeClosePool): boolean {
  if (pool.canCloseNativeResources?.() !== false) {
    return true;
  }
  return getSqliteRuntimeCapabilities().explicitSqliteCloseReleasesNativeResources;
}

function settleWithin(work: Promise<unknown>, budgetMs: number): Promise<boolean> {
  if (budgetMs <= 0) {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), budgetMs);
    timer.unref();
    work.then(
      () => {
        clearTimeout(timer);
        resolve(true);
      },
      () => {
        clearTimeout(timer);
        resolve(false);
      },
    );
  });
}

/**
 * Close history connections for this agent without rotating the worker.
 * Returns false when a peer cannot be closed within the reload budget. The
 * caller then leaves the database open instead of blocking config reload.
 */
export async function releaseSessionHistoryWorkerDatabases(options: {
  agentId: string;
  paths: readonly string[];
}): Promise<boolean> {
  const agentId = normalizeAgentId(options.agentId);
  const wanted = new Set(options.paths.map((pathname) => path.resolve(pathname)));
  const selected = [...historyDatabases.values()].filter(
    (resource) =>
      resource.database.agentId === agentId &&
      [...wanted].some((pathname) => resource.matchesPath(pathname)),
  );
  if (selected.length === 0) {
    return true;
  }
  const deadline = performance.now() + HISTORY_RELEASE_BUDGET_MS;
  const effects = selected.flatMap((resource) => [
    ...resource.hostEffects,
    ...(resource.closing ? [resource.closing] : []),
  ]);
  if (
    effects.length > 0 &&
    !(await settleWithin(Promise.allSettled(effects), deadline - performance.now()))
  ) {
    return false;
  }
  // A retained read has no completion promise. Polling its counter blocks reload.
  if (selected.some((resource) => resource.pending > 0 || resource.hostEffects.size > 0)) {
    return false;
  }
  for (const resource of selected) {
    for (const lane of Array.from(resource.nativeLanes)) {
      const pool = nativeClosePool(lane.pool);
      if (!pool || !poolAllowsNativeClose(pool)) {
        return false;
      }
      resource.nativeLanes.delete(lane);
      const closed = await settleWithin(
        pool.closeResources(JSON.stringify([{ path: resource.database.path }])),
        deadline - performance.now(),
      );
      if (!closed) {
        return false;
      }
    }
    if (resource.nativeLanes.size !== 0) {
      return false;
    }
    const retired = await settleWithin(resource.retire(), deadline - performance.now());
    if (!retired) {
      return false;
    }
  }
  return true;
}
