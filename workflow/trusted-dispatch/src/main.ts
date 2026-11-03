import * as core from "@actions/core";
import * as github from "@actions/github";
import ky, { HTTPError } from "ky";
import { DispatchRequest, DispatchResponse, DispatchStatus } from "./models.ts";

// Statuses after which the request does not change any more.
const finalStatuses = ["success", "rejected", "failure", "error"];

class Api {
    constructor(private server: string, private client: string, private audience: string) {}

    // OIDC tokens expire within minutes and a review can take hours, so
    // every call gets a fresh one.
    private async call<T>(method: "get" | "post", path: string, body?: unknown): Promise<T> {
        const token = await core.getIDToken(this.audience);
        const url = `${this.server}/api/v1/dispatch/${encodeURIComponent(this.client)}${path}`;
        try {
            return await ky(url, {
                method,
                timeout: 60000,
                headers: { Authorization: `Bearer ${token}` },
                json: body,
            }).json<T>();
        } catch (error) {
            if (error instanceof HTTPError) {
                const text = await error.response.text().catch(() => "");
                throw new Error(`${method.toUpperCase()} ${url} failed: ${error.response.status} ${text}`.trim());
            }
            throw error;
        }
    }

    dispatch(req: DispatchRequest) { return this.call<DispatchResponse>("post", "", req); }
    status(id: string) { return this.call<DispatchStatus>("get", `/${encodeURIComponent(id)}`); }
}

async function DispatchAudience(server: string): Promise<string> {
    const info: { dispatchAudience?: string } = await ky.get(`${server}/api/v1/info`, { timeout: 60000 }).json();
    if (!info.dispatchAudience) {
        throw new Error(`${server} does not announce a dispatch audience; set the audience input`);
    }
    return info.dispatchAudience;
}

function describe(s: DispatchStatus): string {
    if (s.status === "pending_review" && s.review) {
        return `pending review (${s.review.status}${s.review.reason ? ": " + s.review.reason : ""})`;
    }
    return s.status;
}

// Sets the outputs for a status and reports whether the request succeeded.
function report(s: DispatchStatus): boolean {
    const finished = finalStatuses.includes(s.status);
    core.setOutput("workflow_id", s.id);
    core.setOutput("status", s.status);
    core.setOutput("finished", finished);
    core.setOutput("signed_artifacts", "");

    if (!finished) {
        core.info(`Workflow not completed yet, status: ${describe(s)}`);
        return false;
    }
    if (s.status === "rejected") {
        const reason = s.review?.reason || s.error;
        core.setFailed(`Signing request was rejected by review${reason ? ": " + reason : ""}`);
        return false;
    }
    if (s.status !== "success") {
        core.setFailed(`Signing workflow ended with ${s.status}${s.error ? ": " + s.error : ""}${s.run?.url ? " (" + s.run.url + ")" : ""}`);
        return false;
    }

    core.info("Workflow completed successfully.");
    if (s.assets && s.assets.length > 0) {
        core.info("Signed artifacts:");
        s.assets.forEach(asset => core.info(`- ${asset.name}: ${asset.browser_download_url}`));
        core.setOutput("signed_artifacts", JSON.stringify(s.assets));
    } else {
        core.info("No signed artifacts found.");
    }
    return true;
}

export async function run() {
    const server = (core.getInput("server").trim() || "https://signer.ossign.org").replace(/\/+$/, "");
    // Dispatch clients are named <owner>-<repo> by default.
    const client = core.getInput("client").trim()
        || `${github.context.repo.owner}-${github.context.repo.repo}`.toLowerCase();
    const dispatch_only = core.getInput("dispatch_only").toLowerCase() === "true";
    const single_check = core.getInput("single_check").trim();

    if (!process.env.ACTIONS_ID_TOKEN_REQUEST_URL || !process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) {
        core.setFailed("No GitHub OIDC token is available. Add 'permissions: id-token: write' to the job.");
        return;
    }

    let api: Api;
    try {
        const audience = core.getInput("audience").trim() || await DispatchAudience(server);
        api = new Api(server, client, audience);
    } catch (error) {
        core.setFailed(error instanceof Error ? error.message : String(error));
        return;
    }

    if (single_check !== "") {
        core.info(`Single check mode enabled, checking status of workflow ID ${single_check}...`);
        try {
            return report(await api.status(single_check));
        } catch (error) {
            core.setFailed(error instanceof Error ? error.message : String(error));
            return;
        }
    }

    const ref = github.context.ref.replace("refs/heads/", "").replace("refs/tags/", "");
    core.info(`Triggering workflow dispatch for ${ref} in ${github.context.repo.repo} as client ${client}...`);
    let id: string;
    try {
        const started = await api.dispatch({
            ref,
            releaseName: "Ref: " + ref + " - " + new Date().toISOString(),
        });
        id = started.id;
        core.info(`Dispatched workflow ID ${id}, status: ${started.status}`);
    } catch (error) {
        core.setFailed(`Error dispatching workflow: ${error instanceof Error ? error.message : String(error)}`);
        return;
    }

    if (dispatch_only) {
        core.info("Dispatch only mode enabled, exiting after dispatch.");
        core.setOutput("signed_artifacts", "");
        core.setOutput("workflow_id", id);
        core.setOutput("finished", false);
        return;
    }

    const pollInterval = 15000;
    const timeout = 1000 * 60 * 60 * 24;
    const startTime = Date.now();
    const maxErrors = 5;
    let errors = 0;
    let last = "";

    while ((Date.now() - startTime) < timeout) {
        await new Promise(resolve => setTimeout(resolve, pollInterval));

        let s: DispatchStatus;
        try {
            s = await api.status(id);
            errors = 0;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (++errors >= maxErrors) {
                core.setFailed(`Checking the workflow failed ${errors} times in a row: ${message}`);
                return;
            }
            core.warning(`Checking the workflow failed, retrying: ${message}`);
            continue;
        }

        const current = describe(s);
        if (current !== last) {
            core.info(`Status is now: ${current}`);
            last = current;
        }
        if (finalStatuses.includes(s.status)) {
            return report(s);
        }
    }

    core.setOutput("workflow_id", id);
    core.setOutput("finished", false);
    core.setFailed("Workflow did not complete within the timeout period.");
}
