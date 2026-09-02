import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { FlaryAgentThreadHandle } from "../harness/client/functions.js";
import type { FlaryRealtimeConnection } from "../harness/client/flue.js";
import type { UserInputRecord } from "../harness/contracts/user-input.js";
import {
  flaryUiTurnIsActive,
  mergeFlaryUiRecords,
  normalizeFlaryUiRecords,
  projectFlaryUiTurns,
  type FlaryUiRecord,
} from "./model.js";
import type { FlaryConnectionState, FlaryPendingMessage } from "./types.js";

export interface UseFlaryThreadOptions {
  thread: FlaryAgentThreadHandle | null;
  includeChildren?: boolean;
  storage?: Storage;
  reconnectMaxMs?: number;
}

export interface UseFlaryThreadResult {
  records: FlaryUiRecord[];
  turns: ReturnType<typeof projectFlaryUiTurns>;
  pendingMessages: FlaryPendingMessage[];
  connectionState: FlaryConnectionState;
  active: boolean;
  error: string | null;
  inputRequests: UserInputRecord[];
  send(message: string, mode?: "queue" | "steer"): Promise<void>;
  interrupt(): Promise<void>;
  approve(approvalId: string): Promise<void>;
  reject(approvalId: string): Promise<void>;
  respondToInput(
    requestId: string,
    answers: Readonly<Record<string, string>>,
    options?: { response?: string; canceled?: boolean },
  ): Promise<void>;
  reconnect(): void;
}

const sleep = (duration: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, duration);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

