import { app } from "./flary";
import { coder, reviewer } from "./coder";
import { support } from "./support";

export const functions = { support, coder, reviewer };

export default app.serve(functions);
