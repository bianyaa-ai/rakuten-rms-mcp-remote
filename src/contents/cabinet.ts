
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { createHash } from "node:crypto";

const CABINET_API =
  "https://api.rms.rakuten.co.jp/es/1.0/cabinet";

const AI_CONTENTS_FOLDER_ID = 14313603;

const ALLOWED_HOSTS = new Set([
  "iwiss.co.jp",
  "www.iwiss.co.jp"
]);

const MAX_IMAGE_BYTES = 2_000_000;

function getAuthorization(): string {
  const serviceSecret =
    process.env.RMS_SERVICE_SECRET?.trim();

  const licenseKey =
    process.env.RMS_LICENSE_KEY?.trim();

  if (!serviceSecret || !licenseKey) {
    throw new Error(
      "楽天RMS API認証情報が未設定です"
    );
  }

  const credentials = Buffer.from(
    `${serviceSecret}:${licenseKey}`,
    "utf8"
  ).toString("base64");

  return `ESA ${credentials}`;
}

function xmlValue(
  xml: string,
  tag: string
): string | undefined {
  const match = xml.match(
    new RegExp(
      `<${tag}>\\s*([^<]*?)\\s*</${tag}>`
    )
  );

  return match?.[1]?.trim();
}

function validateResult(
  xml: string,
  resultTag: string
): void {
  const systemStatus =
    xmlValue(xml, "systemStatus");

  const resultBlock = xml.match(
    new RegExp(
      `<${resultTag}>[\\s\\S]*?</${resultTag}>`
    )
  )?.[0];

  const resultCode = resultBlock
    ? xmlValue(resultBlock, "resultCode")
    : undefined;

  if (
    systemStatus !== "OK" ||
    resultCode !== "0"
  ) {
    throw new Error(
      `楽天API処理エラー: systemStatus=${
        systemStatus ?? "unknown"
      }, resultCode=${
        resultCode ?? "unknown"
      }`
    );
  }
}

async function cabinetGet(
  endpoint: string,
  params: Record<string, string>,
  resultTag: string
): Promise<string> {
  const url = new URL(
    `${CABINET_API}/${endpoint}`
  );

  for (const [key, value] of Object.entries(
    params
  )) {
    url.searchParams.set(key, value);
  }

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: getAuthorization(),
      Accept: "application/xml"
    },
    redirect: "error",
    signal: AbortSignal.timeout(30000)
  });

  if (!response.ok) {
    throw new Error(
      `R-Cabinet API error: HTTP ${response.status}`
    );
  }

  const result = await response.text();

  validateResult(result, resultTag);

  return result;
}

async function listFolders(
  offset: number,
  limit: number
): Promise<string> {
  return cabinetGet(
    "folders/get",
    {
      offset: String(offset),
      limit: String(limit)
    },
    "cabinetFoldersGetResult"
  );
}

async function listFiles(
  offset: number,
  limit: number
): Promise<string> {
  return cabinetGet(
    "folder/files/get",
    {
      folderId: String(AI_CONTENTS_FOLDER_ID),
      offset: String(offset),
      limit: String(limit)
    },
    "cabinetFolderFilesGetResult"
  );
}

function validateImageUrl(
  imageUrl: string
): URL {
  const url = new URL(imageUrl);

  if (
    url.protocol !== "https:" ||
    !ALLOWED_HOSTS.has(url.hostname) ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "許可されていない画像URLです"
    );
  }

  if (
    !url.pathname.startsWith(
      "/wp-content/uploads/"
    ) ||
    !/\.(jpe?g|png|gif)$/i.test(
      url.pathname
    )
  ) {
    throw new Error(
      "WordPressのJPG・PNG・GIF画像のみ登録できます"
    );
  }

  return url;
}

async function downloadImage(
  imageUrl: string
) {
  const url = validateImageUrl(imageUrl);

  const response = await fetch(url, {
    method: "GET",
    redirect: "error",
    headers: {
      Accept:
        "image/jpeg,image/png,image/gif"
    },
    signal: AbortSignal.timeout(30000)
  });

  if (!response.ok) {
    throw new Error(
      `画像取得エラー: HTTP ${response.status}`
    );
  }

  const mime = (
    response.headers.get("content-type") ||
    ""
  ).split(";")[0].trim().toLowerCase();

  const allowedTypes: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/gif": "gif"
  };

  const extension = allowedTypes[mime];

  if (!extension) {
    await response.body?.cancel();

    throw new Error(
      "対応していない画像形式です"
    );
  }

  const contentLength = Number(
    response.headers.get("content-length") ||
    "0"
  );

  if (contentLength > MAX_IMAGE_BYTES) {
    await response.body?.cancel();

    throw new Error(
      "画像容量が2MBを超えています"
    );
  }

  if (!response.body) {
    throw new Error(
      "画像データを取得できませんでした"
    );
  }

  const reader = response.body.getReader();

  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } =
        await reader.read();

      if (done) break;

      total += value.byteLength;

      if (total > MAX_IMAGE_BYTES) {
        await reader.cancel();

        throw new Error(
          "画像容量が2MBを超えています"
        );
      }

      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  if (total === 0) {
    throw new Error(
      "画像データが空です"
    );
  }

  const bytes = Buffer.concat(chunks);

  // Check image file signatures.
  const validJpeg =
    mime === "image/jpeg" &&
    bytes.length >= 4 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff;

  const validPng =
    mime === "image/png" &&
    bytes.subarray(0, 8).equals(
      Buffer.from([
        137, 80, 78, 71,
        13, 10, 26, 10
      ])
    );

  const validGif =
    mime === "image/gif" &&
    ["GIF87a", "GIF89a"].includes(
      bytes.subarray(0, 6).toString("ascii")
    );

  if (!validJpeg && !validPng && !validGif) {
    throw new Error(
      "画像形式と実際のデータが一致しません"
    );
  }

  return {
    bytes,
    mime,
    extension
  };
}

