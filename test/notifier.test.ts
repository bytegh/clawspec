import test from "node:test";
import assert from "node:assert/strict";
import { ClawSpecNotifier } from "../src/watchers/notifier.ts";
import { createLogger } from "./helpers/harness.ts";

test("notifier formats Discord channel target correctly", async () => {
  const sent: Array<{ to: string; text: string; options?: Record<string, unknown> }> = [];
  const notifier = new ClawSpecNotifier({
    api: {
      config: {},
      runtime: {
        channel: {
          discord: {
            sendMessageDiscord: async (to: string, text: string, options?: Record<string, unknown>) => {
              sent.push({ to, text, options });
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
  assert.deepEqual(sent, [{
    to: "channel:1474686041939251210",
    text: "hello",
    options: {
      cfg: {},
      accountId: undefined,
      silent: true,
    },
  }]);
});

test("notifier retries transient Discord fetch failures and eventually succeeds", async () => {
  const sent: Array<{ to: string; text: string; options?: Record<string, unknown> }> = [];
  let attempts = 0;
  const logs = createCapturedLogger();
  const notifier = new ClawSpecNotifier({
    api: {
      config: {},
      runtime: {
        channel: {
          discord: {
            sendMessageDiscord: async (to: string, text: string, options?: Record<string, unknown>) => {
              attempts += 1;
              if (attempts < 3) {
                throw new Error("fetch failed");
              }
              sent.push({ to, text, options });
            },
          },
          telegram: {},
          slack: {},
          signal: {},
        },
      },
    } as any,
    logger: logs.logger as any,
  });

  await notifier.send("discord:1474686041939251210:judy_bot:main", "hello");

  assert.equal(attempts, 3);
  assert.deepEqual(sent, [{
    to: "channel:1474686041939251210",
    text: "hello",
    options: {
      cfg: {},
      accountId: "judy_bot",
      silent: true,
    },
  }]);
  assert.equal(logs.warn.length, 0);
  assert.equal(logs.debug.length, 2);
  assert.equal(logs.info.some((line) => /recovered/i.test(line)), true);
});

test("notifier does not retry permanent Discord delivery errors", async () => {
  let attempts = 0;
  const logs = createCapturedLogger();
  const notifier = new ClawSpecNotifier({
    api: {
      config: {},
      runtime: {
        channel: {
          discord: {
            sendMessageDiscord: async () => {
              attempts += 1;
              throw new Error("Outbound not configured for channel: discord");
            },
          },
          telegram: {},
          slack: {},
          signal: {},
        },
      },
    } as any,
    logger: logs.logger as any,
  });

  await notifier.send("discord:1474686041939251210:judy_bot:main", "hello");

  assert.equal(attempts, 1);
  assert.equal(logs.warn.some((line) => /Outbound not configured/i.test(line)), true);
  assert.equal(logs.debug.length, 0);
});

test("notifier retries transient Discord failures up to the limit and then warns once", async () => {
  let attempts = 0;
  const logs = createCapturedLogger();
  const notifier = new ClawSpecNotifier({
    api: {
      config: {},
      runtime: {
        channel: {
          discord: {
            sendMessageDiscord: async () => {
              attempts += 1;
              throw new Error("fetch failed");
            },
          },
          telegram: {},
          slack: {},
          signal: {},
        },
      },
    } as any,
    logger: logs.logger as any,
  });

  await notifier.send("discord:1474686041939251210:judy_bot:main", "hello");

  assert.equal(attempts, 3);
  assert.equal(logs.debug.length, 2);
  assert.equal(logs.warn.length, 1);
  assert.equal(logs.warn[0]?.includes("fetch failed"), true);
  assert.equal(logs.info.length, 0);
});

function createCapturedLogger(): {
  info: string[];
  warn: string[];
  debug: string[];
  error: string[];
  logger: {
    info: (message: string) => void;
    warn: (message: string) => void;
    debug: (message: string) => void;
    error: (message: string) => void;
  };
} {
  const info: string[] = [];
  const warn: string[] = [];
  const debug: string[] = [];
  const error: string[] = [];
  return {
    info,
    warn,
    debug,
    error,
    logger: {
      info: (message: string) => info.push(message),
      warn: (message: string) => warn.push(message),
      debug: (message: string) => debug.push(message),
      error: (message: string) => error.push(message),
    },
  };
}
