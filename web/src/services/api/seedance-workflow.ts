import { useAgentStore } from "@/stores/use-agent-store";
import { getImageBlob } from "@/services/image-storage";
import type { CanvasConnection, CanvasNodeData } from "@/types/canvas";
import { inferVideoRatio, parseVideoResolution } from "@/lib/media-size";

export type LocalVideoRun = {
    runId: string; title: string; status: string; final?: string; error?: string;
    shots: { nodeId: string; title: string; status: string; taskId?: string; file?: string; error?: string }[];
};
export async function workflowRequest<T>(route: string, body?: unknown): Promise<T> {
    const { url, token } = useAgentStore.getState();
    if (!token) throw new Error("请先连接本地 Agent");
    const response = await fetch(`${url.replace(/\/$/, "")}/workflows/seedance${route}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { "x-canvas-agent-token": token, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `工作流请求失败（${response.status}）`);
    return data;
}
export async function workflowVideo(runId: string, file: string) {
    const { url, token } = useAgentStore.getState();
    const response = await fetch(`${url.replace(/\/$/, "")}/workflows/seedance/runs/${encodeURIComponent(runId)}/files/${encodeURIComponent(file)}`, { headers: { "x-canvas-agent-token": token } });
    if (!response.ok) throw new Error("视频下载失败，请继续查询后重试");
    return response.blob();
}
export function dataUrl(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsDataURL(blob);
    });
}
export function videoConfigs(nodes: CanvasNodeData[]) {
    return nodes.filter((n) => n.type === "config" && n.metadata?.generationMode === "video").sort((a, b) => a.position.x - b.position.x || a.position.y - b.position.y);
}
export async function workflowShots(nodes: CanvasNodeData[], edges: CanvasConnection[]) {
    return Promise.all(videoConfigs(nodes).map(async (node) => {
        const visited = new Set<string>(), inputs: CanvasNodeData[] = [];
        const visit = (nodeId: string) => {
            if (visited.has(nodeId)) return; visited.add(nodeId);
            const item = nodes.find((n) => n.id === nodeId);
            if (!item || item.type === "config") return;
            if (item.type === "group") nodes.filter((n) => n.metadata?.groupId === nodeId).forEach((n) => visit(n.id));
            else if (item.type === "image" || item.type === "text") inputs.push(item);
        };
        edges.filter((e) => e.toNodeId === node.id).forEach((e) => visit(e.fromNodeId));
        (node.metadata?.references || []).forEach(visit);
        const images = await Promise.all(inputs.filter((n) => n.type === "image").map(async (n) => {
            const blob = n.metadata?.storageKey ? await getImageBlob(n.metadata.storageKey) : null;
            if (blob) return dataUrl(blob);
            if (n.metadata?.content?.startsWith("data:image/")) return n.metadata.content;
            throw new Error(`请重新上传参考图：${n.title}`);
        }));
        const model = (node.metadata?.model || "").split("::").pop() || "";
        if (!model.startsWith("doubao-seedance-")) throw new Error(`${node.title} 请选择 Seedance 模型`);
        const ratio = inferVideoRatio(node.metadata?.size || "1920x1080");
        if (!["16:9", "9:16"].includes(ratio)) throw new Error("完整视频工作流目前支持横版 16:9 和竖版 9:16");
        const prompt = [...inputs.filter((n) => n.type === "text").map((n) => n.metadata?.content || n.metadata?.prompt || ""), node.metadata?.composerContent || node.metadata?.prompt || ""].filter(Boolean).join("\n\n");
        if (!prompt.trim()) throw new Error(`${node.title} 缺少提示词`);
        const mode = node.metadata?.videoMode === "reference" ? "reference" : "frames";
        if (mode === "frames" && images.length > 2) throw new Error(`${node.title} 有多张参考图，请选择全能参考模式`);
        return { nodeId: node.id, title: node.title, model, prompt, images, duration: Number(node.metadata?.seconds || "15"), resolution: `${parseVideoResolution(node.metadata?.vquality)}p`, ratio, mode, generateAudio: node.metadata?.generateAudio !== "false" };
    }));
}
