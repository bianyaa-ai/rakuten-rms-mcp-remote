/**
 * Independent write gate for the Contents / R-Cabinet tools.
 *
 * RMS_CONTENTS_ENABLE_WRITE is separate from RMS_MCP_ENABLE_WRITE (RMS tools).
 * Default is OFF: only the exact string "true" (case-insensitive, trimmed)
 * enables Contents write tools. The variable is read on every call so a
 * change takes effect without re-registering tools.
 */

export const CONTENTS_WRITE_ENV = "RMS_CONTENTS_ENABLE_WRITE";

/** Tools that change Rakuten data. Everything else in Contents is read-only. */
export const CONTENTS_WRITE_TOOLS = [
  "cabinet_upload_image",
  "contents_create",
  "contents_update",
  "contents_widget_create"
] as const;

export function isContentsWriteEnabled(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return env[CONTENTS_WRITE_ENV]?.trim().toLowerCase() === "true";
}

export const CONTENTS_WRITE_DISABLED_MESSAGE =
  `Contents write tools are disabled. ` +
  `Set ${CONTENTS_WRITE_ENV}=true on the server to enable ` +
  `cabinet_upload_image, contents_create, contents_update ` +
  `and contents_widget_create. No Rakuten request was made.`;

/**
 * Returns an MCP error result when writes are disabled, otherwise null.
 * Call first in every write tool handler, before validation or any network I/O.
 */
export function contentsWriteBlockedResult(
  env: NodeJS.ProcessEnv = process.env
) {
  if (isContentsWriteEnabled(env)) return null;
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: CONTENTS_WRITE_DISABLED_MESSAGE
      }
    ]
  };
}
