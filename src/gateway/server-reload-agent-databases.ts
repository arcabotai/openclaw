import fs from "node:fs";
import path from "node:path";
import { hasAgentRosterProperty, listAgentIds } from "../agents/agent-roster.js";
import { getRuntimeConfigSnapshot } from "../config/io.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { captureDeletedAgentDatabaseFences } from "../infra/agent-database-readers.js";
import { formatErrorMessage } from "../infra/errors.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";

let reconciliation: Promise<void> = Promise.resolve();
const departedWorkAdmissions = new Map<string, () => void>();
const pendingDepartedReleases = new Map<string, { cancelled: boolean; done: Promise<void> }>();

/** Resolves when a deferred database release finishes. Idle removal has already closed. */
export function waitForDepartedAgentDatabaseRelease(agentId: string): Promise<void> {
  return pendingDepartedReleases.get(normalizeAgentId(agentId))?.done ?? Promise.resolve();
}

/** One roster publication at a time, so a later commit cannot lose to an older close. */
function enqueueAgentDatabaseReconciliation(task: () => Promise<void>): Promise<void> {
  const run = reconciliation.then(task, task);
  reconciliation = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function explicitAgentIds(config: OpenClawConfig): string[] {
  return hasAgentRosterProperty(config) ? listAgentIds(config) : [];
}

function liveAgentIds(): Set<string> | undefined {
  const live = getRuntimeConfigSnapshot();
  return live ? new Set(listAgentIds(live)) : undefined;
}

/**
 * Follow a snapshot published after this commit captured its predecessor.
 * An unchanged snapshot still belongs to that predecessor, so this commit's
 * roster is authoritative until a later publication replaces it.
 */
function admittedAgentIds(previousConfig: OpenClawConfig, nextConfig: OpenClawConfig): Set<string> {
  const live = getRuntimeConfigSnapshot();
  if (live && live !== previousConfig) {
    return new Set(listAgentIds(live));
  }
  return new Set(listAgentIds(nextConfig));
}

/** A roster that admits an agent again may adopt databases its deletion left behind. */
export async function reviveAgentDatabasesAfterConfigCommit(
  agentIds: readonly string[],
  warn: (message: string) => void,
): Promise<void> {
  await enqueueAgentDatabaseReconciliation(() => reviveAgentDatabases(agentIds, warn));
}

/**
 * Closing a removed agent's holders keeps its files. Revival follows PR #159013:
 * only an owner the committed roster admits again is revived.
 */
export async function reconcileAgentDatabasesAfterConfigCommit(params: {
  previousConfig: OpenClawConfig;
  nextConfig: OpenClawConfig;
  warn: (message: string) => void;
}): Promise<void> {
  const { previousConfig, nextConfig, warn } = params;
  await enqueueAgentDatabaseReconciliation(async () => {
    const admitted = admittedAgentIds(previousConfig, nextConfig);
    for (const agentId of admitted) {
      cancelPendingDepartedRelease(agentId);
    }
    try {
      for (const agentId of explicitAgentIds(previousConfig)) {
        if (admitted.has(agentId)) {
          continue;
        }
        if (await agentDeletionOwnsCleanup(agentId)) {
          continue;
        }
        if (!(await agentHasOpenDatabaseHolder(agentId))) {
          continue;
        }
        try {
          await releaseDepartedAgentDatabase(agentId, previousConfig, nextConfig, warn);
        } catch (error) {
          warn(
            `agent ${agentId} left the roster; database release failed: ${formatErrorMessage(error)}. Restart the Gateway before deleting that agent's files.`,
          );
        }
      }
    } finally {
      releaseAdmittedWorkClosures(admitted);
    }
    await reviveAgentDatabases(
      listAgentIds(nextConfig).filter((agentId) =>
        admittedAgentIds(previousConfig, nextConfig).has(agentId),
      ),
      warn,
    );
  });
}

/** Revive fenced readers only. Admission closures are released separately. */
async function reviveAgentDatabases(
  agentIds: readonly string[],
  warn: (message: string) => void,
): Promise<void> {
  const deletedAgents = new Set(captureDeletedAgentDatabaseFences().map(([, agentId]) => agentId));
  const returningAgents = agentIds.filter((agentId) => deletedAgents.has(agentId));
  if (!returningAgents.length) {
    return;
  }
  try {
    const { reviveAgentDatabases: revive } = await import("../state/openclaw-agent-db-readers.js");
    await revive(returningAgents);
  } catch (error) {
    warn(
      `agent config committed; worker reader revival will reconcile at next task: ${formatErrorMessage(error)}`,
    );
  }
}

/** agents.delete still owns purge after it commits the roster change. */
async function agentDeletionOwnsCleanup(agentId: string): Promise<boolean> {
  const { readAgentDeletionJournalAsync } = await import("../state/agent-deletion-journal.js");
  const journal = await readAgentDeletionJournalAsync(agentId);
  return journal !== undefined && !journal.cleanupCompleted;
}

async function agentHasOpenDatabaseHolder(agentId: string): Promise<boolean> {
  const normalized = normalizeAgentId(agentId);
  const [{ agentDatabaseLifecycle }, { hasOpenClawAgentDatabaseAsyncResources }] =
    await Promise.all([
      import("../state/openclaw-agent-db-lifecycle.js"),
      import("../state/openclaw-agent-db-resources.js"),
    ]);
  for (const database of agentDatabaseLifecycle.databases.values()) {
    if (database.agentId === normalized && database.db.isOpen) {
      return true;
    }
  }
  return hasOpenClawAgentDatabaseAsyncResources({ agentId: normalized });
}

async function releaseDepartedAgentDatabase(
  agentId: string,
  previousConfig: OpenClawConfig,
  nextConfig: OpenClawConfig,
  warn: (message: string) => void,
): Promise<void> {
  const normalized = normalizeAgentId(agentId);
  const running = await captureDepartedAgentWork(normalized);
  if (running) {
    // Reload stays unblocked. The turn finishes on its own, then the database closes.
    deferDepartedAgentRelease(normalized, running.settled, previousConfig, nextConfig, warn);
    return;
  }
  await closeDepartedAgentResources(normalized, previousConfig, nextConfig);
}

function departedDatabasePaths(
  agentId: string,
  canonical: string,
  paths: {
    resolveOpenClawAgentSqlitePath: (options: { agentId: string }) => string;
    resolveIncognitoOpenClawAgentSqlitePath: (options: { agentId: string }) => string;
  },
): Set<string> {
  const physical = new Set<string>();
  for (const pathname of [
    canonical,
    paths.resolveOpenClawAgentSqlitePath({ agentId }),
    paths.resolveIncognitoOpenClawAgentSqlitePath({ agentId }),
  ]) {
    const resolved = path.resolve(pathname);
    physical.add(resolved);
    try {
      physical.add(fs.realpathSync(resolved));
    } catch {
      // The file may not exist yet. The lexical path still names its writer queue.
    }
  }
  return physical;
}

/** Session-row, transcript, and history-worker writes can still be queued after the turn ends. */
async function awaitDepartedDurableWrites(
  agentId: string,
  databasePaths: ReadonlySet<string>,
): Promise<void> {
  const [{ drainOpenClawAgentWriteQueues }, { awaitSessionHistoryWorkerIdle }] = await Promise.all([
    import("../state/openclaw-agent-write-admission.js"),
    import("../config/sessions/session-history-worker-idle.js"),
  ]);
  const ownsPath = (storePath: string) => {
    const resolved = path.resolve(storePath);
    if (databasePaths.has(resolved)) {
      return true;
    }
    try {
      return databasePaths.has(fs.realpathSync(resolved));
    } catch {
      return false;
    }
  };
  await drainOpenClawAgentWriteQueues(ownsPath);
  await awaitSessionHistoryWorkerIdle({ agentId, paths: [...databasePaths] });
  await drainOpenClawAgentWriteQueues(ownsPath);
}

async function closeDepartedAgentResources(
  agentId: string,
  previousConfig: OpenClawConfig,
  nextConfig: OpenClawConfig,
): Promise<void> {
  const normalized = normalizeAgentId(agentId);
  if (liveAgentIds()?.has(normalized)) {
    return;
  }
  const [
    { prepareAgentDeleteDatabases },
    { resolveEffectiveAgentDir },
    { retirePreparedModelRuntimeAgent },
    { closeActiveMemorySearchManagerCore },
    { releaseSessionHistoryWorkerDatabases },
    paths,
    { agentDatabaseLifecycle, closeOpenClawAgentDatabaseByPathAsync },
    { closeDeletedAgentDatabases },
  ] = await Promise.all([
    import("../agents/agent-delete-databases.js"),
    import("../agents/agent-scope-config.js"),
    import("../agents/prepared-model-runtime.js"),
    import("../plugins/memory-runtime.js"),
    import("../config/sessions/session-history-worker-idle.js"),
    import("../state/openclaw-agent-db.paths.js"),
    import("../state/openclaw-agent-db-lifecycle.js"),
    import("../state/openclaw-agent-db-readers.js"),
  ]);
  const agentDir = resolveEffectiveAgentDir(previousConfig, normalized);
  const canonical = paths.resolveOpenClawAgentSqlitePath({
    agentId: normalized,
    path: path.join(agentDir, "openclaw-agent.sqlite"),
  });
  const durablePaths = departedDatabasePaths(normalized, canonical, paths);
  await awaitDepartedDurableWrites(normalized, durablePaths);
  if (liveAgentIds()?.has(normalized)) {
    return;
  }
  const openPaths = [...agentDatabaseLifecycle.databases.values()]
    .filter((database) => database.agentId === normalized && database.db.isOpen)
    .map((database) => database.path);
  await releaseSessionHistoryWorkerDatabases({
    agentId: normalized,
    paths: [
      canonical,
      paths.resolveOpenClawAgentSqlitePath({ agentId: normalized }),
      paths.resolveIncognitoOpenClawAgentSqlitePath({ agentId: normalized }),
    ],
  });
  await closeActiveMemorySearchManagerCore({ cfg: previousConfig, agentId: normalized });

  let readerPaths = [
    ...new Set([
      canonical,
      paths.resolveOpenClawAgentSqlitePath({ agentId: normalized }),
      ...openPaths,
    ]),
  ];
  let agentDirs = [agentDir];
  let planningError: Error | undefined;
  try {
    const plan = await prepareAgentDeleteDatabases(nextConfig, normalized, agentDir);
    if (plan.readerPaths.length > 0) {
      readerPaths = [...new Set([...readerPaths, ...plan.readerPaths])];
    }
    agentDirs = plan.agentDirs;
  } catch (error) {
    planningError = error instanceof Error ? error : new Error(formatErrorMessage(error));
  }
  await retirePreparedModelRuntimeAgent({ agentId: normalized, agentDirs });
  if (liveAgentIds()?.has(normalized)) {
    if (planningError) {
      throw planningError;
    }
    return;
  }
  await blockDepartedAgentWork(normalized);
  if (liveAgentIds()?.has(normalized)) {
    releaseDepartedWorkAdmission(normalized);
    if (planningError) {
      throw planningError;
    }
    return;
  }
  // close() skips TRUNCATE on a worker-maintained handle. History peers are already
  // closed, so this handle checkpoints once and its close removes -wal/-shm.
  for (const pathname of readerPaths) {
    agentDatabaseLifecycle.databases.get(path.resolve(pathname))?.walMaintenance.checkpoint();
  }
  for (const pathname of readerPaths) {
    await closeOpenClawAgentDatabaseByPathAsync(pathname, normalized);
  }
  if (liveAgentIds()?.has(normalized)) {
    releaseDepartedWorkAdmission(normalized);
    if (planningError) {
      throw planningError;
    }
    return;
  }
  await closeDeletedAgentDatabases(normalized, readerPaths, {
    assertCurrentFinal() {
      if (liveAgentIds()?.has(normalized)) {
        throw new Error(`Agent ${normalized} returned to the roster during database release.`);
      }
    },
    async assertCurrentAsync() {
      this.assertCurrentFinal();
    },
  });
  if (planningError) {
    throw planningError;
  }
}

/** New session writes stop once the departed agent's current turn has finished. */
async function blockDepartedAgentWork(agentId: string): Promise<void> {
  if (departedWorkAdmissions.has(agentId)) {
    return;
  }
  const [{ closeAgentWorkAdmissions }, { AgentDeletionPendingError }] = await Promise.all([
    import("../sessions/session-controller.lifecycle.js"),
    import("../sessions/session-agent-work-admission.js"),
  ]);
  try {
    departedWorkAdmissions.set(
      agentId,
      closeAgentWorkAdmissions({
        agentId,
        reason: new AgentDeletionPendingError(
          `Agent ${agentId} left the roster and its database is closing.`,
        ),
      }),
    );
  } catch (error) {
    // Reload can observe the departed agent's own turn. The database fence still
    // refuses a later open; this call only cannot be issued from inside that turn.
    if (error instanceof Error && error.message.includes("from its own active turn")) {
      return;
    }
    throw error;
  }
}

function releaseDepartedWorkAdmission(agentId: string): void {
  const release = departedWorkAdmissions.get(normalizeAgentId(agentId));
  if (!release) {
    return;
  }
  departedWorkAdmissions.delete(normalizeAgentId(agentId));
  release();
}

/** Re-admission must not depend on a reader fence that cleanup never installed. */
function releaseAdmittedWorkClosures(admitted: ReadonlySet<string>): void {
  const agentIds: string[] = [];
  for (const agentId of departedWorkAdmissions.keys()) {
    if (admitted.has(agentId)) {
      agentIds.push(agentId);
    }
  }
  for (const agentId of agentIds) {
    releaseDepartedWorkAdmission(agentId);
  }
}

function cancelPendingDepartedRelease(agentId: string): void {
  const pending = pendingDepartedReleases.get(normalizeAgentId(agentId));
  if (!pending) {
    return;
  }
  pending.cancelled = true;
  pendingDepartedReleases.delete(normalizeAgentId(agentId));
}

/**
 * In-flight embedded runs and acquired turns keep the database. Nothing here
 * aborts them: config removal already refuses new turns, and the current turn
 * persists the same way it does on main.
 */
async function captureDepartedAgentWork(
  agentId: string,
): Promise<{ settled: Promise<void> } | undefined> {
  const [
    { captureAgentWorkAdmissionSettlement },
    { nativeAttemptAttachments },
    { captureEmbeddedRunDrainTarget },
  ] = await Promise.all([
    import("../sessions/session-controller.lifecycle.js"),
    import("../agents/embedded-agent-runner/run-state.js"),
    import("../agents/embedded-agent-runner/runs.js"),
  ]);
  const runs: Array<NonNullable<ReturnType<typeof captureEmbeddedRunDrainTarget>>> = [];
  for (const attachment of nativeAttemptAttachments()) {
    const run = captureEmbeddedRunDrainTarget(attachment, { agentId });
    if (run?.isActive()) {
      runs.push(run);
    }
  }
  const effects = captureAgentWorkAdmissionSettlement({ agentId });
  if (!runs.length && !effects.pending) {
    return undefined;
  }
  return {
    settled: Promise.all([
      ...runs.map((run) => run.waitForEnd(null).finally(() => run.release())),
      ...(effects.pending ? [effects.released] : []),
    ]).then(() => awaitDepartedTerminalPersistence(agentId)),
  };
}

function deferDepartedAgentRelease(
  agentId: string,
  settled: Promise<void>,
  previousConfig: OpenClawConfig,
  nextConfig: OpenClawConfig,
  warn: (message: string) => void,
): void {
  if (pendingDepartedReleases.has(agentId)) {
    return;
  }
  const pending = {
    cancelled: false,
    done: Promise.resolve(),
  };
  pending.done = settled
    .then(async () => {
      if (pending.cancelled || pendingDepartedReleases.get(agentId) !== pending) {
        return;
      }
      if (liveAgentIds()?.has(agentId)) {
        return;
      }
      await closeDepartedAgentResources(agentId, previousConfig, nextConfig);
    })
    .catch((error: unknown) => {
      if (!pending.cancelled) {
        warn(
          `agent ${agentId} left the roster; database release failed: ${formatErrorMessage(error)}. Restart the Gateway before deleting that agent's files.`,
        );
      }
    })
    .finally(() => {
      if (pendingDepartedReleases.get(agentId) === pending) {
        pendingDepartedReleases.delete(agentId);
      }
    });
  pendingDepartedReleases.set(agentId, pending);
}

/** Source work and Gateway terminal persistence can settle after effect release. */
async function awaitDepartedTerminalPersistence(agentId: string): Promise<void> {
  const { getRpcSourceIdentity, listRpcSourceEntries } =
    await import("../sessions/session-controller.rpc-sources.js");
  const seen = new WeakSet<Promise<unknown>>();
  let stalled = false;
  for (;;) {
    const work: Promise<unknown>[] = [];
    let awaitingOwner = false;
    for (const [, source] of listRpcSourceEntries()) {
      const identity = getRpcSourceIdentity(source);
      const owner = identity.agentId ?? parseAgentSessionKey(identity.sessionKey)?.agentId;
      if (!owner || normalizeAgentId(owner) !== agentId) {
        continue;
      }
      const persistence = source.adapter.projectSessionTerminalPersistence;
      if (persistence) {
        work.push(persistence);
      } else if (source.adapter.projectSessionTerminalPending === true) {
        awaitingOwner = true;
      }
      for (const pending of source.input.custody.work ?? []) {
        work.push(pending);
      }
    }
    const fresh = work.filter((pending) => !seen.has(pending));
    for (const pending of fresh) {
      seen.add(pending);
    }
    if (!fresh.length && !awaitingOwner) {
      return;
    }
    if (!fresh.length) {
      if (stalled) {
        throw new Error(`Agent ${agentId} terminal session persistence did not start.`);
      }
      stalled = true;
      await Promise.resolve();
      continue;
    }
    stalled = false;
    await Promise.allSettled(fresh);
  }
}
