import { app } from "./flary";
import { docs } from "./docs";

export const functions = { docs };

export default app.serve(functions);