const RAKUTEN_IMAGE_BASE =
  "https://image.rakuten.co.jp/iwiss/cabinet/ai-contents";

function imageLog(
  stage: string,
  startedAt: number,
  details: Record<string, unknown> = {}
): void {
  console.log(
    "CABINET diagnostic:",
    JSON.stringify({
      stage,
      elapsedMs: Date.now() - startedAt,
      ...details
    })
  );
}

async function findExistingImage(
  filePath: string
): Promise<string | undefined> {
  const limit = 100;
  let offset = 1;

  for (let page = 0; page < 1000; page++) {
    const xml = await listFiles(offset, limit);

    const files =
      xml.match(/<file>[\s\S]*?<\/file>/g) || [];

    const countText = xmlValue(xml, "fileCount");
    const totalText = xmlValue(xml, "fileAllCount");

    if (
      countText === undefined ||
      totalText === undefined ||
      !/^\d+$/.test(countText) ||
      !/^\d+$/.test(totalText)
    ) {
      throw new Error(
        "画像一覧の件数を確認できません"
      );
    }

    const count = Number(countText);
    const total = Number(totalText);

    if (files.length !== count) {
      throw new Error(
        "画像一覧の解析結果が一致しません"
      );
    }

    for (const file of files) {
      const path = xmlValue(file, "FilePath");
      const id = xmlValue(file, "FileId");

      if (
        path &&
        path.split("/").pop() === filePath
      ) {
        if (!id || !/^[1-9]\d*$/.test(id)) {
          throw new Error(
            "登録済み画像のIDを確認できません"
          );
        }

        return id;
      }
    }

    if ((offset - 1) * limit + count >= total) {
      return undefined;
    }

    if (count === 0) {
      throw new Error(
        "画像一覧を最後まで取得できません"
      );
    }

    offset += 1;
  }

  throw new Error(
    "画像検索の上限に達しました"
  );
}

function makeImageResult(
  fileId: string,
  filePath: string,
  imageUrl: string,
  reused: boolean
): string {
  return JSON.stringify(
    {
      ok: true,
      folderId: AI_CONTENTS_FOLDER_ID,
      folderName: "AIコンテンツ",
      fileId,
      fileName: filePath,
      sourceUrl: imageUrl,
      rakutenImageUrl:
        `${RAKUTEN_IMAGE_BASE}/${filePath}`,
      reused,
      overwrite: false,
      uploadResult:
        reused ? "reused" : "success"
    },
    null,
    2
  );
}

