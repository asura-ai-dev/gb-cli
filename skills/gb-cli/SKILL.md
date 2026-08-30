---
name: gb-cli
description: Inspect and operate a Grok Bot local/dev gateway or an explicitly approved desktop remote app session with gb-cli.
---

# gb-cli

Grok Bot desktop のlocal/dev gatewayまたは明示承認済みremote app sessionを `gb` で確認・操作する。
対象はlocal gateway v0.24.0と、desktop app-session v0.24.0 / v0.30.0 gateway-direct profileであり、xAI 公式 Grok CLI とは別物として扱う。

## 最初に確認すること

1. `command -v gb` と `gb --version` で CLI が利用できるか確認する。
2. CLI がなければ、source checkoutの `npm install && npm link` を案内する。registry packageは公開後だけ案内し、無断でinstallしない。
3. 通常版desktopのremote app session利用が当該依頼で明示承認済みなら、最初から `gb --app-session --allow-remote doctor --json` を使う。
4. local/dev gatewayを対象にするなら `gb doctor --json` で自動discoveryする。
5. 接続方式もremote承認も不明ならunflagged doctorを使う。exit `3`でも「local gateway未発見」とだけ判断し、Grok Bot全体の切断と断定しない。remote app session接続の許可をユーザーへ確認して停止する。
6. 操作対象の agent は、選んだ接続方式と同じglobal flagsを付けた `agents list` または `agents search` で特定する。
7. app-session v0.30.0ではcompatibility profileを確認し、agent固有操作はexact IDからgatewayへ直接route、agent作成は不可として扱う。
8. 変更系操作の前に、対象 ID と入力内容がユーザーの依頼に一致するか確認する。

remote承認を別の依頼へ持ち越さず、app sessionへ自動fallbackしない。
ユーザーが指定していないdata rootやgateway URLを推測して固定しない。

## 操作の選択

- 接続診断は `gb doctor`。
- 現在状態の取得は `gb status`。
- agent の列挙・検索・作成は `gb agents list|search|create`。
- transcript の直近 entry は `gb transcript tail`。
- prompt 送信は `gb send`。
- event の継続購読は `gb watch`。
- stdin と event stream を使う対話は `gb chat`。
- active run の中断は `gb interrupt`。

完全な引数と出力形式が必要なら [references/commands.md](references/commands.md) を読む。
接続先、version override、秘密情報の判断が必要なら [references/safety.md](references/safety.md) を読む。

## 実行規則

read-only の確認では、後続処理がある場合に `--json` を優先する。
human-readable output をユーザーが求めた場合は `--json` を外してよい。
`watch` と `chat` は常に JSONL なので `--json` を追加しない。

継続購読には依頼に見合う `--timeout SEC` を付ける。
単発chatはまず120秒を初期目安にするが、timeoutを完了判定には使わない。
ユーザーが明示的に監視継続を求めた場合だけ timeout なしで起動する。
timeout 終了は exit code `0` の正常終了として扱う。
ただしtimeout/SIGINTはローカル購読だけを終了し、remote runを停止せず、回答完了も意味しない。

`agents create`、`send`、`chat`、`interrupt` は remote state を変更する。
ユーザーの依頼が read-only の場合は実行しない。
対象agentと name・description・prompt を依頼内容に照合し、変更の承認境界を越えない。
desktop v0.30.0では `agents create` を実行しない。`--allow-unsupported` でもこの制限は迂回できない。
v0.30.0のtail/watch/send/chat/interruptはCLIが操作前にagentを完全一致・一意解決し、harnessを理由に拒否せずgatewayへ直接routeする。
harnessがmissing、box、temporal、未知のいずれでも専用Temporal backendへ切り替えず、追加のCursor account credentialを取得しない。
gateway側の拒否はAPI rejectionとして扱い、transport failureに読み替えて自動再試行しない。
prompt は shell history へ残しにくい `--stdin` を推奨する。
runnerのstdin channelへpromptを書き、続けてEOF/closeを送る方法を第一選択にする。
安全なstdin channelが使えない場合は、敏感なpromptを `--prompt`、pipe command、temp fileへ勝手に移さない。
その場合は実行不能を報告し、安全な実行または露出許可をユーザーへ確認して停止する。
`--prompt` を使う必要がある場合は、CLI へ渡す文字列を shell の一引数として安全に扱う。

## 接続境界

local/dev gatewayを選んだ場合は既定discoveryとloopback接続を使う。
`--gateway-url` はユーザーが指定した場合、または既定 discovery の代替として明確に必要な場合だけ使う。
URL の userinfo、query、fragment に credential を埋め込まない。

loopback 以外へは、ユーザーが接続先を認識して許可した場合だけ `--allow-remote` を使う。
この flag は gateway 認証、TLS、host 側の権限制御を迂回する許可ではない。

