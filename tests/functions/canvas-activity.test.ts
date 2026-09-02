import assert from "node:assert/strict";
import test from "node:test";
import {
  interactiveToolFailureState,
  projectPublicToolActivityInput,
  projectPublicToolActivityResult,
} from "../../src/harness/functions/codemode.js";

test("draw_canvas projects a bounded redacted UI artifact", () => {
  const canvas = {
    title: "Weekly performance",
    html: '<div data-value="$2,500">Revenue</div><script>document.body.dataset.ready="true"</script>',
    height: 360,
    apiKey: "secret-value",
  };
  const projected = projectPublicToolActivityInput(canvas, "draw_canvas");
  assert.equal((projected.canvas as any).title, "Weekly performance");
  assert.equal((projected.canvas as any).html, canvas.html);
  assert.equal((projected.canvas as any).height, 360);
  assert.notEqual((projected.canvas as any).apiKey, "secret-value");
});

test("draw_canvas bounds public HTML and iframe height", () => {
  const projected = projectPublicToolActivityInput(
    {
      title: "Large canvas",
      html: `  <main>${"x".repeat(70_000)}</main>  `,
      height: 4_000,
    },
    "flary__draw_canvas",
  );
  const canvas = projected.canvas as Record<string, unknown>;
  assert.equal((canvas.html as string).length, 60_000);
  assert.equal(canvas.height, 720);
});

test("normal tools do not project arbitrary structured inputs", () => {
  assert.deepEqual(projectPublicToolActivityInput({ query: "secret", range: "7d" }, "stats"), {
    range: "7d",
  });
});

test("tool activity projects a bounded redacted result for live inspection", () => {
  assert.deepEqual(projectPublicToolActivityResult({ total: 42, apiKey: "secret-value" }), {
    total: 42,
    apiKey: "<redacted>",
  });
  assert.deepEqual(projectPublicToolActivityResult({ content: "x".repeat(20_000) }), {
    summary: "The tool result is too large for the live activity stream.",
    sizeBytes: 20_014,
  });
});

test("read failures settle while uncertain writes stay blocked", () => {
  assert.equal(interactiveToolFailureState("read"), "failed");
  assert.equal(interactiveToolFailureState(undefined), "failed");
  assert.equal(interactiveToolFailureState("write"), "outcome_unknown");
});
