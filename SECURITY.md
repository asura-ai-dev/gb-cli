# セキュリティポリシー

## 報告方法

脆弱性を見つけた場合は、公開 Issue へ詳細を書かず、GitHub の
[Private vulnerability reporting](https://github.com/asura-ai-dev/gb-cli/security/advisories/new)
を優先して報告してください。再現手順、影響範囲、確認したバージョンを、秘密情報を除いて添えてください。

Private vulnerability reportingが無効、または上記リンクを利用できない場合は、公開 Issue に脆弱性の詳細や秘密情報を書かず、保守者へprivateな連絡手段の確認だけを依頼してください。privateな連絡経路が確立するまで詳細の共有は保留してください。

## 対象範囲

現時点は初回release前のため、公開されたsupported releaseはありません。初回release後は、このリポジトリの最新releaseだけを保守対象とします。Grok Bot 本体、xAI のサービス、第三者の環境に関する問題は、それぞれの提供元へ報告してください。

`gateway.json` の token、Authorization header、会話内容、ユーザー識別子などを、Issue、ログ、スクリーンショットへ含めないでください。`--app-session` の調査では、app descriptor、Keychain password、復号済みconnection、remote URL、routing header値も同様に扱ってください。報告の確認中も、実環境への侵入、永続化、データ持ち出しは行わないでください。

`--app-session` はmacOSの固定2 app bundle候補、固定descriptor、固定Keychain serviceだけを、ユーザーが指定した時に読みます。app bundleとInfo.plistの非symlink/realpath境界を確認し、固定 `plutil` でidentifierとstrictなdesktop appVersionだけを取得します。通常discoveryからの自動fallbackはなく、`--allow-remote` が必須です。復号値はmemory内でBearer認証とallowlist済みrouting headerにだけ使います。descriptor format、Safe Storage実装、remote側の契約はGrok Bot更新で変わり得ます。app-sessionはv0.24.0とv0.30.0 gateway-direct profileを対応対象とし、local gatewayの対応hostVersionはv0.24.0のままです。

app-session互換性の正本はdesktop appVersionで、remote hostVersionは別namespaceとして判定・公開に使いません。known mismatchはread-only warning、変更操作の既定拒否と明示 `--allow-unsupported` を適用します。bundle missing/invalid/ambiguousなどsourceを確定できない状態はoverride不可で、descriptor、Keychain、networkより前にfail closedします。plist path、raw plist、`plutil` stderrは公開しません。local gatewayのhostVersion gateは従来どおりです。

v0.30.0のagent固有操作は `listAgents` でIDを完全一致・一意解決した後、harnessに依存せず同じgateway API/SSEへ直接routeします。明示Temporalでも専用backendへ切り替えず、Cursor account credentialや追加secret storeは読みません。gatewayが拒否したrequestはAPI rejectionとして扱います。v0.30.0のagent作成は送信前に拒否し、`--allow-unsupported` でも迂回できません。

Keychain stdout、PBKDF2 key、復号plaintext Bufferは利用後にbest-effortでzeroizeします。ただしJavaScript文字列は確実な上書きを保証できないため、parse後のtoken、URL、header値などを完全消去できるという保証ではありません。これらを出力・永続化せず、process lifetimeを越えて保持しないことを安全境界とします。

通常doctorのKeychain確認は3秒で打ち切り、自動再試行しません。`keychain-timeout` 時の `gb app-session authorize --yes` は、ユーザー本人のmacOS対話Terminal専用です。固定Keychain itemを最大60秒待ち、親stdinをchildへ継承してOS GUIまたはstderrの確認promptへ応答可能にします。secret stdoutは継承せず64KiBまで逐次zeroizeし、descriptor、復号connection、networkを使用しません。agent、CI、非TTY runner、shell redirectionから実行したり、手動のsecret取得commandへ置き換えたりしないでください。以前のprompt非表示版でtimeoutした場合だけ、修正版の導入後にユーザー本人が1回再試行できます。修正版でのtimeoutは別の `authorize-timeout` として停止し、それ以上の再実行を案内しません。
