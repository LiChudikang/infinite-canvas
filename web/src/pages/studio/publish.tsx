import { useState } from "react";
import { App, Button, Input, Select } from "antd";
import { Link } from "react-router-dom";
import { useWorkflowTemplateStore } from "@/stores/use-workflow-template-store";
import { workflowShots } from "@/services/api/seedance-workflow";
import { platformRequest, type StudioTemplate } from "@/services/api/template-platform";

export function StudioPublish({ token }: { token: string }) {
    const { message } = App.useApp();
    const templates = useWorkflowTemplateStore((s) => s.templates);
    const [selected, setSelected] = useState<string>();
    const [category, setCategory] = useState("");
    const [sampleUrl, setSampleUrl] = useState("");
    const [busy, setBusy] = useState(false);
    const [published, setPublished] = useState<StudioTemplate>();
    const publish = async () => {
        const t = templates.find((v) => `${v.templateId}:${v.version}` === selected);
        if (!t || !category.trim()) return void message.warning("请选择模板并填写分类");
        setBusy(true);
        try {
            const imageVariables = Object.fromEntries(t.variables.filter((v) => v.type === "image" && v.nodeId).map((v) => [v.nodeId!, v.key]));
            // Existing image keys can contain Chinese titles. Give hosted inputs portable IDs.
            const keyMap = Object.fromEntries(t.variables.filter((v) => v.type === "image").map((v, i) => [v.key, `image_${i + 1}`]));
            const shots = await workflowShots(t.nodes, t.edges, Object.fromEntries(Object.entries(imageVariables).map(([id, key]) => [id, keyMap[key]])));
            const result = await platformRequest<StudioTemplate>(token, "/templates", {
                templateId: t.templateId, version: t.version, title: t.title, description: t.description, category: category.trim(), sampleUrl: sampleUrl.trim(),
                variables: t.variables.map(({ key, label, type, required, defaultValue }) => ({ key: Object.hasOwn(keyMap, key) ? keyMap[key] : key, label, type, required, ...(type === "text" ? { defaultValue } : {}) })),
                shots, postProcess: { subtitles: t.postProcess.subtitles || [], ...(t.postProcess.logo ? { logo: t.postProcess.logo } : {}), autoSubtitles: t.postProcess.autoSubtitles || false },
            });
            setPublished(result); message.success("模板已发布，可以分享此版本的链接");
        } catch (e) { message.error(e instanceof Error ? e.message : "发布失败"); } finally { setBusy(false); }
    };
    return <section className="mx-auto max-w-2xl space-y-6 py-8">
        <h1 className="text-3xl font-semibold">发布你的成熟流程</h1>
        <p className="text-muted-foreground">先在画布中发布本地模板，再选定一个版本上架。使用者只看到样片、说明和开放的输入字段。</p>
        <label className="block space-y-2"><span>模板版本</span><Select className="w-full" placeholder="选择已在画布发布的模板" value={selected} onChange={setSelected} options={templates.map((t) => ({ value: `${t.templateId}:${t.version}`, label: `${t.title} · v${t.version}` }))} /></label>
        {!templates.length && <Link to="/canvas" className="underline">前往画布创建模板</Link>}
        <label className="block space-y-2"><span>分类</span><Input placeholder="例如：酒店宣传、产品展示" value={category} onChange={(e) => setCategory(e.target.value)} /></label>
        <label className="block space-y-2"><span>样片链接（可选）</span><Input placeholder="可供使用者观看的 HTTPS 视频地址" value={sampleUrl} onChange={(e) => setSampleUrl(e.target.value)} /></label>
        <p className="text-sm text-muted-foreground">发布会保存固定提示词和必要参考图片，不上传生成视频或历史任务。样片需要你单独提供可分享的地址。已发布版本不可覆盖；更新内容请先在画布发布新版本。</p>
        <Button type="primary" loading={busy} onClick={() => void publish()}>发布此版本</Button>
        {published && <div className="space-y-3 border-t pt-5"><Link className="underline" to={`/studio/templates/${published.templateId}/${published.version}`}>打开已发布模板</Link><div><Button onClick={() => void navigator.clipboard.writeText(`${location.origin}/studio/templates/${published.templateId}/${published.version}`).then(() => message.success("链接已复制；对方仍需自己的访问凭证"), () => message.error("无法复制，请复制地址栏链接"))}>复制分享链接</Button></div></div>}
    </section>;
}
