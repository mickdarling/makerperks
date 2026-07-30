/**
 * MakerPerks MCP server — a first-party, read-only Model Context Protocol endpoint
 * over the builder-perks directory. Runs as a Cloudflare Worker (Durable Object via
 * the `agents` SDK's McpAgent). It reads the published `perks.json` (the same source
 * of truth as the static agent outputs), caches it briefly, and exposes intent-shaped
 * query tools so an agent can ask "what can an X claim?" without fetching and
 * filtering the whole dataset.
 *
 * Transports: Streamable HTTP at `/mcp` (modern) and SSE at `/sse` (legacy).
 * Public, read-only, soft per-IP rate limit. No auth, no mutating tools.
 */
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

interface Env {
  MCP_OBJECT: DurableObjectNamespace;
  RATE_LIMITER: { limit(opts: { key: string }): Promise<{ success: boolean }> };
  PERKS_JSON_URL: string;
  ACCELERATORS_JSON_URL: string;
}

/** One program as published in /perks.json (see src/pages/perks.json.ts). */
interface Perk {
  slug: string;
  title: string;
  provider: string;
  url: string;
  audience: string[];
  tags: string[];
  value_type: string;
  currency: string;
  min_value: number;
  max_value: number;
  value_display: string;
  region: string;
  status: string;
  aggregator: boolean;
  unlocks: string[];
  sources: string[];
  verified: string;
}

interface PerksDataset {
  name: string;
  description: string;
  homepage: string;
  generated: string;
  count: number;
  programs: Perk[];
}

/** Persona ids the directory uses, with display labels. */
const PERSONA_LABELS: Record<string, string> = {
  startup: "Startups",
  student: "Students",
  oss: "Open-source maintainers",
  indie: "Indie developers",
  ambassador: "Ambassadors",
  nonprofit: "Non-profits",
};
const PERSONA_IDS = Object.keys(PERSONA_LABELS) as [string, ...string[]];

// Module-level cache: persists across requests handled by the same isolate, so we
// don't refetch perks.json on every call. Serves last-good on a failed refresh.
let perksCache: { data: PerksDataset; fetchedAt: number } | null = null;
const PERKS_TTL_MS = 5 * 60 * 1000;

async function loadPerks(env: Env): Promise<PerksDataset> {
  const now = Date.now();
  if (perksCache && now - perksCache.fetchedAt < PERKS_TTL_MS) {
    return perksCache.data;
  }
  try {
    const res = await fetch(env.PERKS_JSON_URL, {
      // Edge-cache the upstream fetch too; cheap and resilient.
      cf: { cacheTtl: 300, cacheEverything: true },
    });
    if (!res.ok) throw new Error(`perks.json fetch failed: ${res.status}`);
    const data = (await res.json()) as PerksDataset;
    perksCache = { data, fetchedAt: now };
    return data;
  } catch (err) {
    if (perksCache) return perksCache.data; // serve last-good rather than fail
    throw err;
  }
}

/** One program as published in datasets/accelerators/accelerators.json. */
interface Accelerator {
  slug: string;
  title: string;
  provider: string;
  url: string;
  apply_url: string;
  category: string;
  tags: string[];
  stage: string[];
  value_type: string;
  currency: string;
  max_value: number;
  value_display: string;
  equity: string;
  cohort_model: string;
  format: string;
  location: string;
  region: string;
  next_cohort: string | null;
  next_deadline: string | null;
  deadline_note: string | null;
  eligibility: string;
  status: string;
  fit: string;
  fit_note: string;
  sources: string[];
  verified: string;
}

interface AcceleratorsDataset {
  name: string;
  description: string;
  generated: string;
  count: number;
  programs: Accelerator[];
}

const ACCEL_CATEGORIES = [
  "flagship",
  "ai",
  "non_dilutive",
  "vendor",
  "regional",
  "university",
] as const;
const ACCEL_FORMATS = ["remote", "hybrid", "in_person"] as const;

// Loaded lazily inside accelerator tool handlers (not at init) so a failing
// accelerators fetch can never take the perks tools down with it.
let accelCache: { data: AcceleratorsDataset; fetchedAt: number } | null = null;

