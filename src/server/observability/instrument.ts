// Side-effect module: initializes logging + error reporting BEFORE anything else loads.
//
// It must be the very first import in the server (and worker) entrypoint. Under
// TS→CommonJS, `import` statements compile to hoisted `require()` calls that run
// in source order before any other statement — so importing this first
// guarantees `initLogging()` / `initObservability()` (and therefore `Sentry.init`)
// run before `express`, `http`, and the rest of the app are required. That lets
// @sentry/node instrument those modules and capture errors thrown in their
// load-time side effects, and it puts structured JSON on stdout from the first
// log line. A plain init call in index.ts would run only after all imports had
// already loaded.
import { initLogging } from '../logging'
import { initObservability } from './index'

initLogging()
initObservability()
