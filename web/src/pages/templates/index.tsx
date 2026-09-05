import { useMemo, useState } from "react";
import { App, Button, Empty, Select } from "antd";
import { Boxes, Image, Play, Plus, Trash2, Type, Video } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";

import { latestWorkflowTemplates, useWorkflowTemplateStore } from "@/stores/use-workflow-template-store";
import type { WorkflowTemplate } from "@/types/workflow-template";

export default function TemplatesPage() {
    const { modal } = App.useApp();
    const navigate = useNavigate();
    const hydrated = useWorkflowTemplateStore((state) => state.hydrated);
    const templates = useWorkflowTemplateStore((state) => state.templates);
    const deleteTemplate = useWorkflowTemplateStore((state) => state.deleteTemplate);
    const latest = useMemo(() => latestWorkflowTemplates(templates), [templates]);

    return (
        <main className="h-full overflow-auto bg-background text-stone-950 dark:text-stone-100">
            <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-6 py-10">
                <header className="flex flex-wrap items-end justify-between gap-4 border-b border-stone-200 pb-6 dark:border-stone-800">
                    <div>
                        <p className="text-xs text-stone-500">把成熟流程交给别人重复使用</p>
                        <h1 className="mt-3 text-3xl font-semibold">视频工作流模板</h1>
                    </div>
                    <Link to="/canvas"><Button type="primary" icon={<Plus className="size-4" />}>从画布创建</Button></Link>
                </header>

                {!hydrated ? (
                    <section className="flex min-h-[360px] items-center justify-center border-y border-stone-200 text-sm text-stone-500 dark:border-stone-800">正在加载模板...</section>
                ) : latest.length ? (
                    <div className="grid gap-5 lg:grid-cols-2">
                        {latest.map((template) => (
                            <TemplateCard
                                key={template.templateId}
                                template={template}
                                versions={templates.filter((item) => item.templateId === template.templateId).sort((a, b) => b.version - a.version)}
                                onRun={(version) => navigate(`/templates/${template.templateId}/run?version=${version}`)}
                                onDelete={() => modal.confirm({ title: `删除「${template.title}」？`, content: "所有历史版本都会从本机模板库移除，已经创建的画布快照不受影响。", okText: "删除", okButtonProps: { danger: true }, onOk: () => deleteTemplate(template.templateId) })}
                            />
                        ))}
                    </div>
                ) : (
                    <section className="grid min-h-[380px] place-items-center border-y border-stone-200 dark:border-stone-800"><Empty description="还没有模板。先在画布搭好流程，再从画布菜单发布。"><Link to="/canvas"><Button type="primary">打开我的画布</Button></Link></Empty></section>
                )}
            </div>
        </main>
    );
}

function TemplateCard({ template, versions, onRun, onDelete }: { template: WorkflowTemplate; versions: WorkflowTemplate[]; onRun: (version: number) => void; onDelete: () => void }) {
    const [version, setVersion] = useState(template.version);
    const selected = versions.find((item) => item.version === version) || template;
    const textCount = selected.variables.filter((item) => item.type === "text").length;
    const imageCount = selected.variables.filter((item) => item.type === "image").length;
    return (
        <article className="flex min-h-72 flex-col rounded-2xl border border-stone-200 bg-white p-6 dark:border-stone-800 dark:bg-white/[.03]">
            <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                    <div className="flex items-center gap-2 text-xs text-stone-500"><Boxes className="size-3.5" />个人模板</div>
                    <h2 className="mt-3 truncate text-2xl font-semibold">{selected.title}</h2>
                    <p className="mt-2 line-clamp-2 min-h-10 text-sm leading-5 text-stone-500">{selected.description || "替换素材与文字，按固定流程生成同款或相似视频。"}</p>
                </div>
                <Select size="small" value={version} onChange={setVersion} options={versions.map((item) => ({ value: item.version, label: `v${item.version}` }))} />
            </div>

            <div className="my-6 flex items-center gap-2 overflow-hidden text-xs text-stone-600 dark:text-stone-300">
                <FlowStep icon={<Image className="size-4" />} label={`${imageCount} 个素材`} />
                <span className="h-px min-w-4 flex-1 bg-stone-200 dark:bg-stone-700" />
                <FlowStep icon={<Type className="size-4" />} label={`${textCount} 个文本`} />
                <span className="h-px min-w-4 flex-1 bg-stone-200 dark:bg-stone-700" />
                <FlowStep icon={<Video className="size-4" />} label={`${selected.seedanceConfig.estimatedCalls} 次生成`} />
            </div>

            <div className="mt-auto flex items-center justify-between gap-3 border-t border-stone-200 pt-4 dark:border-stone-800">
                <span className="text-xs text-stone-500">{new Date(selected.publishedAt).toLocaleString()}</span>
                <div className="flex items-center gap-1">
                    <Button type="text" danger shape="circle" icon={<Trash2 className="size-4" />} onClick={onDelete} aria-label="删除模板" />
                    <Button type="primary" icon={<Play className="size-4" />} onClick={() => onRun(version)}>使用模板</Button>
                </div>
            </div>
        </article>
    );
}

function FlowStep({ icon, label }: { icon: React.ReactNode; label: string }) {
    return <span className="flex shrink-0 items-center gap-1.5">{icon}{label}</span>;
}
