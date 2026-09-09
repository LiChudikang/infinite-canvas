import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile, rename, access, copyFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Router } from "express";
import { z } from "zod";
import { CONFIG_DIR } from "../config.js";

const exec = promisify(execFile);
const API = "https://ark.cn-beijing.volces.com/api/v3";
const id = z.string().regex(/^[\w-]+$/);
const picture = z.string().regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/);
export const subtitleCuesSchema = z.array(z.object({ shot: z.number().int().nonnegative(), start: z.number().finite().nonnegative(), end: z.number().finite().positive(), text: z.string().trim().min(1) }));
type SubtitleCue = z.infer<typeof subtitleCuesSchema>[number];
export function validateSubtitleCues(value: unknown, durations: number[]) {
    const cues = subtitleCuesSchema.parse(value);
    const ends = new Map<number, number>();
    for (const cue of cues) {
        if (cue.shot >= durations.length || cue.end <= cue.start || cue.end > durations[cue.shot] || cue.start < (ends.get(cue.shot) || 0)) throw new Error("字幕时间必须在对应镜头内，并按时间排列且不重叠");
        ends.set(cue.shot, cue.end);
    }
    return cues;
}
export const workflowSchema = z.object({
    runId: id, title: z.string(), snapshot: z.record(z.unknown()),
    shots: z.array(z.object({
        nodeId: id, title: z.string(), prompt: z.string().trim().min(1),
        model: z.string().regex(/^doubao-seedance-/), duration: z.number().int().min(4).max(30),
        resolution: z.enum(["480p", "720p", "1080p"]), ratio: z.enum(["16:9", "9:16"]),
        images: z.array(picture), mode: z.enum(["reference", "frames"]), generateAudio: z.boolean(),
    })).min(1),
    postProcess: z.object({ subtitles: z.array(z.string()), logo: picture.optional(), autoSubtitles: z.boolean().optional() }),
    existingTaskIds: z.array(z.string().regex(/^cgt-[\w-]+$/)).optional(),
}).superRefine((spec, context) => {
    if (spec.existingTaskIds && spec.existingTaskIds.length !== spec.shots.length) context.addIssue({ code: "custom", message: "已有任务 ID 数量必须与镜头数量一致" });
    if (spec.postProcess.subtitles.length > spec.shots.length) context.addIssue({ code: "custom", message: "字幕行数不能多于镜头数量" });
    spec.shots.forEach((shot) => { if (shot.mode === "frames" && shot.images.length > 2) context.addIssue({ code: "custom", message: "首尾帧模式最多两张图" }); });
});
type Spec = z.infer<typeof workflowSchema>;
type ShotState = { nodeId: string; title: string; status: string; taskId?: string; file?: string; error?: string };
export type WorkflowState = { runId: string; title: string; status: string; shots: ShotState[]; final?: string; outputs?: string[]; error?: string };
const exists = (file: string) => access(file).then(() => true, () => false);
const delay = () => new Promise((resolve) => setTimeout(resolve, 20_000));

