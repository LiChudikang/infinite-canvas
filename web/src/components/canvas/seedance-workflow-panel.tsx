import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { nanoid } from "nanoid";
import { Play, RotateCcw, Download } from "lucide-react";
import { localForageStorage } from "@/lib/localforage-storage";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { useAgentStore } from "@/stores/use-agent-store";
import { getMediaBlob, setMediaBlob } from "@/services/file-storage";
import { dataUrl, videoConfigs, workflowRequest, workflowShots, workflowVideo, type LocalVideoRun } from "@/services/api/seedance-workflow";
import type { CanvasConnection, CanvasNodeData } from "@/types/canvas";
import type { WorkflowTemplateInstance } from "@/types/workflow-template";

const labels: Record<string, string> = { pending: "等待提交", submitting: "正在提交", running: "生成中", succeeded: "已完成", failed: "生成失败", uncertain: "待核对任务 ID", paused: "已暂停", composing: "合成中", ready: "已准备" };
labels.transcribing = "识别原声字幕"; labels.awaiting_review = "等待字幕校对";
type Cue = { shot: number; start: number; end: number; text: string };
export function SeedanceWorkflowPanel({ projectId, title, nodes, connections, setNodes, setConnections, instance }: {
    projectId: string; title: string; nodes: CanvasNodeData[]; connections: CanvasConnection[];
    setNodes: Dispatch<SetStateAction<CanvasNodeData[]>>; setConnections: Dispatch<SetStateAction<CanvasConnection[]>>; instance?: WorkflowTemplateInstance;
}) {
    const theme = canvasThemes[useThemeStore((s) => s.theme)];
    const connected = useAgentStore((s) => s.connected);
    const [runId, setRunId] = useState("");
    const [run, setRun] = useState<LocalVideoRun>();
    const [ready, setReady] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
    const [captions, setCaptions] = useState(instance?.snapshot.postProcess.subtitles?.join("\n") || "");
    const [logo, setLogo] = useState<string | undefined>(instance?.snapshot.postProcess.logo);
    const [autoSubtitles, setAutoSubtitles] = useState(instance?.snapshot.postProcess.autoSubtitles || false);
    const [cues, setCues] = useState<Cue[] | null>(null);
    const [existingIds, setExistingIds] = useState("");
    const [taskIds, setTaskIds] = useState<Record<string, string>>({});
    const nodesRef = useRef(nodes); nodesRef.current = nodes;
    const mounted = useRef(true);
    useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
    const imported = useRef(new Set<string>());
    const storageKey = `infinite-canvas:seedance-run:${projectId}`;
    const configs = videoConfigs(nodes);
    const linkedRunId = configs.find((node) => node.metadata?.workflowRunId)?.metadata?.workflowRunId;
    useEffect(() => {
        if (ready && linkedRunId && !runId) { setRunId(linkedRunId); void localForageStorage.setItem(storageKey, linkedRunId); }
    }, [ready, linkedRunId, runId, storageKey]);
    useEffect(() => {
        let cancelled = false;
        void Promise.all([localForageStorage.getItem(storageKey), localForageStorage.getItem(`infinite-canvas:workflow-post:${projectId}`)]).then(([value, settings]) => { if (!cancelled) { setRunId(value || ""); if (settings) { const post = JSON.parse(settings); setCaptions(post.subtitles?.join("\n") || ""); setLogo(post.logo); setAutoSubtitles(Boolean(post.autoSubtitles)); } setReady(true); } });
        return () => { cancelled = true; };
    }, [storageKey]);
    useEffect(() => {
        if (ready) void localForageStorage.setItem(`infinite-canvas:workflow-post:${projectId}`, JSON.stringify({ subtitles: captions ? captions.split("\n") : [], logo, autoSubtitles }));
    }, [ready, projectId, captions, logo, autoSubtitles]);
    useEffect(() => {
        if (!runId || run?.status !== "awaiting_review") return;
        let cancelled = false;
        void workflowRequest<{ data: { cues: Cue[] } }>(`/runs/${runId}/subtitles`).then(({ data }) => { if (!cancelled) setCues(data.cues); }).catch((e) => { if (!cancelled) setError(e.message); });
        return () => { cancelled = true; };
    }, [runId, run?.status]);

    const sync = async (state: LocalVideoRun) => {
        setRun(state);
        const files = [...state.shots.filter((s) => s.file).map((s, i) => ({ file: s.file!, title: s.title, source: s.nodeId, index: i })), ...(state.final ? [{ file: state.final, title: "完整视频", source: "", index: state.shots.length }] : [])];
        for (const item of files) {
            const id = `workflow-${state.runId}-${item.file.replace(".", "-")}`;
            if (nodesRef.current.some((n) => n.id === id) || imported.current.has(id)) continue;
            const key = `workflow:${state.runId}:${item.file}`;
            const blob = await getMediaBlob(key) || await workflowVideo(state.runId, item.file);
            const url = await setMediaBlob(key, blob);
            if (!mounted.current) return;
            const source = nodesRef.current.find((n) => n.id === item.source);
            const vertical = (source || videoConfigs(nodesRef.current)[0])?.metadata?.size === "1080x1920";
            const video: CanvasNodeData = { id, type: "video", title: item.title, position: { x: source?.position.x ?? 40, y: (source?.position.y ?? 400) + 360 + (item.source ? 0 : 360) }, width: vertical ? 270 : 480, height: vertical ? 480 : 270, metadata: { content: url, storageKey: key, mimeType: "video/mp4", bytes: blob.size, status: "success", naturalWidth: vertical ? 1080 : 1920, naturalHeight: vertical ? 1920 : 1080 } };
            imported.current.add(id);
            setNodes((current) => current.some((n) => n.id === id) ? current : [...current, video]);
            if (item.source) setConnections((current) => current.some((e) => e.toNodeId === id) ? current : [...current, { id: `edge-${id}`, fromNodeId: item.source, toNodeId: id }]);
            else setConnections((current) => [...current, ...state.shots.filter((s) => s.file).map((s) => ({ id: `final-${state.runId}-${s.nodeId}`, fromNodeId: `workflow-${state.runId}-${s.file!.replace(".", "-")}`, toNodeId: id })).filter((e) => !current.some((c) => c.id === e.id))]);
        }
    };
    useEffect(() => {
        if (!runId || !connected) return;
        let cancelled = false, timer: ReturnType<typeof setTimeout>;
        void workflowRequest<{ data: { postProcess: { subtitles: string[]; logo?: string; autoSubtitles?: boolean } } }>(`/runs/${runId}/snapshot`).then(({ data }) => {
            if (!cancelled) { setCaptions(data.postProcess.subtitles.join("\n")); setLogo(data.postProcess.logo); setAutoSubtitles(Boolean(data.postProcess.autoSubtitles)); }
        }).catch(() => { /* A create request may still be saving the snapshot. */ });
        const refresh = async () => {
            try {
                const response = await workflowRequest<{ data: LocalVideoRun }>(`/runs/${runId}`);
                if (!cancelled) { await sync(response.data); setError(""); }
            } catch (e) { if (!cancelled) setError(e instanceof Error ? e.message : "查询失败"); }
            if (!cancelled) timer = setTimeout(refresh, 20_000);
        };
        void refresh();
        return () => { cancelled = true; clearTimeout(timer); };
    }, [runId, connected]);

    const execute = async (action: () => Promise<void>) => {
        setBusy(true); setError("");
        try { await action(); } catch (e) { setError(e instanceof Error ? e.message : "操作失败"); } finally { setBusy(false); }
    };
    const start = () => execute(async () => {
        const configuration = await workflowRequest<{ keyReady: boolean; ffmpegReady: boolean; subtitlesReady: boolean }>("/config");
        if (!configuration.keyReady || !configuration.ffmpegReady) throw new Error("请在本地 Agent 配置火山方舟密钥和 FFmpeg；密钥无需填入网页。");
        if (autoSubtitles && !configuration.subtitlesReady) throw new Error("请配置本地字幕识别环境和模型，尚未提交生成任务。");
        const shots = await workflowShots(nodes, connections);
        const id = runId || nanoid();
        // Persist before sending a paid request. A lost response reuses this run ID.
        await localForageStorage.setItem(storageKey, id); setRunId(id);
        const existingTaskIds = existingIds.trim() ? existingIds.trim().split(/\s+/) : undefined;
        const result = await workflowRequest<{ data: LocalVideoRun }>("/runs", { runId: id, title, shots, snapshot: { projectId, nodes, edges: connections, templateInstance: instance }, postProcess: { subtitles: captions ? captions.split("\n") : [], autoSubtitles, ...(logo ? { logo } : {}) }, ...(existingTaskIds ? { existingTaskIds } : {}) });
        await sync(result.data);
    });
    const resume = (nodeId?: string, taskId?: string) => execute(async () => { const result = await workflowRequest<{ data: LocalVideoRun }>(`/runs/${runId}/resume`, { nodeId, taskId }); await sync(result.data); });
    const download = () => execute(async () => {
        if (!run?.final) return;
        const blob = await workflowVideo(runId, run.final), url = URL.createObjectURL(blob);
        const a = document.createElement("a"); a.href = url; a.download = `${title}.mp4`; a.click(); URL.revokeObjectURL(url);
    });
    if (!configs.length && !runId) return null;
    const button = "inline-flex items-center gap-1.5 px-2 py-1.5 text-sm hover:bg-black/5 dark:hover:bg-white/10 disabled:opacity-40";
    return <details className="absolute right-4 top-16 z-40 max-h-[75vh] w-80 overflow-auto p-3" style={{ background: theme.canvas.background, color: theme.node.text }}>
        <summary className="cursor-pointer text-sm">完整视频工作流 {run ? `· ${labels[run.status] || run.status}` : ""}</summary>
        <div className="mt-3 space-y-3 text-sm">
            <p>按画布从左到右生成 {configs.length} 段，每节点 1 次调用，完成后自动拼接。费用以方舟账单为准。</p>
            {!run && <>
                <label className="flex items-start gap-2"><input type="checkbox" checked={autoSubtitles} onChange={(e) => setAutoSubtitles(e.target.checked)} />识别原声逐句字幕（本机识别，完成后暂停校对）</label>
                {!autoSubtitles && <label className="block">字幕（每行对应一段，可留空）<textarea className="mt-1 w-full border border-current/20 bg-transparent p-2" rows={3} value={captions} onChange={(e) => setCaptions(e.target.value)} /></label>}
                <label className="block">片尾 Logo（可选）<input className="mt-1 w-full text-xs" type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => { const file = e.target.files?.[0]; if (file) void execute(async () => setLogo(await dataUrl(file))); }} /></label>
                <p className="text-xs opacity-70">参考图请连接到对应视频配置节点。密钥只由本地 Agent 读取。</p>
                <details><summary className="cursor-pointer text-xs">接回已经生成的方舟任务</summary><textarea className="mt-1 w-full border border-current/20 bg-transparent p-2" rows={3} placeholder="每行一个任务 ID，按镜头顺序。只查询、下载与合成，不创建新任务。" value={existingIds} onChange={(e) => setExistingIds(e.target.value)} /></details>
                <button className={button} disabled={!ready || busy || !connected} onClick={() => void start()}><Play size={15} />{existingIds.trim() ? "接回已有视频并合成" : "生成完整视频"}</button>
            </>}
            {!connected && <p>请先连接本地 Agent。</p>}
            {run?.shots.map((shot) => <div key={shot.nodeId} className="border-t border-current/15 pt-2">
                <div>{shot.title} · {labels[shot.status] || shot.status}</div>
                {shot.taskId && <div className="break-all text-xs opacity-60">{shot.taskId}</div>}
                {shot.error && <p className="mt-1 text-xs">{shot.error}</p>}
                {shot.status === "failed" && <button disabled={busy} className={button} onClick={() => void resume(shot.nodeId)}>重新生成此段（1 次调用）</button>}
                {["uncertain", "submitting"].includes(shot.status) && <div><input placeholder="粘贴控制台已有任务 ID" className="my-1 w-full border border-current/20 bg-transparent p-1" value={taskIds[shot.nodeId] || ""} onChange={(e) => setTaskIds((s) => ({ ...s, [shot.nodeId]: e.target.value }))} /><button disabled={busy || !taskIds[shot.nodeId]} className={button} onClick={() => void resume(shot.nodeId, taskIds[shot.nodeId])}>绑定任务并继续</button></div>}
            </div>)}
            {runId && <button className={button} disabled={busy || !connected} onClick={() => void resume()}><RotateCcw size={15} />继续查询 / 合成</button>}
            {(run?.status === "awaiting_review" || (run?.final && cues !== null)) && <section className="space-y-2 border-t border-current/15 pt-2">
                <p>请播放原片核对。字幕为识别草稿，只纠正识别错误，不用字幕补写模型漏念的内容。时间为各段内的秒数。</p>
                {cues?.map((cue, i) => <div key={i} className="space-y-1"><div className="flex items-center gap-1 text-xs">第 {cue.shot + 1} 段<input aria-label={`字幕${i + 1}开始秒`} className="w-16 border border-current/20 bg-transparent" type="number" step="0.01" value={cue.start} onChange={(e) => setCues((current) => current!.map((c, j) => j === i ? { ...c, start: Number(e.target.value) } : c))} />至<input aria-label={`字幕${i + 1}结束秒`} className="w-16 border border-current/20 bg-transparent" type="number" step="0.01" value={cue.end} onChange={(e) => setCues((current) => current!.map((c, j) => j === i ? { ...c, end: Number(e.target.value) } : c))} /></div><textarea aria-label={`字幕${i + 1}文字`} className="w-full border border-current/20 bg-transparent p-1" value={cue.text} onChange={(e) => setCues((current) => current!.map((c, j) => j === i ? { ...c, text: e.target.value } : c))} /></div>)}
                {cues?.length === 0 && <p>未识别出语音，请检查原片。可以确认无字幕导出。</p>}
                <button className={button} disabled={busy || !connected || cues === null} onClick={() => void execute(async () => { const result = await workflowRequest<{ data: LocalVideoRun }>(`/runs/${runId}/subtitles`, { cues }); setCues(null); await sync(result.data); })}>已校对，烧录字幕并合成（不重新生成）</button>
            </section>}
            {run?.final && autoSubtitles && <button className={button} disabled={busy || !connected} onClick={() => void execute(async () => { const result = await workflowRequest<{ data: { cues: Cue[] } }>(`/runs/${runId}/subtitles`); setCues(result.data.cues); })}>重新校对字幕（保留已有成片）</button>}
            {run?.final && <><button className={button} disabled={busy} onClick={() => void download()}><Download size={15} />下载完整视频</button><button className={button} disabled={busy} onClick={() => void execute(async () => { await localForageStorage.removeItem(storageKey); setNodes((current) => current.map((node) => node.metadata?.workflowRunId ? { ...node, metadata: { ...node.metadata, workflowRunId: undefined } } : node)); setRunId(""); setRun(undefined); setCues(null); })}>再做一个</button></>}
            {(error || run?.error) && <p role="alert" className="break-words text-xs">{error || run?.error}</p>}
        </div>
    </details>;
}
