import type { APIRoute } from "astro";
import {
  getPublishedPrograms,
  forAudience,
  displayValue,
  programPath,
  AUDIENCE_LABELS,
  type Audience,
} from "../lib/programs";
import { AUDIENCES } from "../content.config";

/**
 * /llms.txt — a curated index for LLM/agent consumption, grouped by persona,
 * linking each program. Follows the llmstxt.org convention.
 */
export const GET: APIRoute = async ({ site }) => {
  const base = (site?.toString() ?? "https://makerperks.com").replace(
    /\/$/,
    "",
  );
  const programs = await getPublishedPrograms();

  // Live popularity is served by the engagement Worker, never baked into this file
  // (counts are client-side + cached). Only advertise it when configured.
  const engagementBase = (
    import.meta.env.PUBLIC_ENGAGEMENT_ENDPOINT ?? ""
  ).replace(/\/$/, "");
  const countMin =
    Math.floor(Number(import.meta.env.PUBLIC_FAVORITES_COUNT_MIN)) || 10;

  const lines: string[] = [
    "# MakerPerks",
    "",
    "> A browseable, agent-friendly directory of builder perks (free credits, discounts, and programs) for startups, students, OSS maintainers, indie developers, and non-profits. Builder + dev-adjacent scope only. No ads, no affiliate links.",
    "",
    `Full machine-readable dataset: ${base}/perks.json`,
    `Full inlined version: ${base}/llms-full.txt`,
    "",
    "## For agents: query interface (MCP)",
    "",
    "Prefer querying over downloading the whole dataset. The official Model Context",
    "Protocol endpoint exposes read-only tools (search_perks, perks_for_persona,",
    "get_perk, list_personas, list_categories) over this same data:",
    "",
    "- MCP endpoint (Streamable HTTP): https://mcp.makerperks.com/mcp",
    "- Connect: `claude mcp add --transport http makerperks https://mcp.makerperks.com/mcp`",
    "",
  ];

  if (engagementBase) {
    lines.push(
      "## For agents: live popularity",
      "",
      "Favorite counts are deduplicated by identity and served live (never baked into this",
      "file). Targets below the display threshold are omitted by the endpoint:",
      "",
      `- Popular perks (saved by ${countMin}+): ${engagementBase}/counts?type=favorite&min=${countMin}`,
      "",
    );
  }

  for (const audience of AUDIENCES as readonly Audience[]) {
    const items = forAudience(programs, audience);
    if (!items.length) continue;
    lines.push(`## ${AUDIENCE_LABELS[audience]}`, "");
    for (const p of items) {
      const agg = p.data.aggregator ? " [gateway]" : "";
      lines.push(
        `- [${p.data.title}](${base}${programPath(p)})${agg}: ${displayValue(p.data)} — ${p.data.intro}`,
      );
    }
    lines.push("");
  }

  return new Response(lines.join("\n"), {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
};
