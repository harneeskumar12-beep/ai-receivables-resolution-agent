import test from "node:test";
import assert from "node:assert/strict";

import { resolveProvider } from "../src/resolve-provider.ts";

test("OPENROUTER_API_KEY reaches the OpenRouterProvider", () => {
  const r = resolveProvider({ OPENROUTER_API_KEY: "fake-key" } as NodeJS.ProcessEnv);
  assert.ok(r);
  assert.equal(r?.kind, "openrouter");
  assert.ok(r?.provider.name.startsWith("openrouter:"));
});

test("GEMINI_API_KEY is used when OPENROUTER_API_KEY is absent", () => {
  const r = resolveProvider({ GEMINI_API_KEY: "fake-key" } as NodeJS.ProcessEnv);
  assert.ok(r);
  assert.equal(r?.kind, "gemini");
});

test("OPENROUTER_API_KEY takes precedence when both keys are present", () => {
  const r = resolveProvider({ OPENROUTER_API_KEY: "or-key", GEMINI_API_KEY: "g-key" } as NodeJS.ProcessEnv);
  assert.equal(r?.kind, "openrouter");
});

test("no keys present resolves to null - no network call is ever attempted", () => {
  const r = resolveProvider({} as NodeJS.ProcessEnv);
  assert.equal(r, null);
});
