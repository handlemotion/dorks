#!/usr/bin/env node
// A stand-in for the real `gh`, for the shim tests. Test hooks (child env):
//   FAKE_GH_REPORT=<file>   write {argv, token, hasSocket} as JSON (the token is what GH_TOKEN held)
//   FAKE_GH_STDOUT / FAKE_GH_STDERR   text to print;   FAKE_GH_EXIT   exit code (default 0)
import { writeFileSync } from "node:fs";

if (process.env.FAKE_GH_REPORT) {
  writeFileSync(process.env.FAKE_GH_REPORT, JSON.stringify({ argv: process.argv.slice(2), token: process.env.GH_TOKEN ?? null, hasSocket: !!process.env.DORKS_SOCK }));
}
if (process.env.FAKE_GH_STDOUT) process.stdout.write(process.env.FAKE_GH_STDOUT);
if (process.env.FAKE_GH_STDERR) process.stderr.write(process.env.FAKE_GH_STDERR);
process.exit(Number(process.env.FAKE_GH_EXIT ?? 0));
