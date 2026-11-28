
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

const LAYOUT_API =
  "https://api.rms.rakuten.co.jp/es/1.0/shop-page/layouts";


let updateInProgress = false;

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

const locationSchema = z.string()
  .min(1)
  .max(104);

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

const previewInputSchema = {
  layoutId: uuidSchema.describe(
    "編集対象のlayoutId"
  ),

  location: locationSchema.describe(
    "編集対象ページのlocation"
  ),

  widgetIds: widgetIdsSchema.describe(
    "更新後の全widgetIdを表示順に指定する。既存widgetIdを省略してはいけない"
  )
};

const updateInputSchema = {
  ...previewInputSchema,

  expectedRevisionId: uuidSchema.describe(
    "更新前の事前確認で取得したrevisionId"
  ),

  confirmUpdate: z.boolean()
    .default(false)
    .describe(
      "ユーザーが今回の編集を明示承認した場合のみtrue"
    )
};

const previewSchema =
  z.object(previewInputSchema).strict();

const updateSchema =
  z.object(updateInputSchema).strict();

type PreviewInput =
  z.infer<typeof previewSchema>;

type UpdateInput =
  z.infer<typeof updateSchema>;

// ----------------------------------------
// Retrieve existing layout
// ----------------------------------------

async function getLayout(
  layoutId: string,
  location: string
) {
  const url = new URL(LAYOUT_API);

  url.searchParams.set(
    "layoutType",
    "CONTENTS"
  );

  url.searchParams.set(
    "location",
    location
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
      "Accept-Language": "ja-JP",
      "X-Time-Zone": "Asia/Tokyo"
    },

    redirect: "error",
    signal: AbortSignal.timeout(30000)
  });

  const requestId =
    response.headers.get("x-request-id");

  const data: any =
    await response.json();

  if (
    !response.ok ||
    data?.errors?.length
  ) {
    throw new Error(
      JSON.stringify({
        message:
          "コンテンツページ取得エラー",
        httpStatus: response.status,
        requestId,
        errors: data?.errors || []
      })
    );
  }

  if (!Array.isArray(data?.result)) {
    throw new Error(
      "コンテンツ取得結果が不正です"
    );
  }

  const layout = data.result.find(
    (entry: any) =>
      entry.layoutId === layoutId &&
      entry.type === "CONTENTS" &&
      entry.meta?.location === location
  );

  if (!layout) {
    throw new Error(
      "layoutIdとlocationが一致するコンテンツページが見つかりません"
    );
  }

  if (
    !uuidSchema.safeParse(
      layout.revisionId
    ).success
  ) {
    throw new Error(
      "revisionIdを確認できません"
    );
  }

  return layout;
}

// ----------------------------------------
// Safety checks
// ----------------------------------------

function checkPrivateLayout(
  layout: any
): void {

  if (layout.type !== "CONTENTS") {
    throw new Error(
      "コンテンツページ以外は編集できません"
    );
  }

  if (
    layout.meta?.visibility !==
    "NOT_VISIBLE"
  ) {
    throw new Error(
      "初期実装では非公開ページのみ編集可能です"
    );
  }

  if (layout.meta?.searchable !== false) {
    throw new Error(
      "SEO検索設定がOFFのページのみ編集可能です"
    );
  }

  if (
    layout.meta?.displayInTopics
      ?.displayControlType !==
    "NOT_DISPLAY"
  ) {
    throw new Error(
      "トピックス非表示のページのみ編集可能です"
    );
  }

  if (
    typeof layout.meta?.title !== "string" ||
    typeof layout.meta?.location !== "string"
  ) {
    throw new Error(
      "既存ページのメタ情報が不正です"
    );
  }

  if (
    !["CABINET", "RECOMMEND"].includes(
      layout.meta?.thumbnail?.imageType
    ) ||
    typeof layout.meta?.thumbnail
      ?.imagePath !== "string"
  ) {
    throw new Error(
      "既存サムネイル情報を確認できません"
    );
  }

  if (
    !Array.isArray(layout.modules) ||
    layout.modules.length !== 3
  ) {
    throw new Error(
      "モジュール構成が不正です"
    );
  }

  const expectedTypes = [
    "HEADER",
    "WIDGET",
    "FOOTER"
  ];

  for (let i = 0; i < 3; i++) {
    const module = layout.modules[i];

    if (
      module.type !== expectedTypes[i]
    ) {
      throw new Error(
        "既存モジュールの順番が不正です"
      );
    }

    if (
      !uuidSchema.safeParse(
        module.moduleId
      ).success
    ) {
      throw new Error(
        "既存moduleIdを確認できません"
      );
    }
  }
}

