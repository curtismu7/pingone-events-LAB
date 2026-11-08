import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installNetguard } from './netguard.js';
import { startHttpServer, createApp } from './app.js';
import { allPassed, runChecks } from './doctor.js';
import { assertBindAllowed, bindHost, resolvePort } from './safety.js';
import { forwardOnStart, modeFrom, pingoneFrom, realAvailableFrom, sinkFrom } from './config.js';

installNetguard(); // before anything else can open a socket

// Settings: this repo's .env first, then the shared settings file (~/Development/.env; STANDALONE_ENV overrides it). Existing environment
// variables win. Secrets are read into process.env and never printed.
for (const file of [fileURLToPath(new URL('../../.env', import.meta.url)), process.env.STANDALONE_ENV || path.join(os.homedir(), 'Development', '.env')]) {
  try { process.loadEnvFile(file); } catch { /* not there */ }
}

const checks = await runChecks();
if (!allPassed(checks)) {
  for (const c of checks.filter((x) => x.level === 'fail')) console.error(`[pingone-events-lab] refusing to start: ${c.id}: ${c.detail}`);
  process.exit(1);
}
console.log(`[pingone-events-lab] starting in ${modeFrom()} mode`);
const host = assertBindAllowed(bindHost(), process.env);
const app = createApp();
const { url, server } = await startHttpServer({ port: resolvePort(), host, app });
const real = realAvailableFrom();
console.log(`[pingone-events-lab] lab at ${url} (${real ? `Real configured: pull ${pingoneFrom() ? 'on' : 'off'}, forwarding target ${sinkFrom() ? (forwardOnStart() ? 'set (starts ON: FORWARD_ON_START)' : 'set (switched OFF)') : 'not set'}` : 'Mock only, no outbound network'})`);
console.log(`[pingone-events-lab] health: ${url}api/health`);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { app.flushStore(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 2000).unref(); });
