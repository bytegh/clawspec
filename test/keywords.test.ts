import test from "node:test";
import assert from "node:assert/strict";
import {
  parseClawSpecKeyword,
  extractEmbeddedClawSpecKeyword,
  isClawSpecKeywordText,
} from "../src/control/keywords.ts";

test("parseClawSpecKeyword recognizes all primary commands", () => {
  const commands = [
    ["cs-plan", "plan"],
    ["cs-work", "work"],
    ["cs-attach", "attach"],
    ["cs-detach", "detach"],
    ["cs-deattach", "detach"],
    ["cs-pause", "pause"],
    ["cs-continue", "continue"],
    ["cs-status", "status"],
    ["cs-cancel", "cancel"],
  ] as const;

  for (const [input, expectedKind] of commands) {
    const result = parseClawSpecKeyword(input);
    assert.equal(result?.kind, expectedKind, `${input} should be kind "${expectedKind}"`);
    assert.equal(result?.command, input.toLowerCase());
  }
});

test("parseClawSpecKeyword handles args", () => {
  const result = parseClawSpecKeyword("cs-continue now please");
  assert.equal(result?.kind, "continue");
  assert.equal(result?.args, "now please");
  assert.equal(result?.raw, "cs-continue now please");
});

test("parseClawSpecKeyword returns null for non-cs- prefixed text", () => {
  assert.equal(parseClawSpecKeyword("hello world"), null);
  assert.equal(parseClawSpecKeyword("/clawspec proposal"), null);
  assert.equal(parseClawSpecKeyword(""), null);
  assert.equal(parseClawSpecKeyword("cs-nonexistent"), null);
});

test("parseClawSpecKeyword is case-insensitive for command", () => {
  const result = parseClawSpecKeyword("CS-PLAN");
  assert.equal(result?.kind, "plan");
  assert.equal(result?.command, "cs-plan");
});

test("parseClawSpecKeyword trims input", () => {
  const result = parseClawSpecKeyword("  cs-work  ");
  assert.equal(result?.kind, "work");
});

test("isClawSpecKeywordText returns boolean correctly", () => {
  assert.equal(isClawSpecKeywordText("cs-plan"), true);
  assert.equal(isClawSpecKeywordText("hello"), false);
});

test("extractEmbeddedClawSpecKeyword finds keyword in multiline text", () => {
  const text = "Here is some context\n\ncs-work\n\nMore text after";
  const result = extractEmbeddedClawSpecKeyword(text);
  assert.equal(result?.kind, "work");
});

test("extractEmbeddedClawSpecKeyword finds keyword with args in multiline text", () => {
  const text = "Please do this:\ncs-continue hello world\nThanks!";
  const result = extractEmbeddedClawSpecKeyword(text);
  assert.equal(result?.kind, "continue");
  assert.equal(result?.args, "hello world");
});

test("extractEmbeddedClawSpecKeyword returns direct match for single-line input", () => {
  const result = extractEmbeddedClawSpecKeyword("cs-status");
  assert.equal(result?.kind, "status");
});

test("extractEmbeddedClawSpecKeyword returns null when no keyword present", () => {
  assert.equal(extractEmbeddedClawSpecKeyword("no keywords here"), null);
  assert.equal(extractEmbeddedClawSpecKeyword("just a normal message\nwith multiple lines"), null);
});
