import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

import { transformSync } from "esbuild";

class ChatElement extends EventTarget {
  dataset: Record<string, string> = {};
  attributes = new Map<string, string>();
  children: ChatElement[] = [];
  hidden = false;
  disabled = false;
  className = "";
  textContent = "";
  value = "";
  scrollTop = 0;
  scrollHeight = 0;
  clientHeight = 0;
  focusCount = 0;
  classList = { add() {} };

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }

  appendChild(child: ChatElement) {
    this.children.push(child);
    return child;
  }

  replaceChildren() {
    this.children = [];
  }

  querySelector(_selector: string) {
    return null;
  }

  focus() {
    this.focusCount += 1;
  }

  requestSubmit() {
    this.dispatchEvent(new Event("submit", { cancelable: true }));
  }
}

function chatWidget() {
  const root = new ChatElement();
  const elements = new Map<string, ChatElement>();
  for (const name of [
    "open",
    "close",
    "panel",
    "messages",
    "status",
    "form",
    "input",
    "send",
    "stop",
    "retry",
    "latest",
    "sessions",
    "session-list",
    "session-toggle",
  ]) {
    elements.set(`[data-chat-${name}]`, new ChatElement());
  }
  const panel = elements.get("[data-chat-panel]")!;
  panel.hidden = true;
  elements.get("[data-chat-open]")!.disabled = true;
  const newChat = new ChatElement();
  return {
    root: Object.assign(root, {
      querySelector: (selector: string) => elements.get(selector),
      querySelectorAll: () => [newChat],
    }),
    panel,
    launcher: elements.get("[data-chat-open]")!,
    closer: elements.get("[data-chat-close]")!,
    form: elements.get("[data-chat-form]")!,
    input: elements.get("[data-chat-input]")!,
    messages: elements.get("[data-chat-messages]")!,
    send: elements.get("[data-chat-send]")!,
    stop: elements.get("[data-chat-stop]")!,
    retry: elements.get("[data-chat-retry]")!,
    latest: elements.get("[data-chat-latest]")!,
    newChat,
  };
}

type MarkdownElement = { type: unknown; props: Record<string, unknown> };
type MockRoot = {
  target: unknown;
  renders: MarkdownElement[];
  unmounted: boolean;
};

function runChatScript(script: string, context: Record<string, unknown>) {
  const roots: MockRoot[] = [];
  const FlaryMarkdown = function FlaryMarkdown() {};
  let activeLayoutEffects: Array<() => void> | undefined;
  let layoutEffectRuns = 0;
  const mocks = {
    roots,
    get layoutEffectRuns() {
      return layoutEffectRuns;
    },
    require(specifier: string) {
      if (specifier === "react") {
        return {
          createElement: (type: unknown, props: Record<string, unknown>) => ({ type, props }),
          useLayoutEffect(effect: () => void) {
            activeLayoutEffects?.push(() => {
              effect();
              layoutEffectRuns += 1;
            });
          },
        };
      }
      if (specifier === "react-dom/client") {
        return {
          createRoot(target: unknown) {
            const root: MockRoot = { target, renders: [], unmounted: false };
            roots.push(root);
            return {
              render(element: MarkdownElement) {
                const effects: Array<() => void> = [];
                activeLayoutEffects = effects;
                const commit = (node: MarkdownElement) => {
                  if (typeof node.type === "function" && node.type !== FlaryMarkdown) {
                    commit(
                      (node.type as (props: Record<string, unknown>) => MarkdownElement)(
                        node.props,
                      ),
                    );
                    return;
                  }
                  root.renders.push(node);
                };
                commit(element);
                activeLayoutEffects = undefined;
                for (const effect of effects) effect();
              },
              unmount() {
                root.unmounted = true;
              },
            };
          },
        };
      }
      if (specifier === "flary/react") {
        return { FlaryMarkdown, flaryMarkdownStyles: ".flary-markdown{}" };
      }
      throw new Error(`Unexpected import: ${specifier}`);
    },
  };
  runInNewContext(transformSync(script, { loader: "ts", format: "cjs" }).code, {
    ...context,
    AbortController,
    require: mocks.require,
  });
  return mocks;
}

