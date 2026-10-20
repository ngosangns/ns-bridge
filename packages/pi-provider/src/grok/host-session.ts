// @ts-nocheck — one Grok CLI session per host chat. Not the ACP process pool.
/**
 * In-process map from a host session scope to the Grok CLI session it resumes.
 * A new process cannot see this map. session_shutdown forgets one scope;
 * process exit forgets every scope.
 */

export interface HostSessionMemory {
	grokSessionId: string;
	/** Host messages already represented in that Grok session. */
	count: number;
	/** `contextHistoryFingerprint` of those messages. */
	fingerprint: string;
}

const sessions = new Map<string, HostSessionMemory>();
const lanes = new Map<string, Promise<void>>();

export function getHostSession(scopeKey: string): HostSessionMemory | undefined {
	return sessions.get(scopeKey);
}

export function setHostSession(scopeKey: string, memory: HostSessionMemory): void {
	sessions.set(scopeKey, memory);
}

export function forgetHostSession(scopeKey: string): void {
	sessions.delete(scopeKey);
}

export function forgetAllHostSessions(): void {
	sessions.clear();
}

/** One host chat resumes a single Grok session, so its turns run in order. */
export function enqueueHostTurn(scopeKey: string, run: () => Promise<void>): Promise<void> {
	const previous = lanes.get(scopeKey) ?? Promise.resolve();
	const current = previous.then(run, run);
	lanes.set(
		scopeKey,
		current.then(
			() => undefined,
			() => undefined,
		),
	);
	return current;
}

export function resetHostSessionsForTests(): void {
	sessions.clear();
	lanes.clear();
}
