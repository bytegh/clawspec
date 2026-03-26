import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { resolveUserPath } from "../src/utils/paths.ts";

test("resolveUserPath expands home directory shorthand", () => {
  const actual = resolveUserPath("~/Desktop/workspace/ai_workspace", "/tmp/base");
  const expected = path.join(os.homedir(), "Desktop", "workspace", "ai_workspace");
  assert.equal(actual, expected);
});

test("resolveUserPath resolves relative path against base directory", () => {
  const base = path.join(os.homedir(), "clawspec", "workspace");
  const actual = resolveUserPath("demo-app", base);
  assert.equal(actual, path.resolve(base, "demo-app"));
});

test("resolveUserPath keeps POSIX absolute path absolute", () => {
  const absolute = "/tmp/clawspec-posix-absolute";
  const actual = resolveUserPath(absolute, "/tmp/base");
  assert.equal(actual, path.normalize(absolute));
});

test("resolveUserPath keeps Windows drive absolute path absolute on all platforms", () => {
  const absolute = "C:\\Users\\dev\\workspace\\demo";
  const actual = resolveUserPath(absolute, "/tmp/base");
  assert.equal(actual, path.normalize(absolute));
});

