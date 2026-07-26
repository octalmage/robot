#!/usr/bin/env node

const { run } = require("../src/cli");

run(process.argv.slice(2)).then((exitCode) => {
  if (typeof exitCode === "number" && exitCode !== 0) {
    process.exit(exitCode);
  }
});
