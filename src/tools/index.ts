import type { ModelInfo, Settings } from "../types";
import { computerTools } from "./computer";
import { fileTools } from "./files";
import { mcpManager } from "./mcp";
import { mediaModelFor, mediaTools } from "./media";
import type { Tool } from "./types";
import { webTools } from "./web";

/** The tools offered to the model for this turn, given the model and the user's switches. */
export async function activeTools(settings: Settings, model: ModelInfo): Promise<Tool[]> {
  if (!model.caps.tools) return [];
  const t = settings.tools;
  const out: Tool[] = [];
  if (t.files) out.push(...fileTools);
  if (t.media) {
    for (const tool of mediaTools) {
      // only offer generators there is a model for (chosen in Settings, or the best one available)
      if (tool.spec.name === "generate_image" && !mediaModelFor(settings, "image")) continue;
      if (tool.spec.name === "generate_video" && !mediaModelFor(settings, "video")) continue;
      out.push(tool);
    }
  }
  if (t.web) out.push(...webTools);
  if (t.computer) out.push(...computerTools());
  if (t.connectors && settings.mcpServers.some((s) => s.enabled)) out.push(...(await mcpManager.tools(settings.mcpServers)));
  return out;
}

export type { Tool, ToolContext, ToolOutput } from "./types";
