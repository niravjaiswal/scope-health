import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentConfig } from "./config";

/** Provider id under which the LLM proxy is registered in OpenCode. */
export const providerId = "arena";

/** Name of the browser MCP server. OpenCode prefixes its tools with `browser_`. */
export const browserServerName = "browser";

/**
 * Builds the OpenCode configuration. The LLM proxy is the only provider, the browser is a
 * Playwright MCP server running headless Chromium, and every tool that needs the internet is
 * off. The proxy URL and key are read by OpenCode from the environment at run time.
 */
export function buildOpencodeConfig(config: AgentConfig, browserOutputDir: string) {
  const model = `${providerId}/${config.model}`;
  return {
    $schema: "https://opencode.ai/config.json",
    autoupdate: false,
    share: "disabled",
    model,
    small_model: model,
    enabled_providers: [providerId],
    provider: {
      [providerId]: {
        npm: "@ai-sdk/openai-compatible",
        name: "Arena LLM proxy",
        options: {
          baseURL: "{env:LLM_BASE_URL}",
          apiKey: "{env:LLM_API_KEY}",
        },
        models: {
          [config.model]: {
            name: config.model,
            tool_call: true,
            attachment: true,
            // Without this, OpenCode refuses to hand a picture to the model: a screenshot or
            // a page image that the agent reads comes back as "this model does not support
            // image input".
            modalities: { input: ["text", "image"], output: ["text"] },
            limit: { context: 200000, output: 16000 },
          },
        },
      },
    },
    mcp: {
      [browserServerName]: {
        type: "local",
        command: [
          process.execPath,
          config.playwrightMcp,
          "--headless",
          "--browser",
          "chromium",
          "--no-sandbox",
          "--isolated",
          "--output-dir",
          browserOutputDir,
        ],
        enabled: true,
        timeout: 30000,
      },
    },
    tools: {
      webfetch: false,
      websearch: false,
      codesearch: false,
    },
    permission: {
      edit: "allow",
      bash: "allow",
      external_directory: "allow",
    },
    lsp: false,
    formatter: false,
  };
}

/**
 * Writes the OpenCode configuration to `opencode.json` in the work directory, and makes the
 * directory the browser writes its output to. Returns the path of the file.
 */
export async function writeOpencodeConfig(config: AgentConfig): Promise<string> {
  const browserOutputDir = join(config.workDir, "browser");
  await mkdir(browserOutputDir, { recursive: true });
  const configPath = join(config.workDir, "opencode.json");
  await writeFile(
    configPath,
    JSON.stringify(buildOpencodeConfig(config, browserOutputDir), null, 2),
    "utf8",
  );
  return configPath;
}
