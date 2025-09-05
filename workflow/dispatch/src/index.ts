import * as core from "@actions/core";
import * as github from "@actions/github";
import ky from "ky";

const username = core.getInput("username");
const token = core.getInput("token");
var ref_name = "";

type WorkflowStatusResponse = {
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


try {
    ref_name = github.context.ref.replace("refs/heads/", "").replace("refs/tags/", "");
    core.info(`Starting build for ${ref_name}`);
} catch (error) {
    core.setFailed("Error retrieving ref name");
}

try {
    core.info(`Triggering workflow dispatch for ${ref_name} in ${github.context.repo.repo}...`);

    const startRequest = {
        source_branch: ref_name,
        release_name: 'Ref: ' + ref_name + ' - ' + new Date().toISOString(),
    };

    const response = await ky.post(`https://api.ossign.org/api/v1/dispatch/${username}`, {
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify(startRequest)
    });

    if (!response.ok) {
        const errorText = await response.text();
        core.setFailed(`Failed to trigger workflow dispatch: ${response.status} ${response.statusText} - ${errorText}`);
    }

    const responseData: WorkflowStatusResponse | Error = await response.json();

    if ("message" in responseData) {
        core.setFailed(`Failed to trigger workflow dispatch: ${responseData.message}`);
    }

    const verifiedResponseData = responseData as WorkflowStatusResponse;

    core.info(`Workflow dispatch triggered successfully. Workflow Run ID: ${verifiedResponseData.workflow_run_id}`);

    core.info(`Waiting for workflow to complete...`);

    const pollInterval = 15000;
    const timeout = 1000 * 60 * 60 * 24;
    const startTime = Date.now();

    let completed = false;
    let lastStatus = "";

    let verifiedStatusData: WorkflowStatusResponse | null = null;

    while (!completed && (Date.now() - startTime) < timeout) {
        await new Promise(resolve => setTimeout(resolve, pollInterval));

        const statusResponse = await ky.post(`https://api.ossign.org/api/v1/status/${username}/${verifiedResponseData.id}`, {
            headers: {
                'Authorization': `Bearer ${token}`,
            }
        });

        if (!statusResponse.ok) {
            const errorText = await statusResponse.text();
            core.setFailed(`Failed to get workflow status: ${statusResponse.status} ${statusResponse.statusText} - ${errorText}`);
        }

        const statusData: WorkflowStatusResponse | Error = await statusResponse.json();
        if ("message" in statusData) {
            core.setFailed(`Failed to get workflow status: ${statusData.message}`);
        }

        verifiedStatusData = statusData as WorkflowStatusResponse;

        completed = verifiedStatusData.completed || false;
        lastStatus = verifiedStatusData.last_status || "";

        core.info(`Current status: ${lastStatus}`);
    }

    if (!completed) {
        core.setFailed("Workflow did not complete within the timeout period.");
    } else {
        core.info("Workflow completed successfully.");

        if (verifiedResponseData.release_assets && verifiedResponseData.release_assets.length > 0) {
            core.info("Signed artifacts:");
            verifiedResponseData.release_assets.forEach(asset => {
                core.info(`- ${asset.name}: ${asset.browser_download_url}`);
            });
        } else {
            core.info("No signed artifacts found.");
        }
    }

    core.setOutput("artifacts", verifiedStatusData?.release_assets ? JSON.stringify(verifiedStatusData.release_assets) : "[]");

} catch (err) {
  core.setFailed(err instanceof Error ? err.message : String(err));
}