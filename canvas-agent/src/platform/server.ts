import express, { type ErrorRequestHandler } from "express";
import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { SeedanceWorkflows } from "../workflow/seedance.js";
import { ChannelVault } from "./credentials.js";
import { PlatformError, PlatformStore, summary, type Member } from "./store.js";

const accountsSchema = z.array(z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]+$/), role: z.enum(["author", "user"]), token: z.string().min(1) }).strict()).min(1);
type Account = z.infer<typeof accountsSchema>[number];
const hash = (s: string) => createHash("sha256").update(s).digest();
export function platformApp(store: PlatformStore, accounts: Account[], generationEnabled = false) {
    const app = express();
    app.disable("x-powered-by");
    app.use("/api/platform", (req, res, next) => {
        res.setHeader("Cache-Control", "no-store");
        const supplied = hash(req.get("authorization")?.replace(/^Bearer /, "") || "");
        const account = accounts.find((a) => timingSafeEqual(hash(a.token), supplied));
        if (!account) return void res.status(401).json({ error: "请输入有效的访问凭证" });
        res.locals.member = { id: account.id, role: account.role } satisfies Member;
        next();
    });
    // Same payload boundary as the existing Agent; includes base64 image inputs.
    app.use("/api/platform", express.json({ limit: "30mb" }));
    const api = express.Router();
    api.get("/me", async (_req, res) => {
        let channelConfigured = false;
        try { await store.channels.current(res.locals.member.id); channelConfigured = true; } catch { /* No saved channel. */ }
        res.json({ ...res.locals.member, generationEnabled, channelConfigured });
    });
    api.put("/channel", async (req, res) => {
        const { apiKey } = z.object({ apiKey: z.string().trim().min(1) }).strict().parse(req.body);
        await store.channels.save(res.locals.member.id, apiKey);
        res.json({ configured: true });
    });
    api.get("/templates", async (_req, res) => { res.json(await store.catalog()); });
    api.get("/templates/:id/:version", async (req, res) => { res.json(summary(await store.template(String(req.params.id), Number(req.params.version)))); });
    api.post("/templates", async (req, res) => {
        if (res.locals.member.role !== "author") throw new PlatformError(403, "仅作者可以发布模板");
        res.status(201).json(await store.publish(req.body));
    });
    api.get("/runs", async (_req, res) => { res.json(await store.runs(res.locals.member)); });
    api.post("/runs", async (req, res) => {
        if (!generationEnabled) throw new PlatformError(503, "作者尚未启用生成服务");
        res.status(201).json(await store.create(res.locals.member, req.body));
    });
    api.get("/runs/:id", async (req, res) => { res.json(await store.status(res.locals.member, String(req.params.id))); });
    api.post("/runs/:id/resume", async (req, res) => {
        const id = String(req.params.id);
        await store.owned(res.locals.member, id);
        if (!generationEnabled) throw new PlatformError(503, "作者尚未启用生成服务");
        // Only resume existing work; no user-controlled task IDs or paid-shot retries.
        const state = await store.workflows.state(id);
        if (state.shots.some((s) => ["pending", "failed", "uncertain", "submitting"].includes(s.status))) throw new PlatformError(409, "此任务需要作者检查，不能自动重新提交");
        await store.workflows.resume(id);
        res.json(await store.status(res.locals.member, id));
    });
    api.get("/runs/:id/subtitles", async (req, res) => {
        await store.owned(res.locals.member, String(req.params.id));
        res.json(await store.workflows.subtitles(String(req.params.id)));
    });
    api.post("/runs/:id/subtitles", async (req, res) => {
        await store.owned(res.locals.member, String(req.params.id));
        if (!generationEnabled) throw new PlatformError(503, "作者尚未启用生成服务");
        await store.workflows.approveSubtitles(String(req.params.id), req.body.cues);
        res.json(await store.status(res.locals.member, String(req.params.id)));
    });
    api.get("/runs/:id/files/:file", async (req, res) => {
        const id = String(req.params.id), file = String(req.params.file);
        await store.owned(res.locals.member, id);
        const state = await store.workflows.state(id);
        if (!/^(final(?:-\d+)?|shot-\d+)\.mp4$/.test(file) || !(file === state.final || state.outputs?.includes(file) || state.shots.some((s) => s.file === file))) throw new PlatformError(404, "文件不存在");
        res.download(path.join(store.workflows.folder(id), file), file);
    });
    app.use("/api/platform", api);
    app.use("/api/platform", (_req, res) => res.status(404).json({ error: "接口不存在" }));
    const errors: ErrorRequestHandler = (error, _req, res, _next) => {
        const status = error instanceof PlatformError ? error.status : error instanceof z.ZodError ? 400 : error.type === "entity.too.large" ? 413 : 500;
        res.status(status).json({ error: error instanceof PlatformError ? error.message : status === 400 ? "模板或输入格式不正确" : status === 413 ? "请求超过现有 30 MB 上限，请缩小图片后重试" : "服务暂时无法处理，请联系作者检查" });
    };
    app.use(errors);
    return app;
}
async function main() {
    if (!process.env.PLATFORM_ACCOUNTS_FILE || !process.env.PLATFORM_DATA_DIR || !process.env.PLATFORM_PORT || !process.env.PLATFORM_ENCRYPTION_KEY) throw new Error("请配置 PLATFORM_ACCOUNTS_FILE、PLATFORM_DATA_DIR、PLATFORM_PORT 和 PLATFORM_ENCRYPTION_KEY");
    const accounts = accountsSchema.parse(JSON.parse(await readFile(process.env.PLATFORM_ACCOUNTS_FILE, "utf8")));
    if (new Set(accounts.map((a) => a.token)).size !== accounts.length || new Set(accounts.map((a) => a.id)).size !== accounts.length) throw new Error("账号 ID 和凭证必须唯一");
    const root = path.resolve(process.env.PLATFORM_DATA_DIR);
    const port = z.coerce.number().int().min(1).max(65535).parse(process.env.PLATFORM_PORT);
    const encryptionKey = z.string().regex(/^[a-fA-F0-9]{64}$/).parse(process.env.PLATFORM_ENCRYPTION_KEY);
    const channels = new ChannelVault(path.join(root, "channels"), Buffer.from(encryptionKey, "hex"));
    const workflows = new SeedanceWorkflows(path.join(root, "workflows"), fetch, undefined, async (runId) => {
        const record = JSON.parse(await readFile(path.join(root, "runs", `${runId}.json`), "utf8"));
        return channels.get(record.owner, record.channelRevision);
    });
    platformApp(new PlatformStore(root, workflows, channels), accounts, process.env.PLATFORM_GENERATION_ENABLED === "true").listen(port, "127.0.0.1", () => console.log(`Template platform listening on 127.0.0.1:${port}`));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main().catch(() => { console.error("模板服务启动失败，请检查环境变量、账号文件和数据目录权限"); process.exitCode = 1; });
