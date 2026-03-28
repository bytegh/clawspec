import test from "node:test";
import assert from "node:assert/strict";
import {
  BootstrapCoordinator,
  buildBootstrapFailureMessage,
  buildBootstrapPendingMessage,
} from "../src/bootstrap/state.ts";
import { waitFor } from "./helpers/harness.ts";

test("BootstrapCoordinator collapses concurrent starts into a single in-flight bootstrap", async () => {
  let runs = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const coordinator = new BootstrapCoordinator(async (report) => {
    runs += 1;
    await report({
      dependency: "openspec",
      phase: "installing",
      detail: "ClawSpec is installing @fission-ai/openspec.",
    });
    await gate;
  });

  const startA = coordinator.start();
  const startB = coordinator.start();
  const startC = coordinator.start();

  assert.equal(runs, 1);
  assert.equal(coordinator.getSnapshot().status, "running");
  assert.match(buildBootstrapPendingMessage(coordinator.getSnapshot()), /installing @fission-ai\/openspec/i);

  release();
  await Promise.all([startA, startB, startC]);

  assert.equal(runs, 1);
  assert.equal(coordinator.getSnapshot().status, "ready");
});

test("BootstrapCoordinator retries failed bootstrap once per retry wave and preserves the failure reason", async () => {
  let runs = 0;
  const coordinator = new BootstrapCoordinator(async (report) => {
    runs += 1;
    await report({
      dependency: "acpx",
      phase: "installing",
      detail: "ClawSpec is installing acpx@0.3.1.",
    });
    if (runs === 1) {
      throw new Error("failed to install plugin-local acpx: npm install exited 1");
    }
  });

  await coordinator.start();
  const failedSnapshot = coordinator.getSnapshot();
  assert.equal(failedSnapshot.status, "failed");
  assert.match(buildBootstrapFailureMessage(failedSnapshot), /failed to install plugin-local acpx/i);
  assert.match(buildBootstrapFailureMessage(failedSnapshot), /Retrying dependency bootstrap in the background now/i);

  coordinator.startInBackground();
  coordinator.startInBackground();
  coordinator.startInBackground();

  await waitFor(async () => coordinator.getSnapshot().status === "ready", 4_000);
  assert.equal(runs, 2);
});
