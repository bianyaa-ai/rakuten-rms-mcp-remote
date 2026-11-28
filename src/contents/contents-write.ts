
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { contentsWriteBlockedResult } from "./gate.js";

const LAYOUT_API =
  "https://api.rms.rakuten.co.jp/es/1.0/shop-page/layouts";

const CONTENTS_URL =
  "https://www.rakuten.co.jp/iwiss/contents";


const MAX_LAYOUTS = 1000;

// Prevent concurrent creation within this server process.
let creationInProgress = false;

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

  return `ESA ${Buffer.from(
    `${serviceSecret}:${licenseKey}`,
    "utf8"
  ).toString("base64")}`;
}

// ----------------------------------------
// Input validation
// ----------------------------------------

const uuidSchema = z.string().regex(
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
);

const titleSchema = z.string()
  .min(1)
  .max(40)
  .regex(/^[^\r\n]+$/)
  .refine(
    (value) => value.trim().length > 0,
    "ページタイトルが空です"
  );

const locationSchema = z.string()
  .min(1)
  .max(104)
  .regex(
    /^[a-z0-9_-]+(?:\/[a-z0-9_-]+)*$/
  )
  .refine(
    (value) => value !== "topicslist",
    "topicslistは使用できません"
  );

const thumbnailPathSchema = z.string()
  .max(255)
  .regex(
    /^\/ai-contents\/[a-zA-Z0-9_.-]+\.(jpg|gif)$/
  );

const descriptionSchema = z.string()
  .max(130)
  .optional();

const widgetIdsSchema = z.array(
  uuidSchema
)
  .min(1)
  .refine(
    (ids) =>
      new Set(
        ids.map((id) => id.toLowerCase())
      ).size === ids.length,
    "widgetIdが重複しています"
  );

const createInputSchema = {
  title: titleSchema.describe(
    "ページタイトル。最大40文字"
  ),

  location: locationSchema.describe(
    "コンテンツURLのサブディレクトリ。最大104文字"
  ),

  thumbnailPath: thumbnailPathSchema.describe(
    "AIコンテンツフォルダ内のJPGまたはGIF画像パス"
  ),

  description: descriptionSchema.describe(
    "SEO説明文。最大130文字"
  ),

  widgetIds: widgetIdsSchema.describe(
    "登録済みwidgetIdを表示順に指定する"
  ),

  confirmCreate: z.boolean()
    .default(false)
    .describe(
      "非公開ページの新規作成についてユーザー承認済みの場合のみtrue"
    )
};

const createSchema =
  z.object(createInputSchema).strict();

type CreateInput =
  z.infer<typeof createSchema>;

type LayoutSummary = {
  layoutId: string;
  revisionId?: string;
  type: string;
  meta: {
    title: string;
    location?: string;
    visibility?: string;
    searchable?: boolean;
    thumbnail?: {
      imageType: string;
      imagePath: string;
    };
  };
};

// ----------------------------------------
// Retrieve existing contents
// ----------------------------------------

async function getExistingLayouts():
  Promise<LayoutSummary[]> {

  const url = new URL(LAYOUT_API);

  url.searchParams.set(
    "layoutType",
    "CONTENTS"
  );

  const response = await fetch(url, {
    method: "GET",

    headers: {
      Authorization: getAuthorization(),
      Accept: "application/json",
      "Accept-Language": "ja-JP"
    },

    redirect: "error",
    signal: AbortSignal.timeout(30000)
  });

  const requestId =
    response.headers.get("x-request-id");

  const data: any = await response.json();

  if (
    !response.ok ||
    data?.errors?.length
  ) {
    throw new Error(
      JSON.stringify({
        message:
          "既存コンテンツ一覧の取得に失敗しました",
        httpStatus: response.status,
        requestId,
        errors: data?.errors || []
      })
    );
  }

  if (!Array.isArray(data?.result)) {
    throw new Error(
      "コンテンツ一覧のレスポンス形式が不正です"
    );
  }

  if (
    data.result.some(
      (layout: any) =>
        layout?.type !== "CONTENTS" ||
        typeof layout?.layoutId !== "string" ||
        typeof layout?.meta?.title !== "string"
    )
  ) {
    throw new Error(
      "コンテンツ一覧に不正なデータが含まれています"
    );
  }

  return data.result as LayoutSummary[];
}

// ----------------------------------------
// Duplicate and capacity checks
// ----------------------------------------

