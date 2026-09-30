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
  value = "";
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

  focus() {}
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
    "sessions",
    "session-list",
    "session-toggle",
  ]) {
    elements.set(`[data-chat-${name}]`, new ChatElement());
  }
  const panel = elements.get("[data-chat-panel]")!;
  panel.hidden = true;
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
    widget.launcher.dispatchEvent(new Event("click"));
    assert.equal(widget.panel.hidden, false);
    assert.equal(widget.launcher.attributes.get("aria-expanded"), "true");
    widget.closer.dispatchEvent(new Event("click"));
    assert.equal(widget.panel.hidden, true);
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
  widget.form.dispatchEvent(new Event("submit", { cancelable: true }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sockets.length, 1);
  const socket = sockets[0]!;
  socket.readyState = FakeWebSocket.OPEN;
  socket.emit({ type: "ready", cursor: 0 });
  await new Promise((resolve) => setImmediate(resolve));

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
