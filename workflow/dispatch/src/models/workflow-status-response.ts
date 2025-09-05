export type WorkflowStatusResponse = {
    id: string;
    username?: string;
    workflow_run_id?: number;
    last_checked?: Date;
    last_status?: string;
    completed?: boolean;
    release_assets?: Array<{
        id: string;
        name: string;
        url: string;
        browser_download_url: string;
    }>;
};