async function withTimeout<T>(promise: Promise<T>, durationMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("The live command acknowledgement timed out.")),
          durationMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function storageFor(options: UseFlaryThreadOptions): Storage | undefined {
  if (options.storage) return options.storage;
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

function cursorKey(thread: FlaryAgentThreadHandle): string {
  return `flary:thread:${thread.ref.organizationId}:${thread.ref.appId}:${thread.ref.threadId}:cursor`;
}

async function readAllAudit(thread: FlaryAgentThreadHandle): Promise<FlaryUiRecord[]> {
  const all: unknown[] = [];
  let after = 0;
  for (let page = 0; page < 100; page += 1) {
    const records = await thread.audit.list({ after, limit: 500 });
    if (!records.length) break;
    all.push(...records);
    const normalized = normalizeFlaryUiRecords(records);
    const last = normalized.at(-1)?.sequence;
    if (!last || last <= after || records.length < 500) break;
    after = last;
  }
  return normalizeFlaryUiRecords(all);
}

/** Durable WebSocket-first thread state with cursor replay and HTTP repair. */
export function useFlaryThread(options: UseFlaryThreadOptions): UseFlaryThreadResult {
  const { thread } = options;
  const [records, setRecords] = useState<FlaryUiRecord[]>([]);
  const [pendingMessages, setPendingMessages] = useState<FlaryPendingMessage[]>([]);
  const [connectionState, setConnectionState] = useState<FlaryConnectionState>(
    thread ? "connecting" : "idle",
  );
  const [reconnectToken, setReconnectToken] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [inputRequests, setInputRequests] = useState<UserInputRecord[]>([]);
  const connection = useRef<FlaryRealtimeConnection | null>(null);
  const cursor = useRef(0);
  const reconnectGeneration = useRef(0);
  const currentRecords = useRef<FlaryUiRecord[]>([]);

  const commit = useCallback(
    (incoming: FlaryUiRecord[]) => {
      if (!thread || !incoming.length) return;
      const merged = mergeFlaryUiRecords(currentRecords.current, incoming);
      currentRecords.current = merged;
      setRecords(merged);
      if (incoming.some((record) => record.type.startsWith("input."))) {
        void thread
          .userInput()
          .then((requests) => {
            setInputRequests([...requests]);
          })
          .catch(() => undefined);
      }
      const confirmed = incoming.filter((record) => record.type === "message.user").length;
      if (confirmed) setPendingMessages((current) => current.slice(confirmed));
      const nextCursor = incoming.at(-1)?.sequence ?? cursor.current;
      if (nextCursor > cursor.current) {
        cursor.current = nextCursor;
        storageFor(options)?.setItem(cursorKey(thread), String(nextCursor));
        connection.current?.acknowledge(nextCursor);
      }
    },
    [options.storage, thread],
  );

  useEffect(() => {
    reconnectGeneration.current += 1;
    const generation = reconnectGeneration.current;
    connection.current?.close(1000, "thread changed");
    connection.current = null;
    currentRecords.current = [];
    setRecords([]);
    setPendingMessages([]);
    setError(null);
    setInputRequests([]);
    if (!thread) {
      setConnectionState("idle");
      return;
    }

    const controller = new AbortController();
    // React state is not stored with the cursor. Start a new hook instance at
    // zero so the WebSocket can replay the durable view in one request. The
    // previous eager HTTP history repair competed with the socket handshake
    // on the same Durable Object and made cold chat startup visibly slower.
    cursor.current = 0;

    const resync = async () => {
      const [history, requests] = await Promise.all([readAllAudit(thread), thread.userInput()]);
      if (controller.signal.aborted || generation !== reconnectGeneration.current) return;
      const merged = mergeFlaryUiRecords(history, currentRecords.current);
      currentRecords.current = merged;
      setRecords(merged);
      setInputRequests([...requests]);
      const nextCursor = merged.at(-1)?.sequence ?? 0;
      cursor.current = nextCursor;
      storageFor(options)?.setItem(cursorKey(thread), String(nextCursor));
    };

    const run = async () => {
      let attempt = 0;
      while (!controller.signal.aborted && generation === reconnectGeneration.current) {
        setConnectionState(attempt ? "reconnecting" : "connecting");
        try {
          const active = await thread.connect({
            after: cursor.current,
            includeChildren: options.includeChildren ?? true,
          });
          if (controller.signal.aborted) {
            active.close(1000, "view closed");
            return;
          }
          connection.current = active;
          attempt = 0;
          setConnectionState("live");
          setError(null);
          for await (const frame of active.events()) {
            if (controller.signal.aborted || generation !== reconnectGeneration.current) break;
            if (frame.type === "events") commit(normalizeFlaryUiRecords(frame.records));
            else if (frame.type === "resync_required") await resync();
            else if (frame.type === "error" && !frame.requestId) setError(frame.message);
          }
        } catch (cause) {
          if (!controller.signal.aborted) {
            setError(cause instanceof Error ? cause.message : "The live connection closed.");
            await resync().catch(() => undefined);
          }
        } finally {
          connection.current = null;
        }
        if (controller.signal.aborted) return;
        attempt += 1;
        const delay = Math.min(500 * 2 ** Math.min(attempt, 5), options.reconnectMaxMs ?? 12_000);
        await sleep(delay, controller.signal);
      }
    };
    void run();
    return () => {
      controller.abort();
      connection.current?.close(1000, "view closed");
      connection.current = null;
    };
  }, [
    commit,
    options.includeChildren,
    options.reconnectMaxMs,
    options.storage,
    reconnectToken,
    thread,
  ]);

  const send = useCallback(
    async (message: string, mode: "queue" | "steer" = "queue") => {
      const value = message.trim();
      if (!thread || !value) return;
      const requestId = crypto.randomUUID();
      setPendingMessages((current) => [
        ...current,
        { id: requestId, text: value, createdAt: new Date().toISOString() },
      ]);
      setError(null);
      try {
        const realtime = connection.current;
        if (realtime) {
          try {
            await withTimeout(
              realtime.command(
                mode === "steer" ? "steer" : "send",
                { message: value },
                {
                  requestId,
                  idempotencyKey: requestId,
                },
              ),
              8_000,
            );
            return;
          } catch {
            // Reuse the idempotency key on the HTTP fallback. If the WebSocket
            // command was admitted, Flary returns the same durable turn.
          }
        }
        await thread.send({ message: value, mode, idempotencyKey: requestId });
      } catch (cause) {
        setPendingMessages((current) => current.filter((item) => item.id !== requestId));
        const message = cause instanceof Error ? cause.message : "The message was not accepted.";
        setError(message);
        throw cause;
      }
    },
    [thread],
  );

  const interrupt = useCallback(async () => {
    if (!thread) return;
    const realtime = connection.current;
    if (realtime) await realtime.command("interrupt");
    else await thread.interrupt();
  }, [thread]);

  const respondToInput = useCallback(
    async (
      requestId: string,
      answers: Readonly<Record<string, string>>,
      inputOptions: { response?: string; canceled?: boolean } = {},
    ) => {
      if (!thread) return;
      await thread.sendInput(requestId, answers, inputOptions);
      setInputRequests((current) =>
        current.map((record) =>
          record.request.id === requestId
            ? {
                ...record,
                response: {
                  requestId,
                  answers: { ...answers },
                  ...(inputOptions.response ? { response: inputOptions.response } : {}),
                  canceled: inputOptions.canceled ?? false,
                  answeredBy: thread.binding.createdBy,
                  answeredAt: new Date().toISOString(),
                },
              }
            : record,
        ),
      );
    },
    [thread],
  );

  const decide = useCallback(
    async (approvalId: string, decision: "approve" | "reject") => {
      if (!thread) return;
      const realtime = connection.current;
      if (realtime) await realtime.command(decision, { approvalId });
      else if (decision === "approve") await thread.approve(approvalId);
      else await thread.reject(approvalId);
    },
    [thread],
  );

  const turns = useMemo(() => projectFlaryUiTurns(records), [records]);
  return {
    records,
    turns,
    pendingMessages,
    connectionState,
    active: flaryUiTurnIsActive(turns) || pendingMessages.length > 0,
    error,
    inputRequests,
    send,
    interrupt,
    approve: (approvalId) => decide(approvalId, "approve"),
    reject: (approvalId) => decide(approvalId, "reject"),
    respondToInput,
    reconnect: () => {
      connection.current?.close(4101, "manual reconnect");
      setReconnectToken((value) => value + 1);
    },
  };
}
