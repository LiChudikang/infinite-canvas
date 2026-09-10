import type { WorkflowTemplateVariable } from "@/types/workflow-template";
export type StudioTemplate = { templateId: string; version: number; title: string; description: string; category: string; sampleUrl: string; variables: WorkflowTemplateVariable[]; calls: number; seconds: number; ratios: string[]; resolutions: string[] };
export type StudioMember = { id: string; role: "author" | "user"; channelConfigured: boolean; generationEnabled: boolean };
export type StudioRun = { runId: string; title: string; templateId: string; version: number; createdAt: string; status: string; final?: string; error?: string; shots: { nodeId: string; title: string; status: string; file?: string }[] };
export async function platformRequest<T>(token: string, route: string, body?: unknown, method = "POST"): Promise<T> {
    const response = await fetch(`/api/platform${route}`, { method: body === undefined ? "GET" : method, headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = await response.json().catch(() => { throw new Error("模板服务尚未连接，请联系作者检查服务部署"); });
    if (!response.ok) throw new Error(data.error || "请求失败，请重试");
    return data;
}
export async function downloadStudioFile(token: string, runId: string, file: string) {
    const response = await fetch(`/api/platform/runs/${encodeURIComponent(runId)}/files/${encodeURIComponent(file)}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error("下载失败，请检查访问权限并重试");
    return response.blob();
}