function getCurrentWidgetIds(
  layout: any
): string[] {

  const widgets =
    layout.modules[1]?.details?.widgets;

  if (!Array.isArray(widgets)) {
    throw new Error(
      "既存パーツ一覧を確認できません"
    );
  }

  const ids = widgets.map(
    (widget: any) => widget.widgetId
  );

  if (
    ids.some(
      (id: unknown) =>
        !uuidSchema.safeParse(id).success
    )
  ) {
    throw new Error(
      "既存widgetIdに不正な値があります"
    );
  }

  return ids;
}

function checkWidgetChanges(
  currentIds: string[],
  requestedIds: string[]
) {
  const normalizedRequested =
    requestedIds.map(
      (id) => id.toLowerCase()
    );

  const normalizedCurrent =
    currentIds.map(
      (id) => id.toLowerCase()
    );

  const removedIds =
    currentIds.filter(
      (id) =>
        !normalizedRequested.includes(
          id.toLowerCase()
        )
    );

  if (removedIds.length > 0) {
    throw new Error(
      JSON.stringify({
        message:
          "既存パーツの削除・置換は禁止されています",
        removedWidgetIds: removedIds,
        updated: false
      })
    );
  }

  const addedIds =
    requestedIds.filter(
      (id) =>
        !normalizedCurrent.includes(
          id.toLowerCase()
        )
    );

  const unchanged =
    JSON.stringify(normalizedCurrent) ===
    JSON.stringify(normalizedRequested);

  return {
    currentWidgetIds: currentIds,
    requestedWidgetIds: requestedIds,
    addedWidgetIds: addedIds,
    removedWidgetIds: removedIds,
    currentWidgetCount: currentIds.length,
    requestedWidgetCount:
      requestedIds.length,
    addedWidgetCount: addedIds.length,
    unchanged
  };
}

// ----------------------------------------
// Construct full PUT payload
// ----------------------------------------

function buildUpdatePayload(
  layout: any,
  widgetIds: string[]
) {
  return {
    type: "CONTENTS",

    meta: {
      title: layout.meta.title,
      location: layout.meta.location,

      thumbnail: {
        imageType:
          layout.meta.thumbnail.imageType,
        imagePath:
          layout.meta.thumbnail.imagePath
      },

      ...(typeof layout.meta.description
        === "string"
        ? {
            description:
              layout.meta.description
          }
        : {}),

      searchable: false,
      visibility: "NOT_VISIBLE",

      displayInTopics: {
        displayControlType: "NOT_DISPLAY"
      }
    },

    modules: [
      {
        moduleId:
          layout.modules[0].moduleId,
        type: "HEADER"
      },
      {
        moduleId:
          layout.modules[1].moduleId,
        type: "WIDGET",

        details: {
          widgetIds
        }
      },
      {
        moduleId:
          layout.modules[2].moduleId,
        type: "FOOTER"
      }
    ]
  };
}

// ----------------------------------------
// Preview only
// ----------------------------------------

async function previewUpdate(
  rawInput: PreviewInput
) {
  const input =
    previewSchema.parse(rawInput);

  const layout = await getLayout(
    input.layoutId,
    input.location
  );

  checkPrivateLayout(layout);

  const currentIds =
    getCurrentWidgetIds(layout);

  const changes =
    checkWidgetChanges(
      currentIds,
      input.widgetIds
    );

  const payload =
    buildUpdatePayload(
      layout,
      input.widgetIds
    );

  return {
    ok: true,

    previewOnly: true,
    updated: false,

    rakutenDryRun: false,
    validationMode: "LOCAL_PREVIEW",

    layoutId: layout.layoutId,
    revisionId: layout.revisionId,
    location: layout.meta.location,

    currentMeta: layout.meta,

    changes,

    proposedPayload: payload,

    currentModules: layout.modules,

    publicationRequested: false,

    message:
      "更新予定内容を確認しました。楽天側への変更は行っていません。追加パーツの存在確認と最終検証は楽天更新APIで行われます。"
  };
}

