#!/usr/bin/env node

import cli from "../src/cli.js";

await cli.serve(process.argv.slice(2), {
  exit(code) {
    process.exitCode = code;
  }
});
