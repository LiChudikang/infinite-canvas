import type { CanvasConnection, CanvasNodeData } from "@/types/canvas";

export type WorkflowTemplateMode = "replicate" | "similar";
export type WorkflowTemplateVariableType = "text" | "image";

export type WorkflowTemplateVariable = {
    key: string;
    label: string;
    type: WorkflowTemplateVariableType;
    required: boolean;
    defaultValue?: string;
    nodeId?: string;
};

export type WorkflowTemplateSeedanceConfig = {
    models: string[];
    durations: string[];
    aspectRatios: string[];
    resolutions: string[];
    estimatedCalls: number;
};

export type WorkflowTemplatePostProcess = {
    enabled: boolean;
    steps: string[];
    subtitles?: string[];
    logo?: string;
    autoSubtitles?: boolean;
};

export type WorkflowTemplate = {
    templateId: string;
    version: number;
    sourceProjectId: string;
    title: string;
    description: string;
    visibility: "personal";
    variables: WorkflowTemplateVariable[];
    lockedFields: string[];
    nodes: CanvasNodeData[];
    edges: CanvasConnection[];
    seedanceConfig: WorkflowTemplateSeedanceConfig;
    postProcess: WorkflowTemplatePostProcess;
    estimatedUnitCost?: number;
    currency: "CNY";
    publishedAt: string;
};

export type WorkflowTemplateSnapshot = Pick<
    WorkflowTemplate,
    "templateId" | "version" | "title" | "publishedAt" | "variables" | "lockedFields" | "seedanceConfig" | "postProcess"
>;

export type WorkflowTemplateInstance = {
    runId: string;
    mode: WorkflowTemplateMode;
    createdAt: string;
    variableValues: Record<string, string>;
    snapshot: WorkflowTemplateSnapshot;
};
