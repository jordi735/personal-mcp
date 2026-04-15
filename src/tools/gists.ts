import { Octokit } from "@octokit/rest";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const githubPat = process.env.GITHUB_PAT;

const octokit: Octokit | null = githubPat
  ? new Octokit({ auth: githubPat, userAgent: "personal-mcp/0.1.0" })
  : null;

interface OctokitGistFile {
  filename?: string;
  language?: string | null;
  type?: string | null;
  size?: number;
  truncated?: boolean;
  content?: string;
  raw_url?: string;
}

interface OctokitGist {
  id?: string;
  description?: string | null;
  public?: boolean;
  html_url?: string;
  created_at?: string;
  updated_at?: string;
  files?: { [key: string]: OctokitGistFile | null | undefined };
}

interface GistSummary {
  id: string;
  description: string | null;
  public: boolean;
  files: string[];
  html_url: string;
  updated_at: string;
}

interface GistFileDetail {
  filename: string;
  language: string | null;
  type: string | null;
  size: number;
  truncated: boolean;
  content: string;
}

interface GistDetail {
  id: string;
  description: string | null;
  public: boolean;
  html_url: string;
  created_at: string;
  updated_at: string;
  files: GistFileDetail[];
}

interface RequestLikeError {
  status: number;
  message: string;
  response?: { data?: { message?: string } };
}

// Duck-type on .status to avoid importing from the transitive @octokit/request-error package.
function isRequestLikeError(err: unknown): err is RequestLikeError {
  return (
    typeof err === "object" &&
    err !== null &&
    "status" in err &&
    typeof (err as { status: unknown }).status === "number" &&
    "message" in err &&
    typeof (err as { message: unknown }).message === "string"
  );
}

function mapError(err: unknown): string {
  if (isRequestLikeError(err)) {
    switch (err.status) {
      case 401:
        return "PAT invalid or missing gist scope";
      case 403:
        return "Rate limited or forbidden";
      case 404:
        return "Gist not found";
      case 422:
        return `Validation error: ${err.response?.data?.message ?? err.message}`;
      default:
        return `GitHub API error (${err.status}): ${err.message}`;
    }
  }
  if (err instanceof Error) return `Gist operation failed: ${err.message}`;
  return "Gist operation failed: unknown error";
}

function errorResult(err: unknown) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: mapError(err) }],
  };
}

function jsonResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

function summarizeGist(g: OctokitGist): GistSummary {
  const filenames: string[] = [];
  if (g.files) {
    for (const [key, file] of Object.entries(g.files)) {
      if (!file) continue;
      filenames.push(file.filename ?? key);
    }
  }
  return {
    id: g.id ?? "",
    description: g.description ?? null,
    public: g.public ?? false,
    files: filenames,
    html_url: g.html_url ?? "",
    updated_at: g.updated_at ?? "",
  };
}

async function resolveFileContent(
  file: OctokitGistFile,
  key: string,
): Promise<GistFileDetail> {
  let content = file.content ?? "";
  const truncated = file.truncated ?? false;
  // GitHub truncates files >1 MB in the main API response; re-fetch from raw_url to get full content.
  if (truncated && file.raw_url) {
    try {
      const raw = await fetch(file.raw_url, {
        headers: {
          Authorization: `token ${githubPat ?? ""}`,
          "User-Agent": "personal-mcp/0.1.0",
        },
      });
      if (raw.ok) content = await raw.text();
    } catch {
      // Prefer returning partial content over failing the whole gist_get.
    }
  }
  return {
    filename: file.filename ?? key,
    language: file.language ?? null,
    type: file.type ?? null,
    size: file.size ?? 0,
    truncated,
    content,
  };
}

async function detailGist(g: OctokitGist): Promise<GistDetail> {
  const files: GistFileDetail[] = [];
  if (g.files) {
    for (const [key, file] of Object.entries(g.files)) {
      if (!file) continue;
      files.push(await resolveFileContent(file, key));
    }
  }
  return {
    id: g.id ?? "",
    description: g.description ?? null,
    public: g.public ?? false,
    html_url: g.html_url ?? "",
    created_at: g.created_at ?? "",
    updated_at: g.updated_at ?? "",
    files,
  };
}

