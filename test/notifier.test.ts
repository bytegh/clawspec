import test from "node:test";
import assert from "node:assert/strict";
import { ClawSpecNotifier } from "../src/watchers/notifier.ts";
import { createLogger } from "./helpers/harness.ts";

test("notifier formats Discord channel target correctly", async () => {
  const sent: Array<{ to: string; text: string }> = [];
  const notifier = new ClawSpecNotifier({
    api: {
      config: {},
      runtime: {
        channel: {
          discord: {
            sendMessageDiscord: async (to: string, text: string) => {
              sent.push({ to, text });
            },
          },
          telegram: {},
          slack: {},
          signal: {},
        },
      },
    } as any,
    logger: createLogger() as any,
  });

  await notifier.send("discord:1474686041939251210:default:main", "hello");
  assert.deepEqual(sent, [{ to: "channel:1474686041939251210", text: "hello" }]);
});