function checkExistingLayouts(
  layouts: LayoutSummary[],
  input: CreateInput
): void {

  if (layouts.length >= MAX_LAYOUTS) {
    throw new Error(
      "コンテンツページの登録上限1000件に達しています"
    );
  }

  const existingTitle = layouts.find(
    (layout) =>
      layout.meta.title === input.title
  );

  if (existingTitle) {
    throw new Error(
      JSON.stringify({
        message:
          "同じタイトルのページが既に存在します",
        layoutId: existingTitle.layoutId,
        title: existingTitle.meta.title,
        location:
          existingTitle.meta.location || null,
        created: false
      })
    );
  }

  const existingLocation = layouts.find(
    (layout) =>
      layout.meta.location === input.location
  );

  if (existingLocation) {
    throw new Error(
      JSON.stringify({
        message:
          "同じlocationのページが既に存在します",
        layoutId: existingLocation.layoutId,
        title: existingLocation.meta.title,
        location: input.location,
        created: false
      })
    );
  }
}

// ----------------------------------------
// Read back created layout
// ----------------------------------------

async function verifyCreatedLayout(
  layoutId: string,
  input: CreateInput
) {
  const url = new URL(LAYOUT_API);

  url.searchParams.set(
    "layoutType",
    "CONTENTS"
  );

  url.searchParams.set(
    "location",
    input.location
  );

  url.searchParams.set(
    "expandWithModules",
    "true"
  );

  const response = await fetch(url, {
    method: "GET",

    headers: {
      Authorization: getAuthorization(),
      Accept: "application/json",
      "Accept-Language": "ja-JP"
    },

    redirect: "error",
    signal: AbortSignal.timeout(15000)
  });

  const data: any = await response.json();

  if (
    !response.ok ||
    data?.errors?.length ||
    !Array.isArray(data?.result)
  ) {
    throw new Error(
      "作成後のページ確認に失敗しました"
    );
  }

  const layout = data.result.find(
    (entry: any) =>
      entry.layoutId === layoutId &&
      entry.type === "CONTENTS"
  );

  if (!layout) {
    throw new Error(
      "作成済みlayoutIdを確認できません"
    );
  }

  const widgetModule =
    Array.isArray(layout.modules)
      ? layout.modules.find(
          (module: any) =>
            module.type === "WIDGET"
        )
      : undefined;

  const returnedWidgetIds =
    Array.isArray(
      widgetModule?.details?.widgets
    )
      ? widgetModule.details.widgets.map(
          (widget: any) => widget.widgetId
        )
      : null;

  const widgetOrderVerified =
    returnedWidgetIds !== null &&
    JSON.stringify(returnedWidgetIds) ===
      JSON.stringify(input.widgetIds);

  const settingsVerified =
    layout.meta?.visibility === "NOT_VISIBLE" &&
    layout.meta?.searchable === false &&
    layout.meta?.title === input.title &&
    layout.meta?.location === input.location &&
    layout.meta?.thumbnail?.imageType === "CABINET" &&
    layout.meta?.thumbnail?.imagePath ===
      input.thumbnailPath &&
    layout.meta?.displayInTopics
      ?.displayControlType === "NOT_DISPLAY";

  return {
    verified:
      settingsVerified && widgetOrderVerified,
    settingsVerified,
    widgetOrderVerified,
    layoutId: layout.layoutId,
    revisionId: layout.revisionId,
    meta: layout.meta,
    modules: layout.modules
  };
}

// ----------------------------------------
// Create a private contents page
// ----------------------------------------

