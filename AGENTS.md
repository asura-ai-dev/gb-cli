# AGENTS.md

- 日本語で応答し、依頼範囲だけを局所的に変更する。
- `agent-docs/` は Grok Bot v0.24.0 契約の読み取り専用資料とし、編集・force-add・公開物へのコピーをしない。
- gateway token、Authorization、raw descriptor、prompt、credential をログ・fixture・エラー・公開文書へ残さない。
- agent自身による Electron descriptor、Application Support、cookie、secret store の探索・直接読取は禁止する。例外は、ユーザーが当該依頼で `gb --app-session --allow-remote` を明示承認した場合に限り、CLI実装が固定resourceへアクセスできる。agentはraw秘密を出力せず、通常discoveryから自動fallbackせず、`gb app-session authorize --yes` を実行しない。
- 変更後は `npm test` と `npm run check` を実行する。skill変更時は `scripts/validate-skills` も実行する。
- release、version bump、commit、push、publish は明示要求がある場合だけ行う。
- 破壊的操作や未知の変更の巻き戻しを行わない。
