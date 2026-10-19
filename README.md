# vrc-ta-hub-bot
VRChat 技術・学術系集会の Discord に入り、LT の応募を VRC 技術学術系 Hub に承認待ちで登録する Bot

現在は Gateway 受信・永続化の土台です。Hub API への登録や投稿処理はまだ行いません。

## 開発

Bun 1.3.6 を使用します。依存の直接指定と `bun.lock` を固定しています。

```sh
bun install --frozen-lockfile
bun test
bunx tsc --noEmit
```

テストは偽の Gateway とローカルの SDK イベントだけを使い、Discord に接続しません。

## 設定と起動

`.env.example` を `.env` にコピーし、次の環境変数を設定します。秘密の値を Git に含めないでください。

| 変数 | 用途 |
| --- | --- |
| `DISCORD_TOKEN` | Bot の認証トークン（必須） |
| `HUB_API_KEY` | Hub API 用の予約設定（必須、現段階では未使用） |
| `HUB_BASE_URL` | Hub API の HTTP(S) ベース URL（必須、現段階では未使用） |
| `JEV_API_KEY` | 後続処理用の予約設定（必須、現段階では未使用） |
| `DISCORD_CHANNEL_IDS` | 受信・履歴補完するチャンネル ID のカンマ区切り（必須） |
| `BOT_DATA_DIR` | 状態の保存先（省略時は作業ディレクトリの `data/`） |

```sh
bun start
```

このコマンドは実際に Discord へ接続します。開発時に接続は不要です。Bot には対象チャンネルの
View Channel と Read Message History が必要です。Developer Portal で Message Content Intent を有効にします。
Gateway の intent は Guilds / GuildMessages / MessageContent のみです。
SDK の `allowedMentions: { parse: [], repliedUser: false }` でメンションを無効化しています。

## 取りこぼしの補完

- `src/gateway.ts` のインターフェースを実装すれば、接続部分を差し替えられます。
- 選択したチャンネルの新着を SQLite の `inbox` に保存します。本文を含むため、保存先へのアクセスを制限してください。
- メッセージ ID は文字列として保存し、比較は `BigInt` で行います。チャンネルごとに `channel_cursors` を保存します。
- 起動時・接続再確立時は最新の履歴から最大 100 件ずつ遡り、保存カーソルより新しい ID だけを取り込みます。
  初回はカーソル `0` から、閲覧可能な全履歴を補完します。
- 補完中・切断中の新着も inbox に保存しますが、カーソルを進めません。全ページの保存成功後に進めます。
  通常受信では inbox とカーソルを同じトランザクションで保存し、重複 ID は無視します。
- 履歴取得に失敗したチャンネルは 5 秒ごとに再試行します。他のチャンネルの補完は継続します。
- 切断後の再接続・セッション再開は discord.js が処理します。再開・再接続のどちらでも履歴を照合します。
  起動失敗・セッション無効化は接続を破棄して終了コード 1 で終了します。同じクライアントで login を繰り返しません。

Discord 上で既に削除された投稿や、権限がなく閲覧できない履歴は復元できません。
更新・削除の同期と inbox の後続処理はこの土台の対象外です。inbox の本文は処理後に消し、取り残しも 23 時間で消します（5 分ごとに削除し、削除した頁は上書き・WAL も切り詰める）。

## 二重起動と停止

保存先の `bot.lock` を排他的に作成し、既存ファイルがあれば接続前に起動を拒否します。
すべての起動で同じ `BOT_DATA_DIR` を指定してください。保存先を分けたプロセス間は排他できません。
SIGINT / SIGTERM では接続・SQLite を閉じてロックを解除します。

強制終了や電源断ではロックが残ります。ロックの PID と実行コマンドを確認し、同じ保存先を使う
プロセスが存在しないことを確かめてから `bot.lock` を削除して再起動します。
稼働中のロックを自動で奪わない設計です。プロセス終了後の再起動は外部の監督プロセスで行ってください。

## 健康状態と計測

`data/health.json`（保存先変更時はその配下）をイベント時および 5 秒ごとに一時ファイルから置換します。
監視側はこの JSON の読み取りだけで判定できます。ファイルの更新に失敗しても受信は続け、構造化警告ログを出します。

| フィールド | 意味・判定例 |
| --- | --- |
| `startedAt` / `updatedAt` | 起動時刻・最終更新時刻。ファイルなし、JSON 不正、更新が 15 秒超古い場合は要確認 |
| `lastReceivedAt` | 選択チャンネルの新着または履歴を最後に受け取った時刻。投稿がなければ古くても正常 |
| `connectionState` | `connecting` / `connected` / `disconnected` / `reconnecting` / `error` / `stopped` |
| `reconnectCount` | 初回接続を除く接続再確立回数 |
| `recoveredMessageCount` | 履歴補完によって inbox に新規保存した件数（重複は含まない） |
| `pendingChannelCount` | 補完待ち・失敗中のチャンネル数。0 で同期完了 |
| `lastSuccessfulSyncAt` | 全選択チャンネルの補完が成功した時刻 |
| `lastErrorAt` | 接続・履歴取得・保存の最終エラー時刻 |

カウンタはプロセスの起動ごとに 0 に戻ります。`updatedAt` が新しくても接続が戻らない、または
`pendingChannelCount` が長時間 0 にならない場合は、接続や履歴補完の停滞として監視します。
初回の全履歴取得は件数に応じて時間がかかるため、許容時間は対象チャンネルに合わせて決めてください。

- 指標: 接続状態、再接続回数、補完件数、補完待ちチャンネル数
- 置き場: `health.json` と標準エラーの JSON ログ（本文・資格情報を含まない）
- 確認方法: `cat data/health.json`（保存先変更時は読み替え）
- 見直し日: 初回稼働の 7 日後に、監視の許容時間と補完待ちの解消を確認
