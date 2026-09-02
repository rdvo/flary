import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";

import type { FlaryAgentThreadHandle } from "../harness/client/functions.js";
import type { ThreadBinding } from "../harness/contracts/index.js";
import type { FlaryUiActivity, FlaryUiTurn } from "./model.js";
import type { FlaryReactAgentClient } from "./types.js";
import { useFlaryThread } from "./use-thread.js";

export interface FlaryAgentConsoleProps {
  agent: FlaryReactAgentClient;
  title?: string;
  className?: string;
  welcomeTitle?: string;
  welcomeMessage?: string;
  suggestions?: readonly string[];
  includeChildren?: boolean;
  headerActions?: ReactNode;
  onThreadChange?(thread: FlaryAgentThreadHandle | null): void;
}

function titleOf(binding: ThreadBinding): string {
  const metadata =
    binding.metadata && typeof binding.metadata === "object"
      ? (binding.metadata as Record<string, unknown>)
      : {};
  return typeof metadata.title === "string" && metadata.title.trim()
    ? metadata.title.trim()
    : "New thread";
}

function timeOf(binding: ThreadBinding): number {
  const value = Date.parse(binding.updatedAt || binding.createdAt);
  return Number.isFinite(value) ? value : 0;
}

function duration(value?: number): string | undefined {
  if (value === undefined) return undefined;
  if (value < 1_000) return `${Math.round(value)}ms`;
  return `${Math.round(value / 100) / 10}s`;
}

function icon(
  name: "plus" | "send" | "stop" | "trash" | "chevron" | "tool" | "spark" | "check" | "error",
) {
  const paths: Record<typeof name, ReactNode> = {
    plus: (
      <>
        <path d="M12 5v14M5 12h14" />
      </>
    ),
    send: (
      <>
        <path d="m22 2-7 20-4-9-9-4Z" />
        <path d="M22 2 11 13" />
      </>
    ),
    stop: <rect x="7" y="7" width="10" height="10" />,
    trash: (
      <>
        <path d="M3 6h18M8 6V4h8v2M19 6l-1 15H6L5 6M10 11v6M14 11v6" />
      </>
    ),
    chevron: <path d="m9 18 6-6-6-6" />,
    tool: (
      <>
        <path d="M14.7 6.3a4 4 0 0 0-5-5l2.1 2.1-3.4 3.4-2.1-2.1a4 4 0 0 0 5 5l7.3 7.3a2 2 0 0 0 2.8-2.8Z" />
        <path d="m5 19 4-4" />
      </>
    ),
    spark: (
      <>
        <path d="m12 3 1.2 4.8L18 9l-4.8 1.2L12 15l-1.2-4.8L6 9l4.8-1.2Z" />
        <path d="m19 16 .6 2.4L22 19l-2.4.6L19 22l-.6-2.4L16 19l2.4-.6Z" />
      </>
    ),
    check: <path d="m5 12 4 4L19 6" />,
    error: (
      <>
        <path d="M18 6 6 18M6 6l12 12" />
      </>
    ),
  };
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      {paths[name]}
    </svg>
  );
}

function ActivityIcon({ item }: { item: FlaryUiActivity }) {
  if (item.state === "failed")
    return <span className="flary-activity-icon is-failed">{icon("error")}</span>;
  if (item.state === "completed")
    return <span className="flary-activity-icon is-complete">{icon("check")}</span>;
  if (item.kind === "reasoning")
    return <span className="flary-activity-icon is-live">{icon("spark")}</span>;
  return <span className="flary-activity-icon is-live">{icon("tool")}</span>;
}