async function loadAccelerators(env: Env): Promise<AcceleratorsDataset> {
  const now = Date.now();
  if (accelCache && now - accelCache.fetchedAt < PERKS_TTL_MS) {
    return accelCache.data;
  }
  try {
    const res = await fetch(env.ACCELERATORS_JSON_URL, {
      cf: { cacheTtl: 300, cacheEverything: true },
    });
    if (!res.ok)
      throw new Error(`accelerators.json fetch failed: ${res.status}`);
    const data = (await res.json()) as AcceleratorsDataset;
    accelCache = { data, fetchedAt: now };
    return data;
  } catch (err) {
    if (accelCache) return accelCache.data; // serve last-good rather than fail
    throw err;
  }
}

const byValueDesc = (a: Perk, b: Perk) =>
  (b.max_value ?? 0) - (a.max_value ?? 0);

const byAccelValueDesc = (a: Accelerator, b: Accelerator) =>
  (b.max_value ?? 0) - (a.max_value ?? 0);

/** Non-dilutive = the money/value doesn't cost equity. */
const isNonDilutive = (p: Accelerator) =>
  ["grant", "credits", "services"].includes(p.value_type) ||
  p.equity === "none";

/** MCP tool results carry structured JSON as text content. */
function jsonResult(obj: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }],
  };
}

export class MakerPerksMCP extends McpAgent<Env> {
  server = new McpServer({ name: "makerperks", version: "1.0.0" });

