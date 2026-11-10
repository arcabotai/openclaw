import { normalizeAgentId } from "../routing/session-key.js";

type EmbeddedAgentAttempt = {
  agentId: string;
  /** Abort the in-flight provider stream. The prompt settles after its transcript appends. */
  abort: () => void;
  settled: Promise<void>;
};

const attempts = new Set<EmbeddedAgentAttempt>();

/** Join a live prompt until its aborted transcript appends finish. */
export function trackEmbeddedAgentAttempt(attempt: EmbeddedAgentAttempt): () => void {
  const tracked = { ...attempt, agentId: normalizeAgentId(attempt.agentId) };
  attempts.add(tracked);
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    attempts.delete(tracked);
  };
}

export function listEmbeddedAgentAttempts(agentId: string): EmbeddedAgentAttempt[] {
  const normalized = normalizeAgentId(agentId);
  return [...attempts].filter((attempt) => attempt.agentId === normalized);
}
