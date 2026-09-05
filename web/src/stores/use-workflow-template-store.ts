import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { nanoid } from "nanoid";

import { localForageStorage } from "@/lib/localforage-storage";
import type { WorkflowTemplate } from "@/types/workflow-template";

type PublishTemplateInput = Omit<WorkflowTemplate, "templateId" | "version" | "publishedAt"> & { templateId?: string };

type WorkflowTemplateStore = {
    hydrated: boolean;
    templates: WorkflowTemplate[];
    publishTemplate: (input: PublishTemplateInput) => WorkflowTemplate;
    deleteTemplate: (templateId: string) => void;
};

const STORE_KEY = "infinite-canvas:workflow_template_store";

export const useWorkflowTemplateStore = create<WorkflowTemplateStore>()(
    persist(
        (set, get) => ({
            hydrated: false,
            templates: [],
            publishTemplate: (input) => {
                const related = get().templates.filter((item) => item.templateId === input.templateId || (!input.templateId && item.sourceProjectId === input.sourceProjectId));
                const templateId = input.templateId || related[0]?.templateId || nanoid();
                const version = Math.max(0, ...related.map((item) => item.version)) + 1;
                const template: WorkflowTemplate = { ...input, templateId, version, publishedAt: new Date().toISOString() };
                set((state) => ({ templates: [template, ...state.templates] }));
                return template;
            },
            deleteTemplate: (templateId) => {
                set((state) => ({ templates: state.templates.filter((item) => item.templateId !== templateId) }));
                window.setTimeout(() => void import("@/stores/use-asset-store").then(({ useAssetStore }) => useAssetStore.getState().cleanupImages()), 0);
            },
        }),
        {
            name: STORE_KEY,
            storage: createJSONStorage(() => localForageStorage),
            partialize: (state) => ({ templates: state.templates }) as WorkflowTemplateStore,
            onRehydrateStorage: () => () => useWorkflowTemplateStore.setState({ hydrated: true }),
        },
    ),
);

export function latestWorkflowTemplates(templates: WorkflowTemplate[]) {
    const latest = new Map<string, WorkflowTemplate>();
    templates.forEach((item) => {
        const current = latest.get(item.templateId);
        if (!current || item.version > current.version) latest.set(item.templateId, item);
    });
    return [...latest.values()].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
}
