export type DispatchRequest = {
    ref: string;
    releaseName: string;
};

export type Review = {
    id: string;
    status: string;
    mode?: string;
    reason?: string;
    note?: string;
};

export type Asset = {
    id: string;
    name: string;
    url: string;
    browser_download_url: string;
};

// Response of POST /api/v1/dispatch/{client}.
export type DispatchResponse = {
    id: string;
    status: string;
    review?: Review | null;
};

// Response of GET /api/v1/dispatch/{client}/{id}.
export type DispatchStatus = {
    id: string;
    status: string;
    ref?: string;
    sha?: string;
    error?: string;
    review?: Review | null;
    run?: { id?: number; url?: string; status?: string; conclusion?: string };
    assets?: Asset[] | null;
};
