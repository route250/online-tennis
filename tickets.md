# チケット一覧（最新版）

目的別に現状の計画と未着手/改善点のみを掲載（完了済みは下の変更履歴へ）。

## A. サーバ/ネットワーク
- A-1: サーバ情報APIの堅牢化（優先中）
  - 目的: `/server-info` の応答にプライベートIP検出の失敗時フォールバックやIPv6の扱いを追記
  - 成果物: 例外処理追加、簡易テスト
  - 受入: ローカル/公衆設定いずれでもURLが正しく返る

## B. クライアントUX/操作
（現在はプレイアビリティ重視の最低限に留め、追加演出は見送り）

## C. 品質/テスト
- C-1: テストの強化（未着手）
  - 目的: `tests/test_integration.js` にサーブ解放（mouseup/touchend）とスコア更新のアサートを追加
  - 成果物: テスト更新
  - 受入: サーブ後に `running=true` のGAME_STATEを確認、得点後に再度案内表示を確認

## D. ドキュメント/運用
- D-1: Windows向け起動スクリプト（未着手）
  - 目的: `bin/start-server.bat` の追加
  - 成果物: BATスクリプト、README追記
  - 受入: Windows端末での起動確認

---

## 実施しない（WON'T DO）
- W-1: 画面回転（横向き）時のUI最適化
  - 理由: スコープ外（スマホ縦持ち前提の軽量プロトタイプ）
- W-2: サーブ演出のタイムアウト（自動フェード）
  - 理由: プレイアビリティに与える影響が小さく、優先度を下げる方針

---

## 変更履歴（主要な完了項目）
- ディレクトリ再構成（`client/`, `server/`, `tests/`, `bin/`）
- サーバ（Express + ws）と`/ws`、静的配信`client/`
- ロビー（CONNECT/JOIN_LOBBY/HEARTBEAT/PARTICIPANTS）、INVITE/INVITE_RESPONSE、ROOM作成
- GAME_STATE配信（20Hz）とサーバ権威の物理（すり抜け抑制、速度上限）
- サーブ改善: 解放でサーブ（mouseup/touchend）、中央案内、サーブ側パドル移動で案内消去、スコア縮小
- モバイル最適化: aspect-ratioで縮小表示、座標スケーリング、touch-action調整、入力時iOSオートズーム対策
- ロビーUI刷新: ユーザ名バッジ/退出、QR表示（`/server-info`, `/qr.svg`）
- 起動スクリプト: `bin/start-server.sh`, `bin/server.sh`（`--local/--public`, `-p`）
- ドキュメント整理: README（遊び方/起動）、spec（最新版仕様）、AGENTS更新
