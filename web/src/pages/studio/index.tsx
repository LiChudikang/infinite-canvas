import { useEffect, useState } from "react";
import { App, Button, Checkbox, Input, Select } from "antd";
import { ArrowLeft, Download, Film, RefreshCw } from "lucide-react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { saveAs } from "file-saver";
import { dataUrl } from "@/services/api/seedance-workflow";
import { downloadStudioFile, platformRequest, type StudioMember, type StudioRun, type StudioTemplate } from "@/services/api/template-platform";
import { StudioPublish } from "./publish";

const sessionKey = "infinite-canvas:studio-access";
const statusText: Record<string, string> = { reserved: "待作者检查启动状态", ready: "准备生成", pending: "等待生成", submitting: "正在提交", running: "生成中", paused: "需要处理", uncertain: "提交结果待确认", failed: "生成失败", succeeded: "已完成", transcribing: "识别字幕中", awaiting_review: "请校对字幕", composing: "合成中" };
export default function StudioPage() {
    const { id, version } = useParams();
    const location = useLocation();
    const [token, setToken] = useState(() => sessionStorage.getItem(sessionKey) || "");
    const [draft, setDraft] = useState("");
    const [member, setMember] = useState<StudioMember>();
    const [error, setError] = useState("");
    const [checking, setChecking] = useState(false);
    const refreshMember = async (value = token) => {
        setChecking(true); setError("");
        try { const m = await platformRequest<StudioMember>(value, "/me"); setMember(m); setToken(value); sessionStorage.setItem(sessionKey, value); setDraft(""); }
        catch (e) { setError(e instanceof Error ? e.message : "连接失败"); setMember(undefined); }
        finally { setChecking(false); }
    };
    useEffect(() => { if (token) void refreshMember(); }, []);
    const logout = () => { sessionStorage.removeItem(sessionKey); setMember(undefined); setToken(""); setError(""); };
    return <main className="h-dvh overflow-auto bg-background text-foreground">
        <header className="border-b"><div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-6 py-5">
            <Link to="/studio" className="flex items-center gap-3 font-semibold"><Film className="size-5" />同款视频</Link>
            {member && <nav className="flex flex-wrap items-center gap-5 text-sm"><Link to="/studio">选模板</Link><Link to="/studio/works">我的作品</Link><Link to="/studio/channel">我的渠道</Link>{member.role === "author" && <Link to="/studio/publish">发布模板</Link>}<Button type="text" onClick={logout}>退出</Button></nav>}
        </div></header>
        <div className="mx-auto max-w-6xl px-6 pb-16">
            {!member ? <section className="mx-auto max-w-md space-y-6 py-20"><h1 className="text-3xl font-semibold">用喜欢的模板，做自己的视频</h1><p className="text-muted-foreground">输入作者提供的访问凭证。进入后选择模板、替换素材，使用自己的生成渠道制作视频。</p><Input.Password aria-label="访问凭证" autoComplete="off" value={draft} onChange={(e) => setDraft(e.target.value)} onPressEnter={() => void refreshMember(draft)} /><Button type="primary" loading={checking} disabled={!draft.trim()} onClick={() => void refreshMember(draft)}>进入模板库</Button>{error && <p role="alert" className="text-destructive">{error}</p>}</section>
                : location.pathname === "/studio/channel" ? <Channel token={token} member={member} onSaved={() => void refreshMember()} />
                : location.pathname === "/studio/publish" ? member.role === "author" ? <StudioPublish token={token} /> : <p className="py-10">仅作者可以发布模板。</p>
                : location.pathname === "/studio/works" ? <Works token={token} />
                : id && version ? <TemplateForm key={`${id}:${version}`} token={token} member={member} id={id} version={version} />
                : <Catalog token={token} />}
        </div>
    </main>;
}
function Channel({ token, member, onSaved }: { token: string; member: StudioMember; onSaved: () => void }) {
    const { message } = App.useApp(); const [apiKey, setApiKey] = useState(""); const [busy, setBusy] = useState(false);
    const save = async () => { setBusy(true); try { await platformRequest(token, "/channel", { apiKey }, "PUT"); setApiKey(""); message.success("渠道已保存，未发起收费请求"); onSaved(); } catch (e) { message.error(e instanceof Error ? e.message : "保存失败"); } finally { setBusy(false); } };
    return <section className="mx-auto max-w-xl space-y-6 py-12"><h1 className="text-3xl font-semibold">我的生成渠道</h1><p>首版支持火山方舟 Seedance。生成使用你的 API Key，费用计入你的方舟账户；请确保该账户可以调用模板指定的模型。</p><p className="text-sm text-muted-foreground">凭证在服务端加密保存，不返回浏览器。已有任务继续使用创建时的凭证版本；保存新凭证用于之后的任务。</p><label className="block space-y-2"><span>{member.channelConfigured ? "更换方舟 API Key" : "方舟 API Key"}</span><Input.Password autoComplete="new-password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} /></label><Button type="primary" loading={busy} disabled={!apiKey.trim()} onClick={() => void save()}>保存渠道</Button><p className="text-sm text-muted-foreground">保存只检查格式，不验证模型权限或余额。生成前将展示调用次数，实际金额以渠道账单为准。</p></section>;
}
function Catalog({ token }: { token: string }) {
    const [templates, setTemplates] = useState<StudioTemplate[]>([]); const [error, setError] = useState(""); const [loading, setLoading] = useState(true); const [category, setCategory] = useState("全部");
    useEffect(() => { let active = true; platformRequest<StudioTemplate[]>(token, "/templates").then((data) => { if (active) setTemplates(data); }, (e) => { if (active) setError(e.message); }).finally(() => { if (active) setLoading(false); }); return () => { active = false; }; }, [token]);
    return <section className="py-12"><div className="mb-10 flex flex-wrap items-end justify-between gap-6"><div><h1 className="text-4xl font-semibold tracking-tight">选一个风格，换成你的内容</h1><p className="mt-4 text-muted-foreground">分镜、运镜和节奏已经安排好。准备照片与文字，就可以开始。</p></div><Select aria-label="模板分类" className="min-w-40" value={category} onChange={setCategory} options={["全部", ...new Set(templates.map((t) => t.category))].map((value) => ({ value, label: value }))} /></div>
        {error && <p role="alert">{error}</p>}{loading && <p>正在读取模板…</p>}{!loading && !error && !templates.length && <p className="border-y py-16 text-muted-foreground">作者还没有发布模板。发布后，样片和使用入口会出现在这里。</p>}
        <div className="grid gap-x-8 gap-y-12 md:grid-cols-2">{templates.filter((t) => category === "全部" || t.category === category).map((t) => <article key={t.templateId}>
            <Sample template={t} /><div className="flex items-start justify-between gap-4 pt-5"><div><p className="text-sm text-muted-foreground">{t.category} · {t.seconds} 秒 · {t.ratios.join(" / ")}</p><h2 className="mt-2 text-2xl font-semibold">{t.title}</h2><p className="mt-2 text-muted-foreground">{t.description || `准备 ${t.variables.filter((v) => v.type === "image").length} 张图片和模板要求的文字。`}</p></div><Link className="shrink-0" to={`/studio/templates/${t.templateId}/${t.version}`}><Button>制作同款</Button></Link></div>
        </article>)}</div></section>;
}
function Sample({ template: t }: { template: StudioTemplate }) {
    return t.sampleUrl ? <video className="aspect-video w-full bg-muted object-contain" controls preload="metadata" src={t.sampleUrl} aria-label={`${t.title}样片`} /> : <div className="flex aspect-video items-center justify-center bg-muted text-muted-foreground"><div className="text-center"><Film className="mx-auto mb-3 size-8" /><p>{t.title}</p><p className="mt-2 text-sm">作者尚未提供样片</p></div></div>;
}
function TemplateForm({ token, member, id, version }: { token: string; member: StudioMember; id: string; version: string }) {
    const { message } = App.useApp(); const navigate = useNavigate();
    const [template, setTemplate] = useState<StudioTemplate>(); const [error, setError] = useState(""); const [values, setValues] = useState<Record<string, string>>({});
    const [confirmed, setConfirmed] = useState(false); const [busy, setBusy] = useState(false); const [submitted, setSubmitted] = useState(false); const [requestId] = useState(() => crypto.randomUUID());
    useEffect(() => { let active = true; platformRequest<StudioTemplate>(token, `/templates/${encodeURIComponent(id)}/${encodeURIComponent(version)}`).then((t) => { if (active) { setTemplate(t); setValues(Object.fromEntries(t.variables.filter((v) => v.type === "text").map((v) => [v.key, v.defaultValue || ""]))); } }, (e) => { if (active) setError(e.message); }); return () => { active = false; }; }, [token, id, version]);
    const start = async () => {
        if (!template) return;
        const missing = template.variables.find((v) => v.required && !values[v.key]?.trim());
        if (missing) return void message.warning(`请填写${missing.label}`);
        setBusy(true); setSubmitted(true); setError("");
        try { await platformRequest(token, "/runs", { templateId: id, version: template.version, values, requestId, confirmed: true }); navigate("/studio/works"); }
        catch (e) { setError(e instanceof Error ? e.message : "提交失败，请先查看我的作品确认任务状态"); }
        finally { setBusy(false); }
    };
    if (!template) return <p className="py-12" role="status">{error || "正在读取模板…"}</p>;
    return <section className="py-10"><Link to="/studio" className="mb-8 inline-flex items-center gap-2 text-sm"><ArrowLeft className="size-4" />返回模板库</Link><div className="grid gap-12 lg:grid-cols-2"><div><Sample template={template} /><h1 className="mt-6 text-3xl font-semibold">{template.title}</h1><p className="mt-4 text-muted-foreground">{template.description}</p><p className="mt-5 text-sm">v{template.version} · {template.seconds} 秒 · {template.ratios.join(" / ")} · {template.resolutions.join(" / ")}</p><p className="mt-3 text-sm text-muted-foreground">沿用模板的分镜、风格和节奏；AI 生成的具体画面会有差异。</p></div>
        <div className="space-y-6"><h2 className="text-2xl font-semibold">换成你的内容</h2>{template.variables.map((v) => <label key={v.key} className="block space-y-2"><span>{v.label}{v.required ? " *" : ""}</span>{v.type === "text" ? <Input.TextArea disabled={submitted} rows={3} value={values[v.key] || ""} onChange={(e) => setValues((prev) => ({ ...prev, [v.key]: e.target.value }))} /> : <><input className="block w-full text-sm" disabled={submitted} type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => { const file = e.target.files?.[0]; if (!file) return; void dataUrl(file).then((value) => setValues((prev) => ({ ...prev, [v.key]: value })), () => message.error("图片读取失败")); }} />{values[v.key] && <img className="max-h-48 max-w-full object-contain" src={values[v.key]} alt={v.label} />}</>}</label>)}
        {!member.channelConfigured && <p><Link to="/studio/channel" className="underline">先配置自己的方舟渠道</Link></p>}{!member.generationEnabled && <p>生成服务尚未启用，请联系作者。</p>}
        <div className="space-y-4 border-t pt-5"><p>本次预计 {template.calls} 次视频生成，费用由你的方舟账户承担，以渠道账单为准。</p><Checkbox checked={confirmed} disabled={submitted} onChange={(e) => setConfirmed(e.target.checked)}>我确认使用自己的渠道生成，可能产生费用</Checkbox><div><Button type="primary" loading={busy} disabled={!confirmed || !member.channelConfigured || !member.generationEnabled} onClick={() => void start()}>{submitted ? "查询此次提交结果" : "生成我的视频"}</Button></div></div>
        {error && <p role="alert" className="text-destructive">{error} <Link className="underline" to="/studio/works">查看我的作品</Link></p>}
        </div></div></section>;
}
function Works({ token }: { token: string }) {
    const { message } = App.useApp(); const [runs, setRuns] = useState<StudioRun[]>([]); const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
    const refresh = async () => { setBusy(true); setError(""); try { setRuns(await platformRequest<StudioRun[]>(token, "/runs")); } catch (e) { setError(e instanceof Error ? e.message : "读取失败"); } finally { setBusy(false); } };
    useEffect(() => { void refresh(); }, [token]);
    const resume = async (id: string) => { try { await platformRequest(token, `/runs/${id}/resume`, {}); await refresh(); } catch (e) { message.error(e instanceof Error ? e.message : "恢复失败"); } };
    const download = async (run: StudioRun, file: string) => { try { saveAs(await downloadStudioFile(token, run.runId, file), `${run.title}-${file}`); } catch (e) { message.error(e instanceof Error ? e.message : "下载失败"); } };
    return <section className="py-12"><div className="mb-8 flex items-center justify-between"><h1 className="text-3xl font-semibold">我的作品</h1><Button icon={<RefreshCw className="size-4" />} loading={busy} onClick={() => void refresh()}>刷新进度</Button></div>{error && <p role="alert">{error}</p>}{!busy && !error && !runs.length && <p>还没有生成记录。<Link className="underline" to="/studio">选择一个模板开始</Link></p>}
        <div className="divide-y">{runs.map((run) => <article className="space-y-4 py-7" key={run.runId}><div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-xl font-semibold">{run.title}</h2><p className="mt-1 text-sm text-muted-foreground">{new Date(run.createdAt).toLocaleString()} · v{run.version}</p></div><span>{statusText[run.status] || run.status}</span></div><div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">{run.shots.map((shot) => <span key={shot.nodeId}>{shot.title}：{statusText[shot.status] || shot.status}{shot.file && <Button type="link" onClick={() => void download(run, shot.file!)}>下载原片</Button>}</span>)}</div>{run.error && <p>{run.error}</p>}
            <div className="flex flex-wrap gap-3">{run.final && <Button type="primary" icon={<Download className="size-4" />} onClick={() => void download(run, run.final!)}>下载视频</Button>}{run.status === "paused" && <Button onClick={() => void resume(run.runId)}>继续查询或合成</Button>}<Link to={`/studio/templates/${run.templateId}/${run.version}`}><Button>再做一个</Button></Link></div>{run.status === "awaiting_review" && <SubtitleReview token={token} runId={run.runId} onApproved={() => void refresh()} />}{run.status === "reserved" && <p className="text-sm text-muted-foreground">任务已保留，尚未确认执行启动。请联系作者检查，避免重复生成。</p>}
        </article>)}</div></section>;
}
function SubtitleReview({ token, runId, onApproved }: { token: string; runId: string; onApproved: () => void }) {
    const { message } = App.useApp(); const [cues, setCues] = useState<{ shot: number; start: number; end: number; text: string }[]>(); const [busy, setBusy] = useState(false);
    const load = async () => { try { const draft = await platformRequest<{ cues: NonNullable<typeof cues> }>(token, `/runs/${runId}/subtitles`); setCues(draft.cues); } catch { message.error("字幕读取失败，请稍后重试"); } };
    const approve = async () => { setBusy(true); try { await platformRequest(token, `/runs/${runId}/subtitles`, { cues }); onApproved(); } catch (e) { message.error(e instanceof Error ? e.message : "保存失败"); } finally { setBusy(false); } };
    return <div className="space-y-3 border-t pt-4">{!cues ? <Button onClick={() => void load()}>打开字幕校对</Button> : <><p className="text-sm">下载上方原片对照校对，确认后继续合成，不会重新生成视频。</p>{cues.map((cue, i) => <div key={i} className="flex flex-wrap items-center gap-2"><span className="text-sm">镜头 {cue.shot + 1}</span><Input className="!w-24" aria-label="开始秒数" type="number" value={cue.start} onChange={(e) => setCues((prev) => prev?.map((c, n) => n === i ? { ...c, start: Number(e.target.value) } : c))} /><Input className="!w-24" aria-label="结束秒数" type="number" value={cue.end} onChange={(e) => setCues((prev) => prev?.map((c, n) => n === i ? { ...c, end: Number(e.target.value) } : c))} /><Input className="!w-auto min-w-48 flex-1" aria-label="字幕文字" value={cue.text} onChange={(e) => setCues((prev) => prev?.map((c, n) => n === i ? { ...c, text: e.target.value } : c))} /></div>)}<Button loading={busy} onClick={() => void approve()}>确认字幕并合成</Button></>}</div>;
}
