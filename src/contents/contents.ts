
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

const SHOP_PAGE_API =
  "https://api.rms.rakuten.co.jp/es/1.0/shop-page";

const SHOP_CONTENTS_URL =
  "https://www.rakuten.co.jp/iwiss/contents";

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

async function listContents(
  location?: string,
  expandWithModules = false
) {
  const startedAt = Date.now();

  if (expandWithModules && !location) {
    throw new Error(
      "モジュール詳細を取得する場合はlocationを指定してください"
    );
  }

  const url = new URL(
    `${SHOP_PAGE_API}/layouts`
  );

  // Restrict requests to contents pages.
  url.searchParams.set(
    "layoutType",
    "CONTENTS"
  );

  if (location) {
    url.searchParams.set(
      "location",
      location
    );

    url.searchParams.set(
      "expandWithModules",
      String(expandWithModules)
    );
  }

  console.log(
    "CONTENTS diagnostic:",
    JSON.stringify({
      stage: "list_start",
      layoutType: "CONTENTS",
      locationSpecified: Boolean(location),
      expandWithModules
    })
  );

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: getAuthorization(),
      Accept: "application/json",
      "Accept-Language": "ja-JP",
      "X-Time-Zone": "Asia/Tokyo"
    },
    redirect: "error",
    signal: AbortSignal.timeout(30000)
  });

  const requestId =
    response.headers.get("x-request-id");

  console.log(
    "CONTENTS diagnostic:",
    JSON.stringify({
      stage: "list_response",
      status: response.status,
      requestId,
      elapsedMs: Date.now() - startedAt
    })
  );

  let data: any;

  try {
    data = await response.json();
  } catch {
    throw new Error(
      `楽天APIからJSONを取得できませんでした。` +
      `HTTP ${response.status}`
    );
  }

  if (!response.ok || data?.errors?.length) {
    throw new Error(
      JSON.stringify({
        message: "楽天コンテンツAPIエラー",
        httpStatus: response.status,
        requestId,
        errors: data?.errors || []
      })
    );
  }

  if (!Array.isArray(data?.result)) {
    throw new Error(
      "楽天APIのレスポンス形式が不正です"
    );
  }

  // Do not return shop-top-page layouts.
  if (
    data.result.some(
      (layout: any) =>
        layout?.type !== "CONTENTS"
    )
  ) {
    throw new Error(
      "コンテンツページ以外のレイアウトが含まれています"
    );
  }

  const contents = data.result.map(
    (layout: any) => {
      const location =
        layout.meta?.location;

      return {
        layoutId: layout.layoutId,
        revisionId: layout.revisionId,
        type: layout.type,
        meta: layout.meta,

        pageUrl:
          typeof location === "string" &&
          location.length > 0
            ? `${SHOP_CONTENTS_URL}/${
                location
                  .split("/")
                  .map(encodeURIComponent)
                  .join("/")
              }`
            : null,

        createTime: layout.createTime,
        updateTime: layout.updateTime,

        ...(expandWithModules
          ? { modules: layout.modules }
          : {})
      };
    }
  );

  return {
    ok: true,
    layoutType: "CONTENTS",
    readOnly: true,
    totalCount: contents.length,
    requestId,
    timestamp:
      response.headers.get("timestamp"),
    elapsedMs: Date.now() - startedAt,
    result: contents
  };
}

export function registerContentsTools(
  server: McpServer
): void {
  server.registerTool(
    "contents_list",
    {
      description:
        "楽天コンテンツページの一覧を取得する。" +
        "locationを指定すると対象ページのみ取得できる。" +
        "expandWithModules=trueでモジュール詳細を取得できる。" +
        "読み取り専用。店舗トップページは対象外。",

      inputSchema: z.object({
        location: z.string()
          .min(1)
          .max(2048)
          .optional()
          .describe(
            "コンテンツページURLのサブディレクトリ部"
          ),

        expandWithModules: z.boolean()
          .default(false)
          .describe(
            "モジュール詳細取得。location指定時のみtrueにできる"
          )
      }),


      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true
      }
    },

    async ({
      location,
      expandWithModules
    }) => {
      try {
        const result = await listContents(
          location,
          expandWithModules
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                result,
                null,
                2
              )
            }
          ]
        };

      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text:
                error instanceof Error
                  ? error.message
                  : "楽天コンテンツAPIエラー"
            }
          ]
        };
      }
    }
  );
}
