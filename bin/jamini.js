#!/usr/bin/env node
// Jamini CLI entrypoint
// Loads the compiled CLI module.
import('../dist/cli.js').catch((err) => {
  console.error('[jamini] Failed to start:', err.message);
  process.exit(1);
});

