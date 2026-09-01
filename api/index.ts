/**
 * Vercel serverless entry point.
 *
 * Vercel does not run a long-lived process, so `src/server.ts` (which calls
 * `listen()`) is not used there. Vercel's Node runtime accepts an Express app
 * exported as the default handler and invokes it per request.
 *
 * The app is built once at module scope so it is reused across warm
 * invocations on the same instance — only cold starts pay the setup cost.
 */
import { createApp } from '../src/app.js';

export default createApp();
