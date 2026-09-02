import { createFlaryThreadClient, type FlaryThreadClient } from "flary/client";
import type { ThreadBinding } from "flary/contracts";
import { useEffect, useMemo, useState, useSyncExternalStore, type FormEvent } from "react";
import { ArrowUpRight, Check, History, LoaderCircle, Search, ShieldAlert } from "lucide-react";

type AppRecord = { id: string; name: string; slug: string; updatedAt?: string };
type Organization = { id: string; name: string; slug: string; role: string };

function useFlaryThread(client: FlaryThreadClient, binding: ThreadBinding | undefined) {
  const observation = useMemo(
    () => (binding ? client.observe(binding.thread, { live: "sse" }) : undefined),
    [client, binding?.thread.threadId, binding?.thread.agentId],
  );
  const emptySubscribe = useMemo(() => () => () => undefined, []);
  const emptySnapshot = useMemo(
    () => () => ({
      conversation: undefined,
      offset: undefined,
      phase: "absent" as const,
      error: undefined,
    }),
    [],
  );
  const snapshot = useSyncExternalStore(
    observation?.subscribe ?? emptySubscribe,
    observation?.getSnapshot ?? emptySnapshot,
    emptySnapshot,
  );

  useEffect(() => () => observation?.close(), [observation]);
  return { observation, snapshot };
}

