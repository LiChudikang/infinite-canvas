import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { PlatformStore, instantiate, type PublishedTemplate } from "./store.js";
import { ChannelVault } from "./credentials.js";
import { platformApp } from "./server.js";
import type { SeedanceWorkflows, WorkflowState } from "../workflow/seedance.js";
const alice = { id: "alice", role: "user" as const }, bob = { id: "bob", role: "user" as const };
const fixture: PublishedTemplate = {
    templateId: "hotel", version: 1, title: "酒店介绍", description: "使用自己的照片", category: "酒店宣传", sampleUrl: "",
    variables: [{ key: "brand", label: "酒店名", type: "text", required: true }],
    shots: [{ nodeId: "shot1", title: "开场", prompt: "介绍 {{brand}}", model: "doubao-seedance-test", duration: 5, resolution: "720p", ratio: "16:9", images: [], mode: "frames", generateAudio: true }],
    postProcess: { subtitles: ["{{brand}}"] },
};
async function setup() {
    const root = await mkdtemp(path.join(os.tmpdir(), "canvas-platform-"));
    const channels = new ChannelVault(path.join(root, "channels"), Buffer.alloc(32, 7));
    await channels.save(alice.id, "alice-secret"); await channels.save(bob.id, "bob-secret");
    let calls = 0; const states = new Map<string, WorkflowState>();
    const workflows = { create: async (spec: { runId: string; title: string }) => { calls++; const state = { runId: spec.runId, title: spec.title, status: "running", shots: [] }; states.set(spec.runId, state); return state; }, state: async (id: string) => { const state = states.get(id); if (!state) throw Object.assign(new Error("missing"), { code: "ENOENT" }); return state; } } as unknown as SeedanceWorkflows;
    return { root, channels, store: new PlatformStore(root, workflows, channels), calls: () => calls, close: () => rm(root, { recursive: true, force: true }) };
}
test("versions are immutable and summaries omit execution prompts", async () => {
    const s = await setup(); try {
        const published = await s.store.publish(fixture); assert.equal("shots" in published, false);
        await s.store.publish(fixture);
        await assert.rejects(s.store.publish({ ...fixture, title: "覆盖旧版本" }), /版本已发布/);
        await assert.rejects(s.store.template("hotel", 99), /不存在/);
        await s.store.publish({ ...fixture, version: 2 }); assert.equal((await s.store.catalog())[0]?.version, 2);
        assert.equal((await s.store.template("hotel", 1)).version, 1);
    } finally { await s.close(); }
});
test("only declared variables change and replacement text is literal", () => {
    const spec = instantiate(fixture, { brand: "$& 海景酒店" }, "run");
    assert.equal(spec.shots[0].prompt, "介绍 $& 海景酒店"); assert.equal(spec.shots[0].model, fixture.shots[0].model);
    assert.throws(() => instantiate(fixture, { brand: "x", model: "cheaper" }, "run"), /只能修改/);
    assert.throws(() => instantiate(fixture, {}, "run"), /请填写/);
});
test("concurrent retries submit once and isolate owners and channel revisions", async () => {
    const s = await setup(); try {
        await s.store.publish(fixture);
        const request = { templateId: "hotel", version: 1, values: { brand: "A" }, requestId: randomUUID(), confirmed: true };
        const [a, b] = await Promise.all([s.store.create(alice, request), s.store.create(alice, request)]);
        assert.equal(a.runId, b.runId); assert.equal(s.calls(), 1);
        await assert.rejects(s.store.status(bob, a.runId), /无权/); assert.equal((await s.store.runs(bob)).length, 0);
        const record = await s.store.owned(alice, a.runId);
        await s.channels.save(alice.id, "alice-new-secret");
        assert.equal(await s.channels.get(alice.id, record.channelRevision), "alice-secret");
        await s.store.create(alice, request); assert.equal(s.calls(), 1);
        await assert.rejects(s.store.create(alice, { ...request, values: { brand: "B" } }), /已使用/);
        await assert.rejects(s.store.create(alice, { ...request, shots: [] }));
    } finally { await s.close(); }
});
test("secrets are encrypted at rest and cannot be read under another owner", async () => {
    const s = await setup(); try {
        const revision = await s.channels.current(alice.id);
        assert.equal((await readFile(path.join(s.root, "channels", alice.id, `${revision}.json`), "utf8")).includes("alice-secret"), false);
        assert.equal(await s.channels.get(alice.id, revision), "alice-secret");
        await assert.rejects(s.channels.get(bob.id, revision));
    } finally { await s.close(); }
});
test("HTTP denies anonymous access, user publishing, and disabled generation", async () => {
    const s = await setup(); const server = platformApp(s.store, [{ ...alice, token: "user-access" }, { id: "author", role: "author", token: "author-access" }]).listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
    const addr = server.address(); assert.ok(addr && typeof addr !== "string");
    const base = `http://127.0.0.1:${addr.port}/api/platform`;
    try {
        assert.equal((await fetch(`${base}/templates`)).status, 401);
        const send = (token: string, route: string, body: unknown) => fetch(base + route, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
        assert.equal((await send("user-access", "/templates", fixture)).status, 403);
        assert.equal((await send("author-access", "/templates", fixture)).status, 201);
        assert.equal((await send("user-access", "/runs", {})).status, 503);
        const response = await fetch(base + "/me", { headers: { Authorization: "Bearer user-access" } });
        const me = await response.json(); assert.equal(me.channelConfigured, true); assert.equal(JSON.stringify(me).includes("secret"), false);
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); await s.close(); }
});
