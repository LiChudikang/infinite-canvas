import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAgentStore } from "@/stores/use-agent-store";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { localForageStorage } from "@/lib/localforage-storage";
import { workflowRequest, type LocalVideoRun } from "@/services/api/seedance-workflow";
import { uploadImage } from "@/services/image-storage";
import type { CanvasConnection, CanvasNodeData } from "@/types/canvas";

type SavedSpec = { title: string; postProcess: { subtitles: string[]; logo?: string }; shots: { nodeId: string; title: string; prompt: string; model: string; duration: number; resolution: string; ratio: string; mode: string; generateAudio: boolean; images: string[] }[] };
export function LocalWorkflowRuns() {
    const connected = useAgentStore((s) => s.connected), navigate = useNavigate();
    const [runs, setRuns] = useState<LocalVideoRun[]>([]), [error, setError] = useState(""), [busy, setBusy] = useState(false);
    const refresh = () => workflowRequest<{ data: LocalVideoRun[] }>("/runs").then((r) => { setRuns(r.data); setError(""); }).catch((e) => setError(e.message));
    useEffect(() => { if (connected) void refresh(); }, [connected]);
    const restore = async (run: LocalVideoRun) => {
        setBusy(true); setError("");
        try {
            const savedId = await localForageStorage.getItem(`infinite-canvas:workflow-project:${run.runId}`);
            if (savedId && useCanvasStore.getState().openProject(savedId)) { navigate(`/canvas/${savedId}`); return; }
            const { data: spec } = await workflowRequest<{ data: SavedSpec }>(`/runs/${run.runId}/snapshot`);
            const nodes: CanvasNodeData[] = [], connections: CanvasConnection[] = [];
            for (let i = 0; i < spec.shots.length; i++) {
                const shot = spec.shots[i];
                nodes.push({ id: shot.nodeId, type: "config", title: shot.title, position: { x: 40 + i * 560, y: 380 }, width: 340, height: 240, metadata: { generationMode: "video", model: shot.model, composerContent: shot.prompt, seconds: String(shot.duration), size: shot.ratio === "9:16" ? "1080x1920" : "1920x1080", vquality: shot.resolution.replace("p", ""), videoMode: shot.mode, generateAudio: String(shot.generateAudio), count: 1 } });
                for (let j = 0; j < shot.images.length; j++) {
                    const image = await uploadImage(shot.images[j]);
                    const id = `${shot.nodeId}-ref-${j}`;
                    const scale = Math.min(200 / image.width, 280 / image.height);
                    nodes.push({ id, type: "image", title: `${shot.title} · 参考 ${j + 1}`, position: { x: 40 + i * 560 + j * 220, y: 40 }, width: image.width * scale, height: image.height * scale, metadata: { content: image.url, storageKey: image.storageKey, status: "success", naturalWidth: image.width, naturalHeight: image.height } });
                    connections.push({ id: `edge-${id}`, fromNodeId: id, toNodeId: shot.nodeId });
                }
            }
            const projectId = useCanvasStore.getState().importProject({ title: spec.title, nodes, connections, viewport: { x: 20, y: 40, k: 0.6 } });
            await localForageStorage.setItem(`infinite-canvas:seedance-run:${projectId}`, run.runId);
            await localForageStorage.setItem(`infinite-canvas:workflow-post:${projectId}`, JSON.stringify(spec.postProcess));
            await localForageStorage.setItem(`infinite-canvas:workflow-project:${run.runId}`, projectId);
            navigate(`/canvas/${projectId}`);
        } catch (e) { setError(e instanceof Error ? e.message : "恢复失败"); } finally { setBusy(false); }
    };
    return <section className="space-y-3">
        <div className="flex items-center justify-between"><h2 className="text-lg font-semibold">本机视频工作流</h2><button className="text-sm hover:underline disabled:opacity-40" disabled={!connected || busy} onClick={() => void refresh()}>刷新</button></div>
        {!connected && <p className="text-sm opacity-60">连接本地 Agent 后，可找回已生成的视频与运行快照。</p>}
        {runs.map((run) => <div key={run.runId} className="flex items-center justify-between gap-4 border-b border-current/15 py-3"><div><p>{run.title}</p><p className="text-xs opacity-60">{run.shots.filter((s) => s.status === "succeeded").length}/{run.shots.length} 段完成 · {run.final ? "成片已就绪" : "可继续执行"}</p></div><button disabled={busy} className="shrink-0 text-sm hover:underline disabled:opacity-40" onClick={() => void restore(run)}>打开工作流画布</button></div>)}
        {error && <p role="alert" className="text-xs">{error}</p>}
    </section>;
}
