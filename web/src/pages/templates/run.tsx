import { useMemo, useState } from "react";
import { App, Button, Input, Radio, Upload } from "antd";
import { ArrowLeft, ImagePlus, LockKeyhole, Play, UploadCloud } from "lucide-react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";

import { instantiateWorkflowTemplate, templateTotalEstimate } from "@/lib/workflow-template";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useWorkflowTemplateStore } from "@/stores/use-workflow-template-store";
import type { WorkflowTemplateMode } from "@/types/workflow-template";

export default function TemplateRunPage() {
    const { message } = App.useApp();
    const navigate = useNavigate();
    const { id = "" } = useParams();
    const [searchParams] = useSearchParams();
    const templates = useWorkflowTemplateStore((state) => state.templates);
    const importProject = useCanvasStore((state) => state.importProject);
    const [mode, setMode] = useState<WorkflowTemplateMode>("replicate");
    const [values, setValues] = useState<Record<string, string>>({});
    const [files, setFiles] = useState<Record<string, File | undefined>>({});
    const [creating, setCreating] = useState(false);
    const requestedVersion = Number(searchParams.get("version"));
    const template = useMemo(() => {
        const matches = templates.filter((item) => item.templateId === id);
        return matches.find((item) => item.version === requestedVersion) || matches.sort((a, b) => b.version - a.version)[0];
    }, [id, requestedVersion, templates]);

    if (!template) return <main className="grid h-full place-items-center bg-background"><div className="text-center"><h1 className="text-xl font-semibold">模板不存在</h1><Link to="/templates"><Button className="mt-5">返回模板库</Button></Link></div></main>;

    const estimate = templateTotalEstimate(template);
    const start = async () => {
        const missing = template.variables.find((item) => item.required && (item.type === "image" ? !files[item.key] : !(values[item.key] ?? item.defaultValue ?? "").trim()));
        if (missing) return message.warning(`请填写${missing.label}`);
        setCreating(true);
        try {
            const project = await instantiateWorkflowTemplate(template, values, files, mode);
            const projectId = importProject(project);
            navigate(`/canvas/${projectId}?runTemplate=1`);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "创建工作流失败");
        } finally {
            setCreating(false);
        }
    };

    return (
        <main className="h-full overflow-auto bg-background text-stone-950 dark:text-stone-100">
            <div className="mx-auto grid w-full max-w-6xl gap-10 px-6 py-10 lg:grid-cols-[minmax(0,1fr)_340px]">
                <section>
                    <Link to="/templates" className="inline-flex items-center gap-2 text-sm text-stone-500 hover:text-stone-950 dark:hover:text-stone-100"><ArrowLeft className="size-4" />返回模板库</Link>
                    <div className="mt-8 border-b border-stone-200 pb-7 dark:border-stone-800">
                        <div className="text-xs text-stone-500">{template.title} · v{template.version}</div>
                        <h1 className="mt-3 text-3xl font-semibold">替换内容，生成你的版本</h1>
                        <p className="mt-3 max-w-2xl text-sm leading-6 text-stone-500">{template.description || "上传需要替换的素材并填写文字。模板里的模型、镜头参数和输出规格保持锁定。"}</p>
                    </div>

                    <div className="mt-7 space-y-6">
                        <div>
                            <div className="mb-3 text-sm font-medium">创作方式</div>
                            <Radio.Group value={mode} onChange={(event) => setMode(event.target.value)}>
                                <Radio.Button value="replicate">同款复刻</Radio.Button>
                                <Radio.Button value="similar">相似创作</Radio.Button>
                            </Radio.Group>
                            <p className="mt-2 text-xs text-stone-500">{mode === "replicate" ? "锁定原分镜、运镜和节奏，只替换主体。" : "保留风格和故事结构，允许局部改写镜头与文案。"}</p>
                        </div>

                        {template.variables.map((variable) => (
                            <label key={variable.key} className="block max-w-2xl">
                                <span className="mb-2 block text-sm font-medium">{variable.label}{variable.required ? " *" : ""}</span>
                                {variable.type === "image" ? (
                                    <Upload.Dragger
                                        accept="image/*"
                                        maxCount={1}
                                        beforeUpload={(file) => (setFiles((current) => ({ ...current, [variable.key]: file })), false)}
                                        onRemove={() => (setFiles((current) => ({ ...current, [variable.key]: undefined })), true)}
                                        fileList={files[variable.key] ? [{ uid: variable.key, name: files[variable.key]!.name, status: "done" }] : []}
                                    >
                                        <UploadCloud className="mx-auto size-6 text-stone-400" />
                                        <p className="mt-2 text-sm">点击或拖入图片</p>
                                    </Upload.Dragger>
                                ) : (
                                    <Input.TextArea rows={3} value={values[variable.key] ?? variable.defaultValue ?? ""} onChange={(event) => setValues((current) => ({ ...current, [variable.key]: event.target.value }))} placeholder={`填写${variable.label}`} />
                                )}
                            </label>
                        ))}
                        {!template.variables.length ? <p className="text-sm text-stone-500">这个模板没有暴露变量，将直接按发布时的快照生成。</p> : null}
                    </div>
                </section>

                <aside className="h-fit rounded-2xl border border-stone-200 bg-white p-6 lg:sticky lg:top-8 dark:border-stone-800 dark:bg-white/[.03]">
                    <div className="flex items-center gap-2 text-sm font-semibold"><LockKeyhole className="size-4" />已锁定的工作流</div>
                    <dl className="mt-5 space-y-3 text-sm">
                        <Row label="视频调用" value={`${template.seedanceConfig.estimatedCalls} 次`} />
                        <Row label="模型" value={template.seedanceConfig.models.join(" / ") || "跟随节点"} />
                        <Row label="时长" value={template.seedanceConfig.durations.join(" / ") || "跟随节点"} />
                        <Row label="比例" value={template.seedanceConfig.aspectRatios.join(" / ") || "跟随节点"} />
                        <Row label="清晰度" value={template.seedanceConfig.resolutions.join(" / ") || "跟随节点"} />
                    </dl>
                    <div className="my-5 h-px bg-stone-200 dark:bg-stone-800" />
                    <div className="flex items-end justify-between gap-4">
                        <span className="text-sm text-stone-500">预计费用</span>
                        <span className="text-right text-lg font-semibold">{estimate === undefined ? "以渠道账单为准" : `¥${estimate.toFixed(2)}`}</span>
                    </div>
                    <Button block type="primary" size="large" className="mt-5" icon={<Play className="size-4" />} loading={creating} onClick={() => void start()}>一键生成</Button>
                    <p className="mt-3 text-xs leading-5 text-stone-500">会先创建独立画布快照，再依次运行其中的视频生成节点。刷新后可根据任务 ID 继续查询。</p>
                    <div className="mt-5 flex items-center gap-2 text-xs text-stone-500"><ImagePlus className="size-4" />素材仅保存在当前浏览器本地。</div>
                </aside>
            </div>
        </main>
    );
}

function Row({ label, value }: { label: string; value: string }) {
    return <div className="flex items-start justify-between gap-5"><dt className="shrink-0 text-stone-500">{label}</dt><dd className="min-w-0 break-all text-right">{value}</dd></div>;
}
