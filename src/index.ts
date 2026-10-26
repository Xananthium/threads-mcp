#!/usr/bin/env node
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerReadTools } from './tools/read.js';
import { registerWriteTools } from './tools/write.js';
import { registerScheduleTools } from './tools/schedule.js';
import { registerDoctorTool } from './tools/doctor.js';
import { registerDurableTools } from './durable/tools.js';
import { startScheduler, stopScheduler } from './scheduler.js';
import { closeContext } from './browser/session.js';

/**
 * The version we report over MCP, read from package.json at runtime.
 *
 * `rootDir` is ./src, so package.json can't be imported directly without
 * changing the build layout — but it sits one level above both ./src and
 * ./build, so the same relative URL resolves under `tsx` and from the compiled
 * output. Falls back to '0.0.0' rather than refusing to start: an unknown
 * version is a cosmetic problem, a server that won't boot is not.
 */
function serverVersion(): string {
  try {
    const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
    return (JSON.parse(raw) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

async function main() {
  const server = new McpServer({
    name: 'threads-mcp',
    version: serverVersion(),
  });

  // Every tool runs through the shared, logged-in CloakBrowser session
  // (see src/browser/session.ts) — sign in once with `npm run login`.
  // Reads intercept the app's GraphQL; writes drive the real UI and are
  // rate-limited (see src/utils/ratelimit.ts).
  registerReadTools(server);
  registerWriteTools(server);
  registerDurableTools(server);
  registerScheduleTools(server);
  // Health check for the DOM anchors the write tools depend on.
  registerDoctorTool(server);

  // Start the persisted scheduled-post loop (see src/scheduler.ts).
  if (process.env.THREADS_DISABLE_SCHEDULER !== '1') startScheduler();

  const transport = new StdioServerTransport();
  await server.connect(transport);

  if (process.env.DEBUG === 'true') {
    process.stderr.write(
      '[threads-mcp] Server started via stdio (browser-backed, cookie session)\n',
    );
  }
}

// Tidy up the browser on shutdown.
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    stopScheduler();
    void closeContext().finally(() => process.exit(0));
  });
}

main().catch((err) => {
  process.stderr.write(`[threads-mcp] Fatal error: ${err}\n`);
  process.exit(1);
});
