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
  assert.match(html, />fast<\/span>/);
  assert.match(html, /href="\/products\/fast"/);
  assert.doesNotMatch(html, /<script>/);
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
