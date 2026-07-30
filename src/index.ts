export * from "./harness/index.js";

// Function-first authoring surface. Keep these explicit so package tooling
// can discover the short API without scanning the low-level harness exports.
export { flary, z } from "./harness/functions/index.js";