  async init() {
    const data = await loadPerks(this.env);

    this.server.registerTool(
      "search_perks",
      {
        description:
          "Search builder-perk programs. All filters optional and combinable: free-text query (matches title, provider, slug, tag), audience/persona, category (tag), and a minimum dollar value. Results are sorted by value, highest first.",
        inputSchema: {
          query: z
            .string()
            .optional()
            .describe("Free-text match on title, provider, slug, or tag"),
          audience: z
            .enum(PERSONA_IDS)
            .optional()
            .describe(
              "Persona id: startup, student, oss, indie, ambassador, nonprofit",
            ),
          category: z
            .string()
            .optional()
            .describe(
              "Tag/category, e.g. ai, cloud, database (see list_categories)",
            ),
          min_value: z
            .number()
            .optional()
            .describe("Only perks whose max_value is at least this (USD)"),
          limit: z
            .number()
            .int()
            .positive()
            .max(100)
            .optional()
            .describe("Max results to return (default 25)"),
        },
      },
      async ({ query, audience, category, min_value, limit }) => {
        let r = data.programs;
        if (audience) r = r.filter((p) => p.audience.includes(audience));
        if (category) r = r.filter((p) => p.tags.includes(category));
        if (typeof min_value === "number")
          r = r.filter((p) => (p.max_value ?? 0) >= min_value);
        if (query) {
          const q = query.toLowerCase();
          r = r.filter(
            (p) =>
              p.title.toLowerCase().includes(q) ||
              p.provider.toLowerCase().includes(q) ||
              p.slug.toLowerCase().includes(q) ||
              p.tags.some((t) => t.toLowerCase().includes(q)),
          );
        }
        const sorted = [...r].sort(byValueDesc);
        const returned = sorted.slice(0, limit ?? 25);
        return jsonResult({
          count: sorted.length,
          returned: returned.length,
          perks: returned,
        });
      },
    );

    this.server.registerTool(
      "perks_for_persona",
      {
        description:
          "List all perks a given persona qualifies for, sorted by value (highest first). The directory's core 'I am X — what can I claim?' query.",
        inputSchema: {
          persona: z
            .enum(PERSONA_IDS)
            .describe("startup, student, oss, indie, ambassador, or nonprofit"),
        },
      },
      async ({ persona }) => {
        const perks = data.programs
          .filter((p) => p.audience.includes(persona))
          .sort(byValueDesc);
        return jsonResult({
          persona,
          label: PERSONA_LABELS[persona] ?? persona,
          count: perks.length,
          perks,
        });
      },
    );

    this.server.registerTool(
      "get_perk",
      {
        description:
          "Get one program by its slug (e.g. 'aws/aws-activate'). Returns the full record, or notFound if no such slug.",
        inputSchema: {
          slug: z.string().describe("Program slug, e.g. aws/aws-activate"),
        },
      },
      async ({ slug }) => {
        const perk = data.programs.find((p) => p.slug === slug);
        return jsonResult(perk ?? { notFound: true, slug });
      },
    );

    this.server.registerTool(
      "list_personas",
      {
        description:
          "List the personas (audiences) the directory supports, with the count of perks available to each.",
        inputSchema: {},
      },
      async () =>
        jsonResult({
          personas: Object.entries(PERSONA_LABELS).map(([id, label]) => ({
            id,
            label,
            count: data.programs.filter((p) => p.audience.includes(id)).length,
          })),
        }),
    );

    this.server.registerTool(
      "list_categories",
      {
        description:
          "List the categories (tags) used across the directory, each with how many perks carry it, sorted by frequency.",
        inputSchema: {},
      },
      async () => {
        const counts = new Map<string, number>();
        for (const p of data.programs) {
          for (const t of p.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
        }
        const categories = [...counts.entries()]
          .map(([tag, count]) => ({ tag, count }))
          .sort((a, b) => b.count - a.count);
        return jsonResult({ count: categories.length, categories });
      },
    );

    // ---- Accelerators dataset tools (perks.json-family; loaded lazily so a ----
    // ---- failed accelerators fetch never disables the perks tools above.  ----

    const accelUnavailable = (err: unknown) =>
      jsonResult({
        error: "accelerators dataset unavailable",
        detail: err instanceof Error ? err.message : String(err),
      });

    this.server.registerTool(
      "search_accelerators",
      {
        description:
          "Search the accelerators/incubators/founder-programs directory. All filters optional and combinable: free-text query (title, provider, slug, tag, location), category, format, region, non-dilutive-only, and minimum program value (USD). Active programs only unless include_inactive is set. Sorted by value, highest first. Note: fit/fit_note fields are relative to the dataset maintainer's founder profile — advisory, not universal.",
        inputSchema: {
          query: z
            .string()
            .optional()
            .describe("Free-text match on title, provider, slug, tag, location"),
          category: z
            .enum(ACCEL_CATEGORIES)
            .optional()
            .describe(
              "flagship, ai, non_dilutive, vendor, regional, or university",
            ),
          format: z
            .enum(ACCEL_FORMATS)
            .optional()
            .describe("remote, hybrid, or in_person"),
          region: z
            .string()
            .optional()
            .describe("Region tag, e.g. global, us, boston"),
          non_dilutive: z
            .boolean()
            .optional()
            .describe("Only programs that take no equity (grants/credits/services)"),
          min_value: z
            .number()
            .optional()
            .describe("Only programs whose max_value is at least this (USD)"),
          include_inactive: z
            .boolean()
            .optional()
            .describe(
              "Include Defunct/Paused/Unverified entries (kept as landscape memory)",
            ),
          limit: z
            .number()
            .int()
            .positive()
            .max(100)
            .optional()
            .describe("Max results to return (default 25)"),
        },
      },
      async ({
        query,
        category,
        format,
        region,
        non_dilutive,
        min_value,
        include_inactive,
        limit,
      }) => {
        let data: AcceleratorsDataset;
        try {
          data = await loadAccelerators(this.env);
        } catch (err) {
          return accelUnavailable(err);
        }
        let r = data.programs;
        if (!include_inactive) r = r.filter((p) => p.status === "Active");
        if (category) r = r.filter((p) => p.category === category);
        if (format) r = r.filter((p) => p.format === format);
        if (region) r = r.filter((p) => p.region === region);
        if (non_dilutive) r = r.filter(isNonDilutive);
        if (typeof min_value === "number")
          r = r.filter((p) => (p.max_value ?? 0) >= min_value);
        if (query) {
          const q = query.toLowerCase();
          r = r.filter(
            (p) =>
              p.title.toLowerCase().includes(q) ||
              p.provider.toLowerCase().includes(q) ||
              p.slug.toLowerCase().includes(q) ||
              (p.location ?? "").toLowerCase().includes(q) ||
              p.tags.some((t) => t.toLowerCase().includes(q)),
          );
        }
        const sorted = [...r].sort(byAccelValueDesc);
        const returned = sorted.slice(0, limit ?? 25);
        return jsonResult({
          count: sorted.length,
          returned: returned.length,
          accelerators: returned,
        });
      },
    );

    this.server.registerTool(
      "get_accelerator",
      {
        description:
          "Get one accelerator/program by its slug (e.g. 'ignition/ai-accelerator-singapore'). Returns the full record, or notFound if no such slug.",
        inputSchema: {
          slug: z
            .string()
            .describe("Program slug, e.g. ignition/ai-accelerator-singapore"),
        },
      },
      async ({ slug }) => {
        let data: AcceleratorsDataset;
        try {
          data = await loadAccelerators(this.env);
        } catch (err) {
          return accelUnavailable(err);
        }
        const program = data.programs.find((p) => p.slug === slug);
        return jsonResult(program ?? { notFound: true, slug });
      },
    );

    this.server.registerTool(
      "upcoming_deadlines",
      {
        description:
          "The radar query: active programs whose next application deadline falls within the next N days (default 60), soonest first with days remaining — plus active rolling/no-deadline programs you can start anytime. Deadline dates are ISO (YYYY-MM-DD); check deadline_note for timezone and decision-date detail.",
        inputSchema: {
          within_days: z
            .number()
            .int()
            .positive()
            .max(730)
            .optional()
            .describe("Deadline window in days from today (default 60)"),
          include_rolling: z
            .boolean()
            .optional()
            .describe(
              "Also list active rolling/no-deadline programs (default true)",
            ),
        },
      },
      async ({ within_days, include_rolling }) => {
        let data: AcceleratorsDataset;
        try {
          data = await loadAccelerators(this.env);
        } catch (err) {
          return accelUnavailable(err);
        }
        const windowDays = within_days ?? 60;
        const today = new Date().toISOString().slice(0, 10);
        const active = data.programs.filter((p) => p.status === "Active");
        const dayMs = 24 * 60 * 60 * 1000;
        const daysLeft = (iso: string) =>
          Math.round((Date.parse(iso) - Date.parse(today)) / dayMs);
        const dated = active
          .filter((p) => p.next_deadline)
          .map((p) => ({ program: p, days_left: daysLeft(p.next_deadline!) }))
          .filter((d) => d.days_left >= 0 && d.days_left <= windowDays)
          .sort((a, b) => a.days_left - b.days_left)
          .map(({ program, days_left }) => ({
            slug: program.slug,
            title: program.title,
            next_deadline: program.next_deadline,
            days_left,
            deadline_note: program.deadline_note,
            value_display: program.value_display,
            format: program.format,
            apply_url: program.apply_url,
          }));
        const rolling =
          include_rolling === false
            ? []
            : active
                .filter((p) => !p.next_deadline)
                .sort(byAccelValueDesc)
                .map((p) => ({
                  slug: p.slug,
                  title: p.title,
                  value_display: p.value_display,
                  format: p.format,
                  apply_url: p.apply_url,
                }));
        return jsonResult({
          as_of: today,
          within_days: windowDays,
          deadlines: dated,
          rolling,
        });
      },
    );
  }
}

const HELP = `MakerPerks MCP server
=====================

A first-party, read-only Model Context Protocol endpoint over the MakerPerks
builder-perks directory (https://makerperks.com).

Connect (Streamable HTTP, recommended):
  claude mcp add --transport http makerperks https://mcp.makerperks.com/mcp

Endpoints:
  POST /mcp   Streamable HTTP transport (modern MCP clients)
  GET  /sse   Server-Sent Events transport (legacy clients)
  GET  /      this help page

Tools (all read-only):
  search_perks(query?, audience?, category?, min_value?, limit?)
  perks_for_persona(persona)        persona: startup|student|oss|indie|ambassador|nonprofit
  get_perk(slug)                    e.g. aws/aws-activate
  list_personas()
  list_categories()

Accelerators dataset (perks.json family):
  search_accelerators(query?, category?, format?, region?, non_dilutive?,
                      min_value?, include_inactive?, limit?)
                                    category: flagship|ai|non_dilutive|vendor|regional|university
                                    format: remote|hybrid|in_person
  get_accelerator(slug)             e.g. ignition/ai-accelerator-singapore
  upcoming_deadlines(within_days?, include_rolling?)

Data: the same sources of truth as https://makerperks.com/perks.json and
datasets/accelerators/accelerators.json in the repo.
Public, read-only, soft rate-limited. No accounts, no auth, no tracking.
`;

const mcpHandler = MakerPerksMCP.serve("/mcp");
const sseHandler = MakerPerksMCP.serveSSE("/sse");

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "") {
      return new Response(HELP, {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    if (
      url.pathname === "/mcp" ||
      url.pathname === "/sse" ||
      url.pathname.startsWith("/sse/")
    ) {
      // Soft per-IP rate limit to cap abuse/cost (read-only, so this is the only guard).
      const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
      const { success } = await env.RATE_LIMITER.limit({ key: ip });
      if (!success) {
        return new Response(
          "429 Too Many Requests — slow down and retry shortly.",
          {
            status: 429,
            headers: { "content-type": "text/plain; charset=utf-8" },
          },
        );
      }
      return url.pathname === "/mcp"
        ? mcpHandler.fetch(request, env, ctx)
        : sseHandler.fetch(request, env, ctx);
    }

    return new Response("Not found. See / for usage.", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },
};