async function createPrivateContents(
  rawInput: CreateInput
) {
  const input =
    createSchema.parse(rawInput);

  if (input.confirmCreate !== true) {
    throw new Error(
      "非公開ページの新規作成承認が必要です"
    );
  }

  if (creationInProgress) {
    throw new Error(
      "別のページ作成処理が実行中です"
    );
  }

  creationInProgress = true;

  const startedAt = Date.now();

  try {
    // Check existing pages before writing.

    const existingLayouts =
      await getExistingLayouts();

    checkExistingLayouts(
      existingLayouts,
      input
    );

    const payload = {
      type: "CONTENTS",

      meta: {
        title: input.title,
        location: input.location,

        thumbnail: {
          imageType: "CABINET",
          imagePath: input.thumbnailPath
        },

        searchable: false,

        ...(input.description !== undefined
          ? {
              description:
                input.description
            }
          : {}),

        visibility: "NOT_VISIBLE",

        displayInTopics: {
          displayControlType: "NOT_DISPLAY"
        }
      },

      modules: [
        {
          type: "HEADER"
        },
        {
          type: "WIDGET",

          details: {
            widgetIds: input.widgetIds
          }
        },
        {
          type: "FOOTER"
        }
      ]
    };

    console.log(
      "CONTENTS CREATE diagnostic:",
      JSON.stringify({
        stage: "create_start",
        layoutType: "CONTENTS",
        visibility: "NOT_VISIBLE",
        widgetCount: input.widgetIds.length,
        existingCount: existingLayouts.length
      })
    );

    let response: Response;

    // Actual registration: never automatically retry.

    try {
      response = await fetch(LAYOUT_API, {
        method: "POST",

        headers: {
          Authorization: getAuthorization(),
          "Content-Type":
            "application/json; charset=UTF-8",
          Accept: "application/json",
          "Accept-Language": "ja-JP"
        },

        body: JSON.stringify(payload),

        redirect: "error",
        signal: AbortSignal.timeout(30000)
      });

    } catch {
      throw new Error(
        JSON.stringify({
          message:
            "ページ登録結果が不明です。contents_listでlocationを確認してください。",
          registrationStatus: "UNKNOWN",
          location: input.location,
          autoRetry: false
        })
      );
    }

    const requestId =
      response.headers.get("x-request-id");

    console.log(
      "CONTENTS CREATE diagnostic:",
      JSON.stringify({
        stage: "create_response",
        status: response.status,
        requestId,
        elapsedMs:
          Date.now() - startedAt
      })
    );

    let data: any;

    try {
      data = await response.json();

    } catch {
      throw new Error(
        JSON.stringify({
          message:
            "登録結果のJSONを取得できません。再登録せず既存ページを確認してください。",
          httpStatus: response.status,
          requestId,
          registrationStatus: "UNKNOWN",
          location: input.location,
          autoRetry: false
        })
      );
    }

    if (
      !response.ok ||
      data?.errors?.length
    ) {
      throw new Error(
        JSON.stringify({
          message:
            "楽天コンテンツ登録APIエラー",
          httpStatus: response.status,
          requestId,
          errors: data?.errors || [],
          location: input.location,
          autoRetry: false
        })
      );
    }

    if (
      !uuidSchema.safeParse(
        data?.layoutId
      ).success
    ) {
      throw new Error(
        JSON.stringify({
          message:
            "layoutIdを確認できません。再登録は禁止します。",
          requestId,
          registrationStatus: "UNKNOWN",
          location: input.location,
          autoRetry: false
        })
      );
    }

    const layoutId: string =
      data.layoutId;

    // POST succeeded. Verify by GET only.

    let verification: unknown;
    let verified = false;

    try {
      const result =
        await verifyCreatedLayout(
          layoutId,
          input
        );

      verified = result.verified;
      verification = result;

    } catch (error) {
      verification = {
        verified: false,

        message:
          error instanceof Error
            ? error.message
            : "作成後の確認に失敗しました",

        autoRetry: false
      };
    }

    const pageUrl =
      `${CONTENTS_URL}/${
        input.location
          .split("/")
          .map(encodeURIComponent)
          .join("/")
      }`;

    return {
      ok: true,
      created: true,
      layoutId,

      title: input.title,
      location: input.location,

      pageUrl,

      requestedVisibility: "NOT_VISIBLE",
      requestedSearchable: false,
      requestedTopicsDisplay: "NOT_DISPLAY",

      publicationRequested: false,

      widgetCount: input.widgetIds.length,
      widgetIds: input.widgetIds,

      previousLayoutCount:
        existingLayouts.length,

      requestId,

      timestamp:
        response.headers.get("timestamp"),

      elapsedMs:
        Date.now() - startedAt,

      verified,
      verification,

      autoRetry: false,

      message: verified
        ? "非公開コンテンツページの登録・確認に成功しました"
        : "登録は成功しましたが、設定確認が未完了です。再登録せずcontents_listまたはRMSで確認してください。"
    };

  } finally {
    creationInProgress = false;
  }
}

// ----------------------------------------
// MCP tool registration
// ----------------------------------------

export function registerContentsWriteTools(
  server: McpServer
): void {

  server.registerTool(
    "contents_create",
    {
      description:
        "楽天コンテンツページを非公開で新規作成する。" +
        "登録済みwidgetIdを表示順に指定する。" +
        "NOT_VISIBLE、searchable=false、" +
        "NOT_DISPLAYを固定する。" +
        "既存タイトルとlocationの重複を確認する。" +
        "ユーザーの明示承認が必要。" +
        "既存ページの編集・削除・公開は行わない。" +
        "登録結果不明時の自動再登録は禁止。",

      inputSchema: z.object(createInputSchema),


      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true
      }
    },

    async (input) => {
      const blocked = contentsWriteBlockedResult();
      if (blocked) return blocked;

      try {
        const result =
          await createPrivateContents(
            input
          );

        return {
          content: [
            {
              type: "text" as const,
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
              type: "text" as const,

              text:
                error instanceof Error
                  ? error.message
                  : "コンテンツ作成APIエラー"
            }
          ]
        };
      }
    }
  );
}