const filePatchSchema = z.union([
  z.null(),
  z.object({
    filename: z.string().optional(),
    content: z.string().optional(),
  }),
]);

const createFilesSchema = z.record(z.string(), z.string());
const updateFilesSchema = z.record(z.string(), filePatchSchema);

export function registerGistTools(server: McpServer): void {
  if (!octokit) return;
  // Local const narrows octokit to non-null inside the closures below.
  const client = octokit;

  server.registerTool(
    "gist_list",
    {
      title: "List gists",
      description:
        "List the 100 most recently updated gists for the authenticated user. " +
        "Returns summary only (id, description, public, filenames, html_url, updated_at) — " +
        "no file contents. Use gist_get to retrieve contents. Older gists beyond the " +
        "first 100 are not accessible via this tool.",
      inputSchema: {},
    },
    async () => {
      try {
        const response = await client.rest.gists.list({ per_page: 100 });
        const summaries = response.data.map((g) =>
          summarizeGist(g as OctokitGist),
        );
        return jsonResult({ count: summaries.length, gists: summaries });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "gist_get",
    {
      title: "Get gist",
      description:
        "Fetch a single gist by id, including full contents of every file. " +
        "Files marked as truncated by the GitHub API are auto-fetched from their raw_url.",
      inputSchema: {
        id: z.string().min(1).describe("Gist id (the hex string from html_url)"),
      },
    },
    async ({ id }) => {
      try {
        const response = await client.rest.gists.get({ gist_id: id });
        return jsonResult(await detailGist(response.data as OctokitGist));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "gist_create",
    {
      title: "Create gist",
      description:
        "Create a new gist. `files` is a flat map from filename to content string " +
        '(e.g. { "notes.md": "# Hello" }). `public` defaults to false (secret gist).',
      inputSchema: {
        files: createFilesSchema.describe(
          "Map from filename to file content. At least one file required.",
        ),
        description: z.string().optional(),
        public: z.boolean().optional(),
      },
    },
    async ({ files, description, public: isPublic }) => {
      try {
        const entries = Object.entries(files);
        if (entries.length === 0) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: "Validation error: at least one file is required",
              },
            ],
          };
        }
        const githubFiles: { [filename: string]: { content: string } } = {};
        for (const [name, content] of entries) {
          githubFiles[name] = { content };
        }
        const response = await client.rest.gists.create({
          description: description ?? "",
          public: isPublic ?? false,
          files: githubFiles,
        });
        return jsonResult(await detailGist(response.data as OctokitGist));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "gist_update",
    {
      title: "Update gist",
      description:
        "Update an existing gist. All arguments except `id` are optional. " +
        "The `files` map uses GitHub's quirky shape:\n" +
        '  • Update content:   { "foo.txt": { "content": "new" } }\n' +
        '  • Rename:           { "foo.txt": { "filename": "bar.txt" } }\n' +
        '  • Rename + update:  { "foo.txt": { "filename": "bar.txt", "content": "new" } }\n' +
        '  • Delete file:      { "foo.txt": null }\n' +
        '  • Add file:         { "new.txt": { "content": "hi" } }\n' +
        "Pass only the files you want to change. Omit `files` entirely to edit just the description.",
      inputSchema: {
        id: z.string().min(1),
        files: updateFilesSchema.optional(),
        description: z.string().optional(),
      },
    },
    async ({ id, files, description }) => {
      try {
        const updateParams: {
          gist_id: string;
          description?: string;
          files?: unknown;
        } = { gist_id: id };
        if (description !== undefined) updateParams.description = description;
        if (files !== undefined) updateParams.files = files;
        const response = await client.rest.gists.update(
          updateParams as Parameters<typeof client.rest.gists.update>[0],
        );
        return jsonResult(await detailGist(response.data as OctokitGist));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "gist_delete",
    {
      title: "Delete gist",
      description: "Permanently delete a gist by id. This cannot be undone.",
      inputSchema: {
        id: z.string().min(1),
      },
    },
    async ({ id }) => {
      try {
        await client.rest.gists.delete({ gist_id: id });
        return jsonResult({ ok: true, id });
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
