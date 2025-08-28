# 対戦型テニスゲーム（サーバ中心設計）

## 目的
ローカルLAN内で複数クライアントが接続できるシンプルなテニス対戦プロトタイプを、中央サーバ（Node.js + WebSocket）を中心に設計・実装する。サーバはロビー管理・マッチメイキング・ゲーム中継（および簡易な権限付与）を担当し、ブラウザクライアントはUIと入力送信・描画を担当する。

## 全体アーキテクチャ（要点）
- 中央サーバ（Express + WebSocket）
  - HTTP(S) で静的ファイル配信 / REST API
  - WebSocket（WSS/WS）でリアルタイム双方向通信
  - ロビー管理（接続ユーザリスト、ステータス、ハートビート）
  - マッチメイキング（INVITE / RESPONSE）
  - ゲーム開始時のルーム管理と中継（SERVER-AUTHORITATIVE または RELAY）
  - 簡易ログ/セッション管理
- ブラウザクライアント
  - ロビー画面（ユーザ名入力、参加者リスト、対戦申し込み）
  - ゲーム画面（Canvas描画＋コート装飾、自分視点ミラー、サーブ、スコアはDOMパネル表示）
  - WebSocket 接続によるイベント送受信（JOIN/HEARTBEAT/INVITE/INPUT/GAME_STATE 等）
- 運用
  - 開発環境: サーバとクライアントを同一マシンまたはLAN内複数マシンで動作確認
  - 本設計では UDP ブロードキャストを使わず、HTTP/WebSocket を中継として採用

## メッセージ仕様（JSONベース、例）
全メッセージは JSON。必須フィールド: { type: string, senderId?: string, timestamp?: ISO8601, payload?: object }

主要タイプ（サーバ⇄クライアント）
- CONNECT / CONNECT_ACK
  - 接続確立時のハンドシェイク（senderId の割当 or 登録確認）
- JOIN_LOBBY
  - クライアントがロビー参加（name を送る）
- HEARTBEAT
  - 生存確認（周期: 5s 程度）→ サーバは lastSeen を更新しリスト配信
- PARTICIPANTS (SERVER → CLIENT)
  - 現在のロビー参加者一覧（id, name, status, lastSeen）
- INVITE
  - 申し込み: { targetId, fromId, matchMeta }
- INVITE_RESPONSE
  - { targetId, fromId, accepted: true|false }
- CREATE_ROOM / ROOM_CREATED
  - マッチ承諾後にサーバがゲームルームを作成し、ルームIDとロールを通知
- START_GAME
  - ゲーム開始トリガ（サーバが送信／または役割付与後クライアント発）
- INPUT (CLIENT → SERVER)
  - クライアント入力（例: { type: 'PADDLE_MOVE', x: number, seq: n, ts }）
- GAME_STATE (SERVER → CLIENT)
  - サーバが送る同期状態（例: ボール位置/速度, 各パドル位置, スコア, serveId, ts）
- PING / PONG / DISCONNECT
  - 接続維持・切断通知

設計上の注意:
- サーバは GAME_STATE の「一次ソース」とする（権威サーバ方式） → クライアントはレンダリング/UIに専念。
- 簡易設計ではサーバが物理を計算（ホストオフロード不要）。将来的にホスト権限移譲を導入できる。

## クライアント・サーバ フロー（簡易）
1. クライアントが WebSocket 接続 → CONNECT を送信（name を含める）
2. サーバは CONNECT_ACK と現在の PARTICIPANTS を返す
3. クライアントは HEARTBEAT を定期送信
4. ユーザが相手に INVITE を送る（サーバ経由で転送）
5. 相手が INVITE_RESPONSE を返し承諾したら、サーバが ROOM を作成し CREATE_ROOM/ROOM_CREATED を配信
6. サーバが START_GAME を送る（サーバがシミュレーション開始）→ 定期的に GAME_STATE を送信（例 20Hz）
7. クライアントはローカル入力を INPUT として送信し、サーバは受け取った入力を権威状態に反映（パドル座標、サーブ待ち中はボール追随）
8. 切断/再接続は DISCONNECT と HEARTBEAT ロジックで扱う

## API・エンドポイント（例）
- HTTP
  - GET / → 静的ファイル
  - GET /spec.md など
- WebSocket
  - ws://host:PORT/ws で接続し、JSONメッセージをやり取り

## 同期・遅延対策（簡易）
- サーバが authoritative。クライアントは受信状態をそのまま描画（補間は任意）。
- INPUT は sequence 番号とタイムスタンプを付与。
- GAME_STATE にタイムスタンプを入れ、クライアントは受信遅延を考慮して少し遅らせて表示（buffering, 50-100ms）。
- パケットロス対策: 重要イベント（スコア更新など）は冪等なメッセージで再送可能にする。

## 受け入れ基準（最低限）
- クライアントが WebSocket 経由でサーバに接続し、ロビー参加名前がサーバに表示される
- クライアントからの INVITE に対し、相手が承諾するとサーバ側でルームが作成され、両者に通知される
- サーバが定期的に GAME_STATE（scores/serveId 含む）を配信し、クライアントがそれを受けて描画を行う
- 切断・再接続時にロビー状態が正しく更新される

## 実装フェーズ（優先度付き）
1. サーバ初期化（Express + ws、静的ファイル配信、/ws エンドポイント） — サーバの最小実装
2. 接続/ロビー管理（CONNECT, JOIN_LOBBY, PARTICIPANTS 配信） — ロビーの動作確認
3. マッチメイキング（INVITE/INVITE_RESPONSE/ROOM 管理） — マッチングフロー確認
4. ゲームシミュレーション（サーバで簡易物理、GAME_STATE 配信 20Hz） — クライアント描画連携
5. 入力同期と遅延補正（INPUT seq, クライアント補間） — 遊びやすさ改善
6. テスト・ドキュメント・デプロイ用設定

## セキュリティと運用上の注意
- ローカルプロトタイプでは認証は省略可だが、実運用を想定するなら接続認証と入力検証を導入する
- CORS / WebSocket origin チェックを行う
- 不正パケットや例外時の堅牢なエラーハンドリングを実装する

## 画面・物理仕様（現在実装）

- フィールド寸法: 500x700px
- パドル: 80x12px、上下に1枚ずつ（下=players[0], 上=players[1]）
- 表示:
  - 招待を受けた側はミラー描画（自分は常に下）
  - スコアパネルはキャンバス外DOMで表示（サーブ権インジケータ付）
  - コートライン（外枠/センター/サービス/ネット風点線）は装飾のみ
- サーブ:
  - サーブ待ち中（running=false）はサーブ側パドルにボールが追随
  - クリックでサーブ開始。直前のパドル速度を初速に反映
- 得点:
  - ボールが上下エンドラインを越えると得点。得点者が次サーブ権
  - 得点直後は一時停止し、得点者パドル前へボール再配置
  - 勝敗条件: 先取7点かつ2点差で勝利。長引く場合は最大11点で決着（ハードキャップ）
- 反射:
  - ボール半径込みAABB + 前フレームからのスイープで「すり抜け」防止
  - 接触オフセット + パドル速度で角度・速度を調整（上限あり）