async function uploadImage(
  imageUrl: string
): Promise<string> {
  const startedAt = Date.now();
  const authorization = getAuthorization();

  imageLog("upload_start", startedAt);

  const downloadStartedAt = Date.now();

  const {
    bytes,
    mime,
    extension
  } = await downloadImage(imageUrl);

  imageLog(
    "download_complete",
    downloadStartedAt,
    { bytes: bytes.byteLength, mime }
  );

  const hash = createHash("sha256")
    .update(bytes)
    .digest("hex")
    .slice(0, 12);

  const filePath = `ai-${hash}.${extension}`;

  const lookupStartedAt = Date.now();

  const existingId =
    await findExistingImage(filePath);

  imageLog(
    "existing_image_check",
    lookupStartedAt,
    {
      filePath,
      found: Boolean(existingId)
    }
  );

  // Reuse existing images.
  if (existingId) {
    imageLog("image_reused", startedAt, {
      fileId: existingId,
      filePath
    });

    return makeImageResult(
      existingId,
      filePath,
      imageUrl,
      true
    );
  }

  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<request>",
    "<fileInsertRequest>",
    "<file>",
    `<fileName>${filePath}</fileName>`,
    `<folderId>${AI_CONTENTS_FOLDER_ID}</folderId>`,
    `<filePath>${filePath}</filePath>`,
    "<overWrite>false</overWrite>",
    "</file>",
    "</fileInsertRequest>",
    "</request>"
  ].join("");

  const form = new FormData();

  form.append("xml", xml);

  form.append(
    "file",
    new Blob(
      [Uint8Array.from(bytes)],
      { type: mime }
    ),
    filePath
  );

  const uploadStartedAt = Date.now();

  try {
    imageLog(
      "rakuten_upload_start",
      uploadStartedAt,
      { filePath }
    );

    const response = await fetch(
      `${CABINET_API}/file/insert`,
      {
        method: "POST",
        headers: {
          Authorization: authorization,
          Accept: "application/xml"
        },
        body: form,
        redirect: "error",
        signal: AbortSignal.timeout(30000)
      }
    );

    imageLog(
      "rakuten_response",
      uploadStartedAt,
      { httpStatus: response.status }
    );

    if (!response.ok) {
      throw new Error(
        `画像登録APIエラー: HTTP ${response.status}`
      );
    }

    const result = await response.text();

    validateResult(
      result,
      "cabinetFileInsertResult"
    );

    const fileId = xmlValue(
      result,
      "FileId"
    );

    if (
      !fileId ||
      !/^[1-9]\d*$/.test(fileId)
    ) {
      throw new Error(
        "画像IDを確認できません"
      );
    }

    imageLog(
      "upload_success",
      startedAt,
      { fileId, filePath }
    );

    return makeImageResult(
      fileId,
      filePath,
      imageUrl,
      false
    );

  } catch (error) {
    imageLog(
      "upload_response_error",
      uploadStartedAt,
      {
        filePath,
        errorType:
          error instanceof Error
            ? error.name
            : "unknown"
      }
    );

    // Never automatically repeat the upload.
    try {
      const recoveredId =
        await findExistingImage(filePath);

      if (recoveredId) {
        imageLog(
          "upload_recovered",
          startedAt,
          {
            fileId: recoveredId,
            filePath
          }
        );

        return JSON.stringify({
          ok: true,
          folderId: AI_CONTENTS_FOLDER_ID,
          fileId: recoveredId,
          fileName: filePath,
          rakutenImageUrl:
            `${RAKUTEN_IMAGE_BASE}/${filePath}`,
          uploadResult: "confirmed_by_lookup",
          overwrite: false
        }, null, 2);
      }
    } catch {
      imageLog(
        "recovery_lookup_failed",
        startedAt,
        { filePath }
      );
    }

    throw new Error(
      `画像登録結果が未確定です。` +
      `ファイル名: ${filePath}。` +
      `自動再登録は禁止します。` +
      `cabinet_list_files で登録状況を確認してください。` +
      `原因: ${
        error instanceof Error
          ? error.message
          : "unknown"
      }`
    );
  }
}


function successResult(text: string) {
  return {
    content: [
      {
        type: "text" as const,
        text
      }
    ]
  };
}

function errorResult(error: unknown) {
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text:
          error instanceof Error
            ? error.message
            : "R-Cabinet API error"
      }
    ]
  };
}

export function registerCabinetTools(
  server: McpServer
): void {

  // Tool 1: List folders.
  server.registerTool(
    "cabinet_list_folders",
    {
      description:
        "楽天R-Cabinetのフォルダ一覧を取得する。読み取り専用。",
      inputSchema: z.object({
        offset: z.number().int().min(1).default(1),
        limit: z.number().int().min(1).max(100).default(100)
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true
      }
    },
    async ({ offset, limit }) => {
      try {
        return successResult(
          await listFolders(offset, limit)
        );
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  // Tool 2: List images in AI contents.
  server.registerTool(
    "cabinet_list_files",
    {
      description:
        "AIコンテンツ専用フォルダ内の画像一覧を取得する。読み取り専用。",
      inputSchema: z.object({
        offset: z.number().int().min(1).default(1),
        limit: z.number().int().min(1).max(100).default(100)
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true
      }
    },
    async ({ offset, limit }) => {
      try {
        return successResult(
          await listFiles(offset, limit)
        );
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  // Tool 3: Upload one WordPress image.
  server.registerTool(
    "cabinet_upload_image",
    {
      description:
        "ユーザーが承認したIWISS WordPress画像1枚をAIコンテンツフォルダに登録する。既存画像の上書き・削除は禁止。",
      inputSchema: z.object({
        imageUrl: z.string().url().max(2048),
        confirmUpload: z.literal(true)
          .describe(
            "ユーザーが画像登録を明示的に承認した場合のみtrue"
          )
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true
      }
    },
    async ({ imageUrl, confirmUpload }) => {

      try {
        if (confirmUpload !== true) {
          throw new Error(
            "画像登録の承認が必要です"
          );
        }

        return successResult(
          await uploadImage(imageUrl)
        );
      } catch (error) {
        return errorResult(error);
      }
    }
  );
}