/** Disk state is authoritative. A persisted submitting marker never causes another POST. */
export class SeedanceWorkflows {
    readonly active = new Map<string, Promise<void>>();
    constructor(readonly root = path.join(CONFIG_DIR, "video-workflows"), readonly fetcher: typeof fetch = fetch, readonly composer = compose) {}
    folder(runId: string) { return path.join(this.root, id.parse(runId)); }
    async state(runId: string): Promise<WorkflowState> { return JSON.parse(await readFile(path.join(this.folder(runId), "state.json"), "utf8")); }
    async spec(runId: string): Promise<Spec> { return JSON.parse(await readFile(path.join(this.folder(runId), "snapshot.json"), "utf8")); }
    async save(state: WorkflowState) {
        const file = path.join(this.folder(state.runId), "state.json");
        await writeFile(file + ".tmp", JSON.stringify(state), { mode: 0o600 });
        await rename(file + ".tmp", file);
    }
    async create(input: unknown) {
        const spec = workflowSchema.parse(input);
        const folder = this.folder(spec.runId);
        if (await exists(path.join(folder, "state.json"))) return this.state(spec.runId);
        await credentials();
        await exec(process.env.FFMPEG_PATH || "ffmpeg", ["-version"]);
        if (spec.postProcess.autoSubtitles) await checkTranscriber();
        await mkdir(this.root, { recursive: true, mode: 0o700 });
        // Exclusive directory creation also guards concurrent create requests.
        await mkdir(folder, { mode: 0o700 });
        await writeFile(path.join(folder, "snapshot.json"), JSON.stringify(spec), { mode: 0o600, flag: "wx" });
        const state: WorkflowState = { runId: spec.runId, title: spec.title, status: "ready", shots: spec.shots.map((s, i) => ({ nodeId: s.nodeId, title: s.title, status: spec.existingTaskIds ? "running" : "pending", ...(spec.existingTaskIds ? { taskId: spec.existingTaskIds[i] } : {}) })) };
        await this.save(state);
        this.start(spec.runId);
        return state;
    }
    start(runId: string) {
        if (this.active.has(runId)) return;
        const work = this.run(runId).catch(async () => {
            const state = await this.state(runId);
            state.status = "paused"; state.error = "本地执行中断，请继续查询已有任务。";
            await this.save(state);
        }).finally(() => this.active.delete(runId));
        this.active.set(runId, work);
    }
    async subtitles(runId: string) {
        const folder = this.folder(runId);
        const approved = path.join(folder, "subtitles-approved.json");
        return JSON.parse(await readFile(await exists(approved) ? approved : path.join(folder, "subtitles-draft.json"), "utf8"));
    }
    async transcribe(folder: string) {
        await checkTranscriber();
        await exec(process.env.WORKFLOW_PYTHON!, [fileURLToPath(new URL("../../scripts/transcribe_workflow.py", import.meta.url)), folder]);
    }
    async approveSubtitles(runId: string, input: unknown) {
        if (this.active.has(runId)) throw new Error("工作流执行中，请等待字幕校对阶段");
        const spec = await this.spec(runId), state = await this.state(runId);
        if (!spec.postProcess.autoSubtitles || !state.shots.every((shot) => shot.status === "succeeded")) throw new Error("请先完成原片生成与下载");
        const cues = validateSubtitleCues(input, spec.shots.map((shot) => shot.duration));
        const previous = await this.subtitles(runId);
        const approved = path.join(this.folder(runId), "subtitles-approved.json");
        await writeFile(approved + ".tmp", JSON.stringify({ cues, revision: (previous.revision || 0) + 1, reviewed: true }), { mode: 0o600 });
        await rename(approved + ".tmp", approved);
        return this.resume(runId);
    }
    async resume(runId: string, retryNodeId?: string, taskId?: string) {
        if (this.active.has(runId)) return this.state(runId);
        const state = await this.state(runId);
        if (retryNodeId) {
            const shot = state.shots.find((s) => s.nodeId === retryNodeId);
            if (!shot) throw new Error("镜头不存在");
            if (taskId) {
                if (!["uncertain", "submitting"].includes(shot.status) || !/^cgt-[\w-]+$/.test(taskId)) throw new Error("只能为提交结果不明的镜头补充任务 ID");
                shot.taskId = taskId; shot.status = "running";
            } else {
                if (shot.status !== "failed") throw new Error("只能重新生成已明确失败的镜头");
                shot.status = "pending"; delete shot.taskId;
            }
            delete shot.error;
        }
        state.status = "ready"; delete state.error;
        await this.save(state); this.start(runId); return state;
    }
    async run(runId: string) {
        const spec = await this.spec(runId), state = await this.state(runId), folder = this.folder(runId);
        const key = await credentials();
        const api = async (method: string, suffix: string, body?: unknown) => {
            const response = await this.fetcher(API + suffix, { method, signal: AbortSignal.timeout(120_000), headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
            if (!response.ok) throw Object.assign(new Error(`方舟请求失败（HTTP ${response.status}）`), { status: response.status });
            return response.json();
        };
        state.status = "running"; delete state.error;
        state.shots.forEach((s) => { if (s.status === "submitting" && !s.taskId) { s.status = "uncertain"; s.error = "提交结果不明，请在方舟控制台查找并补充任务 ID，避免重复计费。"; } });
        await this.save(state);
        while (true) {
            let pending = false;
            for (let i = 0; i < spec.shots.length; i++) {
                const shot = state.shots[i], input = spec.shots[i];
                if (["succeeded", "failed", "uncertain"].includes(shot.status)) continue;
                if (!shot.taskId) {
                    shot.status = "submitting"; await this.save(state);
                    try {
                        const content: unknown[] = [{ type: "text", text: input.prompt }];
                        input.images.forEach((url, index) => content.push({ type: "image_url", image_url: { url }, role: input.mode === "reference" ? "reference_image" : index === 0 ? "first_frame" : "last_frame" }));
                        if (input.mode === "frames" && input.images.length > 2) throw new Error("首尾帧模式只接受最多两张参考图");
                        const result = await api("POST", "/contents/generations/tasks", { model: input.model, content, duration: input.duration, resolution: input.resolution, ratio: input.ratio, generate_audio: input.generateAudio, watermark: false });
                        if (!/^cgt-[\w-]+$/.test(result.id || "")) throw new Error("任务 ID 缺失");
                        shot.taskId = result.id; shot.status = "running";
                        await this.save(state);
                    } catch (error) {
                        const status = (error as { status?: number }).status;
                        const rejected = status && status >= 400 && status < 500 && status !== 408;
                        shot.status = rejected ? "failed" : "uncertain";
                        shot.error = rejected ? `方舟拒绝请求（HTTP ${status}），请检查账号权限和模型参数。` : "未确认提交结果，请核对方舟任务 ID；不会自动再次提交。";
                        await this.save(state); continue;
                    }
                }
                try {
                    const task = await api("GET", `/contents/generations/tasks/${shot.taskId}`);
                    if (task.status === "succeeded") {
                        const file = `shot-${i}.mp4`;
                        if (!(await exists(path.join(folder, file)))) {
                            const url = new URL(task.content.video_url);
                            if (url.protocol !== "https:") throw new Error("视频下载地址无效");
                            const response = await this.fetcher(url, { signal: AbortSignal.timeout(300_000) });
                            if (!response.ok) throw new Error("视频下载失败");
                            await writeFile(path.join(folder, file + ".part"), Buffer.from(await response.arrayBuffer()), { mode: 0o600 });
                            await rename(path.join(folder, file + ".part"), path.join(folder, file));
                        }
                        shot.status = "succeeded"; shot.file = file; delete shot.error;
                    } else if (["failed", "expired", "cancelled"].includes(task.status)) {
                        shot.status = "failed"; shot.error = `方舟任务 ${task.status}，可单独重新生成此段。`;
                    } else {
                        shot.status = "running"; pending = true;
                    }
                    await this.save(state);
                } catch {
                    state.status = "paused"; state.error = "查询或下载中断，任务 ID 已保存；点击继续，不会重复提交。";
                    await this.save(state); return;
                }
            }
            if (!pending) break;
            await delay();
        }
        if (!state.shots.every((s) => s.status === "succeeded")) {
            state.status = "paused"; await this.save(state); return;
        }
        let finalFile = "final.mp4";
        if (spec.postProcess.autoSubtitles) {
            if (!(await exists(path.join(folder, "subtitles-draft.json")))) {
                state.status = "transcribing"; await this.save(state);
                await this.transcribe(folder);
            }
            if (!(await exists(path.join(folder, "subtitles-approved.json")))) {
                state.status = "awaiting_review"; await this.save(state); return;
            }
            const approved = await this.subtitles(runId);
            finalFile = `final-${approved.revision}.mp4`;
        }
        state.status = "composing"; await this.save(state);
        try {
            await this.composer(folder, spec, finalFile);
            state.final = finalFile; state.outputs = [...new Set([...(state.outputs || []), finalFile])]; state.status = "succeeded";
        } catch {
            state.status = "paused"; state.error = "本地合成失败，请检查 FFmpeg 与字体配置后继续。已完成的原片会复用。";
        }
        await this.save(state);
    }
}

async function credentials() {
    let key = process.env.ARK_API_KEY?.trim();
    if (!key && process.env.ARK_API_KEY_FILE) {
        const text = await readFile(process.env.ARK_API_KEY_FILE, "utf8");
        key = text.split(/\r?\n/).find((line) => line.startsWith("ARK_API_KEY="))?.slice(12).trim();
    }
    if (!key) throw new Error("请在本地 Agent 配置 ARK_API_KEY 或 ARK_API_KEY_FILE");
    return key;
}

async function checkTranscriber() {
    if (!process.env.WORKFLOW_PYTHON || !process.env.WORKFLOW_WHISPER_MODEL) throw new Error("请配置本地字幕识别 Python 和模型路径");
    await access(process.env.WORKFLOW_WHISPER_MODEL);
    await exec(process.env.WORKFLOW_PYTHON, ["-c", "import faster_whisper"]);
}

function srtTime(seconds: number) { return new Date(seconds * 1000).toISOString().slice(11, 23).replace(".", ","); }
async function compose(folder: string, spec: Spec, finalFile = "final.mp4") {
    const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
    const run = (args: string[]) => exec(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", ...args], { cwd: folder });
    const [width, height] = spec.shots[0].ratio === "9:16" ? [1080, 1920] : [1920, 1080];
    if (process.env.WORKFLOW_FONT_FILE) await copyFile(process.env.WORKFLOW_FONT_FILE, path.join(folder, "subtitle-font.ttf"));
    if (spec.postProcess.logo) await writeFile(path.join(folder, "logo.png"), Buffer.from(spec.postProcess.logo.split(",")[1], "base64"));
    const cues: SubtitleCue[] = spec.postProcess.autoSubtitles ? validateSubtitleCues(JSON.parse(await readFile(path.join(folder, "subtitles-approved.json"), "utf8")).cues, spec.shots.map((shot) => shot.duration)) : [];
    for (let i = 0; i < spec.shots.length; i++) {
        const shot = spec.shots[i];
        let audio = false;
        try { await exec(ffmpeg, ["-hide_banner", "-i", `shot-${i}.mp4`], { cwd: folder }); }
        catch (error) { audio = /Audio:/.test(String((error as { stderr?: string }).stderr)); }
        const shotCues = spec.postProcess.autoSubtitles ? cues.filter((cue) => cue.shot === i) : spec.postProcess.subtitles[i]?.trim() ? [{ start: 0, end: shot.duration, text: spec.postProcess.subtitles[i].trim() }] : [];
        const caption = shotCues.length > 0;
        if (caption) await writeFile(path.join(folder, `caption-${i}.srt`), shotCues.map((cue, index) => `${index + 1}\n${srtTime(cue.start)} --> ${srtTime(cue.end)}\n${cue.text.replace(/[\r\n]+/g, " ")}\n`).join("\n"));
        let filter = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=25`;
        if (caption) filter += `,subtitles=caption-${i}.srt:fontsdir=.:force_style='Fontsize=20,MarginV=30,Outline=1'`;
        const args = ["-i", `shot-${i}.mp4`, "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo"];
        const logo = Boolean(spec.postProcess.logo) && i === spec.shots.length - 1;
        if (logo) args.push("-loop", "1", "-i", "logo.png");
        const graph = logo ? `[0:v]${filter}[base];[2:v]scale=${Math.round(width / 4)}:-1[logo];[base][logo]overlay=(W-w)/2:H-h-180:enable='gte(t,${Math.max(0, shot.duration - 4)})'[out]` : `[0:v]${filter}[out]`;
        args.push("-filter_complex", graph, "-map", "[out]", "-map", audio ? "0:a:0" : "1:a:0", "-t", String(shot.duration), "-af", `afade=t=in:d=0.25,afade=t=out:st=${shot.duration - 0.35}:d=0.35`, "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ar", "48000", "-ac", "2", `part-${i}.mp4`);
        await run(args);
    }
    await writeFile(path.join(folder, "clips.txt"), spec.shots.map((_, i) => `file 'part-${i}.mp4'`).join("\n"));
    await run(["-f", "concat", "-safe", "0", "-i", "clips.txt", "-c", "copy", "-movflags", "+faststart", "final.part.mp4"]);
    await run(["-i", "final.part.mp4", "-f", "null", "-"]);
    await rename(path.join(folder, "final.part.mp4"), path.join(folder, finalFile));
}

export function seedanceWorkflowRouter(workflows = new SeedanceWorkflows()) {
    const router = Router();
    router.get("/config", async (_req, res) => {
        let keyReady = false, ffmpegReady = false, subtitlesReady = false;
        try { await credentials(); keyReady = true; } catch { /* no secret returned */ }
        try { await exec(process.env.FFMPEG_PATH || "ffmpeg", ["-version"]); ffmpegReady = true; } catch { /* optional local dependency */ }
        try { await checkTranscriber(); subtitlesReady = true; } catch { /* Optional local recognition. */ }
        res.json({ ok: true, keyReady, ffmpegReady, subtitlesReady });
    });
    router.post("/runs", async (req, res, next) => { try { res.json({ ok: true, data: await workflows.create(req.body) }); } catch (e) { next(e); } });
    router.get("/runs", async (_req, res, next) => {
        try {
            const entries = await readdir(workflows.root).catch(() => []);
            const states = await Promise.all(entries.filter((name) => id.safeParse(name).success).map((name) => workflows.state(name).catch(() => null)));
            res.json({ ok: true, data: states.filter(Boolean) });
        } catch (e) { next(e); }
    });
    router.get("/runs/:id/snapshot", async (req, res, next) => { try { res.json({ ok: true, data: await workflows.spec(String(req.params.id)) }); } catch (e) { next(e); } });
    router.get("/runs/:id/subtitles", async (req, res, next) => { try { res.json({ ok: true, data: await workflows.subtitles(String(req.params.id)) }); } catch (e) { next(e); } });
    router.post("/runs/:id/subtitles", async (req, res, next) => { try { res.json({ ok: true, data: await workflows.approveSubtitles(String(req.params.id), req.body?.cues) }); } catch (e) { next(e); } });
    router.get("/runs/:id", async (req, res, next) => { try { res.json({ ok: true, data: await workflows.state(String(req.params.id)) }); } catch (e) { next(e); } });
    router.post("/runs/:id/resume", async (req, res, next) => { try { res.json({ ok: true, data: await workflows.resume(String(req.params.id), req.body?.nodeId, req.body?.taskId) }); } catch (e) { next(e); } });
    router.get("/runs/:id/files/:file", async (req, res, next) => {
        try {
            const file = String(req.params.file);
            if (!/^(final(?:-\d+)?|shot-\d+)\.mp4$/.test(file)) return void res.sendStatus(404);
            const state = await workflows.state(String(req.params.id));
            if (file !== state.final && !state.outputs?.includes(file) && !state.shots.some((s) => s.file === file)) return void res.sendStatus(404);
            res.sendFile(path.join(workflows.folder(state.runId), file), { dotfiles: "allow" });
        } catch (e) { next(e); }
    });
    return router;
}
