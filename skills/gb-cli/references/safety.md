# Safety and compatibility

## 観測契約

gb-cli は macOS 版 Grok Bot desktop v0.24.0を2026-08-29、v0.30.0を2026-08-30に静的調査し、read-onlyで観測したgateway契約を対象とする。v0.30.0はgateway-direct profileであり、専用Temporal backendまで含む完全対応ではない。xAI、Grok、Grok Bot の公式・提携・承認済みツールではなく、xAI公式Grok CLIとも別物である。

非公開契約は製品更新で予告なく変わり得る。local gatewayはhostVersion、app-sessionは固定bundleのdesktop appVersionを互換性sourceにする。local対応hostVersionはv0.24.0、app-session対応profileはv0.24.0とv0.30.0 gateway-direct profileである。known対象外versionのread-only操作はwarning付きで続くが、変更操作は既定で拒否される。変更が必要なら対象versionの契約を再調査し、`--allow-unsupported` を通常の解決策として勧めない。再調査後も残るriskをユーザーが明示承認した場合だけ検討する。unknown sourceとv0.30 agent作成拒否はoverrideしない。

## Discovery

local/dev gatewayを対象にする時は、data root の `gateway.json` を CLI に発見させる。unflagged doctorのexit `3`はlocal gateway未発見を示すだけで、Grok Bot全体の切断とは断定しない。descriptor は crash 後に stale になり得るため、記録された endpoint を恒久設定にコピーしない。CLI の process/schema/health 確認結果を使う。

token が存在する場合は Bearer authentication にだけ使う。値を表示、記録、文書化しない。descriptor の raw JSON を回答や公開ログへ貼らない。

## Remote connection

既定は loopback だけを許可する。`--allow-remote` は、ユーザーが接続先と network exposure を認識して許可した場合に限る。認証や TLS の代替ではない。

`--gateway-url` に userinfo、credential query、fragment を含めない。shell history、CI log、process argument に秘密値を残さない。

通常版Grok Botのremote app sessionは、ユーザーが当該依頼で接続を明示承認した場合だけ `--app-session --allow-remote` で選ぶ。このoptionはmacOSの固定descriptorと固定Keychain serviceを読むため、read-only commandでもcredential accessを伴う。承認済みなら最初のdoctorから両flagを使い、後続の各invocationにも指定する。承認不明なら確認して停止し、通常discovery失敗時の代替として勝手に追加したり承認を永続化したりしない。

system/user Applicationsの固定2候補だけで非symlink app bundle/Info.plist境界を検証し、固定 `plutil` からidentifierとstrictなdesktop appVersionだけを得る。valid候補なし・複数valid・invalid sourceはdescriptor、Keychain、network前に拒否する。remote hostVersionはapp-sessionの互換判定や公開出力に使わない。

descriptor entryは保存から7日以内だけを受理し、5分を超える未来時刻も拒否する。staleの場合はKeychainやnetworkへ進まず、Grok Botでsessionを更新する。

app sessionのremote URL、Bearer token、routing header値、Keychain password、raw descriptor、復号済みconnectionは表示・記録しない。`gb doctor --json` が返すsourceやauth有無などの非秘密metadataだけを共有する。

通常doctorのKeychain確認は3秒で終了し、localeやerror textでなく `keychain-timeout` reasonで分類される。このreasonの場合だけ、ユーザー本人へmacOSの対話Terminalから `gb app-session authorize --yes` を実行するよう依頼する。agent自身はauthorizeを実行しない。成功報告後のdoctor再試行は1回に限り、timeout・拒否・通常の `keychain` failureでは停止する。

authorizeは固定Keychain itemを最大60秒待つlocal-only commandである。親stdinをchildへ継承してOS GUIまたはstderrの確認promptを表示し、secret stdoutは継承せず64KiBまで逐次zeroizeする。descriptor、復号処理、remote gatewayは使わない。成功してもremote接続を許可したことにはならず、app-session利用承認とは別境界である。agentは実行せず、shell redirectionや手動のsecret取得commandへ置き換えない。以前のprompt非表示版でtimeoutした場合だけ、修正版導入後にユーザー本人が1回再試行できる。修正版のtimeoutは `authorize-timeout` として停止し、再実行ではなく必要に応じたKeychainとGrok Botの状態確認だけを案内する。

## State changes

次は remote state を変更する。

- `gb agents create`
- `gb send`
- `gb chat`
- `gb interrupt`

対象 ID、name/description、prompt を実行直前に依頼内容と照合する。read-only依頼では実行しない。`send`/`chat` の受理とagentの完了、`interrupt` のrequest成功とactive runの有無を区別する。`--yes` はユーザー承認の代替ではない。

`watch`/`chat`のtimeoutやSIGINTはローカルSSE購読だけを終了し、remote runを止めない。一般的terminal event/完了schemaは未定義なので、CLIだけでは回答完了を保証せず「完了未確認」とする。timeoutや未知eventで自動interruptしない。

## v0.30.0 gateway-direct boundary

v0.30.0ではdoctor/status/list/searchをgatewayで扱う。tail/watch/send/chat/interruptは操作前に `listAgents` でIDを完全一致・一意解決し、harnessに依存せず対象gateway APIまたはSSEへ直接routeする。chatはSSE open後の送信直前にも存在と一意性を再確認する。

harnessがmissing、box、temporal、未知のいずれでもgateway-direct routeは同じであり、harnessを理由にCLI側で拒否しない。明示Temporalでも専用backendへ切り替えず、追加secret storeやCursor credentialを探索しない。gatewayが拒否した場合はAPI rejectionとし、transport failureとして再試行しない。agent作成はserverがTemporalを選び得るためAPI前に拒否し、`--allow-unsupported` でも迂回しない。

## Data minimization

transcript と prompt は機密情報を含み得る。必要な agent と範囲だけを取得し、不要な本文を回答・ログ・fixture へ複製しない。event stream も必要な時間だけ購読する。

失敗調査で環境変数、credential store、Application Support、raw traffic を広く読むことはしない。app session指定時も、CLIが固定対象を読む以外に探索範囲を広げない。まず選択中の接続方式と同じglobal flagsを付けたdoctorのredaction済み結果とexit codeを使う。
