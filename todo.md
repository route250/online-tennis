# TODO（最新版）

短期で価値の高い項目に絞ったタスクリストです。不要・重複の古い項目は削除しました。

## 高優先
- [ ] `tests/test_integration.js` にサーブ解放とスコア更新の検証を追加
- [ ] Windows用起動スクリプト `bin/start-server.bat` を追加

## 中優先
- [ ] `/server-info` のIPv6/失敗時フォールバック改善と簡易テスト追加
- [ ] ゲーム中離脱/中断時のUI復帰（ロビーへ戻る）のガード強化

## 低優先 / 将来
- [ ] 入力送信のレート制御・簡易スロットリング
- [ ] 物理チューニング（速度上限・反発係数の調整UI）
- [ ] 効果音/簡易SEの追加（ミュート切替）

## 実施しない（WON'T DO）
- 画面回転（横向き）時のUI最適化（当面スコープ外）
- サーブ演出のタイムアウト（自動フェード）

## 完了（主なもの）
- [x] ディレクトリ再構成（`client/`, `server/`, `tests/`, `bin/`）
- [x] サーバ（Express + ws）、`/ws`、静的配信 `client/`
- [x] ロビー（JOIN/HEARTBEAT/PARTICIPANTS）、INVITE/ROOM作成
- [x] サーバ権威の物理と `GAME_STATE` 配信（20Hz）
- [x] サーブ改善（解放でサーブ、中央案内、移動で消去、スコア縮小）
- [x] モバイル最適化（座標スケール、touch-action、オートズーム対策）
- [x] QR表示（`/server-info`, `/qr.svg`）
- [x] 起動スクリプト（`bin/start-server.sh`, `bin/server.sh`）
- [x] ドキュメント整理（READMEの遊び方/起動、spec最新版、AGENTS更新、tickets整備）
