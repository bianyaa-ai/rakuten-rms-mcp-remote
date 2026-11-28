# rakuten-rms-mcp-remote

[`rakuten-rms-mcp`](https://github.com/moneyan9/rakuten-rms-mcp) の **Remote MCP ホスト**です。

- Transport: **Streamable HTTP**（`/mcp`）
- Auth: **OAuth 2.1 + PKCE**（共有パスコード）および任意の **静的 Bearer**
- RMS ツール実装はコアパッケージを依存として利用（このリポに RMS ロジックは置きません）
- **R-Contents / R-Cabinet ツール**（`src/contents/`）を同じ `McpServer`・同じ `/mcp`・同じ OAuth 認証で公開（下記「Contents ツール」）

Claude.ai / ChatGPT などの「URL を貼る」系クライアント向けです。Cursor のローカル stdio はコア側を使ってください。

---

## 必要条件

- Node.js 20+
- RMS の `serviceSecret` / `licenseKey`
- 次のどちらか（または両方）
  - `RMS_MCP_OAUTH_PASSCODE` … OAuth 認可画面の共有パスコード
  - `RMS_MCP_API_KEY` … `Authorization: Bearer …` を直接書けるクライアント用

---

## セットアップ

```bash
git clone https://github.com/moneyan9/rakuten-rms-mcp-remote.git
cd rakuten-rms-mcp-remote
cp .env.example .env   # 値を編集
npm install
npm run build
npm start
```

ローカルではコア未公開でも動くように、必要なら `package.json` の依存を一時的に:

```json
"rakuten-rms-mcp": "file:../rakuten-rms-mcp"
```

に差し替えて `npm install` してください。

---

## エンドポイント

| Path | 説明 |
|------|------|
| `GET /health` | 存活確認 |
| `GET /.well-known/oauth-authorization-server` | OAuth AS メタデータ |
| `GET /.well-known/oauth-protected-resource` | Protected Resource メタデータ |
| `GET /.well-known/oauth-protected-resource/mcp` | 同上（RFC 9728 path-aware） |
| `POST /oauth/register` | Dynamic Client Registration |
| `GET/POST /oauth/authorize` | パスコード入力 → auth code |
| `POST /oauth/token` | code → access token（PKCE） |
| `ALL /mcp` | MCP Streamable HTTP（**Bearer 必須**・SDK `requireBearerAuth`） |

---

## Contents ツール（R-Contents / R-Cabinet）

`rakuten-contents-mcp` を統合したものです。別サーバ・別認証エンドポイントはなく、`/mcp` の Bearer 認証（OAuth 2.1 / 静的 Bearer）をそのまま使います。Contents 専用の Auth0 / JWT 検証や `AUTH0_ALLOWED_USER` は不要です。楽天 API 認証は既存の `RMS_SERVICE_SECRET` / `RMS_LICENSE_KEY` を共用します。

| ツール | 種別 |
|--------|------|
| `contents_health` | 読み取り（楽天 API は呼ばない） |
| `cabinet_list_folders` / `cabinet_list_files` | 読み取り |
| `contents_list` | 読み取り |
| `contents_widget_validate` | 読み取り（**ローカル検証専用**・楽天 API は呼ばない。下記参照） |
| `contents_update_preview` | 読み取り（ローカル事前確認） |
| `cabinet_upload_image` | **書き込み** |
| `contents_widget_create` | **書き込み** |
| `contents_create` | **書き込み** |
| `contents_update` | **書き込み** |

### 認証と書き込みの安全策

- 認証済み（`/mcp` の共有 Bearer 認証: OAuth 2.1 発行のアクセストークン、または設定済みの静的 Bearer API キー）のクライアントは、既存 RMS ツールも Contents ツールも **読み取り・書き込みともに既定で利用可能** です。書き込みを無効にするグローバルな環境変数（`RMS_CONTENTS_ENABLE_WRITE` / `RMS_MCP_ENABLE_WRITE`）はありません。認証は変更していません。
- 書き込みは操作ごとの安全策で守ります: 明示承認入力（`confirmUpload` / `confirmCreate` / `confirmUpdate`）、厳格なスキーマ検証、重複防止、非公開ページ固定、ウィジェット登録は承認後に楽天へ POST をちょうど 1 回だけ送信（事前の Dry-Run 通信なし）、`expectedRevisionId` 照合、画像アップロードの重複排除（上書きなし）、結果不明時の自動リトライ禁止、作成・更新後の読み取り確認。承認入力が無い呼び出しは楽天へリクエストせずに拒否されます。
- 既存 RMS ツール（`rakuten-rms-mcp` 由来）の `rms_cancel_order` / `rms_cancel_order_after_shipping` / `rms_delete_*` などは、パッケージ側に承認入力がありません。クライアント側で必ずユーザー確認を取ってください。

**`contents_widget_validate` と `contents_widget_create` の違い:** `contents_widget_validate` はローカル検証専用です。Zod スキーマと業務チェックで入力を検証し、正規化したパーツを `localValidationOnly=true` / `rakutenApiCalled=false` / `registered=false` として返します。楽天 API は呼ばず（`fetch` なし・`X-Dry-Run` なし）、楽天側の検証結果ではありません。パーツは登録されません。`contents_widget_create` は実際の登録です。`confirmCreate=true` かつローカル検証成功の場合のみ、楽天パーツ API へ POST をちょうど 1 回送ります。事前の Dry-Run や検証用リクエストは送らず、失敗・結果不明の場合も自動再送はしません（`X-Dry-Run` ヘッダーが楽天で有効かは未確認のため使用していません）。

---

## ChatGPT / Claude への接続

1. このサーバを HTTPS で公開（Railway / Render / Fly など）
2. `ALLOWED_HOSTS` に公開ホスト名を入れる（例: `my-app.up.railway.app`）
3. ChatGPT: Developer Mode → カスタムコネクタに `https://…/mcp` を追加（OAuth）
4. Claude.ai: Connectors → カスタムコネクタに同様に追加
5. 認可画面で `RMS_MCP_OAUTH_PASSCODE` を入力

ヘッダを書けるクライアント（一部の MCP クライアント）向け:

```json
{
  "mcpServers": {
    "rakuten-rms": {
      "url": "https://YOUR_HOST/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_RMS_MCP_API_KEY"
      }
    }
  }
}
```

---

## 環境変数

| 変数 | 必須 | 説明 |
|------|------|------|
| `RMS_SERVICE_SECRET` | はい | RMS serviceSecret |
| `RMS_LICENSE_KEY` | はい | RMS licenseKey |
| `RMS_SHOP_ID` | 任意 | 問い合わせ返信時 |
| `PORT` | 任意 | デフォルト `8000` |
| `ALLOWED_HOSTS` | 推奨 | カンマ区切りホスト名（公開時必須級） |
| `RMS_MCP_OAUTH_PASSCODE` | OAuth 時 | 共有パスコード |
| `RMS_MCP_API_KEY` | 任意 | 静的 Bearer |
| `RMS_MCP_OAUTH_STORE_PATH` | 任意 | トークン永続化パス |

**注意:** 現状は **1 プロセス = 1 店舗の RMS 鍵**（サーバ env）です。個人事業主ごとの鍵分離はまだありません。

---

## Vercel

Express アプリとしてデプロイします（`src/app.ts` の default export）。

1. このリポを Vercel に Import（または `npx vercel`）
2. Environment Variables に少なくとも次を設定
   - `RMS_SERVICE_SECRET` / `RMS_LICENSE_KEY`
   - `RMS_MCP_OAUTH_PASSCODE`（自分で決めた共有パスコード）
3. Deploy 後の MCP URL: `https://<project>.vercel.app/mcp`
4. ChatGPT カスタムコネクタにその URL を追加し、認可画面でパスコードを入力

`ALLOWED_HOSTS` は任意（未設定でも `VERCEL_URL` 系を自動許可）。カスタムドメイン利用時は本番ホスト名を追加してください。

OAuth トークンはサーバレス上では原則 `/tmp`（インスタンス内）。コールドスタートで消えることがあるので、再認可が必要になる場合があります。

---

## 開発

```bash
npm run typecheck
npm test
npm run build
```

---

## License

MIT
