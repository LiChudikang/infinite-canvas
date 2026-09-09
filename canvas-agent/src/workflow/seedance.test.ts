import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import { SeedanceWorkflows, workflowSchema, seedanceWorkflowRouter, validateSubtitleCues } from "./seedance.js";

const input = (runId: string) => ({ runId, title: "测试", snapshot: { templateId: "t", version: 1 }, shots: [{ nodeId: "a", title: "A", model: "doubao-seedance-test", prompt: "酒店", duration: 15, resolution: "1080p", ratio: "16:9", images: [], mode: "reference", generateAudio: true }], postProcess: { subtitles: [] } });
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
async function setup(fetcher: typeof fetch) {
    process.env.ARK_API_KEY = "test-key-never-sent";
    process.env.FFMPEG_PATH = "/usr/bin/true";
    const root = await mkdtemp(path.join(os.tmpdir(), "canvas-workflow-test-"));
    return new SeedanceWorkflows(root, fetcher, async (dir) => { await writeFile(path.join(dir, "final.mp4"), "test-only"); });
}

test("completed run reuses snapshot and never resubmits on create or resume", async () => {
    let posts = 0;
    const runner = await setup(async (_url, init) => {
        if (init?.method === "POST") { posts++; return response({ id: "cgt-test" }); }
        if (init?.method === "GET") return response({ status: "succeeded", content: { video_url: "https://media.example/video" } });
        return new Response("video");
    });
    await runner.create(input("same")); await runner.active.get("same");
    await runner.create({ ...input("same"), snapshot: { version: 99 } });
    await runner.resume("same"); await runner.active.get("same");
    assert.equal(posts, 1);
    assert.equal((await runner.state("same")).status, "succeeded");
    assert.equal((await runner.spec("same")).snapshot.version, 1);
    assert.ok(!(await readFile(path.join(runner.folder("same"), "snapshot.json"), "utf8")).includes("test-key"));
});
test("ambiguous POST survives restart without creating duplicate charged tasks", async () => {
    let posts = 0;
    const fetcher: typeof fetch = async () => { posts++; throw new Error("connection lost after POST"); };
    const runner = await setup(fetcher);
    await runner.create(input("unknown")); await runner.active.get("unknown");
    const restarted = new SeedanceWorkflows(runner.root, fetcher);
    await restarted.resume("unknown"); await restarted.active.get("unknown");
    assert.equal(posts, 1);
    assert.equal((await restarted.state("unknown")).shots[0].status, "uncertain");
});
test("failed download resumes with existing ID and does not POST again", async () => {
    let posts = 0, downloads = 0;
    const runner = await setup(async (_url, init) => {
        if (init?.method === "POST") { posts++; return response({ id: "cgt-download" }); }
        if (init?.method === "GET") return response({ status: "succeeded", content: { video_url: "https://media.example/video" } });
        if (++downloads === 1) throw new Error("download offline");
        return new Response("video");
    });
    await runner.create(input("download")); await runner.active.get("download");
    assert.equal((await runner.state("download")).status, "paused");
    await runner.resume("download"); await runner.active.get("download");
    assert.equal(posts, 1); assert.equal((await runner.state("download")).status, "succeeded");
});
test("adopting existing tasks uses GET only and validates task count before payment", async () => {
    const runner = await setup(async (_url, init) => {
        assert.notEqual(init?.method, "POST");
        return init?.method === "GET" ? response({ status: "succeeded", content: { video_url: "https://media.example/video" } }) : new Response("video");
    });
    assert.equal(workflowSchema.safeParse({ ...input("bad"), existingTaskIds: [] }).success, false);
    assert.equal(workflowSchema.safeParse({ ...input("../bad") }).success, false);
    await runner.create({ ...input("adopt"), existingTaskIds: ["cgt-existing"] }); await runner.active.get("adopt");
    assert.equal((await runner.state("adopt")).status, "succeeded");
});

test("video route serves only recorded outputs even inside a hidden storage directory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), ".canvas-workflow-route-"));
    const runner = new SeedanceWorkflows(root, async (_url, init) => init?.method === "GET" ? response({ status: "succeeded", content: { video_url: "https://media.example/video" } }) : new Response("video"), async (dir) => { await writeFile(path.join(dir, "final.mp4"), "final-video"); });
    await runner.create({ ...input("route"), existingTaskIds: ["cgt-existing"] }); await runner.active.get("route");
    const app = express(); app.use(seedanceWorkflowRouter(runner));
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    try {
        const address = server.address() as { port: number };
        const base = `http://127.0.0.1:${address.port}/runs/route/files/`;
        assert.equal(await (await fetch(base + "final.mp4")).text(), "final-video");
        assert.equal((await fetch(base + "snapshot.json")).status, 404);
        assert.equal((await fetch(base + "shot-99.mp4")).status, 404);
    } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("speech subtitles pause for review, preserve snapshots and version outputs without new generation", async () => {
    let posts = 0;
    const runner = await setup(async (_url, init) => {
        if (init?.method === "POST") { posts++; return response({ id: "cgt-speech" }); }
        return init?.method === "GET" ? response({ status: "succeeded", content: { video_url: "https://media.example/video" } }) : new Response("video");
    });
    process.env.WORKFLOW_PYTHON = "/usr/bin/true"; process.env.WORKFLOW_WHISPER_MODEL = runner.root;
    const cues = [{ shot: 0, start: 1, end: 4, text: "店总决定。" }];
    runner.transcribe = async (folder) => { await writeFile(path.join(folder, "subtitles-draft.json"), JSON.stringify({ cues })); };
    await runner.create({ ...input("speech"), postProcess: { subtitles: [], autoSubtitles: true } }); await runner.active.get("speech");
    assert.equal((await runner.state("speech")).status, "awaiting_review");
    assert.equal((await runner.state("speech")).final, undefined);
    await assert.rejects(runner.approveSubtitles("speech", [{ ...cues[0], end: 99 }]));
    await runner.approveSubtitles("speech", cues); await runner.active.get("speech");
    assert.equal((await runner.state("speech")).final, "final-1.mp4");
    await runner.approveSubtitles("speech", [{ ...cues[0], text: "店总作决定。" }]); await runner.active.get("speech");
    assert.deepEqual((await runner.state("speech")).outputs, ["final-1.mp4", "final-2.mp4"]);
    assert.equal(posts, 1);
    assert.equal((await runner.spec("speech")).postProcess.subtitles.length, 0);
    assert.throws(() => validateSubtitleCues([cues[0], { ...cues[0], start: 3, end: 5 }], [15]));
});
