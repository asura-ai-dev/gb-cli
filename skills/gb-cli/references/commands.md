# Command reference

必要な command の節だけを読む。実装 version のglobal helpを正本とし、迷う場合は `gb --help` を確認する。個別command専用helpはない。

## Global options

| option | 用途 |
|---|---|
| `--app-session` | 通常版Grok Botのremote app sessionを明示利用する（macOS限定） |
| `--data-root PATH` | discovery の data root を明示する |
| `--gateway-url URL` | discovery を使わず gateway URL を明示する |
| `--allow-remote` | loopback 以外への接続を明示的に許可する |
| `--allow-unsupported` | 観測対象外desktop app/local host versionへの変更操作を明示的に許可する。v0.30 agent作成拒否は迂回しない |
| `--request-timeout SEC` | HTTP request timeout を指定する |
| `--help` | help を表示する |
| `--version` | CLI version を表示する |

`--app-session` は `--allow-remote` が必須で、`--data-root`、`--gateway-url`、`GB_GATEWAY_URL` と競合する。通常discoveryから自動選択されることはない。
app-sessionを選んだ場合、両global flagsはdoctorだけでなく後続の各invocationにも必要になる。shell functionやaliasへ省略形を置いてもそのshell session固有で、新しいshellやagent runnerへは残らない。
descriptor entryは保存から7日以内だけ有効で、5分を超える未来時刻も拒否される。
app-sessionはsystem/user Applicationsの固定2 bundle候補からdesktop appVersionを取得する。known mismatchの変更だけが `--allow-unsupported` の対象で、missing/invalid/ambiguousなsourceはoverrideできない。

## App session authorization

```sh
gb app-session authorize --yes
```

macOSのstdin・stdout・stderrがTTYの対話Terminalで、ユーザー本人だけが実行する。親stdinをchildへ継承し、OS GUIまたはstderrの確認promptを表示する。secret stdoutは継承せず64KiBまで逐次zeroizeする。descriptor読取、復号、network接続は行わない。成功はexit `0`、`--yes` 欠落・非TTYは`2`、timeout・拒否等は`3`、SIGINTは`130`。

agentはこのcommandを実行せず、shell redirectionや手動のsecret取得commandへ置き換えない。doctorのJSON stderrが `reason: "keychain-timeout"` の場合にユーザーへ案内し、成功報告後だけdoctorを1回再試行する。以前のprompt非表示版でtimeoutした場合は、修正版導入後に限りユーザー本人がauthorizeを1回再試行できる。修正版での60秒timeoutは `authorize-timeout` として停止し、同commandの再実行を案内しない。authorizeの成功は固定Keychain itemへのlocal access確認だけであり、remote app-session接続の許可とは別の承認境界である。

## Diagnostics

```sh
gb doctor [--json]
gb status [--json]
```

`doctor` は discovery、descriptor、process、health、version compatibility の切り分けに使う。`status` は到達可能な gateway/host の現在状態を取得する。app-sessionではdesktop appVersionのcompatibility metadataだけを公開し、remote hostVersionは判定・出力に使わない。local gatewayはhostVersionを使う。
app-sessionのcompatibilityは対応version一覧、選択profile、capabilitiesを含む。v0.30.0の `app-session-v0.30-gateway-direct` はgateway read、agent discovery、exact-ID解決後のagent操作を対象にし、専用Temporal backendは持たない。

### 接続方式のtroubleshooting

- `gb doctor --json` のexit `3`はlocal/default discoveryの失敗であり、通常版Grok Bot全体が未接続とは断定できない。
- 当該依頼でremote app-session接続が明示承認済みなら、`gb --app-session --allow-remote doctor --json` を別の接続方式として使う。自動fallbackはしない。
- remote承認が不明なら、通常版desktopのremote app-session接続を許可するかユーザーへ確認して停止する。
- flagged doctorが成功した後も、app-sessionを使う各commandへ `--app-session --allow-remote` を毎回付ける。
- desktop appVersion不一致のread-only結果はwarning付き成功になり得る。変更操作では対象versionの契約を再調査し、`--allow-unsupported` を通常のtroubleshooting手段として勧めない。再調査後に残るriskをユーザーが明示承認した場合だけ検討する。

## Agents

```sh
gb agents list [--json]
gb agents search --query Q [--limit N] [--json]
gb agents create --name N --description D [--json]
```

search の `--limit` 既定値は 20。作成は state を変更する。曖昧な検索結果から ID を推測せず、必要なら list/search の JSON で確認する。
v0.30.0のapp-sessionではserverがTemporalを選び得るため `agents create` はAPI前に `temporal-create-unsupported` で拒否される。`--allow-unsupported` では継続できない。

## Transcript and prompt

```sh
gb transcript tail --agent ID [--limit N] [--before-seq N] [--json]
gb send --agent ID (--prompt TEXT | --stdin) [--json]
```

`transcript tail` は直近の transcript page を取得し、`--limit` 既定値は 50。`--before-seq` で前の page を指定できる。`send` の prompt は引数または stdin の一方だけを使う。runnerのstdin channelへpromptを書き、続けてEOF/closeを送る方法を第一選択にする。安全なstdin channelが使えない場合は、敏感なpromptを `--prompt`、pipe command、temp fileへ勝手に移さず、安全な実行または露出許可を確認して停止する。成功は request の受理を意味し、agent の処理完了を意味しない。
v0.30.0ではtail/sendの前にCLIが `listAgents` でIDを完全一致・一意確認する。harnessは判定に使わず、missing/box/temporal/unknownのいずれも同じgateway APIへ直接routeする。

## Events and chat

```sh
gb watch --agent ID [--timeout SEC]
gb chat --agent ID (--prompt TEXT | --stdin) [--timeout SEC]
```

両方とも stdout は JSONL。`watch` はread-only、`chat` はSSE接続後にpromptを1回送る変更操作。単発chatは120秒を初期目安にできるが完了判定ではない。timeoutはexit `0`、SIGINTは`130`で、どちらもローカル購読だけを終了しremote runを停止しない。一般的terminal event/完了schemaは未定義で、未知eventからrun完了や回答本文を推測せず「完了未確認」とする。timeoutや未知eventで自動interruptしない。
v0.30.0ではwatch/chatのSSE接続前にexact IDを確認し、chatはSSE open後・送信直前にも再解決する。再解決は存在と一意性だけを確認し、harness変化はgateway-direct routeを妨げない。

## Interrupt

```sh
gb interrupt --agent ID --yes [--json]
```

active run を中断する変更系操作。誤操作防止の `--yes` が必須だが、ユーザー承認の代替ではない。結果の `hadActiveRun` が false なら、request 成功と実際の中断発生を区別する。
v0.30.0ではexact ID解決後にharnessに依存せずinterrupt APIを呼ぶ。

## Output contract

対応 command の `--json` は stdout に機械可読 JSON を出す。`watch` / `chat` は 1 event 1 行の JSONL。診断は stderr、結果は stdout とし、自動化では文言でなく exit code を判定する。app sessionの設定失敗はstdoutを空に保ち、stderrへ安全な `reason`、`message`、`hint` を持つJSONを出す。
v0.30のID解決・作成拒否も `--json` commandでは同じ安全なJSON errorを返す。watch/chatではstderrの固定文面にstable reasonを含める。主なreasonは `agent-not-found`、`agent-selection-ambiguous`、`temporal-create-unsupported`。gatewayがagent固有requestを拒否した場合はAPI rejectionとして扱い、transport errorに読み替えない。
