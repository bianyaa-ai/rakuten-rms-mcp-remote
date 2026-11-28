import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { registerCabinetTools } from "./cabinet.js";
import { registerContentsTools as registerContentsListTools } from "./contents.js";
import { registerWidgetTools } from "./widgets.js";
import { registerContentsWriteTools } from "./contents-write.js";
import { registerContentsUpdateTools } from "./contents-update.js";
import {
  CONTENTS_WRITE_ENV,
  CONTENTS_WRITE_TOOLS,
  isContentsWriteEnabled
} from "./gate.js";

export const CONTENTS_SERVICE_VERSION = "1.1.0";

export const AI_CONTENTS_FOLDER_ID = 14313603;

/** Every tool name registered by registerContentsTools. */
export const CONTENTS_TOOL_NAMES = [
  "contents_health",
  "cabinet_list_folders",
  "cabinet_list_files",
  "cabinet_upload_image",
  "contents_list",
  "contents_widget_validate",
  "contents_widget_create",
  "contents_create",
  "contents_update_preview",
  "contents_update"
] as const;

export function contentsHealthPayload(
  env: NodeJS.ProcessEnv = process.env
) {
  const rmsServiceSecretConfigured =
    Boolean(env.RMS_SERVICE_SECRET?.trim());
  const rmsLicenseKeyConfigured =
    Boolean(env.RMS_LICENSE_KEY?.trim());

  return {
    ok: true,
    service: "rakuten-rms-mcp-remote",
    module: "contents",
    version: CONTENTS_SERVICE_VERSION,
    // The request reached this tool only after the host's /mcp
    // bearer auth (OAuth 2.1 access token or static API key) passed.
    authentication: "unified-mcp-oauth",
    authenticated: true,
    writeEnabled: isContentsWriteEnabled(env),
    writeEnvVar: CONTENTS_WRITE_ENV,
    writeTools: [...CONTENTS_WRITE_TOOLS],
    rmsServiceSecretConfigured,
    rmsLicenseKeyConfigured,
    rmsCredentialsConfigured:
      rmsServiceSecretConfigured && rmsLicenseKeyConfigured,
    rakutenApiConnectionVerified: false,
    cabinet: {
      targetFolderId: AI_CONTENTS_FOLDER_ID,
      targetFolderName: "AIコンテンツ",
      targetFolderPath: "/ai-contents"
    }
  };
}

function registerHealth(server: McpServer): void {
  server.registerTool(
    "contents_health",
    {
      description:
        "楽天コンテンツ/R-Cabinetツールの状態を確認する。" +
        "統合MCP認証・書き込みゲート・楽天API認証情報の設定状況を返す。" +
        "楽天APIは呼び出さない。",
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false
      }
    },
    async () => ({
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(contentsHealthPayload(), null, 2)
        }
      ]
    })
  );
}

/**
 * Register all Contents / R-Cabinet tools on the host's existing McpServer.
 * Authentication is handled by the host's /mcp bearer middleware; write
 * tools are additionally gated by RMS_CONTENTS_ENABLE_WRITE (default OFF).
 */
export function registerContentsTools(server: McpServer): void {
  registerHealth(server);
  registerCabinetTools(server);
  registerContentsListTools(server);
  registerWidgetTools(server);
  registerContentsWriteTools(server);
  registerContentsUpdateTools(server);
}
