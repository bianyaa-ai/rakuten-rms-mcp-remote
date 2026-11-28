
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

const WIDGET_API =
  "https://api.rms.rakuten.co.jp/es/1.0/shop-page/widgets";


function getAuthorization(): string {
  const serviceSecret =
    process.env.RMS_SERVICE_SECRET?.trim();

  const licenseKey =
    process.env.RMS_LICENSE_KEY?.trim();

  if (!serviceSecret || !licenseKey) {
    throw new Error("楽天RMS API認証情報が未設定です");
  }

  return `ESA ${Buffer.from(
    `${serviceSecret}:${licenseKey}`,
    "utf8"
  ).toString("base64")}`;
}

// ----------------------------------------
// Common validation
// ----------------------------------------

const shortText = (max: number) =>
  z.string()
    .min(1)
    .max(max)
    .regex(/^[^\r\n]+$/);

const imagePathSchema = z.string()
  .min(1)
  .max(255)
  .regex(
    /^\/[a-zA-Z0-9_./-]+\.(jpg|gif)$/
  )
  .refine(
    (path) =>
      !path.includes("//") &&
      !path.split("/").some(
        (part) => part === ".." || part === "."
      ),
    "画像パスが不正です"
  );

const altTextSchema = z.string()
  .max(127)
  .regex(/^[^\r\n<>]*$/)
  .optional();

const linkUrlSchema = z.string()
  .max(255)
  .url()
  .refine((value) => {
    try {
      const url = new URL(value);

      return (
        url.protocol === "https:" &&
        !url.username &&
        !url.password &&
        !url.port &&
        (
          url.hostname === "rakuten.co.jp" ||
          url.hostname.endsWith(".rakuten.co.jp")
        )
      );
    } catch {
      return false;
    }
  }, "楽天内のHTTPSリンクのみ使用可能です");

const imageTypeSchema = z.enum([
  "CABINET",
  "RECOMMEND"
]);

const imageBodySchema = z.object({
  caption: shortText(30).optional(),
  imageType: imageTypeSchema,
  imagePath: imagePathSchema,
  linkUrl: linkUrlSchema.optional(),
  altText: altTextSchema
}).strict();

// ----------------------------------------
// TITLE
// ----------------------------------------

const titleBodySchema = z.discriminatedUnion(
  "displayType",
  [
    z.object({
      displayType: z.literal("TEXT"),
      title: shortText(20)
    }).strict(),

    z.object({
      displayType: z.literal("IMAGE"),
      imageType: imageTypeSchema,
      imagePath: imagePathSchema,
      altText: altTextSchema
    }).strict()
  ]
);

const titleSchema = z.object({
  type: z.literal("TITLE"),
  body: z.array(titleBodySchema).length(1)
}).strict();

// ----------------------------------------
// TEXT
// ----------------------------------------

const textSchema = z.object({
  type: z.literal("TEXT"),
  body: z.array(
    z.object({
      text: z.string()
        .min(1)
        .max(1000)
        .regex(
          /^[^\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]+$/
        )
    }).strict()
  ).length(1)
}).strict();

// ----------------------------------------
// SMALL_IMAGE
// ----------------------------------------

const smallImageSchema = z.object({
  type: z.literal("SMALL_IMAGE"),

  displayFormat: z.enum([
    "LANDSCAPE",
    "PORTRAIT"
  ]).optional(),

  body: z.array(imageBodySchema)
    .min(1)
    .max(12)
}).strict();

// ----------------------------------------
// LARGE_IMAGE
// ----------------------------------------

const largeImageSchema = z.object({
  type: z.literal("LARGE_IMAGE"),

  displayFormat: z.enum([
    "LANDSCAPE",
    "LANDSCAPE_SCROLL",
    "PORTRAIT"
  ]).optional(),

  body: z.array(imageBodySchema)
    .min(1)
    .max(12),

  pcDisplaySettings: z.object({
    size: z.union([
      z.literal(50),
      z.literal(75),
      z.literal(100)
    ]).optional(),

    alignment: z.enum([
      "CENTER",
      "LEFT"
    ]).optional()
  }).strict().optional()
}).strict();
// ----------------------------------------
// VIDEO
// ----------------------------------------

