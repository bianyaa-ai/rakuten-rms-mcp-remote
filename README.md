# rakuten-rms-mcp-remote

[`rakuten-rms-mcp`](https://github.com/moneyan9/rakuten-rms-mcp) の **Remote MCP ホスト**です。

- Transport: **Streamable HTTP**（`/mcp`）
- Auth: **OAuth 2.1 + PKCE**（共有パスコード）および任意の **静的 Bearer**
- ツール実装はコアパッケージを依存として利用（このリポに RMS ロジックは置きません）

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

## 開発

```bash
npm run typecheck
npm test
npm run build
```

---

## License

MIT