// ----------------------------------------
// Execute update
// ----------------------------------------

async function executeUpdate(
  rawInput: UpdateInput
) {
  const input =
    updateSchema.parse(rawInput);

  if (input.confirmUpdate !== true) {
    throw new Error(
      "ユーザーによる編集承認が必要です"
    );
  }

  if (updateInProgress) {
    throw new Error(
      "別の更新処理が実行中です"
    );
  }

  updateInProgress = true;

  const startedAt = Date.now();

  try {
    const currentLayout =
      await getLayout(
        input.layoutId,
        input.location
      );

    checkPrivateLayout(currentLayout);

    if (
      currentLayout.revisionId !==
      input.expectedRevisionId
    ) {
      throw new Error(
        JSON.stringify({
          message:
            "revisionIdが変更されています。事前確認をやり直してください。",
          expectedRevisionId:
            input.expectedRevisionId,
          actualRevisionId:
            currentLayout.revisionId,
          updated: false
        })
      );
    }

    const currentIds =
      getCurrentWidgetIds(
        currentLayout
      );

    const changes =
      checkWidgetChanges(
        currentIds,
        input.widgetIds
      );

    if (changes.unchanged) {
      return {
        ok: true,
        updated: false,
        unchanged: true,
        layoutId: input.layoutId,
        revisionId:
          currentLayout.revisionId,
        message:
          "変更内容がないため更新を実行しませんでした"
      };
    }

    const payload =
      buildUpdatePayload(
        currentLayout,
        input.widgetIds
      );

    console.log(
      "CONTENTS UPDATE diagnostic:",
      JSON.stringify({
        stage: "update_start",
        layoutId: input.layoutId,
        revisionId:
          currentLayout.revisionId,
        currentWidgetCount:
          currentIds.length,
        requestedWidgetCount:
          input.widgetIds.length,
        visibility: "NOT_VISIBLE"
      })
    );

    let response: Response;

    try {
      response = await fetch(
        `${LAYOUT_API}/${input.layoutId}`,
        {
          method: "PUT",

          headers: {
            Authorization:
              getAuthorization(),
            "Content-Type":
              "application/json; charset=UTF-8",
            Accept: "application/json",
            "Accept-Language": "ja-JP"
          },

          body: JSON.stringify(payload),

          redirect: "error",

          signal:
            AbortSignal.timeout(30000)
        }
      );

    } catch {
      throw new Error(
        JSON.stringify({
          message:
            "更新結果が不明です。再実行せずcontents_listで確認してください。",
          updateStatus: "UNKNOWN",
          layoutId: input.layoutId,
          location: input.location,
          autoRetry: false
        })
      );
    }

    const requestId =
      response.headers.get(
        "x-request-id"
      );

    console.log(
      "CONTENTS UPDATE diagnostic:",
      JSON.stringify({
        stage: "update_response",
        status: response.status,
        requestId,
        elapsedMs:
          Date.now() - startedAt
      })
    );

    // Successful update returns HTTP 204.
    // Do not attempt JSON parsing on 204.

    if (response.status !== 204) {
      let data: any = null;

      try {
        data = await response.json();
      } catch {
        // No JSON error body returned.
      }

      throw new Error(
        JSON.stringify({
          message:
            "楽天コンテンツ更新APIが204以外を返しました",
          httpStatus: response.status,
          requestId,
          layoutId: input.layoutId,
          location: input.location,
          errors: data?.errors || [],
          updateStatus: "UNCONFIRMED",
          autoRetry: false
        })
      );
    }

    // Verify updated page using GET only.

    let verification: any;
    let verified = false;

    try {
      const updatedLayout =
        await getLayout(
          input.layoutId,
          input.location
        );

      checkPrivateLayout(
        updatedLayout
      );

      const returnedIds =
        getCurrentWidgetIds(
          updatedLayout
        );

      const widgetOrderVerified =
        JSON.stringify(
          returnedIds.map(
            (id) => id.toLowerCase()
          )
        ) ===
        JSON.stringify(
          input.widgetIds.map(
            (id) => id.toLowerCase()
          )
        );

      const moduleIdsVerified =
        updatedLayout.modules.every(
          (module: any, index: number) =>
            module.moduleId ===
            currentLayout.modules[index]
              .moduleId
        );

      const settingsVerified =
        updatedLayout.meta.visibility ===
          "NOT_VISIBLE" &&

        updatedLayout.meta.searchable ===
          false &&

        updatedLayout.meta
          .displayInTopics
          ?.displayControlType ===
          "NOT_DISPLAY" &&

        updatedLayout.meta.title ===
          currentLayout.meta.title &&

        updatedLayout.meta.location ===
          currentLayout.meta.location &&

        updatedLayout.meta.description ===
          currentLayout.meta.description &&

        updatedLayout.meta.thumbnail
          ?.imageType ===
          currentLayout.meta.thumbnail
            ?.imageType &&

        updatedLayout.meta.thumbnail
          ?.imagePath ===
          currentLayout.meta.thumbnail
            ?.imagePath;

      const existingWidgetsPreserved =
        currentLayout.modules[1]
          .details.widgets.every(
            (oldWidget: any) => {
              const newWidget =
                updatedLayout.modules[1]
                  .details.widgets.find(
                    (widget: any) =>
                      widget.widgetId ===
                      oldWidget.widgetId
                  );

              return Boolean(newWidget);
            }
          );

      verified =
        widgetOrderVerified &&
        moduleIdsVerified &&
        settingsVerified &&
        existingWidgetsPreserved;

      verification = {
        verified,
        widgetOrderVerified,
        moduleIdsVerified,
        settingsVerified,
        existingWidgetsPreserved,

        revisionId:
          updatedLayout.revisionId,

        meta: updatedLayout.meta,
        modules: updatedLayout.modules
      };

    } catch (error) {
      verification = {
        verified: false,

        message:
          error instanceof Error
            ? error.message
            : "更新後の確認に失敗しました",

        autoRetry: false
      };
    }

    return {
      ok: true,
      updated: true,

      layoutId: input.layoutId,
      location: input.location,

      previousRevisionId:
        currentLayout.revisionId,

      revisionId:
        verification.revisionId || null,

      changes,

      httpStatus: 204,
      requestId,

      timestamp:
        response.headers.get("timestamp"),

      elapsedMs:
        Date.now() - startedAt,

      publicationRequested: false,

      verified,
      verification,

      autoRetry: false,

      message: verified
        ? "非公開ページの更新・照合に成功しました"
        : "更新APIは成功しましたが、照合が未完了です。再更新せずRMSで確認してください。"
    };

  } finally {
    updateInProgress = false;
  }
}