const videoSchema = z.object({
  type: z.literal("VIDEO"),

  body: z.array(
    z.object({
      videoId: z.string()
        .min(1)
        .max(10),

      altText: altTextSchema,

      linkUrl: linkUrlSchema.optional()
    }).strict()
  ).length(1),

  pcDisplaySettings: z.object({
    size: z.union([
      z.literal(50),
      z.literal(75),
      z.literal(100)
    ]).optional(),

    alignment: z.enum([
      "CENTER",
      "LEFT"
    ]).optional()
  }).strict().optional()
}).strict();


// ----------------------------------------
// ITEM_LIST
// ----------------------------------------

const itemListSchema = z.object({
  type: z.literal("ITEM_LIST"),

  displayFormat: z.enum([
    "LANDSCAPE",
    "PORTRAIT"
  ]).optional(),

  body: z.array(
    z.object({
      itemMngNumber: z.string()
        .min(1)
        .max(32)
        .regex(/^[0-9a-z_-]+$/)
    }).strict()
  ).min(1).max(12)
}).strict();

// ----------------------------------------
// HYPERLINK
// ----------------------------------------

const hyperlinkSchema = z.object({
  type: z.literal("HYPERLINK"),

  body: z.array(
    z.object({
      url: linkUrlSchema,
      text: shortText(22)
    }).strict()
  ).min(1).max(10)
}).strict();

// ----------------------------------------
// Supported widget types
// ----------------------------------------

const widgetSchema = z.discriminatedUnion(
  "type",
  [
    titleSchema,
    textSchema,
    smallImageSchema,
    largeImageSchema,
    itemListSchema,
    hyperlinkSchema,
    videoSchema
  ]
);

type Widget = z.infer<typeof widgetSchema>;

function validateWidget(input: Widget): Widget {
  const widget = widgetSchema.parse(input);

  if (widget.type === "LARGE_IMAGE" || widget.type === "VIDEO") {
    const size =
      widget.pcDisplaySettings?.size ?? 100;

    const alignment =
      widget.pcDisplaySettings?.alignment ?? "LEFT";

    if (size === 100 && alignment === "CENTER") {
      throw new Error(
        "PC表示サイズ100%の場合はLEFTのみ指定可能です"
      );
    }
  }

  return widget;
}

// ----------------------------------------
// Local-only validation (no network)
// ----------------------------------------

function validateWidgetLocally(input: Widget) {
  const widget = validateWidget(input);

  return {
    ok: true,
    localValidationOnly: true,
    rakutenApiCalled: false,
    registered: false,
    widgetType: widget.type,
    validatedWidget: widget,
    note:
      "ローカルのスキーマ検証と業務チェックのみ実施しました。" +
      "楽天APIは呼んでおらず、楽天側の検証結果ではありません。" +
      "パーツは登録されていません。"
  };
}

// ----------------------------------------
// Rakuten API request (actual creation)
// ----------------------------------------

/**
 * Sends exactly ONE POST to Rakuten. There is no preflight, no dry-run
 * header and no retry: if the outcome is ambiguous the caller must not
 * resend automatically.
 */
