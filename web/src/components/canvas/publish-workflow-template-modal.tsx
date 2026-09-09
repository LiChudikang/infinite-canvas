import { useEffect, useMemo, useState } from "react";
import { App, Button, Checkbox, Input, InputNumber, Modal } from "antd";
import { useNavigate } from "react-router-dom";

import { buildSeedanceSummary, discoverTextVariables, imageNodeVariable } from "@/lib/workflow-template";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import { useWorkflowTemplateStore } from "@/stores/use-workflow-template-store";
import { CanvasNodeType } from "@/types/canvas";
import { localForageStorage } from "@/lib/localforage-storage";

export function PublishWorkflowTemplateModal({ open, project, onClose }: { open: boolean; project: Pick<CanvasProject, "id" | "title" | "nodes" | "connections">; onClose: () => void }) {
    const { message } = App.useApp();
    const navigate = useNavigate();
    const templates = useWorkflowTemplateStore((state) => state.templates);
    const publishTemplate = useWorkflowTemplateStore((state) => state.publishTemplate);
    const [title, setTitle] = useState(project.title);
    const [description, setDescription] = useState("");
    const [imageNodeIds, setImageNodeIds] = useState<string[]>([]);
    const [estimatedUnitCost, setEstimatedUnitCost] = useState<number | null>(null);
    const imageCandidates = useMemo(() => {
        const generatedIds = new Set(
            project.connections
                .filter((edge) => project.nodes.find((node) => node.id === edge.fromNodeId)?.type === CanvasNodeType.Config)
                .map((edge) => edge.toNodeId),
        );
        return project.nodes.filter((node) => node.type === CanvasNodeType.Image && !generatedIds.has(node.id));
    }, [project.connections, project.nodes]);
    const textVariables = useMemo(() => discoverTextVariables(project.nodes), [project.nodes]);
    const summary = useMemo(() => buildSeedanceSummary(project.nodes), [project.nodes]);
    const existing = useMemo(
        () => templates.filter((item) => item.sourceProjectId === project.id).sort((a, b) => b.version - a.version)[0],
        [project.id, templates],
    );

    useEffect(() => {
        if (!open) return;
        setTitle(existing?.title || project.title);
        setDescription(existing?.description || "");
        setEstimatedUnitCost(existing?.estimatedUnitCost ?? null);
        setImageNodeIds(existing?.variables.filter((item) => item.type === "image").map((item) => item.nodeId || "").filter(Boolean) || imageCandidates.filter((node) => !node.metadata?.content).map((node) => node.id));
    }, [existing, imageCandidates, open, project.title]);

    const publish = async () => {
        if (!title.trim()) return message.warning("请填写模板名称");
        if (!summary.estimatedCalls) return message.warning("画布中至少需要一个视频生成配置节点");
        const savedPost = await localForageStorage.getItem(`infinite-canvas:workflow-post:${project.id}`);
        const templateNodes = project.nodes.filter((node) => !node.metadata?.storageKey?.startsWith("workflow:")).map((node) => ({ ...node, metadata: { ...node.metadata, workflowRunId: undefined } }));
        const nodeIds = new Set(templateNodes.map((node) => node.id));
        const template = publishTemplate({
            ...(existing ? { templateId: existing.templateId } : {}),
            sourceProjectId: project.id,
            title: title.trim(),
            description: description.trim(),
            visibility: "personal",
            variables: [...textVariables, ...imageCandidates.filter((node) => imageNodeIds.includes(node.id)).map(imageNodeVariable)],
            lockedFields: ["model", "duration", "camera", "aspect_ratio", "resolution", "video_mode", "generate_audio", "watermark"],
            nodes: JSON.parse(JSON.stringify(templateNodes)),
            edges: JSON.parse(JSON.stringify(project.connections.filter((edge) => nodeIds.has(edge.fromNodeId) && nodeIds.has(edge.toNodeId)))),
            seedanceConfig: summary,
            postProcess: { ...(savedPost ? JSON.parse(savedPost) : {}), enabled: summary.models.every((model) => model.split("::").pop()?.startsWith("doubao-seedance-")), steps: ["seedance", "download", "subtitles", "logo", "concat"] },
            ...(estimatedUnitCost === null ? {} : { estimatedUnitCost }),
            currency: "CNY",
        });
        message.success(`模板已发布为 v${template.version}`);
        onClose();
        navigate(`/templates/${template.templateId}/run?version=${template.version}`);
    };

    return (
        <Modal open={open} title={existing ? `发布新版本 · 当前 v${existing.version}` : "发布为工作流模板"} onCancel={onClose} width={680} footer={<><Button onClick={onClose}>取消</Button><Button type="primary" onClick={publish}>发布模板</Button></>}>
            <div className="space-y-5 pt-2">
                <div className="grid gap-4 md:grid-cols-2">
                    <label className="block">
                        <span className="mb-1.5 block text-sm font-medium">模板名称</span>
                        <Input value={title} onChange={(event) => setTitle(event.target.value)} />
                    </label>
                    <label className="block">
                        <span className="mb-1.5 block text-sm font-medium">预计单次调用费用（元，可选）</span>
                        <InputNumber className="w-full" min={0} precision={2} value={estimatedUnitCost} onChange={setEstimatedUnitCost} placeholder="未填写时显示以渠道账单为准" />
                    </label>
                </div>
                <label className="block">
                    <span className="mb-1.5 block text-sm font-medium">使用说明</span>
                    <Input.TextArea rows={3} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="告诉使用者需要上传什么、最终会生成什么" />
                </label>

                <section className="border-y border-stone-200 py-4 dark:border-stone-800">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <h3 className="text-sm font-semibold">可修改变量</h3>
                        <span className="text-xs text-stone-500">文本使用 {"{{变量名}}"}；图片在下方勾选</span>
                    </div>
                    <div className="mt-3 space-y-3">
                        {textVariables.length ? <div className="flex flex-wrap gap-2">{textVariables.map((item) => <span key={item.key} className="rounded-md bg-stone-100 px-2.5 py-1 text-xs dark:bg-white/10">{item.label}</span>)}</div> : <p className="text-sm text-stone-500">画布里还没有文本变量。</p>}
                        {imageCandidates.length ? (
                            <Checkbox.Group className="grid gap-2 sm:grid-cols-2" value={imageNodeIds} onChange={(values) => setImageNodeIds(values.map(String))}>
                                {imageCandidates.map((node) => <Checkbox key={node.id} value={node.id}>{node.title || "未命名图片"}</Checkbox>)}
                            </Checkbox.Group>
                        ) : null}
                    </div>
                </section>

                <section className="grid gap-3 text-sm sm:grid-cols-3">
                    <Summary label="视频调用" value={`${summary.estimatedCalls} 次`} />
                    <Summary label="时长" value={summary.durations.join(" / ") || "随节点"} />
                    <Summary label="比例" value={summary.aspectRatios.join(" / ") || "随节点"} />
                </section>
                <p className="text-xs leading-5 text-stone-500">发布会保存当前节点和连线的独立版本快照。后续修改画布或发布新版本，不会改变已经创建的成片任务。</p>
            </div>
        </Modal>
    );
}

function Summary({ label, value }: { label: string; value: string }) {
    return <div className="border-l border-stone-300 pl-3 dark:border-stone-700"><div className="text-xs text-stone-500">{label}</div><div className="mt-1 font-medium">{value}</div></div>;
}