function ActivityRow({
  item,
  onApprove,
  onReject,
}: {
  item: FlaryUiActivity;
  onApprove(id: string): Promise<void>;
  onReject(id: string): Promise<void>;
}) {
  const hasDetail = item.request !== undefined || item.response !== undefined || item.detail;
  const content = (
    <>
      <ActivityIcon item={item} />
      <span className="flary-activity-label">{item.label}</span>
      {duration(item.durationMs) ? (
        <span className="flary-activity-duration">{duration(item.durationMs)}</span>
      ) : null}
      {hasDetail ? <span className="flary-activity-chevron">{icon("chevron")}</span> : null}
    </>
  );
  return (
    <div className={`flary-activity-row is-${item.state}`}>
      {hasDetail ? (
        <details>
          <summary>{content}</summary>
          <div className="flary-activity-detail">
            {item.detail ? <p>{item.detail}</p> : null}
            {item.request !== undefined ? (
              <>
                <b>Request</b>
                <pre>{JSON.stringify(item.request, null, 2)}</pre>
              </>
            ) : null}
            {item.response !== undefined ? (
              <>
                <b>Response</b>
                <pre>{JSON.stringify(item.response, null, 2)}</pre>
              </>
            ) : null}
          </div>
        </details>
      ) : (
        <div className="flary-activity-summary">{content}</div>
      )}
      {item.state === "waiting" && item.approvalId ? (
        <div className="flary-approval-actions">
          <button type="button" onClick={() => void onReject(item.approvalId!)}>
            Reject
          </button>
          <button
            type="button"
            className="is-primary"
            onClick={() => void onApprove(item.approvalId!)}
          >
            Approve
          </button>
        </div>
      ) : null}
    </div>
  );
}

function WorkRail({
  turn,
  onApprove,
  onReject,
}: {
  turn: FlaryUiTurn;
  onApprove(id: string): Promise<void>;
  onReject(id: string): Promise<void>;
}) {
  if (!turn.activity.length && !turn.error) return null;
  const elapsed = turn.startedAt
    ? Math.max(
        0,
        ((turn.completedAt ? Date.parse(turn.completedAt) : Date.now()) -
          Date.parse(turn.startedAt)) /
          1_000,
      )
    : undefined;
  const label =
    turn.status === "working"
      ? `Working${elapsed !== undefined ? ` for ${Math.max(1, Math.round(elapsed))}s` : ""}`
      : turn.status === "waiting"
        ? "Waiting"
        : turn.status === "failed"
          ? "Stopped"
          : `Worked${elapsed !== undefined ? ` for ${Math.max(1, Math.round(elapsed))}s` : ""}`;
  return (
    <details
      className="flary-work-rail"
      open={turn.status === "working" || turn.status === "waiting" || turn.status === "failed"}
    >
      <summary>
        <span className={`flary-work-state is-${turn.status}`} />
        <strong>{label}</strong>
        <span>
          {turn.activity.length} {turn.activity.length === 1 ? "step" : "steps"}
        </span>
        <span className="flary-work-chevron">{icon("chevron")}</span>
      </summary>
      <div className="flary-work-items">
        {turn.activity.map((item) => (
          <ActivityRow key={item.id} item={item} onApprove={onApprove} onReject={onReject} />
        ))}
        {turn.error ? (
          <div className="flary-turn-error">
            <strong>Turn failed</strong>
            <p>{turn.error}</p>
          </div>
        ) : null}
      </div>
    </details>
  );
}

function Transcript({
  turns,
  pending,
  active,
  onApprove,
  onReject,
}: {
  turns: FlaryUiTurn[];
  pending: readonly { id: string; text: string }[];
  active: boolean;
  onApprove(id: string): Promise<void>;
  onReject(id: string): Promise<void>;
}) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => end.current?.scrollIntoView({ block: "end" }), [turns, pending]);
  return (
    <div className="flary-transcript" aria-live="polite">
      {turns.map((turn) => (
        <section className="flary-turn" key={turn.id}>
          {turn.messages.map((message) => (
            <div className={`flary-message is-${message.role}`} key={message.id}>
              <div className="flary-message-body">{message.text}</div>
            </div>
          ))}
          <WorkRail turn={turn} onApprove={onApprove} onReject={onReject} />
        </section>
      ))}
      {pending.map((message) => (
        <div className="flary-message is-user is-pending" key={message.id}>
          <div className="flary-message-body">{message.text}</div>
        </div>
      ))}
      {active && !turns.at(-1)?.activity.length ? (
        <div className="flary-first-pulse">
          <span />
          Working
        </div>
      ) : null}
      <div ref={end} />
    </div>
  );
}

