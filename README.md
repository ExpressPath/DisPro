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
npm.cmd run simulate
npm.cmd run server
```

PowerShell の実行ポリシーで `npm` が止まる場合は、上のように `npm.cmd` を使ってください。

## 主要ファイル

- `docs/implementation-phases.md`: 実装フェーズの分解
- `src/services/orderOrchestrator.ts`: 注文計画の入口
- `src/api/httpServer.ts`: 注文・タスク・ノード API
- `src/storage/fileDisproStore.ts`: JSON ファイル永続化ストア
- `src/domain/taskSplitter.ts`: 注文からタスクへの分割
- `src/domain/scheduler.ts`: タスクからノードへの割り当て
- `src/domain/auditLog.ts`: 署名ログの土台になるハッシュチェーン
- `src/cli/simulate-order.ts`: 注文計画のローカル実行サンプル

## API

`npm.cmd run server` を実行すると、デフォルトで `http://localhost:8787` に API が起動します。状態ファイルは `.dispro/state.json` に保存されます。

- `GET /health`: API ヘルスチェック
- `GET /nodes`: 登録済みノード一覧
- `POST /nodes/register`: ノード登録・更新
- `POST /orders`: 注文を作成し、タスク計画を保存
- `GET /orders`: 注文サマリー一覧
- `GET /orders/:orderId`: 注文計画の詳細
- `GET /orders/:orderId/tasks`: タスク・割り当て一覧
- `GET /orders/:orderId/audit`: 監査イベントとハッシュチェーン検証結果

任意タスクは `workload` に自由な文字列を入れ、必要に応じて `requirements.workloadProfile` で単価、標準チャンクサイズ、推定メモリ、GPU 優先などを指定します。指定がない場合は汎用プロファイルで分割されます。
