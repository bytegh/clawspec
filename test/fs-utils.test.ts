import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { appendUtf8, readUtf8 } from "../src/utils/fs.ts";

test("appendUtf8 preserves concurrent appends", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "clawspec-fs-append-"));
  const targetFile = path.join(tempRoot, "journal.log");
  const writes = Array.from({ length: 64 }, (_, index) => appendUtf8(targetFile, `line-${index}\n`));

  await Promise.all(writes);

  const lines = (await readUtf8(targetFile))
    .trim()
    .split(/\r?\n/)
    .filter(Boolean);

  assert.equal(lines.length, 64);
  assert.equal(new Set(lines).size, 64);
});