test("Ask Flary mounts after docs navigation without duplicate click handlers", () => {
  const source = readFileSync(
    new URL("../../apps/cloud/src/components/DocsChat.astro", import.meta.url),
    "utf8",
  );
  const script = source.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  const document = Object.assign(new EventTarget(), {
    querySelectorAll: () => widgets.map((widget) => widget.root),
    createElement: () => new ChatElement(),
  });
  let widgets: ReturnType<typeof chatWidget>[] = [chatWidget()];
  runChatScript(script, {
    document,
    window: { matchMedia: () => ({ matches: false }) },
    localStorage: { getItem: () => null },
    // Opening the panel must work while its session request is still pending.
    fetch: () => new Promise(() => {}),
  });

  const open = (widget: ReturnType<typeof chatWidget>) => {
    document.dispatchEvent(new Event("astro:page-load"));
    document.dispatchEvent(new Event("astro:page-load"));
    assert.equal(widget.launcher.disabled, false);
    widget.launcher.dispatchEvent(new Event("click"));
    assert.equal(widget.panel.hidden, false);
    assert.equal(widget.launcher.attributes.get("aria-expanded"), "true");
    widget.closer.dispatchEvent(new Event("click"));
    assert.equal(widget.panel.hidden, true);
    assert.equal(widget.launcher.focusCount, 1);
    widget.panel.dispatchEvent(
      Object.assign(new Event("keydown", { cancelable: true }), { key: "Escape" }),
    );
    widget.launcher.dispatchEvent(new Event("click"));
    widget.panel.dispatchEvent(
      Object.assign(new Event("keydown", { cancelable: true }), { key: "Escape" }),
    );
    assert.equal(widget.panel.hidden, true);
    assert.equal(widget.launcher.focusCount, 2);
    widget.launcher.dispatchEvent(new Event("click"));
    assert.equal(widget.panel.hidden, false);
  };

  open(widgets[0]!);
  const previous = widgets[0]!;
  document.dispatchEvent(new Event("astro:before-swap"));
  assert.equal(previous.panel.hidden, true);
  widgets = [chatWidget()];
  open(widgets[0]!);

  // Leaving docs and returning must also initialize the replacement widget.
  document.dispatchEvent(new Event("astro:before-swap"));
  widgets = [];
  document.dispatchEvent(new Event("astro:page-load"));
  document.dispatchEvent(new Event("astro:before-swap"));
  widgets = [chatWidget()];
  open(widgets[0]!);
});

test("Enter sends, IME and Shift+Enter stay in the textarea, and retry keeps one copy of the question", async () => {
  const source = readFileSync(
    new URL("../../apps/cloud/src/components/DocsChat.astro", import.meta.url),
    "utf8",
  );
  const script = source.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  const widget = chatWidget();
  const messageRequests: Array<{ body: string; headers: Headers }> = [];
  const document = Object.assign(new EventTarget(), {
    querySelectorAll: () => [widget.root],
    createElement: () => new ChatElement(),
  });
  runChatScript(script, {
    document,
    Headers,
    window: { matchMedia: () => ({ matches: false }) },
    localStorage: { getItem: () => null, setItem() {} },
    fetch: (url: string, init: RequestInit = {}) => {
      if (url === "/api/docs-chat/session") {
        return Promise.resolve(
          Response.json({
            session: { id: "session-1", reference: "ref-1" },
          }),
        );
      }
      if (url === "/api/docs-chat/messages") {
        messageRequests.push({ body: init.body as string, headers: new Headers(init.headers) });
        return Promise.resolve(
          Response.json({ error: { message: "Temporary failure" } }, { status: 503 }),
        );
      }
      return Promise.resolve(Response.json({ sessions: [] }));
    },
  });

  const keydown = (options: { shiftKey?: boolean; isComposing?: boolean; keyCode?: number } = {}) =>
    Object.assign(new Event("keydown", { cancelable: true }), {
      key: "Enter",
      shiftKey: options.shiftKey ?? false,
      isComposing: options.isComposing ?? false,
      keyCode: options.keyCode ?? 13,
    });

  widget.input.value = "How do I deploy Flary?";
  const shifted = keydown({ shiftKey: true });
  widget.input.dispatchEvent(shifted);
  assert.equal(shifted.defaultPrevented, false);
  const composing = keydown({ isComposing: true, keyCode: 229 });
  widget.input.dispatchEvent(composing);
  assert.equal(composing.defaultPrevented, false);
  assert.equal(messageRequests.length, 0);

  const enter = keydown();
  widget.input.dispatchEvent(enter);
  assert.equal(enter.defaultPrevented, true);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(messageRequests.length, 1);
  assert.deepEqual(JSON.parse(messageRequests[0]!.body), { message: "How do I deploy Flary?" });
  assert.equal(widget.retry.hidden, false);

  widget.retry.dispatchEvent(new Event("click"));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(messageRequests.length, 2);
  assert.deepEqual(JSON.parse(messageRequests[1]!.body), { message: "How do I deploy Flary?" });
  assert.equal(
    widget.messages.children.filter(
      (element) => element.className === "flary-chat__message flary-chat__message--user",
    ).length,
    1,
  );
});