// ----------------------------------------
// MCP result helpers
// ----------------------------------------

function successResult(
  result: unknown
) {
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
}

function errorResult(
  error: unknown
) {
  return {
    isError: true,

    content: [
      {
        type: "text" as const,

        text:
          error instanceof Error
            ? error.message
            : "楽天コンテンツ更新エラー"
      }
    ]
  };
}

// ----------------------------------------
// MCP tool registration
// ----------------------------------------

export function registerContentsUpdateTools(
  server: McpServer
): void {

  server.registerTool(
    "contents_update_preview",
    {
      description:
        "非公開コンテンツページの更新予定内容を確認する。" +
        "既存moduleIdとwidgetIdを保持する。" +
        "楽天側への変更は行わない。" +
        "楽天公式Dry-Runではなくローカル事前確認。" +
        "revisionIdと更新予定payloadを返す。",

      inputSchema: z.object(previewInputSchema),


      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      }
    },

    async (input) => {
      try {
        return successResult(
          await previewUpdate(input)
        );
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    "contents_update",
    {
      description:
        "既存の非公開コンテンツページにパーツを追加または並べ替える。" +
        "既存パーツの削除・置換は禁止。" +
        "layoutId、location、revisionIdを照合する。" +
        "ユーザーの明示承認が必要。" +
        "非公開・SEO OFF・トピックス非表示を維持する。" +
        "公開ページの編集は禁止。" +
        "更新後に読み取り確認を実施する。" +
        "結果不明時の自動再更新は禁止。",

      inputSchema: z.object(updateInputSchema),


      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true
      }
    },

    async (input) => {

      try {
        return successResult(
          await executeUpdate(input)
        );
      } catch (error) {
        return errorResult(error);
      }
    }
  );
}
