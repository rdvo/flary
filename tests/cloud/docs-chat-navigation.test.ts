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
  return {
    root: Object.assign(root, {
      querySelector: (selector: string) => elements.get(selector),
      querySelectorAll: () => [],
    }),
    panel,
    launcher: elements.get("[data-chat-open]")!,
    closer: elements.get("[data-chat-close]")!,
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