async function createWidgetOnce(input: Widget) {
  // Local validation always runs before any network access.
  const widget = validateWidget(input);
  const authorization = getAuthorization();
  const startedAt = Date.now();

  console.log(
    "WIDGET diagnostic:",
    JSON.stringify({
      stage: "request_start",
      widgetType: widget.type
    })
  );

  let response: Response;

  try {
    response = await fetch(WIDGET_API, {
      method: "POST",

      headers: {
        Authorization: authorization,
        "Content-Type":
          "application/json; charset=UTF-8",
        Accept: "application/json",
        "Accept-Language": "ja-JP"
      },

      body: JSON.stringify(widget),
      redirect: "error",
      signal: AbortSignal.timeout(30000)
    });

  } catch {
    throw new Error(
      "登録結果が不明です。重複防止のため自動再登録は禁止します。"
    );
  }

  const requestId =
    response.headers.get("x-request-id");

  console.log(
    "WIDGET diagnostic:",
    JSON.stringify({
      stage: "request_response",
      widgetType: widget.type,
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
      JSON.stringify({
        message:
          "登録結果を確認できません。再登録は禁止します。",
        httpStatus: response.status,
        requestId,
        autoRetry: false
      })
    );
  }

  if (!response.ok || data?.errors?.length) {
    throw new Error(
      JSON.stringify({
        message: "楽天パーツAPIエラー",
        httpStatus: response.status,
        requestId,
        errors: data?.errors || [],
        autoRetry: false
      })
    );
  }

  if (
    typeof data?.widgetId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      .test(data.widgetId)
  ) {
    throw new Error(
      "widgetIdを確認できません。重複防止のため再登録は禁止します。"
    );
  }

  return {
    ok: true,
    rakutenApiCalled: true,
    registered: true,
    widgetType: widget.type,
    widgetId: data.widgetId,
    requestId,
    elapsedMs: Date.now() - startedAt
  };
}

function successResult(result: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(result, null, 2)
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
        text: error instanceof Error
          ? error.message
          : "楽天パーツAPIエラー"
      }
    ]
  };
}

// ----------------------------------------
// MCP tool registration
// ----------------------------------------

export function registerWidgetTools(
  server: McpServer
): void {

  // Local-only: never touches the network.

  server.registerTool(
    "contents_widget_validate",
    {
      description:
        "楽天コンテンツパーツの入力をローカルのみで検証する（ローカル検証専用）。" +
        "Zodスキーマと業務チェックで検証し、正規化したパーツを返す。" +
        "楽天APIは呼ばず、パーツは登録されない" +
        "（localValidationOnly=true、rakutenApiCalled=false、registered=false）。" +
        "楽天側の検証結果ではなく、楽天側で受理される保証もない。" +
        "実際の登録はcontents_widget_createで行う。" +
        "TITLE、TEXT、LARGE_IMAGE、SMALL_IMAGE、" +
        "ITEM_LIST、HYPERLINK、VIDEOに対応。",

      inputSchema: z.object({
        widget: widgetSchema
      }),

      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },

    async ({ widget }) => {
      try {
        return successResult(
          validateWidgetLocally(widget)
        );
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  // Actual creation requires explicit per-operation confirmation.

  server.registerTool(
    "contents_widget_create",
    {
      description:
        "楽天コンテンツ用パーツを新規登録する（実際に楽天APIへ書き込む）。" +
        "confirmCreate=trueかつローカル検証成功の場合のみ、楽天APIへPOSTをちょうど1回送る。" +
        "事前のDry-Runや検証用の通信は行わない。" +
        "confirmCreate未指定・falseの場合は楽天APIを呼ばずに拒否する。" +
        "ユーザーの明示承認が必要。" +
        "既存パーツの編集・削除・公開は行わない。" +
        "失敗・結果不明の場合も自動再登録（再送）はしない。" +
        "登録前の確認にはcontents_widget_validate（ローカル検証専用）を使える。",

      inputSchema: z.object({
        widget: widgetSchema,

        confirmCreate: z.boolean()
          .default(false)
          .describe(
            "実際の新規登録についてユーザー承認済みの場合のみtrue"
          )
      }),

      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true
      }
    },

    async ({
      widget,
      confirmCreate
    }) => {

      try {
        if (confirmCreate !== true) {
          throw new Error(
            "新規登録の承認が必要です"
          );
        }

        // Exactly one POST; never retried.
        return successResult(
          await createWidgetOnce(widget)
        );

      } catch (error) {
        return errorResult(error);
      }
    }
  );
}