test("Stop keeps Send disabled until the interrupt request is accepted", async () => {
  const source = readFileSync(
    new URL("../../apps/cloud/src/components/DocsChat.astro", import.meta.url),
    "utf8",
  );
  const script = source.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  const widget = chatWidget();
  const sockets: FakeWebSocket[] = [];
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let resolveInterrupt!: (response: Response) => void;
  const interruptResponse = new Promise<Response>((resolve) => {
    resolveInterrupt = resolve;
  });
  class FakeWebSocket extends EventTarget {
    static OPEN = 1;
    readyState = 0;

    constructor(_url: string) {
      super();
      sockets.push(this);
    }

    send(_data: string) {}

    close() {
      this.readyState = 3;
      this.dispatchEvent(new Event("close"));
    }

    emit(data: unknown) {
      this.dispatchEvent(Object.assign(new Event("message"), { data: JSON.stringify(data) }));
    }
  }
  const document = Object.assign(new EventTarget(), {
    querySelectorAll: () => [widget.root],
    createElement: () => new ChatElement(),
  });
  runChatScript(script, {
    document,
    Headers,
    WebSocket: FakeWebSocket,
    window: { matchMedia: () => ({ matches: false }), setTimeout, clearTimeout },
    localStorage: { getItem: () => null, setItem() {} },
    fetch: (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      if (url === "/api/docs-chat/session") {
        return Promise.resolve(
          Response.json({
            session: { id: "session-1", reference: "ref-1" },
          }),
        );
      }
      if (url === "/api/docs-chat/messages") {
        return Promise.resolve(Response.json({ submissionId: "submission-1", offset: "0" }));
      }
      if (url === "/api/docs-chat/realtime-ticket") {
        return Promise.resolve(Response.json({ url: "wss://example.test/session" }));
      }
      if (url === "/api/docs-chat/interrupt") return interruptResponse;
      return Promise.resolve(Response.json({ messages: [] }));
    },
  });

  widget.panel.hidden = false;
  widget.input.value = "Stop this answer";
  widget.form.dispatchEvent(new Event("submit", { cancelable: true }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sockets.length, 1);
  assert.equal(widget.send.disabled, true);
  assert.equal(widget.stop.hidden, false);
  const socket = sockets[0]!;
  socket.readyState = FakeWebSocket.OPEN;
  socket.emit({ type: "ready", cursor: 0 });
  await new Promise((resolve) => setImmediate(resolve));

  widget.stop.dispatchEvent(new Event("click"));
  await new Promise((resolve) => setImmediate(resolve));
  const interrupt = calls.find((call) => call.url === "/api/docs-chat/interrupt");
  assert.ok(interrupt);
  assert.deepEqual(JSON.parse(interrupt.init.body as string), {
    sessionId: "session-1",
    submissionId: "submission-1",
  });
  assert.equal(new Headers(interrupt.init.headers).get("x-flary-docs-session-ref"), "ref-1");
  assert.equal(widget.send.disabled, true);
  assert.equal(widget.input.disabled, true);

  resolveInterrupt(Response.json({ ok: true }, { status: 202 }));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(widget.send.disabled, false);
  assert.equal(widget.input.disabled, false);
  assert.equal(widget.stop.hidden, true);
  assert.equal(
    widget.root.querySelector("[data-chat-status]")?.textContent,
    "Stop request accepted",
  );
});

test("switching chats ignores old realtime events and does not steal focus or the new reading position", async () => {
  const source = readFileSync(
    new URL("../../apps/cloud/src/components/DocsChat.astro", import.meta.url),
    "utf8",
  );
  const script = source.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  const widget = chatWidget();
  const sockets: FakeWebSocket[] = [];
  const sessionId = "a".repeat(36);
  const reference = `v1.${sessionId}.${"b".repeat(32)}`;
  class FakeWebSocket extends EventTarget {
    static OPEN = 1;
    readyState = 0;

    constructor(_url: string) {
      super();
      sockets.push(this);
    }

    send(_data: string) {}

    close() {
      this.readyState = 3;
      this.dispatchEvent(new Event("close"));
    }

    emit(data: unknown) {
      this.dispatchEvent(Object.assign(new Event("message"), { data: JSON.stringify(data) }));
    }
  }
  const document = Object.assign(new EventTarget(), {
    querySelectorAll: () => [widget.root],
    createElement: () => new ChatElement(),
  });
  runChatScript(script, {
    document,
    Headers,
    WebSocket: FakeWebSocket,
    window: { matchMedia: () => ({ matches: false }), setTimeout, clearTimeout },
    localStorage: {
      getItem: () =>
        JSON.stringify({
          current: reference,
          sessions: [{ id: sessionId, reference, title: "Previous chat", updatedAt: "2026-09-30" }],
        }),
      setItem() {},
    },
    fetch: (url: string) => {
      if (url === "/api/docs-chat/sessions") return new Promise(() => {});
      if (url === "/api/docs-chat/messages") {
        return Promise.resolve(Response.json({ submissionId: "old-submission", offset: "0" }));
      }
      if (url === "/api/docs-chat/realtime-ticket") {
        return Promise.resolve(Response.json({ url: "wss://example.test/old-session" }));
      }
      return Promise.resolve(Response.json({ messages: [] }));
    },
  });

  widget.launcher.dispatchEvent(new Event("click"));
  widget.input.value = "Question in the old chat";
  widget.form.dispatchEvent(new Event("submit", { cancelable: true }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sockets.length, 1);
  const oldSocket = sockets[0]!;
  oldSocket.readyState = FakeWebSocket.OPEN;
  oldSocket.emit({ type: "ready", cursor: 0 });
  await new Promise((resolve) => setImmediate(resolve));

  widget.newChat.dispatchEvent(new Event("click"));
  widget.messages.clientHeight = 300;
  widget.messages.scrollHeight = 800;
  widget.messages.scrollTop = 120;
  widget.messages.dispatchEvent(new Event("scroll"));
  const childCount = widget.messages.children.length;
  const inputFocusCount = widget.input.focusCount;
  oldSocket.emit({
    type: "events",
    cursor: 1,
    records: [
      {
        sequence: 1,
        publicPayload: {
          type: "message-started",
          messageId: "old-assistant",
          submissionId: "old-submission",
        },
      },
    ],
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(widget.root.querySelector("[data-chat-status]")?.textContent, "New chat");
  assert.equal(widget.messages.children.length, childCount);
  assert.equal(widget.messages.scrollTop, 120);
  assert.equal(widget.input.focusCount, inputFocusCount);
  assert.equal(widget.send.disabled, false);
});

test("the first message creates a session for both a fresh visitor and New chat", async () => {
  const source = readFileSync(
    new URL("../../apps/cloud/src/components/DocsChat.astro", import.meta.url),
    "utf8",
  );
  const script = source.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  const widget = chatWidget();
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let sessionCount = 0;
  const document = Object.assign(new EventTarget(), {
    querySelectorAll: () => [widget.root],
    createElement: () => new ChatElement(),
    createTextNode: () => new ChatElement(),
  });
  runChatScript(script, {
    document,
    Headers,
    window: { matchMedia: () => ({ matches: false }) },
    localStorage: { getItem: () => null, setItem() {} },
    fetch: (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (url === "/api/docs-chat/session") {
        sessionCount += 1;
        return Promise.resolve(
          Response.json({
            session: { id: `chat-${sessionCount}`, reference: `ref-${sessionCount}` },
          }),
        );
      }
      return new Promise(() => {});
    },
  });

  for (let session = 1; session <= 2; session += 1) {
    if (session === 2) widget.newChat.dispatchEvent(new Event("click"));
    widget.input.value = "How do I deploy Flary?";
    widget.form.dispatchEvent(new Event("submit", { cancelable: true }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(
      calls.slice(-2).map((call) => call.url),
      ["/api/docs-chat/session", "/api/docs-chat/messages"],
    );
    assert.equal(new Headers(calls.at(-2)!.init.headers).get("x-flary-docs-new-session"), "1");
    assert.equal(
      new Headers(calls.at(-1)!.init.headers).get("x-flary-docs-session-ref"),
      `ref-${session}`,
    );
    assert.deepEqual(JSON.parse(calls.at(-1)!.init.body as string), {
      message: "How do I deploy Flary?",
    });
  }
});

test("streaming assistant text reuses one React root across frame updates", async () => {
  const source = readFileSync(
    new URL("../../apps/cloud/src/components/DocsChat.astro", import.meta.url),
    "utf8",
  );
  const script = source.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  const widget = chatWidget();
  const sockets: FakeWebSocket[] = [];
  let nextFrame = 1;
  const frames = new Map<number, (timestamp: number) => void>();
  const window = {
    matchMedia: () => ({ matches: false }),
    setTimeout,
    clearTimeout,
    requestAnimationFrame(callback: (timestamp: number) => void) {
      const id = nextFrame++;
      frames.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id: number) {
      frames.delete(id);
    },
  };
  class FakeWebSocket extends EventTarget {
    static OPEN = 1;
    readyState = 0;

    constructor(_url: string) {
      super();
      sockets.push(this);
    }

    send(_data: string) {}

    close() {
      this.readyState = 3;
      this.dispatchEvent(new Event("close"));
    }

    emit(data: unknown) {
      this.dispatchEvent(Object.assign(new Event("message"), { data: JSON.stringify(data) }));
    }
  }
  const document = Object.assign(new EventTarget(), {
    querySelectorAll: () => [widget.root],
    createElement: () => new ChatElement(),
  });
  const markdown = runChatScript(script, {
    document,
    window,
    WebSocket: FakeWebSocket,
    Headers,
    localStorage: { getItem: () => null, setItem() {} },
    fetch: (url: string) => {
      if (url === "/api/docs-chat/session") {
        return Promise.resolve(
          Response.json({
            session: { id: "chat-1", reference: "ref-1" },
          }),
        );
      }
      if (url === "/api/docs-chat/messages") {
        return Promise.resolve(Response.json({ submissionId: "submission-1", offset: "0" }));
      }
      if (url === "/api/docs-chat/realtime") {
        return Promise.resolve(Response.json({ url: "wss://example.test/session" }));
      }
      if (url === "/api/docs-chat/history") {
        return Promise.resolve(Response.json({ messages: [] }));
      }
      return Promise.resolve(Response.json({ sessions: [] }));
    },
  });
  const flushFrame = () => {
    const [id, callback] = frames.entries().next().value ?? [];
    assert.ok(id !== undefined && callback);
    frames.delete(id);
    callback(Date.now());
  };
  const emitRecord = (
    socket: FakeWebSocket,
    sequence: number,
    payload: Record<string, unknown>,
  ) => {
    socket.emit({
      type: "events",
      cursor: sequence,
      records: [{ sequence, publicPayload: payload }],
    });
  };

  widget.input.value = "Ask a question";
  widget.messages.clientHeight = 300;
  widget.messages.scrollHeight = 700;
  widget.form.dispatchEvent(new Event("submit", { cancelable: true }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sockets.length, 1);
  const socket = sockets[0]!;
  socket.readyState = FakeWebSocket.OPEN;
  socket.emit({ type: "ready", cursor: 0 });
  await new Promise((resolve) => setImmediate(resolve));

  widget.messages.scrollTop = 120;
  widget.messages.dispatchEvent(new Event("scroll"));
  assert.equal(widget.latest.hidden, false);

  emitRecord(socket, 1, {
    type: "message-started",
    messageId: "assistant-1",
    submissionId: "submission-1",
  });
  emitRecord(socket, 2, {
    type: "message-delta",
    messageId: "assistant-1",
    submissionId: "submission-1",
    delta: "A",
  });
  flushFrame();
  assert.equal(widget.messages.scrollTop, 120);
  assert.equal(widget.latest.hidden, false);
  emitRecord(socket, 3, {
    type: "message-delta",
    messageId: "assistant-1",
    submissionId: "submission-1",
    delta: "B",
  });
  flushFrame();
  const streamingRoot = markdown.roots.find((root) =>
    root.renders.some((element) => element.props.streaming === true),
  );
  assert.ok(streamingRoot);
  assert.equal(markdown.roots.filter((root) => root.target === streamingRoot.target).length, 1);
  assert.equal(streamingRoot.renders.length, 2);
  assert.equal(streamingRoot.renders[0]?.props.children, "A");
  assert.equal(streamingRoot.renders[1]?.props.children, "AB");
  assert.ok(streamingRoot.renders.every((element) => element.props.styled === false));
  assert.equal(markdown.layoutEffectRuns, 2);

  widget.latest.dispatchEvent(new Event("click"));
  assert.equal(widget.messages.scrollTop, widget.messages.scrollHeight);
  assert.equal(widget.latest.hidden, true);

  emitRecord(socket, 4, {
    type: "submission-settled",
    submissionId: "submission-1",
    outcome: "completed",
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(streamingRoot.unmounted, true);
  const staticRoot = markdown.roots.find((root) =>
    root.renders.some((element) => element.props.streaming === false),
  );
  assert.ok(staticRoot);
  assert.equal(markdown.layoutEffectRuns, 3);
  document.dispatchEvent(new Event("astro:before-swap"));
  assert.equal(staticRoot.unmounted, true);
  assert.equal(
    widget.root.children.filter((child) => child.dataset.flaryMarkdownStyles === "true").length,
    1,
  );
});
