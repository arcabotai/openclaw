import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { buildLatestSubagentRunReadIndex } from "../agents/subagent-registry-read.js";
import { getRuntimeConfig } from "../config/io.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import {
  canonicalizeSpawnedByForAgent,
  resolveSessionStoreAgentId,
  resolveSessionStoreKey,
} from "./session-store-key.js";

const MAX_APPROVAL_AUDIENCE_SESSIONS = 64;

type SubagentApprovalLineage = {
  controllerSessionKey?: string | null;
  requesterSessionKey?: string | null;
};

type StoredApprovalLineage = Pick<SessionEntry, "parentSessionKey" | "spawnedBy">;

export type ApprovalSessionAudienceSources = {
  canonicalizeSessionKey: (
    sessionKey: string,
    relativeToSessionKey?: string,
  ) => string | null | undefined;
  getLatestSubagentLineage: (sessionKey: string) => SubagentApprovalLineage | null | undefined;
  getStoredSessionLineage: (sessionKey: string) => StoredApprovalLineage | null | undefined;
};

function canonicalizeAudienceSessionKey(
  sources: ApprovalSessionAudienceSources,
  sessionKey: string | null | undefined,
  relativeToSessionKey?: string,
): string | null {
  const raw = sessionKey?.trim();
  if (!raw) {
    return null;
  }
  return sources.canonicalizeSessionKey(raw, relativeToSessionKey)?.trim() || null;
}

/** Resolves the source session and its operator-visible ancestor audience. */
export function resolveApprovalSessionAudienceFromSources(params: {
  sourceSessionKey: string;
  sources: ApprovalSessionAudienceSources;
}): string[] {
  const sourceSessionKey = canonicalizeAudienceSessionKey(params.sources, params.sourceSessionKey);
  if (!sourceSessionKey) {
    return [];
  }

  const audience: string[] = [];
  const queued = new Set<string>([sourceSessionKey]);
  const pending = [sourceSessionKey];
  const enqueue = (sessionKey: string | null) => {
    if (!sessionKey || queued.has(sessionKey) || pending.length >= MAX_APPROVAL_AUDIENCE_SESSIONS) {
      return;
    }
    queued.add(sessionKey);
    pending.push(sessionKey);
  };

  for (const sessionKey of pending) {
    audience.push(sessionKey);

    const subagentLineage = params.sources.getLatestSubagentLineage(sessionKey);
    const controllerSessionKey = canonicalizeAudienceSessionKey(
      params.sources,
      subagentLineage?.controllerSessionKey,
      sessionKey,
    );
    const requesterSessionKey = canonicalizeAudienceSessionKey(
      params.sources,
      subagentLineage?.requesterSessionKey,
      sessionKey,
    );
    const registryParents = [controllerSessionKey, requesterSessionKey].filter(
      (candidate): candidate is string => Boolean(candidate),
    );
    if (registryParents.length > 0) {
      // Current registry ownership supersedes session metadata, whose spawnedBy
      // link can remain stale after steering or restart.
      for (const parentSessionKey of registryParents) {
        enqueue(parentSessionKey);
      }
      continue;
    }

    const storedLineage = params.sources.getStoredSessionLineage(sessionKey);
    const parentSessionKey = storedLineage?.parentSessionKey?.trim()
      ? storedLineage.parentSessionKey
      : storedLineage?.spawnedBy;
    enqueue(canonicalizeAudienceSessionKey(params.sources, parentSessionKey, sessionKey));
  }

  return audience;
}

function createRuntimeApprovalSessionAudienceSources(
  cfg: OpenClawConfig,
  sourceAgentId?: string | null,
): ApprovalSessionAudienceSources {
  const subagentRuns = buildLatestSubagentRunReadIndex();
  const resolveStorageTarget = (sessionKey: string): { agentId: string; sessionKey: string } => {
    const parsed = parseAgentSessionKey(sessionKey);
    if (parsed?.rest.toLowerCase() === "global") {
      return { agentId: normalizeAgentId(parsed.agentId), sessionKey: "global" };
    }
    return {
      agentId: resolveSessionStoreAgentId(cfg, sessionKey),
      sessionKey,
    };
  };
  return {
    canonicalizeSessionKey: (sessionKey, relativeToSessionKey) => {
      if (!relativeToSessionKey) {
        const canonical = resolveSessionStoreKey({ cfg, sessionKey });
        const ownerAgentId = sourceAgentId ?? resolveDefaultAgentId(cfg);
        // Storage uses the bare global sentinel, while live session streams are
        // agent-scoped so one agent cannot receive another's global events.
        return resolveApprovalSourceStreamKey(canonical, ownerAgentId);
      }
      const relativeAgentId = resolveSessionStoreAgentId(cfg, relativeToSessionKey);
      const canonical = canonicalizeSpawnedByForAgent(cfg, relativeAgentId, sessionKey);
      return canonical ? resolveApprovalSourceStreamKey(canonical, relativeAgentId) : canonical;
    },
    getLatestSubagentLineage: (sessionKey) => subagentRuns.getLatestSubagentRun(sessionKey),
    getStoredSessionLineage: (sessionKey) => {
      const target = resolveStorageTarget(sessionKey);
      return loadSessionEntry({
        agentId: target.agentId,
        clone: false,
        hydrateSkillPromptRefs: false,
        sessionKey: target.sessionKey,
      });
    },
  };
}

/** Resolves an approval audience from the live registry and session stores. */
export function resolveApprovalSessionAudience(
  sourceSessionKey: string,
  sourceAgentId?: string | null,
): string[] {
  const cfg = getRuntimeConfig();
  return resolveApprovalSessionAudienceFromSources({
    sourceSessionKey,
    sources: createRuntimeApprovalSessionAudienceSources(cfg, sourceAgentId),
  });
}

/** Best-effort stream key used when lineage lookup is unavailable. */
export function resolveApprovalSourceStreamKey(
  sourceSessionKey: string,
  sourceAgentId?: string | null,
): string {
  const normalizedSessionKey = sourceSessionKey.trim();
  return normalizedSessionKey === "global" && sourceAgentId
    ? `agent:${normalizeAgentId(sourceAgentId)}:global`
    : normalizedSessionKey;
}
