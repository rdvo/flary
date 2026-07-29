import { flue } from "@flue/runtime/routing";

/**
 * One Flue router instance is shared by the Worker entry point and the
 * authenticated Flary thread admission route. This keeps Flue's own routing
 * and Durable Object admission in one place.
 */
export const flueApp = flue();

