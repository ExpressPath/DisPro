# Dispro

Dispro は、余剰端末の計算力を使ってファイル・URL・コードなどの処理を低価格に実行する、検証可能な分散処理サービスです。

このリポジトリの最初の実装では、注文を受けて分散処理用のタスクへ分解し、ノード候補へ割り当て、検証タスクと署名ログ用イベントを生成する「注文計画エンジン」を作っています。

Phase 2 では、この注文計画エンジンを HTTP API とファイル永続化ストアから呼べるようにしています。既知ワークロードだけでなく、`custom.*` のような任意タスク名も汎用プロファイルで分割処理できます。

## Phase 1 の範囲

- 注文データの正規化
- ワークロード別の価格見積もり
- 入力サイズに応じたチャンク分割
- compute / verification / canary タスク生成
- ノード性能・信頼度・空き状況による割り当て
- 検証タスクが元の処理ノードと同じノードへ行かない制御
- 改ざん検出用のハッシュチェーン型監査イベント
- CLI シミュレーションと自動テスト

## 使い方

```powershell
npm.cmd install
npm.cmd test
npm.cmd run build
npm.cmd run build:site
npm.cmd run simulate
npm.cmd run server
```

PowerShell の実行ポリシーで `npm` が止まる場合は、上のように `npm.cmd` を使ってください。

`npm.cmd run build:site` は公式サイトを `dist/site` に出力します。GitHub Pages、Netlify、Vercel、静的ホスティングなどへ公開する場合はこのフォルダを使います。

## 主要ファイル

- `docs/implementation-phases.md`: 実装フェーズの分解
- `src/services/orderOrchestrator.ts`: 注文計画の入口
- `src/api/httpServer.ts`: 注文・タスク・ノード API
- `src/storage/fileDisproStore.ts`: JSON ファイル永続化ストア
- `src/domain/taskSplitter.ts`: 注文からタスクへの分割
- `src/domain/scheduler.ts`: タスクからノードへの割り当て
- `src/domain/auditLog.ts`: 署名ログの土台になるハッシュチェーン
- `src/cli/simulate-order.ts`: 注文計画のローカル実行サンプル
- `public/`: 公式サイトの静的ファイル
- `dist/site`: `npm.cmd run build:site` で生成される公開用フォルダ

## API

`npm.cmd run server` を実行すると、デフォルトで `http://localhost:8787` に API が起動します。状態ファイルは `.dispro/state.json` に保存されます。

- `GET /health`: API ヘルスチェック
- `POST /auth/request-link`: メールアドレスのサインインリンクを発行
- `POST /auth/verify`: サインインリンクの token を検証してセッションを発行
- `GET /auth/me`: 現在のユーザーと API key 一覧
- `POST /auth/api-keys`: セッションから API key を発行
- `GET /nodes`: 登録済みノード一覧
- `POST /nodes/register`: ノード登録・更新
- `POST /orders`: 注文を作成し、タスク計画を保存
- `GET /orders`: 注文サマリー一覧
- `GET /orders/:orderId`: 注文計画の詳細
- `GET /orders/:orderId/tasks`: タスク・割り当て一覧
- `GET /orders/:orderId/audit`: 監査イベントとハッシュチェーン検証結果

任意タスクは `workload` に自由な文字列を入れ、必要に応じて `requirements.workloadProfile` で単価、標準チャンクサイズ、推定メモリ、GPU 優先などを指定します。指定がない場合は汎用プロファイルで分割されます。

### Email sign-in and secure API

注文作成、注文参照、ノード登録は Bearer 認証が必要です。認証はメールアドレスの magic link から始まります。

```powershell
$link = Invoke-RestMethod -Method Post -Uri http://localhost:8787/auth/request-link `
  -ContentType application/json `
  -Body '{"email":"owner@example.com"}'

$token = ([uri]$link.devSignInUrl).Query.TrimStart("?").Split("=")[1]
$session = Invoke-RestMethod -Method Post -Uri http://localhost:8787/auth/verify `
  -ContentType application/json `
  -Body (@{ token = $token } | ConvertTo-Json)

$apiKey = Invoke-RestMethod -Method Post -Uri http://localhost:8787/auth/api-keys `
  -Headers @{ Authorization = "Bearer $($session.sessionToken)" } `
  -ContentType application/json `
  -Body '{"label":"local development"}'
```

API 利用時は `Authorization: Bearer <sessionToken or apiKey.secret>` を送ります。API key の生値は作成時に一度だけ返し、ストアにはハッシュだけを保存します。

開発環境では `devSignInUrl` をレスポンスに含めます。本番では `DISPRO_EXPOSE_DEV_SIGNIN_LINKS=false` を設定し、`ConsoleMailer` を実メール送信実装へ差し替えます。公開 URL がある場合は `DISPRO_AUTH_BASE_URL=https://example.com` を設定してください。
