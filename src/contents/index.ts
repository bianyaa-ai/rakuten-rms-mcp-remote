import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { registerCabinetTools } from "./cabinet.js";
import { registerContentsTools as registerContentsListTools } from "./contents.js";
import { registerWidgetTools } from "./widgets.js";
import { registerContentsWriteTools } from "./contents-write.js";
import { registerContentsUpdateTools } from "./contents-update.js";

export const CONTENTS_SERVICE_VERSION = "1.1.0";

export const AI_CONTENTS_FOLDER_ID = 14313603;

/**
 * Tools that change Rakuten data. Informational only (reported by
 * contents_health); there is no global write gate. Every one of them is
 * protected per operation by its own explicit confirmation input and schema.
 */
export const CONTENTS_WRITE_TOOLS = [
  "cabinet_upload_image",
  "contents_create",
  "contents_update",
  "contents_widget_create"
] as const;

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
    // The request reached this tool only after the host's shared /mcp
    // Bearer authentication passed. That check accepts either an access
    // token issued by the host's OAuth 2.1 flow or the configured static
    // Bearer API key. No secret value is ever returned here.
    authentication: "shared-bearer",
    authenticationMethods: [
      "oauth2.1-access-token",
      "static-bearer-api-key"
    ],
    authenticated: true,
    // No global write gate: write tools are available to authenticated
    // callers and protected per operation.
    globalWriteGate: false,
    writeTools: [...CONTENTS_WRITE_TOOLS],
    writeSafeguards: [
      "explicit confirmUpload/confirmCreate/confirmUpdate input",
      "strict input schema validation",
      "duplicate prevention",
      "private/unpublished page defaults",
      "mandatory widget validation before widget create",
      "expectedRevisionId check on update",
      "image upload deduplication, no overwrite",
      "no automatic retry after ambiguous writes",
      "read-after-write verification"
    ],
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
        "認証方式（OAuth 2.1発行のアクセストークンまたは設定済みの静的Bearer APIキーによる共有Bearer認証）、" +
        "書き込みツール一覧と操作ごとの安全策、楽天API認証情報の設定有無を返す。" +
        "シークレットの値は返さない。" +
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
 * Authentication is handled by the host's /mcp Bearer middleware. There is
 * no global write gate: each write tool protects itself with explicit
 * confirmation inputs, schema validation and its other per-operation checks.
 */
export function registerContentsTools(server: McpServer): void {
  registerHealth(server);
  registerCabinetTools(server);
  registerContentsListTools(server);
  registerWidgetTools(server);
  registerContentsWriteTools(server);
  registerContentsUpdateTools(server);
}