function Composer({
  disabled,
  active,
  onSend,
  onInterrupt,
}: {
  disabled: boolean;
  active: boolean;
  onSend(message: string): Promise<void>;
  onInterrupt(): Promise<void>;
}) {
  const [message, setMessage] = useState("");
  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    const value = message.trim();
    if (!value || disabled) return;
    setMessage("");
    try {
      await onSend(value);
    } catch {
      setMessage(value);
    }
  };
  return (
    <form className="flary-composer" onSubmit={(event) => void submit(event)}>
      <textarea
        value={message}
        onChange={(event) => setMessage(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            void submit();
          }
        }}
        disabled={disabled}
        rows={2}
        placeholder={disabled ? "Open a thread to start" : "Ask the agent anything"}
        aria-label="Message"
      />
      <div className="flary-composer-footer">
        <span>Enter to send · Shift Enter for a new line</span>
        {active ? (
          <button
            type="button"
            className="flary-send is-stop"
            onClick={() => void onInterrupt()}
            aria-label="Stop agent"
          >
            {icon("stop")}
          </button>
        ) : (
          <button
            type="submit"
            className="flary-send"
            disabled={disabled || !message.trim()}
            aria-label="Send message"
          >
            {icon("send")}
          </button>
        )}
      </div>
    </form>
  );
}

