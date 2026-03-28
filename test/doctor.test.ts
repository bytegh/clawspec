import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir } from "node:fs/promises";
import { runDoctorCommand } from "../src/orchestrator/service.ts";
import { writeJsonFile, readJsonFile } from "../src/utils/fs.ts";

test("doctor reports no issues when config file does not exist", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "clawspec-doctor-"));
  const configPath = path.join(tempRoot, ".acpx", "config.json");

  const result = await runDoctorCommand(configPath);

  assert.equal(result.isError, undefined);
  assert.match(result.text ?? "", /No issues found/);
});

test("doctor reports no issues when agents is empty", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "clawspec-doctor-"));
  const configDir = path.join(tempRoot, ".acpx");
  await mkdir(configDir, { recursive: true });
  const configPath = path.join(configDir, "config.json");

  await writeJsonFile(configPath, {
    defaultAgent: "codex",
    agents: {},
  });

  const result = await runDoctorCommand(configPath);

  assert.equal(result.isError, undefined);
  assert.match(result.text ?? "", /No issues found/);
});

test("doctor detects custom agent entries", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "clawspec-doctor-"));
  const configDir = path.join(tempRoot, ".acpx");
  await mkdir(configDir, { recursive: true });
  const configPath = path.join(configDir, "config.json");

  await writeJsonFile(configPath, {
    defaultAgent: "codex",
    agents: {
      codex: { command: "/usr/local/bin/codex" },
    },
  });

  const result = await runDoctorCommand(configPath);

  assert.equal(result.isError, undefined);
  assert.match(result.text ?? "", /custom agent entries/);
  assert.match(result.text ?? "", /`codex`/);
  assert.match(result.text ?? "", /doctor fix/);
});

test("doctor detects invalid JSON", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "clawspec-doctor-"));
  const configDir = path.join(tempRoot, ".acpx");
  await mkdir(configDir, { recursive: true });
  const configPath = path.join(configDir, "config.json");

  const { writeUtf8 } = await import("../src/utils/fs.ts");
  await writeUtf8(configPath, '{ "agents": { broken }');

  const result = await runDoctorCommand(configPath);

  assert.equal(result.isError, undefined);
  assert.match(result.text ?? "", /invalid JSON/);
});

test("doctor fix clears custom agent entries", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "clawspec-doctor-"));
  const configDir = path.join(tempRoot, ".acpx");
  await mkdir(configDir, { recursive: true });
  const configPath = path.join(configDir, "config.json");

  await writeJsonFile(configPath, {
    defaultAgent: "codex",
    authPolicy: "skip",
    agents: {
      codex: { command: "/usr/local/bin/codex" },
    },
  });

  const result = await runDoctorCommand(configPath, "fix");

  assert.equal(result.isError, undefined);
  assert.match(result.text ?? "", /Doctor Fix Applied/);

  const updated = await readJsonFile<Record<string, unknown>>(configPath, {});
  assert.deepEqual(updated.agents, {});
  assert.equal(updated.defaultAgent, "codex");
  assert.equal(updated.authPolicy, "skip");
});

test("doctor fix reports nothing to fix when agents is already empty", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "clawspec-doctor-"));
  const configDir = path.join(tempRoot, ".acpx");
  await mkdir(configDir, { recursive: true });
  const configPath = path.join(configDir, "config.json");

  await writeJsonFile(configPath, {
    defaultAgent: "codex",
    agents: {},
  });

  const result = await runDoctorCommand(configPath, "fix");

  assert.equal(result.isError, undefined);
  assert.match(result.text ?? "", /Nothing to fix/);
});

test("doctor fix reports error when config has invalid JSON", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "clawspec-doctor-"));
  const configDir = path.join(tempRoot, ".acpx");
  await mkdir(configDir, { recursive: true });
  const configPath = path.join(configDir, "config.json");

  const { writeUtf8 } = await import("../src/utils/fs.ts");
  await writeUtf8(configPath, '{ broken json');

  const result = await runDoctorCommand(configPath, "fix");

  assert.equal(result.isError, true);
  assert.match(result.text ?? "", /Cannot auto-fix/);
});
