import assert from "node:assert/strict";
import test from "node:test";

import {
  defineEvaluationDataset,
  runEvaluation,
} from "../src/harness/evaluations/index.ts";

test("evaluation datasets run deterministic graders and retain revisions", async () => {
  const dataset = defineEvaluationDataset({
    id: "support",
    cases: [
      { id: "one", input: "hello", expected: "hello" },
      { id: "two", input: "world", expected: "world" },
    ],
  });
  const report = await runEvaluation(dataset, {
    run: async (input) => input,
  }, {
    candidateRevision: "prompt_v2",
    graders: [{ id: "exact", kind: "exact" }],
  });
  assert.equal(report.datasetRevision, dataset.revision);
  assert.equal(report.aggregateScore, 1);
  assert.equal(report.passed, true);
  assert.equal(report.results.length, 2);
});

test("evaluation reports control results, score deltas, and known costs", async () => {
  const dataset = defineEvaluationDataset({
    id: "comparison",
    cases: [{ id: "one", input: "hello", expected: "hello" }],
  });
  const report = await runEvaluation(dataset, {
    run: async (input) => ({ output: input, costUsd: 0.03 }),
  }, {
    candidateRevision: "candidate_v2",
    control: {
      run: async () => ({ output: "old", usage: { costUsd: 0.01 } }),
    },
    controlRevision: "control_v1",
    graders: [{ id: "exact", kind: "exact" }],
  });
  assert.equal(report.usage.costUsd, 0.04);
  assert.equal(report.controlResults?.[0]?.score, 0);
  assert.equal(report.comparison?.controlAggregateScore, 0);
  assert.equal(report.comparison?.scoreDelta, 1);
  assert.equal(report.comparison?.cases[0]?.winner, "candidate");
});