export function FlaryAgentConsole({
  agent,
  title = "Agent",
  className = "",
  welcomeTitle = "Start anywhere",
  welcomeMessage = "Ask a question, assign work, or connect tools when you need them.",
  suggestions = [],
  includeChildren = true,
  headerActions,
  onThreadChange,
}: FlaryAgentConsoleProps) {
  const [bindings, setBindings] = useState<ThreadBinding[]>([]);
  const [thread, setThread] = useState<FlaryAgentThreadHandle | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const realtime = useFlaryThread({ thread, includeChildren });

  const sortedBindings = useMemo(
    () => [...bindings].sort((a, b) => timeOf(b) - timeOf(a)),
    [bindings],
  );
  const open = async (binding: ThreadBinding) => {
    const next = await agent.threads.open({
      organizationId: binding.thread.organizationId,
      threadId: binding.thread.threadId,
    });
    setThread(next);
    onThreadChange?.(next);
  };
  useEffect(() => {
    let disposed = false;
    void agent.threads
      .list()
      .then(async (items) => {
        if (disposed) return;
        setBindings(items);
        if (items[0]) await open(items[0]);
      })
      .catch((cause) => {
        if (!disposed)
          setListError(cause instanceof Error ? cause.message : "Threads are unavailable.");
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [agent]);

  const createThread = async () => {
    if (creating) return;
    setCreating(true);
    setListError(null);
    try {
      const created = await agent.threads.create({ title: "New thread" });
      setBindings((current) => [
        created.binding,
        ...current.filter((item) => item.thread.threadId !== created.ref.threadId),
      ]);
      setThread(created);
      onThreadChange?.(created);
    } catch (cause) {
      setListError(cause instanceof Error ? cause.message : "The thread could not be created.");
    } finally {
      setCreating(false);
    }
  };

  const deleteThread = async (binding: ThreadBinding) => {
    const target =
      thread?.ref.threadId === binding.thread.threadId
        ? thread
        : await agent.threads.open({
            organizationId: binding.thread.organizationId,
            threadId: binding.thread.threadId,
          });
    setBindings((current) =>
      current.filter((item) => item.thread.threadId !== binding.thread.threadId),
    );
    if (thread?.ref.threadId === binding.thread.threadId) {
      setThread(null);
      onThreadChange?.(null);
    }
    try {
      await target.delete();
    } catch (cause) {
      setBindings((current) => [binding, ...current]);
      setListError(cause instanceof Error ? cause.message : "The thread could not be deleted.");
    }
  };

  const empty = !loading && !thread;
  return (
    <div className={`flary-console ${className}`} data-flary-console="">
      <style>{flaryAgentConsoleStyles}</style>
      <header className="flary-console-header">
        <div className="flary-mark">{icon("spark")}</div>
        <div>
          <strong>{title}</strong>
          <span>Durable agent</span>
        </div>
        <div className={`flary-connection is-${realtime.connectionState}`}>
          <i />
          {realtime.connectionState}
        </div>
        {headerActions}
      </header>
      <aside className="flary-thread-panel">
        <div className="flary-panel-heading">
          <span>Threads</span>
          <button type="button" onClick={() => void createThread()} disabled={creating}>
            {icon("plus")}
            <b>{creating ? "Creating" : "New"}</b>
          </button>
        </div>
        {listError ? <p className="flary-list-error">{listError}</p> : null}
        <div className="flary-thread-list">
          {sortedBindings.map((binding) => (
            <div
              className={`flary-thread-item ${
                binding.thread.threadId === thread?.ref.threadId ? "is-active" : ""
              }`}
              key={binding.thread.threadId}
            >
              <button type="button" onClick={() => void open(binding)}>
                <strong>{titleOf(binding)}</strong>
                <span>{binding.status}</span>
              </button>
              <button
                type="button"
                className="flary-delete"
                onClick={() => void deleteThread(binding)}
                aria-label={`Delete ${titleOf(binding)}`}
              >
                {icon("trash")}
              </button>
            </div>
          ))}
        </div>
      </aside>
      <main className="flary-chat-panel">
        {empty ? (
          <div className="flary-welcome">
            <div className="flary-welcome-mark">{icon("spark")}</div>
            <h1>{welcomeTitle}</h1>
            <p>{welcomeMessage}</p>
            <button type="button" onClick={() => void createThread()}>
              {icon("plus")}Create a thread
            </button>
          </div>
        ) : realtime.turns.length || realtime.pendingMessages.length ? (
          <Transcript
            turns={realtime.turns}
            pending={realtime.pendingMessages}
            active={realtime.active}
            onApprove={realtime.approve}
            onReject={realtime.reject}
          />
        ) : (
          <div className="flary-welcome">
            <div className="flary-welcome-mark">{icon("spark")}</div>
            <h1>{welcomeTitle}</h1>
            <p>{welcomeMessage}</p>
            {suggestions.length ? (
              <div className="flary-suggestions">
                {suggestions.map((suggestion) => (
                  <button
                    type="button"
                    key={suggestion}
                    onClick={() => void realtime.send(suggestion)}
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        )}
        {realtime.error ? (
          <button type="button" className="flary-runtime-error" onClick={realtime.reconnect}>
            {realtime.error}
            <span>Reconnect</span>
          </button>
        ) : null}
        <Composer
          disabled={!thread}
          active={realtime.active}
          onSend={realtime.send}
          onInterrupt={realtime.interrupt}
        />
      </main>
    </div>
  );
}

export const flaryAgentConsoleStyles = String.raw`
[data-flary-console]{--flary-ink:#121417;--flary-muted:#687078;--flary-line:#d9dde1;--flary-panel:#f7f8f9;--flary-blue:#1769e0;--flary-blue-strong:#0756c8;--flary-danger:#b42318;--flary-good:#16794d;box-sizing:border-box;color:var(--flary-ink);background:#fff;border:1px solid var(--flary-line);font:14px/1.45 Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;display:grid;grid-template-columns:248px minmax(0,1fr);grid-template-rows:58px minmax(0,1fr);height:min(820px,calc(100dvh - 32px));min-height:560px;overflow:hidden}
[data-flary-console] *{box-sizing:border-box}[data-flary-console] button,[data-flary-console] textarea{font:inherit}[data-flary-console] button{color:inherit}[data-flary-console] svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.flary-console-header{grid-column:1/-1;display:flex;align-items:center;gap:12px;padding:0 14px;border-bottom:1px solid var(--flary-line);min-width:0}.flary-console-header>div:nth-child(2){display:grid;line-height:1.15}.flary-console-header strong{font-size:15px}.flary-console-header span{font-size:11px;color:var(--flary-muted);letter-spacing:.02em}.flary-mark{width:34px;height:34px;display:grid;place-items:center;background:var(--flary-ink);color:white}.flary-connection{margin-left:auto;display:flex;align-items:center;gap:7px;border:1px solid var(--flary-line);padding:5px 9px;text-transform:capitalize;font:12px ui-monospace,SFMono-Regular,Menlo,monospace}.flary-connection i{width:7px;height:7px;border-radius:50%;background:#98a2ab}.flary-connection.is-live i{background:#2bb673}.flary-connection.is-connecting i,.flary-connection.is-reconnecting i{background:#e3a008;animation:flary-pulse 1.2s ease-in-out infinite}
.flary-thread-panel{grid-row:2;border-right:1px solid var(--flary-line);background:var(--flary-panel);min-width:0;overflow:auto}.flary-panel-heading{height:54px;padding:0 12px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--flary-line);font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.12em}.flary-panel-heading button{display:flex;gap:5px;align-items:center;border:1px solid var(--flary-line);background:#fff;padding:7px 9px;cursor:pointer;text-transform:none;letter-spacing:0}.flary-panel-heading button:hover{border-color:#aeb4ba}.flary-thread-list{padding:8px}.flary-thread-item{display:grid;grid-template-columns:minmax(0,1fr) 32px;margin-bottom:4px;border:1px solid transparent}.flary-thread-item:hover{border-color:var(--flary-line);background:#fff}.flary-thread-item.is-active{background:var(--flary-ink);color:#fff}.flary-thread-item>button:first-child{border:0;background:transparent;text-align:left;padding:11px;min-width:0;cursor:pointer;display:grid;gap:2px}.flary-thread-item strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.flary-thread-item span{font-size:11px;color:var(--flary-muted)}.flary-thread-item.is-active span{color:#b8bec5}.flary-delete{border:0;background:transparent;display:grid;place-items:center;opacity:0;cursor:pointer}.flary-thread-item:hover .flary-delete,.flary-thread-item:focus-within .flary-delete{opacity:1}.flary-list-error{margin:8px;padding:9px;border-left:2px solid var(--flary-danger);color:var(--flary-danger);font-size:12px}
.flary-chat-panel{position:relative;min-width:0;min-height:0;display:grid;grid-template-rows:minmax(0,1fr) auto;background:#fff}.flary-transcript{min-height:0;overflow:auto;padding:28px clamp(18px,4vw,64px) 36px;scrollbar-gutter:stable}.flary-turn{display:flow-root;max-width:960px;margin:0 auto 28px}.flary-message{display:flex;margin:0 0 16px}.flary-message.is-user{justify-content:flex-end}.flary-message-body{max-width:min(76ch,82%);white-space:pre-wrap;overflow-wrap:anywhere;padding:11px 14px;background:#eef0f2;border:1px solid #e4e6e8}.flary-message.is-user .flary-message-body{color:white;background:var(--flary-blue);border-color:var(--flary-blue)}.flary-message.is-pending{opacity:.72}.flary-work-rail{margin:18px 0 22px;border-top:1px solid var(--flary-line);border-bottom:1px solid var(--flary-line)}.flary-work-rail>summary{list-style:none;min-height:44px;display:flex;align-items:center;gap:9px;cursor:pointer;color:var(--flary-muted)}.flary-work-rail>summary::-webkit-details-marker{display:none}.flary-work-rail strong{color:var(--flary-ink);font-size:13px}.flary-work-rail>summary>span:nth-of-type(2){font-size:12px}.flary-work-chevron{margin-left:auto;transition:transform .15s}.flary-work-rail[open] .flary-work-chevron{transform:rotate(90deg)}.flary-work-state{width:8px;height:8px;border:1.5px solid var(--flary-muted);border-radius:50%}.flary-work-state.is-working{border-color:var(--flary-blue);border-top-color:transparent;animation:flary-spin .8s linear infinite}.flary-work-state.is-completed{background:var(--flary-good);border-color:var(--flary-good)}.flary-work-state.is-failed{border-color:var(--flary-danger);background:var(--flary-danger)}.flary-work-state.is-waiting{border-color:#d38b00;background:#f5c04a}.flary-work-items{border-top:1px solid #edf0f2;padding:7px 0 10px}.flary-activity-row{position:relative;margin-left:4px;padding-left:20px}.flary-activity-row:before{content:"";position:absolute;left:7px;top:0;bottom:0;border-left:1px solid #dfe3e6}.flary-activity-row details>summary,.flary-activity-summary{list-style:none;display:flex;align-items:center;gap:9px;min-height:34px;color:#4f565d;cursor:default}.flary-activity-row details>summary{cursor:pointer}.flary-activity-row details>summary::-webkit-details-marker{display:none}.flary-activity-icon{width:16px;height:16px;display:grid;place-items:center;background:#fff;z-index:1}.flary-activity-icon svg{width:13px;height:13px}.flary-activity-icon.is-live{color:var(--flary-blue)}.flary-activity-icon.is-failed{color:var(--flary-danger)}.flary-activity-icon.is-complete{color:var(--flary-good)}.flary-activity-label{min-width:0;overflow:hidden;text-overflow:ellipsis}.flary-activity-duration{margin-left:auto;color:#8a9299;font:11px ui-monospace,SFMono-Regular,Menlo,monospace}.flary-activity-chevron{transition:transform .15s}.flary-activity-row details[open] .flary-activity-chevron{transform:rotate(90deg)}.flary-activity-detail{margin:4px 0 10px 25px;border:1px solid var(--flary-line);background:#f8f9fa;padding:10px;max-height:300px;overflow:auto}.flary-activity-detail b{display:block;font-size:10px;text-transform:uppercase;letter-spacing:.1em;margin:6px 0}.flary-activity-detail pre{margin:0 0 10px;white-space:pre-wrap;font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}.flary-approval-actions{display:flex;gap:7px;margin:4px 0 10px 25px}.flary-approval-actions button{border:1px solid var(--flary-line);background:white;padding:6px 10px;cursor:pointer}.flary-approval-actions .is-primary{background:var(--flary-ink);color:#fff;border-color:var(--flary-ink)}.flary-turn-error{border-left:2px solid var(--flary-danger);color:var(--flary-danger);padding:8px 10px;margin:5px 0}.flary-turn-error p{margin:3px 0 0}.flary-first-pulse{display:flex;align-items:center;gap:8px;color:var(--flary-muted);max-width:960px;margin:0 auto}.flary-first-pulse span{width:8px;height:8px;border:1.5px solid var(--flary-blue);border-top-color:transparent;border-radius:50%;animation:flary-spin .8s linear infinite}
.flary-composer{margin:0 clamp(18px,4vw,64px) 18px;border:1px solid #bfc5ca;background:white;box-shadow:0 10px 28px rgba(25,31,37,.07)}.flary-composer textarea{width:100%;min-height:74px;max-height:220px;resize:vertical;border:0;outline:0;padding:14px 15px 6px;background:transparent;color:var(--flary-ink)}.flary-composer-footer{display:flex;align-items:center;gap:10px;padding:7px}.flary-composer-footer>span{color:var(--flary-muted);font-size:11px}.flary-send{margin-left:auto;width:36px;height:36px;border:0;background:var(--flary-ink);color:#fff;display:grid;place-items:center;cursor:pointer}.flary-send:hover{background:#30353a}.flary-send:disabled{opacity:.32;cursor:default}.flary-send.is-stop{background:var(--flary-danger)}.flary-runtime-error{position:absolute;left:50%;bottom:128px;transform:translateX(-50%);border:1px solid #e5b6b2;background:#fff7f6;color:var(--flary-danger);padding:8px 11px;cursor:pointer;box-shadow:0 8px 20px rgba(80,20,15,.08)}.flary-runtime-error span{font-weight:700;margin-left:10px}.flary-welcome{align-self:center;justify-self:center;max-width:560px;text-align:center;padding:30px}.flary-welcome-mark{width:44px;height:44px;margin:0 auto 14px;border:1px solid var(--flary-line);display:grid;place-items:center}.flary-welcome h1{font-size:24px;letter-spacing:-.025em;margin:0 0 8px}.flary-welcome p{color:var(--flary-muted);margin:0 0 18px}.flary-welcome>button{display:inline-flex;align-items:center;gap:7px;border:0;background:var(--flary-ink);color:white;padding:10px 14px;cursor:pointer}.flary-suggestions{display:grid;gap:6px;text-align:left}.flary-suggestions button{border:1px solid var(--flary-line);background:#fff;padding:9px 11px;text-align:left;cursor:pointer}.flary-suggestions button:hover{border-color:var(--flary-blue);color:var(--flary-blue)}
@keyframes flary-spin{to{transform:rotate(360deg)}}@keyframes flary-pulse{50%{opacity:.35}}@media(prefers-reduced-motion:reduce){[data-flary-console] *{animation:none!important;transition:none!important}}@media(max-width:720px){[data-flary-console]{grid-template-columns:1fr;grid-template-rows:58px auto minmax(0,1fr);height:100dvh;border:0}.flary-thread-panel{grid-row:2;border-right:0;border-bottom:1px solid var(--flary-line);max-height:150px}.flary-thread-list{display:flex;overflow:auto}.flary-thread-item{min-width:180px}.flary-chat-panel{grid-row:3}.flary-transcript{padding:20px 14px}.flary-composer{margin:0 10px 10px}.flary-composer-footer>span{display:none}.flary-message-body{max-width:90%}}
`;