export function ThreadConsole({
  organization,
  app,
  userId,
}: {
  organization: Organization;
  app: AppRecord;
  userId: string;
}) {
  const client = useMemo(() => createFlaryThreadClient({ baseUrl: window.location.origin }), []);
  const [threads, setThreads] = useState<ThreadBinding[]>([]);
  const [binding, setBinding] = useState<ThreadBinding>();
  const [message, setMessage] = useState("");
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [thinking, setThinking] = useState<
    "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra"
  >("medium");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [approvals, setApprovals] = useState<ApprovalView[]>([]);
  const [recallQuery, setRecallQuery] = useState("");
  const [recallResults, setRecallResults] = useState<
    Array<{ id: string; snippet: string; reference: Record<string, unknown> }>
  >([]);
  const [checkpoints, setCheckpoints] = useState<
    Awaited<ReturnType<FlaryThreadClient["historyCheckpoints"]>>["checkpoints"]
  >([]);
  const [selectedCheckpoint, setSelectedCheckpoint] = useState<string>();
  const [selectedDiff, setSelectedDiff] =
    useState<Awaited<ReturnType<FlaryThreadClient["historyDiff"]>>["diff"]>();
  const { snapshot } = useFlaryThread(client, binding);

  async function refreshThreads(): Promise<ThreadBinding | undefined> {
    const next = await client.list(app.id);
    setThreads(next);
    const selected = binding
      ? (next.find((item) => item.thread.threadId === binding.thread.threadId) ?? next[0])
      : next[0];
    if (selected) setBinding(selected);
    return selected;
  }

  async function refreshApprovals(nextBinding = binding) {
    if (!nextBinding) {
      setApprovals([]);
      return;
    }
    const records = await client.approvals(nextBinding.thread);
    setApprovals(
      records.map(normalizeApproval).filter((item): item is ApprovalView => Boolean(item)),
    );
  }

  async function refreshHistory(nextBinding = binding) {
    if (!nextBinding) {
      setCheckpoints([]);
      setSelectedCheckpoint(undefined);
      setSelectedDiff(undefined);
      return;
    }
    const response = await client.historyCheckpoints(nextBinding.thread, { limit: 30 });
    setCheckpoints(response.checkpoints);
    setSelectedCheckpoint((current) =>
      current && response.checkpoints.some((item) => item.id === current)
        ? current
        : response.checkpoints[0]?.id,
    );
  }

  useEffect(() => {
    setBinding(undefined);
    void refreshThreads()
      .then(async (selected) => {
        await refreshApprovals(selected);
        await refreshHistory(selected);
      })
      .catch((cause) => setError(errorMessage(cause)));
  }, [app.id]);

  useEffect(() => {
    if (!binding) return;
    void refreshHistory(binding).catch((cause) => setError(errorMessage(cause)));
  }, [binding?.thread.threadId]);

  useEffect(() => {
    if (!binding || !selectedCheckpoint) {
      setSelectedDiff(undefined);
      return;
    }
    const index = checkpoints.findIndex((item) => item.id === selectedCheckpoint);
    const baseCommitId = index >= 0 ? checkpoints[index + 1]?.id : undefined;
    void client
      .historyDiff(binding.thread, {
        ...(baseCommitId ? { baseCommitId } : {}),
        headCommitId: selectedCheckpoint,
      })
      .then((response) => setSelectedDiff(response.diff))
      .catch((cause) => setError(errorMessage(cause)));
  }, [binding?.thread.threadId, selectedCheckpoint, checkpoints]);

  async function createThread() {
    setBusy(true);
    setError(undefined);
    try {
      const next = await client.create({
        agentId: "flary-thread",
        workspace: {
          organizationId: organization.id,
          appId: app.id,
          projectId: app.id,
          workspaceId: `${app.id}-main`,
          branch: "main",
        },
        mode: "ask",
        thinkingLevel: "medium",
      });
      setBinding(next);
      setThreads((current) => [next, ...current]);
      await refreshApprovals(next);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!binding || !message.trim()) return;
    setBusy(true);
    setError(undefined);
    try {
      await client.submit(binding.thread, {
        message: message.trim(),
        ...(provider.trim() && model.trim()
          ? { model: { provider: provider.trim(), model: model.trim() } }
          : {}),
        thinkingLevel: thinking,
        idempotencyKey: crypto.randomUUID(),
      });
      setMessage("");
      await refreshApprovals(binding);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function changeMode(next: string) {
    if (!binding) return;
    try {
      const updated = await client.setMode(binding.thread, next);
      setBinding(updated);
      setThreads((current) =>
        current.map((item) => (item.thread.threadId === updated.thread.threadId ? updated : item)),
      );
      await refreshApprovals(updated);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  async function decideApproval(approval: ApprovalView, status: "approved" | "rejected") {
    if (!binding || !approval.id) return;
    setBusy(true);
    setError(undefined);
    try {
      await client.decideApproval(binding.thread, approval.id, {
        status,
        decidedBy: { id: userId, kind: "user", version: "1" },
        decidedAt: new Date().toISOString(),
      });
      await refreshApprovals(binding);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function searchRecall(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!binding || !recallQuery.trim()) return;
    try {
      const response = await client.recallSearch(binding.thread, {
        query: recallQuery.trim(),
        limit: 8,
      });
      setRecallResults(
        response.results.map((result) => ({
          id: result.id,
          snippet: result.snippet,
          reference: result.reference,
        })),
      );
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  const messages = snapshot.conversation?.messages ?? [];
  return (
    <section className="thread-console" aria-label="Flary thread console">
      <div className="thread-console-head">
        <div>
          <p className="eyebrow">Thread console</p>
          <h3>{binding ? "Continue durable work" : "Start a durable thread"}</h3>
          <p>Flue keeps the canonical stream. Refresh or leave the page and reconnect later.</p>
        </div>
        {!binding && (
          <button className="button primary" disabled={busy} onClick={() => void createThread()}>
            Create thread <ArrowUpRight size={15} />
          </button>
        )}
      </div>
      {threads.length > 0 && (
        <div className="thread-picker">
          <span>Threads</span>
          {threads.slice(0, 5).map((item) => (
            <button
              key={item.thread.threadId}
              className={item.thread.threadId === binding?.thread.threadId ? "selected" : ""}
              onClick={() => {
                setBinding(item);
                void refreshApprovals(item);
              }}
            >
              {item.persona ?? item.agentId} · {item.thread.threadId.slice(-6)}
            </button>
          ))}
        </div>
      )}
      {binding && (
        <>
          <div className="thread-toolbar">
            <label>
              Mode
              <select
                value={binding.defaultMode}
                onChange={(event) => void changeMode(event.target.value)}
              >
                <option value="ask">Ask</option>
                <option value="plan">Plan</option>
                <option value="build">Build</option>
                <option value="review">Review</option>
              </select>
            </label>
            <label>
              Provider
              <input
                value={provider}
                onChange={(event) => setProvider(event.target.value)}
                placeholder="cloudflare"
              />
            </label>
            <label>
              Model
              <input
                value={model}
                onChange={(event) => setModel(event.target.value)}
                placeholder="@cf/meta/llama…"
              />
            </label>
            <label>
              Thinking
              <select
                value={thinking}
                onChange={(event) => setThinking(event.target.value as typeof thinking)}
              >
                <option value="none">None</option>
                <option value="minimal">Minimal</option>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="xhigh">X-high</option>
                <option value="max">Max</option>
                <option value="ultra">Ultra</option>
              </select>
            </label>
            <span className={`thread-phase phase-${snapshot.phase}`}>
              {snapshot.phase === "live" ? (
                <Check size={13} />
              ) : (
                <LoaderCircle size={13} className={snapshot.phase === "connecting" ? "spin" : ""} />
              )}{" "}
              {snapshot.phase}
            </span>
          </div>
          <div className="thread-messages" aria-live="polite">
            {messages.length === 0 && (
              <p className="thread-empty">
                Send a message to begin. Tool activity and approvals will appear in this stream.
              </p>
            )}
            {messages.map((item) => (
              <article className={`thread-message ${item.role}`} key={item.id}>
                <span>{item.role}</span>
                {item.parts.map((part, index) =>
                  part.type === "text" ? (
                    <p key={`${item.id}-${index}`}>{part.text}</p>
                  ) : (
                    <pre key={`${item.id}-${index}`}>{JSON.stringify(part, null, 2)}</pre>
                  ),
                )}
              </article>
            ))}
          </div>
          <form className="thread-compose" onSubmit={(event) => void submit(event)}>
            <textarea
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              placeholder="Ask Flary to inspect, plan, or build…"
              rows={3}
            />
            <button className="button primary" disabled={busy || !message.trim()}>
              {busy ? <LoaderCircle size={15} className="spin" /> : <ArrowUpRight size={15} />} Send
            </button>
          </form>
          <form className="thread-recall" onSubmit={(event) => void searchRecall(event)}>
            <Search size={15} />
            <input
              value={recallQuery}
              onChange={(event) => setRecallQuery(event.target.value)}
              placeholder="Recall this project…"
            />
            <button className="button" disabled={!recallQuery.trim()}>
              Search
            </button>
          </form>
          {recallResults.length > 0 && (
            <div className="recall-results">
              {recallResults.map((result) => (
                <div key={result.id}>
                  <strong>{String(result.reference.path ?? result.id)}</strong>
                  <p>{result.snippet}</p>
                </div>
              ))}
            </div>
          )}
          <div className="thread-history">
            <div className="thread-subheading">
              <History size={15} /> Checkpoints{" "}
              <button className="button" type="button" onClick={() => void refreshHistory(binding)}>
                Refresh
              </button>
            </div>
            {checkpoints.length === 0 && (
              <p className="thread-empty">
                Completed turns will appear here as immutable checkpoints.
              </p>
            )}
            {checkpoints.length > 0 && (
              <div className="history-checkpoints">
                {checkpoints.map((checkpoint) => (
                  <button
                    key={checkpoint.id}
                    type="button"
                    className={checkpoint.id === selectedCheckpoint ? "selected" : ""}
                    onClick={() => setSelectedCheckpoint(checkpoint.id)}
                  >
                    <strong>{checkpoint.id.slice(0, 12)}</strong>
                    <span>{new Date(checkpoint.createdAt).toLocaleString()}</span>
                    <small>{checkpoint.files.length} files</small>
                  </button>
                ))}
              </div>
            )}
            {selectedDiff && (
              <div className="history-diff">
                <strong>Changed files</strong>
                {selectedDiff.files
                  .filter((file) => file.status !== "unchanged")
                  .map((file) => (
                    <div key={file.path}>
                      <code>{file.path}</code>
                      <span>{file.status}</span>
                    </div>
                  ))}
              </div>
            )}
          </div>
          {approvals.length > 0 && (
            <div className="thread-approvals">
              <div className="thread-subheading">Approvals</div>
              {approvals.map((approval) => (
                <article key={approval.id} className="approval-row">
                  <div>
                    <strong>{approval.toolId ?? "Protected operation"}</strong>
                    <p>{approval.reason ?? "This operation needs approval."}</p>
                  </div>
                  {!approval.decided && (
                    <div className="approval-actions">
                      <button
                        className="button"
                        disabled={busy}
                        onClick={() => void decideApproval(approval, "rejected")}
                      >
                        Reject
                      </button>
                      <button
                        className="button primary"
                        disabled={busy}
                        onClick={() => void decideApproval(approval, "approved")}
                      >
                        Approve
                      </button>
                    </div>
                  )}
                </article>
              ))}
            </div>
          )}
          {snapshot.error && <p className="form-error">{snapshot.error.message}</p>}
        </>
      )}
      {error && (
        <p className="form-error">
          <ShieldAlert size={14} /> {error}
        </p>
      )}
    </section>
  );
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "Thread request failed";
}

type ApprovalView = {
  id?: string;
  toolId?: string;
  reason?: string;
  decided?: boolean;
};

function normalizeApproval(value: unknown): ApprovalView | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as { request?: unknown; decision?: unknown };
  if (!record.request || typeof record.request !== "object") return undefined;
  const request = record.request as {
    id?: unknown;
    reason?: unknown;
    resourceId?: unknown;
    context?: { toolId?: unknown };
  };
  const decision =
    record.decision && typeof record.decision === "object" ? record.decision : undefined;
  return {
    id: typeof request.id === "string" ? request.id : undefined,
    toolId:
      typeof request.context?.toolId === "string"
        ? request.context.toolId
        : typeof request.resourceId === "string"
          ? request.resourceId
          : undefined,
    reason: typeof request.reason === "string" ? request.reason : undefined,
    decided: Boolean(decision),
  };
}
