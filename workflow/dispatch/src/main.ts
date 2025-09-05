import * as core from "@actions/core";
import * as github from "@actions/github";
import ky from "ky";
import { WorkflowStatusResponse } from "./models/workflow-status-response.ts";
import { WorkflowDispatchRequest } from "./models/workflow-dispatch-request.ts";

async function CallApi(action: string, body: any, token: string) : Promise<WorkflowStatusResponse> {
    const response = await ky.post(`https://api.ossign.org/api/v1/${action}`, {
        timeout: 60000,
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
        },
        body: body
    });

    if (!response.ok) {
        const errorText = await response.text();
        core.setFailed(`Failed to call API ${action}: ${response.status} ${response.statusText} - ${errorText}`);
    }

    const responseData: WorkflowStatusResponse | Error = await response.json();

    core.debug(`Response from API ${action}: ${JSON.stringify(responseData)}`);

    if ("message" in responseData) {
        core.setFailed(`Failed to call API ${action}: ${responseData.message}`);
    }

    const verifiedResponseData = responseData as WorkflowStatusResponse;

    return verifiedResponseData;
}

async function DispatchWorkflow(username: string, token: string, ref_name: string) : Promise<WorkflowStatusResponse> {
    core.info(`Triggering workflow dispatch for ${ref_name} in ${github.context.repo.repo}...`);

    const startRequest: WorkflowDispatchRequest = {
        source_branch: ref_name,
        release_name: 'Ref: ' + ref_name + ' - ' + new Date().toISOString(),
    };

    const response = await CallApi(`dispatch/${username}`, JSON.stringify(startRequest), token);
    
    return response;
}

async function CheckWorkflow(username: string, token: string, id: string) : Promise<WorkflowStatusResponse> {
    core.info(`Checking workflow status for ID ${id}...`);

    const response = await CallApi(`check/${username}/${id}`, undefined, token);

    return response;
}

   
export async function run() {
    const username = core.getInput("username");
    const token = core.getInput("token");
    const dispatch_only = core.getInput("dispatch_only").toLowerCase() === "true";
    const single_check = core.getInput("single_check");

    if (!username || username.trim() === "") {
        core.setFailed("Username is required");
        return;
    }

    if (!token || token.trim() === "") {
        core.setFailed("Token is required");
        return;
    }

    let verifiedResponseData: WorkflowStatusResponse;

    // If single_check is provided, only check the status of that workflow
    if (single_check && single_check.trim() !== "") {
        core.info(`Single check mode enabled, checking status of workflow ID ${single_check}...`);
        verifiedResponseData = await CheckWorkflow(username, token, single_check);

        if (verifiedResponseData?.completed) {
            core.info("Workflow completed successfully.");

            if (verifiedResponseData.release_assets && verifiedResponseData.release_assets.length > 0) {
                core.info("Signed artifacts:");
                verifiedResponseData.release_assets.forEach(asset => {
                    core.info(`- ${asset.name}: ${asset.browser_download_url}`);
                });

                core.setOutput("signed_artifacts", JSON.stringify(verifiedResponseData.release_assets));
            } else {
                core.info("No signed artifacts found.");
            }

            core.setOutput("finished", true);

            return true;
        }

        core.info("Workflow not completed yet.");
        core.setOutput("signed_artifacts", "");
        core.setOutput("finished", false);
        return false;
    }

    core.info("Dispatching new workflow...");
    try {
        verifiedResponseData = await DispatchWorkflow(username, token, github.context.ref.replace("refs/heads/", "").replace("refs/tags/", ""));
    } catch (error) {
        core.setFailed("Error dispatching workflow");
        return;
    }
    
    if (dispatch_only) {
        core.info("Dispatch only mode enabled, exiting after dispatch.");
        
        core.setOutput("signed_artifacts", "");
        core.setOutput("workflow_id", verifiedResponseData.id);
        core.setOutput("finished", false);

        return;
    }

    const pollInterval = 15000;
    const timeout = 1000 * 60 * 60 * 24;
    const startTime = Date.now();
    let numErrors = 0;
    let numErrorsMax = 5;

    let completed = false;
    let lastStatus = "";

    while (!completed && (Date.now() - startTime) < timeout) {
        await new Promise(resolve => setTimeout(resolve, pollInterval));

        verifiedResponseData = await CheckWorkflow(username, token, verifiedResponseData.id);
        if (lastStatus !== verifiedResponseData.last_status) {
            core.info(`Status is now: ${verifiedResponseData.last_status}`);
        }

        lastStatus = verifiedResponseData.last_status || "";
        completed = verifiedResponseData.completed || false;

        if (completed) {
            break;
        }
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

                core.setOutput("signed_artifacts", JSON.stringify(verifiedResponseData.release_assets));
            } else {
                core.info("No signed artifacts found.");
            }

            core.setOutput("finished", true);

            return true;
    }
}