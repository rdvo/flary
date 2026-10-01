import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  FlaryInlineArtifact,
  FlaryMarkdown,
  FlaryReactStyles,
  FlaryUserInput,
} from "../src/react/index.js";

test("FlaryMarkdown renders streaming Markdown as safe semantic HTML", () => {
  const html = renderToStaticMarkup(
    createElement(FlaryMarkdown, {
      streaming: true,
      children: "A **fast** [link](/products/fast)<script>alert(1)</script>",
    }),
  );
  assert.match(html, /<strong>fast<\/strong>/);
  assert.match(html, /href="\/products\/fast"/);
  assert.doesNotMatch(html, /<script>/);
});

test("FlaryMarkdown ships styled code blocks, lists, and tables without Tailwind", () => {
  const html = renderToStaticMarkup(
    createElement(FlaryMarkdown, {
      children: [
        "## Example",
        "",
        "- **Readable** answers with `inline code`.",
        "",
        "```ts",
        'const html = "<script>example</script>";',
        "const next = 2;",
        "```",
        "",
        "| Feature | Ready |",
        "| --- | --- |",
        "| Markdown | Yes |",
      ].join("\n"),
    }),
  );
  assert.match(html, /data-flary-markdown-styles/);
  assert.match(html, /<h2[^>]*>Example<\/h2>/);
  assert.match(html, /<li[^>]*><strong>Readable<\/strong>/);
  assert.match(html, /data-streamdown="inline-code"/);
  assert.match(html, /data-streamdown="code-block-header"/);
  assert.match(html, /data-language="ts"/);
  assert.match(html, /\[data-language="ts"\]::before/);
  assert.match(html, /content:"TS"/);
  assert.match(html, /min-height:36px/);
  assert.match(html, /data-streamdown="code-block-body"/);
  assert.match(html, /aria-label="Copy Code"/);
  assert.doesNotMatch(html, /aria-label="Download file"/);
  assert.match(html, /&lt;script&gt;example&lt;\/script&gt;/);
  assert.match(html, /const next = 2;/);
  assert.match(html, /<table[^>]*>/);
  assert.match(html, /<th[^>]*>Feature<\/th>/);
  assert.match(html, /<td[^>]*>Yes<\/td>/);
});

test("FlaryMarkdown line numbers use shared CSS counters without adding copy text", () => {
  const markdown = renderToStaticMarkup(
    createElement(FlaryMarkdown, {
      lineNumbers: true,
      styled: false,
      children: "```ts\nconst value = 'copy target';\n```",
    }),
  );
  const styles = renderToStaticMarkup(createElement(FlaryReactStyles));
  assert.match(markdown, /class="\[counter-increment:line_0\] \[counter-reset:line\]"/);
  assert.match(markdown, /before:content-\[counter\(line\)\]/);
  assert.match(styles, /code\[class~=\"\[counter-reset:line\]\"\]/);
  assert.match(styles, /content:counter\(line\);counter-increment:line/);
  assert.match(styles, /user-select:none;-webkit-user-select:none/);
  assert.doesNotMatch(markdown, /<span[^>]*>1<\/span>/);
});

test("FlaryMarkdown keeps incomplete emphasis and fenced code readable while streaming", () => {
  const partial = renderToStaticMarkup(
    createElement(FlaryMarkdown, {
      styled: false,
      streaming: true,
      children: "A **readable",
    }),
  );
  assert.match(partial, /<strong>readable<\/strong>/);
  assert.doesNotMatch(partial, /\*\*|data-flary-markdown-styles/);
  for (const suffix of ["", "\n```"]) {
    const html = renderToStaticMarkup(
      createElement(FlaryMarkdown, {
        styled: false,
        streaming: !suffix,
        children: "```ts\nconst answer = 42;" + suffix,
      }),
    );
    assert.match(html, /data-streamdown="code-block"/);
    assert.match(html, /const answer = 42;/);
    assert.doesNotMatch(html, /```/);
    assert.match(html, /aria-label="Copy Code"/);
    if (!suffix) assert.match(html, /disabled=""/);
    else assert.doesNotMatch(html, /disabled=""/);
  }
});

test("FlaryMarkdown does not turn unsafe URLs or HTML into executable content", () => {
  const html = renderToStaticMarkup(
    createElement(FlaryMarkdown, {
      styled: false,
      children: '[unsafe](javascript:alert%281%29)\n\n<img src=x onerror="alert(1)">',
    }),
  );
  assert.doesNotMatch(html, /href="javascript:|<img|onerror=/);
});

test("FlaryReactStyles provides responsive, focus-visible defaults", () => {
  const html = renderToStaticMarkup(createElement(FlaryReactStyles));
  assert.match(html, /data-flary-react-styles/);
  assert.match(html, /focus-visible/);
  assert.match(html, /prefers-reduced-motion/);
});

test("FlaryInlineArtifact isolates generated HTML in a sandbox", () => {
  const html = renderToStaticMarkup(
    createElement(FlaryInlineArtifact, {
      title: "Preview",
      html: "<button>Buy</button><script>window.x=1</script>",
      height: 5000,
    }),
  );
  assert.match(html, /sandbox="allow-scripts allow-forms allow-popups"/);
  assert.match(html, /--flary-artifact-height:960px/);
  assert.doesNotMatch(html, /allow-same-origin/);
});

test("FlaryUserInput renders choices and a free-form answer", () => {
  const html = renderToStaticMarkup(
    createElement(FlaryUserInput, {
      record: {
        request: {
          id: "input_1",
          threadId: "thread_1",
          questions: [
            {
              header: "Delivery",
              question: "When should we deliver?",
              options: [
                { label: "Today", description: "Fastest available" },
                { label: "Tomorrow", description: "More selection" },
              ],
              multiSelect: false,
            },
          ],
          requestedBy: { id: "agent", kind: "agent", version: "1" },
          requestedAt: new Date(0).toISOString(),
        },
        response: null,
      },
      onSubmit() {},
    }),
  );
  assert.match(html, /Today/);
  assert.match(html, /Tomorrow/);
  assert.match(html, /Type another answer/);
  assert.match(html, /Continue/);
});
