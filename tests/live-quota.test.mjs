import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";

const require = createRequire(import.meta.url);
const entry = fileURLToPath(new URL("../extensions/index.ts", import.meta.url));
const provider = "codex-account-pool";
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(setImmediate); };
const payload = (used) => ({ kind: "quota", items: [{ kind: "text", text: "Usage: 5h " }, { kind: "pct", pct: used, metric: "5h" }], metrics: { "5h": used } });

// Real extension + renderer, deterministic clocks/event bus and memory-only disk.
// No credentials, HTTP or files in the user's Pi profile are accessed.
function harness(t, { mounted = true } = {}) {
  const h = { now: 1_000_000, idle: false, account: "a", used: 2, requests: [], autoReply: true, writes: [], intervals: new Map(), renderCount: 0 };
  const handlers = new Map(), listeners = new Map(), modules = new Map(), commands = new Map();
  const events = {
    on(name, listener) {
      const set = listeners.get(name) ?? new Set(); set.add(listener); listeners.set(name, set);
      return () => set.delete(listener);
    },
    emit(name, data) { for (const listener of [...(listeners.get(name) ?? [])]) listener(data); },
  };
  const pi = { events, on: (name, handler) => handlers.set(name, handler), registerCommand: (name, def) => commands.set(name, def) };
  function load(path) {
    if (modules.has(path)) return modules.get(path);
    const exports = {}; modules.set(path, exports);
    const code = ts.transpileModule(readFileSync(path, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
    vm.runInNewContext(code, {
      exports, process: { env: { PI_AGENT_DIR: "offline-profile" } }, console, AbortController,
      Date: class extends Date { static now() { return h.now; } },
      setTimeout, clearTimeout,
      setInterval(fn, ms) { const id = { unref() {} }; h.intervals.set(id, { fn, ms }); return id; },
      clearInterval(id) { h.intervals.delete(id); },
      fetch() { throw new Error("Unexpected network"); },
      require(name) {
        if (name === "node:fs") return { readFileSync() { throw new Error("No disk cache"); }, chmodSync() {} };
        if (name === "node:fs/promises") return { mkdir: async () => {}, chmod: async () => {}, rename: async () => {}, writeFile: async (_path, text) => h.writes.push(JSON.parse(text)) };
        if (name.startsWith(".")) return load(resolve(dirname(path), name.replace(/\.js$/, ".ts")));
        return require(name);
      },
    }, { filename: path });
    return exports;
  }
  h.ctx = {
    model: { provider }, isIdle: () => h.idle,
    sessionManager: { getSessionId: () => "session" },
    modelRegistry: { getProviderAuth: async () => { throw new Error("No credentials should cross the bus"); } },
    ui: { notify() {}, setWidget(_key, factory) { if (mounted) h.widget = factory({ requestRender: () => h.renderCount++ }, { fg: (_color, text) => text }); } },
  };
  h.reply = (request, { account = h.account, used = h.used, fetchedAt = h.now, ...rest } = {}) => events.emit("pi-quota:response", {
    requestId: request.requestId, provider, identityKey: account, accountLabel: `Account ${account}`, fetchedAt, payload: payload(used), ...rest,
  });
  events.on("pi-quota:request", (request) => { h.requests.push(request); if (h.autoReply) h.reply(request); });
  h.event = (name, data = {}) => handlers.get(name)?.(data, h.ctx);
  h.push = ({ account = h.account, used = h.used, fetchedAt = h.now, ...rest } = {}) => events.emit("pi-quota:updated", { provider, identityKey: account, accountLabel: `Account ${account}`, fetchedAt, payload: payload(used), ...rest });
  h.switch = (account) => { h.account = account; events.emit("codex-account-pool:account-changed", { provider, sessionId: "session", accountId: account }); };
  h.tick = async (ms) => { h.now += ms; for (const { fn } of h.intervals.values()) fn(); await flush(); };
  h.text = () => h.widget.render(200).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
  h.cached = () => h.writes.at(-1)?.providers;
  h.command = (name) => commands.get(name).handler("", h.ctx);
  load(entry).default(pi);
  t.after(async () => { await h.event("session_shutdown"); h.widget?.dispose(); });
  return h;
}

test("long runs refresh at 15s with auto-refresh off: 98 -> 20 -> 0 remaining, without agent_settled", async (t) => {
  const h = harness(t);
  await h.event("session_start", { reason: "startup" }); await flush();
  assert.match(h.text(), /5h 2%/);
  h.used = 80;
  await h.tick(14_999);
  assert.equal(h.requests.length, 1);
  await h.tick(1);
  assert.match(h.text(), /5h 80%/);
  h.used = 100;
  await h.tick(15_000);
  assert.match(h.text(), /5h 100%/);
  assert.equal(h.requests.length, 3);
  assert.ok(h.renderCount > 0);
});

test("polling does not require a mounted widget and slows to 60s when idle", async (t) => {
  const h = harness(t, { mounted: false });
  await h.event("session_start", { reason: "startup" }); await flush();
  await h.tick(15_000);
  assert.equal(h.requests.length, 2);
  h.idle = true;
  await h.tick(59_999);
  assert.equal(h.requests.length, 2);
  await h.tick(1);
  assert.equal(h.requests.length, 3);
  await h.event("session_shutdown");
  assert.equal(h.intervals.size, 0);
});

test("pool pushes repaint immediately, reject old/other-account updates, retain source age", async (t) => {
  const h = harness(t);
  await h.event("session_start", { reason: "startup" }); await flush();
  h.now += 1;
  h.push({ used: 80 }); await flush();
  assert.match(h.text(), /5h 80%/);
  h.push({ account: "other", used: 2, fetchedAt: h.now + 1 });
  h.push({ used: 2, fetchedAt: h.now - 1 });
  assert.match(h.text(), /5h 80%/);
  const sourceTime = h.now;
  h.now += 120_000;
  h.autoReply = false;
  const check = h.command("checkaq");
  h.reply(h.requests.at(-1), { used: 80, fetchedAt: sourceTime });
  await check; await flush();
  assert.match(h.text(), /2m ago/);
  assert.equal(h.cached()[`${provider}:a`].trigger_line.fetchedAt, sourceTime);
});

test("switching accounts starts a new fetch immediately and late old responses cannot win", async (t) => {
  const h = harness(t);
  h.autoReply = false;
  await h.event("session_start", { reason: "startup" });
  const old = h.requests.at(-1);
  h.switch("b");
  assert.equal(h.requests.length, 2, "new request must not join the aborted promise");
  h.reply(h.requests.at(-1), { account: "b", used: 80 });
  h.reply(old, { account: "a", used: 2 });
  await flush();
  assert.match(h.text(), /Account b.*5h 80%/);
  h.push({ account: "a", used: 100, fetchedAt: h.now + 1 });
  assert.match(h.text(), /Account b.*5h 80%/);
});

test("turn_end refreshes, settlement forces live fetch, invalid replies fail without hanging", async (t) => {
  const h = harness(t);
  await h.event("session_start", { reason: "startup" }); await flush();
  await h.event("turn_end"); await flush();
  assert.equal(h.requests.length, 2);
  await h.event("agent_settled");
  assert.equal(h.requests.at(-1).force, true);
  h.autoReply = false;
  const failed = h.command("checkaq");
  h.reply(h.requests.at(-1), { payload: {} });
  await failed;
  assert.match(h.text(), /Failed/i, "failure must be visible while the agent is using the account");
});

test("new push wins over an older in-flight response", async (t) => {
  const h = harness(t);
  await h.event("session_start", { reason: "startup" }); await flush();
  h.autoReply = false;
  const oldTime = h.now;
  const check = h.command("checkaq");
  h.now += 1;
  h.push({ used: 100 });
  h.reply(h.requests.at(-1), { used: 2, fetchedAt: oldTime });
  await check;
  assert.match(h.text(), /5h 100%/);
});

test("other providers keep opt-in polling and ignore pool pushes", async (t) => {
  const h = harness(t);
  h.ctx.model.provider = "openrouter";
  await h.event("session_start", { reason: "startup" }); await flush();
  await h.tick(60_000);
  h.push(); await h.event("turn_end");
  assert.equal(h.requests.length, 0);
});
