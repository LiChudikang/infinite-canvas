import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, link, unlink, readdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { ChannelVault } from "./credentials.js";
import { workflowSchema, type SeedanceWorkflows } from "../workflow/seedance.js";

const identifier = z.string().regex(/^[a-zA-Z0-9_-]+$/);
const picture = z.string().regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/);
const placeholder = /^\{\{\s*([a-zA-Z][a-zA-Z0-9_-]*)\s*\}\}$/;
const tinyImage = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
export const templateSchema = z.object({
    templateId: identifier, version: z.number().int().positive(), title: z.string().trim().min(1),
    description: z.string(), category: z.string().trim().min(1),
    sampleUrl: z.union([z.literal(""), z.string().url().refine((s) => s.startsWith("https://"))]),
    variables: z.array(z.object({ key: identifier, label: z.string().min(1), type: z.enum(["text", "image"]), required: z.boolean(), defaultValue: z.string().optional() }).strict()),
    shots: z.array(z.object({ nodeId: identifier, title: z.string(), prompt: z.string(), model: z.string(), duration: z.number(), resolution: z.string(), ratio: z.string(), images: z.array(z.string()), mode: z.string(), generateAudio: z.boolean() }).strict()),
    postProcess: z.object({ subtitles: z.array(z.string()), logo: picture.optional(), autoSubtitles: z.boolean().optional() }).strict(),
}).strict();
export type PublishedTemplate = z.infer<typeof templateSchema>;
export type Member = { id: string; role: "author" | "user" };
export class PlatformError extends Error { constructor(readonly status: number, message: string) { super(message); } }
const missing = () => new PlatformError(404, "内容不存在或无权访问");
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function read(file: string) { try { return JSON.parse(await readFile(file, "utf8")); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") throw missing(); throw e; } }
async function put(file: string, value: unknown) {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(value), { flag: "wx", mode: 0o600 });
    try { await link(tmp, file); } finally { await unlink(tmp); }
}
function render(text: string, values: Record<string, string>) {
    return text.replace(/\{\{\s*([a-zA-Z][a-zA-Z0-9_-]*)\s*\}\}/g, (_, key: string) => {
        if (!Object.hasOwn(values, key)) throw new PlatformError(400, `未声明或未填写变量：${key}`);
        return values[key];
    });
}
export function instantiate(template: PublishedTemplate, values: Record<string, string>, runId: string) {
    const declared = new Set(template.variables.map((v) => v.key));
    if (Object.keys(values).some((key) => !declared.has(key))) throw new PlatformError(400, "只能修改模板开放的变量");
    const resolved = Object.fromEntries(template.variables.map((v) => {
        const value = Object.hasOwn(values, v.key) ? values[v.key] : v.defaultValue || "";
        if (v.required && !value.trim()) throw new PlatformError(400, `请填写${v.label}`);
        if (v.type === "image") picture.parse(value);
        return [v.key, value];
    }));
    const textValues = Object.fromEntries(template.variables.filter((v) => v.type === "text").map((v) => [v.key, resolved[v.key]]));
    return workflowSchema.parse({ runId, title: template.title, snapshot: { templateId: template.templateId, version: template.version, variables: resolved, template },
        shots: template.shots.map((shot) => ({ ...shot, prompt: render(shot.prompt, textValues), images: shot.images.map((s) => {
            const key = placeholder.exec(s)?.[1];
            if (!key) return picture.parse(s);
            if (!template.variables.some((v) => v.key === key && v.type === "image")) throw new PlatformError(400, "图片变量未声明");
            return resolved[key];
        }) })), postProcess: { ...template.postProcess, subtitles: template.postProcess.subtitles.map((s) => render(s, textValues)) },
    });
}
export function summary(t: PublishedTemplate) {
    return { templateId: t.templateId, version: t.version, title: t.title, description: t.description, category: t.category, sampleUrl: t.sampleUrl,
        variables: t.variables, calls: t.shots.length, seconds: t.shots.reduce((n, s) => n + s.duration, 0),
        ratios: [...new Set(t.shots.map((s) => s.ratio))], resolutions: [...new Set(t.shots.map((s) => s.resolution))] };
}
export class PlatformStore {
    constructor(readonly root: string, readonly workflows: SeedanceWorkflows, readonly channels: ChannelVault) {}
    templateFile(id: string, version: number) { return path.join(this.root, "templates", identifier.parse(id), `${z.number().int().positive().parse(version)}.json`); }
    async template(id: string, version: number): Promise<PublishedTemplate> { return templateSchema.parse(await read(this.templateFile(id, version))); }
    async publish(input: unknown) {
        const t = templateSchema.parse(input);
        if (new Set(t.variables.map((v) => v.key)).size !== t.variables.length) throw new PlatformError(400, "变量名不能重复");
        instantiate(t, Object.fromEntries(t.variables.map((v) => [v.key, v.type === "image" ? tinyImage : "校验"])), "validation");
        try { await put(this.templateFile(t.templateId, t.version), t); }
        catch (e) {
            if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
            if (digest(await this.template(t.templateId, t.version)) !== digest(t)) throw new PlatformError(409, "该版本已发布，请从画布发布新版本");
        }
        return summary(t);
    }
    async catalog() {
        const base = path.join(this.root, "templates");
        const dirs = await readdir(base).catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return []; throw e; });
        return (await Promise.all(dirs.map(async (id) => {
            const versions = (await readdir(path.join(base, id))).filter((f) => /^\d+\.json$/.test(f)).map((f) => Number(f.slice(0, -5)));
            return versions.length ? summary(await this.template(id, Math.max(...versions))) : null;
        }))).filter((t) => t !== null);
    }
    async owned(member: Member, runId: string) {
        const record = await read(path.join(this.root, "runs", `${identifier.parse(runId)}.json`));
        if (record.owner !== member.id) throw missing();
        return record;
    }
    async create(member: Member, input: unknown) {
        const request = z.object({ templateId: identifier, version: z.number().int().positive(), values: z.record(z.string()), requestId: z.string().uuid(), confirmed: z.literal(true) }).strict().parse(input);
        const runId = digest([member.id, request.requestId]);
        const fingerprint = digest(request);
        const template = await this.template(request.templateId, request.version);
        const spec = instantiate(template, request.values, runId);
        let channelRevision: string;
        try { channelRevision = await this.channels.current(member.id); } catch { throw new PlatformError(400, "请先配置自己的方舟渠道"); }
        const record = { channelRevision, runId, owner: member.id, fingerprint, templateId: template.templateId, version: template.version, title: template.title, createdAt: new Date().toISOString() };
        try { await put(path.join(this.root, "runs", `${runId}.json`), record); }
        catch (e) {
            if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
            const prior = await this.owned(member, runId);
            if (prior.fingerprint !== fingerprint) throw new PlatformError(409, "此生成请求已使用，请创建新的请求");
            return this.status(member, runId);
        }
        // Reservation is persisted before any provider request. Never automatically resubmit it.
        try { await this.workflows.create(spec); } catch { throw new PlatformError(503, "任务已保留，但执行未启动。请在我的作品中查看并联系作者处理，请勿重复生成。"); }
        return this.status(member, runId);
    }
    async status(member: Member, runId: string) {
        const record = await this.owned(member, runId);
        try {
            const state = await this.workflows.state(runId);
            return { ...record, owner: undefined, fingerprint: undefined, channelRevision: undefined, ...state, error: state.error ? "执行需要处理，请联系模板作者" : undefined,
                shots: state.shots.map(({ nodeId, title, status, file }) => ({ nodeId, title, status, file })) };
        } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; return { runId, title: record.title, createdAt: record.createdAt, templateId: record.templateId, version: record.version, status: "reserved", shots: [] }; }
    }
    async runs(member: Member) {
        const files = await readdir(path.join(this.root, "runs")).catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return []; throw e; });
        const rows = await Promise.all(files.filter((f) => f.endsWith(".json")).map(async (file) => {
            const record = await read(path.join(this.root, "runs", file));
            return record.owner === member.id ? this.status(member, record.runId) : null;
        }));
        return rows.filter((r) => r !== null).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    }
}
