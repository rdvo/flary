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
  }

  replaceChildren() {
    this.children = [];
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
  runInNewContext(transformSync(script, { loader: "ts" }).code, {
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
  runInNewContext(transformSync(script, { loader: "ts" }).code, {
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