`--app-session` はmacOSの通常版Grok Botからremote接続情報をmemory内で取得する明示経路で、desktop appVersionからv0.24.0またはv0.30.0 gateway-direct profileを選ぶ。
ユーザーのremote接続承認を確認し、必ず `--allow-remote` と併用する。
`--data-root`、`--gateway-url`、`GB_GATEWAY_URL` とは併用しない。
通常discoveryが失敗してもapp sessionへ自動fallbackしない。
保存から7日を超えたdescriptor entryや5分を超える未来時刻は、credential access前に拒否される。
app-sessionのversion sourceはsystem/user Applicationsにある固定2候補の非symlink app bundleだけで、desktop appVersionを対応profileと比較する。
remote hostVersionは別namespaceなのでapp-session互換判定や公開出力に使わない。local gatewayでは従来どおりhostVersionを使う。
local gatewayの対応hostVersionはv0.24.0のままで、v0.30.0対応をlocal接続へ拡張しない。
bundle missing/invalid/ambiguousはdescriptor、Keychain、network前に拒否し、`--allow-unsupported` でも続行しない。

`reason: "keychain-timeout"` では作業を停止し、ユーザー本人へ対話Terminalから `gb app-session authorize --yes` を実行するよう依頼する。
agent自身、runner、subagentからauthorizeを実行しない。
authorizeは親Terminalのstdinをchildへ継承し、OS GUIまたはstderrの確認promptをユーザーへ表示する。secret stdoutは表示せず64KiBまで逐次zeroizeする。
shell redirectionや手動のsecret取得commandへ置き換えない。
ユーザーがauthorize成功を報告した後だけdoctorを1回再試行する。
authorize自身の `authorize-timeout`、拒否、失敗時は再実行を促さず停止し、必要ならKeychainとGrok Botの状態確認だけを案内する。
以前のprompt非表示版でtimeoutしたユーザーは、修正版を導入後に本人が対話Terminalから1回だけauthorizeを再試行できる。

known desktop appVersion不一致のread-only操作ではwarningを保持し、互換性が確認済みとは表現しない。
変更操作がversion不一致で拒否された場合は、まず対象versionの契約を再調査し、未確認互換性であることを報告する。
`--allow-unsupported` を通常の解決策として勧めず、再調査後にユーザーが残るriskを明示承認した場合だけ使う。
override 後に成功しても、その version の互換性が証明されたとは表現しない。

## 秘密情報

gateway token、Authorization header、raw descriptor、credential、private URL、実会話をログや回答へ転載しない。
app sessionのKeychain password、復号済みconnection、routing header値も転載しない。
診断結果を共有する時は、CLI が redaction 済みの field だけを使う。
秘密値が混ざる可能性がある raw file や環境変数を広く列挙しない。

prompt と transcript は依頼達成に必要な最小範囲だけ扱う。
transcript の全文を取得・提示する必要がなければ tail と適切な件数に留める。

## エラー処理

終了コードを第一の分類に使う。

- `0`: 成功。watch/chat timeout も含む。
- `2`: usage error。help と引数を確認する。
- `3`: discovery、config、unsupported version。選択中の接続方式と同じglobal flagsを付けたdoctorで診断する。
- `4`: transport/protocol error。到達性と観測契約の差を確認する。
- `5`: API rejection。入力と host 側の拒否理由を確認する。
- `130`: SIGINT。ユーザーまたは呼出元による中断として扱う。

未知の失敗で flag を追加して繰り返さない。
まずstderrと、選択中の接続方式で実行したdoctorのredaction済み情報で原因を絞る。
app sessionのJSON診断ではstderrの非秘密 `reason` と `hint` だけを共有する。
`keychain-timeout` と通常の `keychain` failureを区別し、前者以外でauthorizeを案内しない。
API rejection を transport failure として再試行しない。
`agent-not-found`、`agent-selection-ambiguous`、`temporal-create-unsupported` はID解決・作成のcapability境界として扱い、flag追加で再試行しない。

## 結果の報告

実行した論理操作、対象 agent、成否を簡潔に報告する。
機械出力を要約する場合も ID と状態の対応を崩さない。
秘密値、不要な transcript 本文、内部 endpoint は省く。

変更系操作では、API が受理したことと agent が作業を完了したことを区別する。
必要なら `watch`、`status`、または `transcript tail` で観測可能な完了状態を確認する。
transcript event の未知fieldから run完了や回答本文のschemaを推測しない。
一般的なterminal event/完了schemaは未定義なので、CLIだけでは「完了未確認」と報告する。
timeoutや未知eventで自動interruptしない。`interrupt --yes` はユーザー承認の代替ではない。
