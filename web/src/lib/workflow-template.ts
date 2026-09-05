import { nanoid } from "nanoid";

import { inferVideoRatio, parseVideoResolution } from "@/lib/media-size";
import { uploadImage } from "@/services/image-storage";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import type { WorkflowTemplate, WorkflowTemplateInstance, WorkflowTemplateMode, WorkflowTemplateVariable } from "@/types/workflow-template";

const PLACEHOLDER = /{{\s*([a-zA-Z][a-zA-Z0-9_-]*)\s*}}/g;
const TEXT_FIELDS = ["content", "prompt", "composerContent"] as const;

export function discoverTextVariables(nodes: CanvasNodeData[]): WorkflowTemplateVariable[] {
    const defaults = new Map<string, string>();
    nodes.forEach((node) => {
        TEXT_FIELDS.forEach((field) => {
            const value = node.metadata?.[field];
            if (typeof value !== "string") return;
            for (const match of value.matchAll(PLACEHOLDER)) defaults.set(match[1], defaults.get(match[1]) || "");
        });
    });
    return [...defaults].map(([key, defaultValue]) => ({ key, label: variableLabel(key), type: "text", required: true, defaultValue }));
}

export function imageNodeVariable(node: CanvasNodeData): WorkflowTemplateVariable {
    const key = uniqueVariableKey(node.title || "image", node.id);
    return { key, label: node.title || "参考图片", type: "image", required: true, nodeId: node.id };
}

export function buildSeedanceSummary(nodes: CanvasNodeData[]) {
    const configs = nodes.filter((node) => node.type === CanvasNodeType.Config && node.metadata?.generationMode === "video");
    return {
        models: unique(configs.map((node) => node.metadata?.model || "").filter(Boolean)),
        durations: unique(configs.map((node) => node.metadata?.seconds || "6")),
        aspectRatios: unique(configs.map((node) => inferVideoRatio(node.metadata?.size || "auto"))),
        resolutions: unique(configs.map((node) => `${parseVideoResolution(node.metadata?.vquality)}p`)),
        estimatedCalls: configs.length,
    };
}

export async function instantiateWorkflowTemplate(template: WorkflowTemplate, values: Record<string, string>, files: Record<string, File | undefined>, mode: WorkflowTemplateMode): Promise<Partial<CanvasProject>> {
    const nodes = clone(template.nodes);
    for (const variable of template.variables) {
        if (variable.type === "image") {
            const file = files[variable.key];
            if (!file || !variable.nodeId) continue;
            const image = await uploadImage(file);
            const index = nodes.findIndex((node) => node.id === variable.nodeId);
            if (index < 0) continue;
            nodes[index] = {
                ...nodes[index],
                metadata: {
                    ...nodes[index].metadata,
                    content: image.url,
                    storageKey: image.storageKey,
                    naturalWidth: image.width,
                    naturalHeight: image.height,
                    bytes: image.bytes,
                    mimeType: image.mimeType,
                    status: "success",
                    errorDetails: undefined,
                },
            };
            continue;
        }
        const value = values[variable.key] ?? variable.defaultValue ?? "";
        nodes.forEach((node, index) => {
            const metadata = { ...node.metadata };
            let changed = false;
            TEXT_FIELDS.forEach((field) => {
                const text = metadata[field];
                if (typeof text !== "string") return;
                const replaced = text.replace(new RegExp(`{{\\s*${escapeRegExp(variable.key)}\\s*}}`, "g"), value);
                if (replaced !== text) {
                    metadata[field] = replaced;
                    changed = true;
                }
            });
            if (changed) nodes[index] = { ...node, metadata };
        });
    }

    const instruction =
        mode === "replicate"
            ? "严格复刻原模板的分镜、运镜、节奏和时长，只替换已填写的主体素材与文字。"
            : "保留原模板的视觉风格和故事结构，允许围绕新素材调整文案、镜头内容和局部运镜。";
    nodes.forEach((node, index) => {
        if (node.type !== CanvasNodeType.Config || node.metadata?.generationMode !== "video") return;
        const composerContent = [node.metadata?.composerContent?.trim(), instruction].filter(Boolean).join("\n\n");
        nodes[index] = { ...node, metadata: { ...node.metadata, composerContent, status: "idle", errorDetails: undefined } };
    });

    const variableValues = Object.fromEntries(template.variables.filter((item) => item.type === "text").map((item) => [item.key, values[item.key] ?? item.defaultValue ?? ""]));
    const instance: WorkflowTemplateInstance = {
        runId: nanoid(),
        mode,
        createdAt: new Date().toISOString(),
        variableValues,
        snapshot: {
            templateId: template.templateId,
            version: template.version,
            title: template.title,
            publishedAt: template.publishedAt,
            variables: clone(template.variables),
            lockedFields: [...template.lockedFields],
            seedanceConfig: clone(template.seedanceConfig),
            postProcess: clone(template.postProcess),
        },
    };

    return {
        title: `${template.title} · ${mode === "replicate" ? "同款" : "相似版"}`,
        nodes,
        connections: clone(template.edges),
        templateInstance: instance,
    };
}

export function templateTotalEstimate(template: WorkflowTemplate) {
    if (template.estimatedUnitCost === undefined) return undefined;
    return template.estimatedUnitCost * template.seedanceConfig.estimatedCalls;
}

function variableLabel(key: string) {
    return key.replace(/[_-]+/g, " ");
}

function uniqueVariableKey(title: string, id: string) {
    const base = title
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "_")
        .replace(/^_+|_+$/g, "") || "image";
    return `${base}_${id.slice(0, 4)}`;
}

function unique(values: string[]) {
    return [...new Set(values)];
}

function escapeRegExp(value: string) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function clone<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}
