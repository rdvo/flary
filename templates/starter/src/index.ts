import { app } from "./flary";
import { coder } from "./coder";
import { support } from "./support";

export const functions = { support, coder };

export default app.serve(functions);
