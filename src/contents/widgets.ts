
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
// Rakuten API request
// ----------------------------------------

async function requestWidget(
  input: Widget,
  dryRun: boolean
) {
  const widget = validateWidget(input);
  const startedAt = Date.now();

  console.log(
    "WIDGET diagnostic:",
    JSON.stringify({
      stage: "request_start",
      widgetType: widget.type,
      dryRun
    })
  );

  let response: Response;

  try {
    response = await fetch(WIDGET_API, {
      method: "POST",

      headers: {
        Authorization: getAuthorization(),
        "Content-Type":
          "application/json; charset=UTF-8",
        Accept: "application/json",
        "Accept-Language": "ja-JP",
        "X-Dry-Run": String(dryRun)
      },

      body: JSON.stringify(widget),
      redirect: "error",
      signal: AbortSignal.timeout(30000)
    });

  } catch {
    throw new Error(
      dryRun
        ? "パーツ事前検証の通信に失敗しました"
        : "登録結果が不明です。重複防止のため自動再登録は禁止します。"
    );
  }

  const requestId =
    response.headers.get("x-request-id");

  console.log(
    "WIDGET diagnostic:",
    JSON.stringify({
      stage: "request_response",
      widgetType: widget.type,
      dryRun,
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
        message: dryRun
          ? "楽天APIのJSON取得に失敗しました"
          : "登録結果を確認できません。再登録は禁止します。",
        httpStatus: response.status,
        requestId
      })
    );
  }

  if (!response.ok || data?.errors?.length) {
    throw new Error(
      JSON.stringify({
        message: "楽天パーツAPIエラー",
        httpStatus: response.status,
        requestId,
        dryRun,
        errors: data?.errors || [],
        autoRetry: false
      })
    );
  }

  if (dryRun) {
    if (
      data?.type !== widget.type ||
      !Array.isArray(data?.body)
    ) {
      throw new Error(
        "事前検証のレスポンス形式が不正です"
      );
    }

    // X-Dry-Run is not verified to be honoured by Rakuten. A widgetId in
    // the "validation" response means the widget was actually registered.
    if (typeof data?.widgetId === "string") {
      return {
        ok: true,
        dryRun: true,
        registered: true,
        warning:
          "X-Dry-Run=trueで送信しましたが、レスポンスにwidgetIdが含まれています。" +
          "楽天側でパーツが登録された可能性があります。再送信しないでください。",
        widgetType: widget.type,
        widgetId: data.widgetId,
        requestId,
        elapsedMs: Date.now() - startedAt
      };
    }

    return {
      ok: true,
      dryRun: true,
      registered: false,
      widgetType: widget.type,
      requestId,
      elapsedMs: Date.now() - startedAt,
      validatedWidget: data
    };
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
    dryRun: false,
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

  // Sends the widget with an "X-Dry-Run: true" header. That header is NOT
  // verified to be honoured by the Rakuten API, so this request may reach
  // Rakuten as a normal request. See the tool description.

  server.registerTool(
    "contents_widget_validate",
    {
      description:
        "楽天コンテンツパーツの事前検証リクエストを送る。" +
        "入力スキーマをローカルで検証したうえで、X-Dry-Run: trueヘッダー付きで楽天APIへ送信する。" +
        "注意: このヘッダーが楽天側でDry-Run（検証のみ）として扱われることは、" +
        "公式ドキュメントまたは実測で未確認。" +
        "楽天APIに実際にリクエストが届き、無視された場合はパーツが登録される可能性がある。" +
        "利用前に楽天公式APIの挙動を確認すること。" +
        "レスポンスにwidgetIdが含まれた場合は登録済みとして警告する。" +
        "TITLE、TEXT、LARGE_IMAGE、SMALL_IMAGE、" +
        "ITEM_LIST、HYPERLINK、VIDEOに対応。",

      inputSchema: z.object({
        widget: widgetSchema
      }),


      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true
      }
    },

    async ({ widget }) => {
      try {
        return successResult(
          await requestWidget(widget, true)
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
        "楽天コンテンツ用パーツを新規登録する。" +
        "登録前にcontents_widget_validateと同じ事前検証リクエスト（X-Dry-Run: true、楽天側の挙動は未確認）を必ず送る。" +
        "事前検証のレスポンスにwidgetIdが含まれた場合は登録済みとみなし、二重登録を避けるため本登録は送らない。" +
        "ユーザーの明示承認が必要。" +
        "既存パーツの編集・削除・公開は行わない。" +
        "登録結果が不明な場合は自動再登録しない。",

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

        // Mandatory validation before creation.
        const validation =
          await requestWidget(widget, true);

        if (!validation.ok) {
          throw new Error(
            "事前検証に失敗したため登録を中止しました"
          );
        }

        // The validation request itself registered the widget (the
        // X-Dry-Run header was not honoured). Never send a second
        // request: that would create a duplicate.
        if ((validation as { registered?: boolean }).registered) {
          return successResult(validation);
        }

        // No automatic retry.
        const result =
          await requestWidget(widget, false);

        return successResult(result);

      } catch (error) {
        return errorResult(error);
      }
    }
  );
}
