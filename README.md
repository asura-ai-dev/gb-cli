# gb-cli

Grok Bot desktop のlocal gatewayまたは明示承認済みremote app sessionを、terminalやagentから安全に操作するための非公式CLIです。agent 一覧・検索・作成、transcript 参照、prompt 送信、event 監視、対話、実行中断を提供します。

> [!IMPORTANT]
> このプロジェクトは xAI、Grok、Grok Bot の公式プロジェクトではなく、提携・承認も受けていません。通信契約は macOS 版 Grok Bot desktop **v0.24.0** を 2026-08-29、**v0.30.0** を 2026-08-30 に静的調査および read-only 観測して得たものです。v0.30.0 はgateway-direct profileを対象としますが、専用Temporal backendを実装した完全対応ではありません。非公開契約のため、製品更新で予告なく動かなくなる可能性があります。xAI 公式 Grok CLI は別製品です。

## 必要条件

- Node.js 20 以上
- macOS 上の Grok Bot desktop v0.24.0、またはv0.30.0のgateway-direct profile
- 到達可能なlocal/dev gateway、または明示承認済みremote app session

## インストール

現在利用できる導線は、このリポジトリの source checkout です。npm registry package や GitHub Release は提供していません。

```sh
git clone https://github.com/asura-ai-dev/gb-cli.git
cd gb-cli
npm install
npm link
gb --help
```

global linkを作らずcheckout内から実行する場合は、`node ./bin/gb.js --help` を使えます。

source checkoutにはCLIとcanonicalな `skills/gb-cli/` が含まれます。Codex向け `.agents/skills/gb-cli` とClaude Code向け `.claude/skills/gb-cli` の既存symlinkがcanonical skillを指します。install時にskill登録やcredential accessを行うscriptはありません。

Codex / Claude Codeへ通常版desktopの診断を依頼する時は、接続許可も同じ依頼で明記します。

- Codex: `$gb-cli` を使い、通常版Grok Botのremote app-session接続を許可する。read-onlyでdoctorを実行して結果を要約して。
- Claude Code: `gb-cli` skillを使い、通常版Grok Botのremote app-session接続を許可する。read-onlyでdoctorを実行して結果を要約して。

## 使い始める

接続方式を先に選びます。global flagsは接続する各commandへ毎回指定します。

### 通常版Grok Bot desktop

通常版desktopのremote app sessionへ接続することをユーザーが当該依頼で明示許可した場合は、最初からfull flagsで診断します。

```sh
gb --app-session --allow-remote doctor --json
gb --app-session --allow-remote status --json
gb --app-session --allow-remote agents list --json
gb --app-session --allow-remote transcript tail --agent AGENT_ID --json
```

remote接続の許可は依頼ごとに確認し、永続承認やlocal discoveryからの自動fallbackとして扱いません。
v0.30.0でagent固有commandを使うと、CLIは操作直前に `listAgents` でIDを完全一致・一意確認し、harnessに依存せずgatewayへ直接routeします。

### Local / dev gateway

localまたはdev gatewayを対象にする場合はunflagged commandで自動discoveryします。

```sh
gb doctor --json
gb status --json
gb agents list --json
```

CLI は既定の data root から `gateway.json` を発見し、schema、host process、health を確認して接続します。token がある場合は memory 内の Bearer 認証にだけ使い、標準出力やエラーへ表示しません。接続方式やremote許可が不明な場合、unflagged doctorのexit `3`は「local gateway未発見」を示すだけで、Grok Bot全体の切断を意味しません。通常版desktopのremote app-session接続を許可するかユーザーへ確認し、許可が得られるまで停止してください。

### App sessionの安全境界

`--app-session` はmacOS限定です。最初にsystem `/Applications/Grok Bot.app` とuser `~/Applications/Grok Bot.app` の固定2候補だけを確認し、非symlinkのapp bundle/Info.plistから固定 `plutil` でbundle identifierとdesktop app versionだけを取得します。valid bundleがない場合や複数ある場合はdescriptor、Keychain、networkへ進みません。その後、固定の `~/Library/Application Support/Grok Bot/gateway-descriptor.json` とKeychain service `Grok Bot Safe Storage` だけを読み、Electron Safe Storage v10のconnectionをmemory内で復号します。descriptor entryは保存から7日以内だけ有効で、5分を超える未来時刻もKeychain access前に拒否します。Bearer tokenと許可されたrouting headerはrequestにだけ使い、接続先、token、header値、raw descriptor、Keychain passwordを出力・保存しません。この経路への自動fallbackはありません。

app-sessionの互換性はbundleから得たstrictなdesktop `appVersion` でprofileを選びます。v0.24.0は従来のgateway profile、v0.30.0はgateway-direct profileです。remote gatewayの `hostVersion` は別namespaceとして互換判定や公開出力に使いません。doctor/statusは対応version一覧、選択profile、非秘密のcapability metadataを出力します。

v0.30.0では `doctor`、`status`、`agents list`、`agents search`に加え、`transcript tail`、`watch`、`send`、`chat`、`interrupt` を利用できます。agent固有操作は `listAgents` で対象IDを完全一致・一意解決した後、harnessが欠落、`box`、`temporal`、未知のいずれでも同じgateway API/SSEへ直接routeします。明示 `temporal` でも専用backendへ切り替えず、追加のCursor account credentialも取得しません。gatewayがrequestを拒否した場合はAPI rejectionとして扱い、transport errorとして再試行しません。`agents create` はserverがTemporalを選び得るためv0.30.0では送信前に拒否し、`--allow-unsupported` でも迂回できません。

対応一覧にないknown appVersionはread-only操作をwarning付きで続行し、変更操作を既定で拒否します。変更が必要なら対象versionの契約を再調査し、`--allow-unsupported` を安易な解決策として使わないでください。再調査後も残る未確認互換性をユーザーが明示承認した場合だけoverrideを検討します。bundle missing、invalid、symlink、複数validなどversion sourceを確定できない状態はoverrideできません。

### 初回Keychain承認

`gb --app-session --allow-remote doctor --json` がstderrへ `reason: "keychain-timeout"` を返した場合は、自動再試行しないでください。ユーザー本人がmacOSの対話Terminalから次を1回実行し、OSの確認を完了します。

```sh
gb app-session authorize --yes
```

このlocal-only commandはstdin・stdout・stderrがTTYの場合だけ、固定Keychain serviceへのaccessを最大60秒待ちます。childへ親Terminalのstdinを継承するため、OS GUIまたはTerminalの確認promptへユーザー本人が応答できます。childのstderrはprompt表示に使いますが、secretを含むstdoutは継承せず64KiBを上限に破棄して即zeroizeします。取得値は表示・保存せず、descriptor読取、復号、gateway接続は行いません。成功はKeychain accessの確認だけで、remote app-session接続の許可とは別境界です。agentや非対話runnerから実行せず、shell redirectionや手動でsecretを取得するcommandへ置き換えないでください。

以前のprompt非表示版でtimeoutした場合は、修正版を導入した後に限り、ユーザー本人が上記commandを対話Terminalから1回だけ再試行します。成功を確認した後だけdoctorを1回再試行してください。修正版のauthorize自身の60秒timeoutはdoctorの `keychain-timeout` と分けて `authorize-timeout` として扱い、同commandの再実行を案内しません。timeout、拒否、item不存在などで失敗した場合は停止します。

## コマンド

正確な引数とglobal optionは `gb --help` で確認できます。個別command専用helpはありません。

| コマンド | 用途 | 出力 |
|---|---|---|
| `gb doctor` | discovery、descriptor、process、health、互換性を診断 | human / `--json` |
| `gb app-session authorize --yes` | ユーザー本人が対話Terminalで初回Keychain accessを確認 | human |
| `gb status` | gateway と host の状態を表示 | human / `--json` |
| `gb agents list` | agent 一覧を取得 | human / `--json` |
| `gb agents search --query Q [--limit N]` | agent を検索（既定 limit: 20） | human / `--json` |
| `gb agents create --name N --description D` | agent を作成 | human / `--json` |
| `gb transcript tail --agent ID [--limit N] [--before-seq N]` | transcript の末尾を取得（既定 limit: 50） | human / `--json` |
| `gb send --agent ID (--prompt TEXT \| --stdin)` | agent へ prompt を送信 | human / `--json` |
| `gb watch --agent ID [--timeout SEC]` | agent の transcript event を監視 | JSONL |
| `gb chat --agent ID (--prompt TEXT \| --stdin) [--timeout SEC]` | prompt 送信後に event を監視 | JSONL |
| `gb interrupt --agent ID --yes` | agent の実行を中断 | human / `--json` |

`agents create`、`send`、`chat`、`interrupt` は状態を変更します。実行対象の agent ID と name・description・prompt を事前に確認し、read-only依頼では実行しないでください。
v0.30.0ではagent固有commandを一意なexact IDからgatewayへ直接routeし、harnessを理由に拒否しません。`agents create` は利用できず、`temporal-create-unsupported` はversion overrideでは解消しません。
prompt は shell history を避けるため `--stdin` を推奨します。`accepted` は受理を示すだけで、run完了を意味しません。transcript の未知fieldからrun完了や回答本文schemaを推測しないでください。

### 共通 option

| option | 意味 |
|---|---|
| `--app-session` | 通常版Grok Botのapp sessionを使う（macOS限定、`--allow-remote` 必須） |
| `--data-root PATH` | discovery に使う data root を明示 |
| `--gateway-url URL` | discovery を使わず gateway URL を明示 |
| `--allow-remote` | HTTPSのloopback以外への接続を明示的に許可 |
| `--allow-unsupported` | 観測対象外desktop app/local host versionへの変更操作を明示的に許可（v0.30 agent作成拒否は迂回不可） |
| `--request-timeout SEC` | HTTP request timeout |
| `--help` | help を表示 |
| `--version` | CLI version を表示 |

read 系コマンドと対応する変更系コマンドは `--json` で機械可読 JSON を出力します。`watch` と `chat` は常に 1 event 1 行の JSONL で、`--timeout SEC` による正常終了を指定できます。JSON/JSONL を使う場合も、秘密値は出力しません。

`--app-session` は `--data-root`、`--gateway-url`、`GB_GATEWAY_URL` と併用できません。app sessionを選ぶ前に、remote gatewayへ接続することをユーザーが明示承認している必要があります。`--allow-remote` はTLS・認証・host側の権限制御を迂回しません。

`watch` / `chat` の timeout や SIGINT はローカルのSSE購読だけを終了し、remote runを停止しません。一般的なterminal eventや回答完了schemaは観測契約にないため、CLIだけでは回答完了を保証できません。timeoutや未知eventを理由に自動で `interrupt` せず、「完了未確認」と報告してください。`interrupt --yes` は誤操作防止の構文であり、ユーザー承認の代替ではありません。

使用例:

```sh
gb agents search --query "review" --limit 10 --json
gb agents create --name "Reviewer" --description "差分を確認する agent" --json
gb transcript tail --agent AGENT_ID --limit 20 --json
gb watch --agent AGENT_ID --timeout 30
read -r -s GB_PROMPT
printf '%s' "$GB_PROMPT" | gb chat --agent AGENT_ID --stdin --timeout 120
unset GB_PROMPT
gb interrupt --agent AGENT_ID --yes --json
```

`read -r -s` はprompt本文をshell historyへ残さず入力する例です。agent runnerやinteractive execで `--stdin` を使う場合は、runnerのstdin channelへpromptを書き込んだ後にEOF/closeを送ってください。EOFがない限りCLIは入力を待ち続けます。安全なstdin channelが使えない場合は、敏感なpromptを `--prompt`、pipe command、temp fileへ移さず、実行を止めて安全な実行方法または露出許可を確認してください。

## 安全性

- 既定では loopback gateway だけに接続します。loopback以外はHTTPS URLと `--allow-remote` の両方が必要で、接続先を確認した場合だけ指定してください。
- local gatewayの対応hostVersionはv0.24.0です。app-sessionはdesktop v0.24.0とv0.30.0 gateway-direct profileを判定し、v0.30.0のagent固有操作はexact ID解決後にharness非依存でgatewayへrouteします。専用Temporal backendは持たず、agent作成は拒否します。version 不一致ではread-only操作にwarningを出し、変更操作を既定で拒否します。変更が必要なら対象versionの契約を再調査し、`--allow-unsupported` を通常の解決策として勧めないでください。このoptionは再調査後に残るriskをユーザーが明示承認したknown mismatchだけを継続し、unknown sourceやagent作成拒否を許可せず互換性も保証しません。
- `--gateway-url` を shell history やログへ残す前に、URL に credential が含まれていないことを確認してください。
- gateway token、Authorization header、raw descriptor、実会話を Issue やログへ貼らないでください。
- app sessionのdescriptor、Keychain password、remote URL、routing header値をログやfixtureへコピーしないでください。
- CLI は browser の `Origin` を偽装せず、gateway の認証や host 側の権限制御を迂回しません。
- stale な `gateway.json` を固定 endpoint とみなさず、process と `/health` の確認結果を使います。

## 終了コード

| code | 意味 |
|---:|---|
| `0` | 成功。`watch` / `chat` の timeout による正常終了も含む |
| `2` | 引数・usage error |
| `3` | discovery、設定、未対応 version の error |
| `4` | transport または protocol error |
| `5` | API が request を拒否 |
| `130` | SIGINT による中断 |

標準出力は結果、標準エラーは診断に使います。自動化では、文言ではなく終了コードと `--json` / JSONL を利用してください。
app sessionの設定失敗時に `--json` を指定すると、stdoutを空のまま保ち、stderrへ非秘密の `reason`、`message`、`hint` を持つJSON errorを1行出力します。
Keychainの3秒確認がtimeoutした場合のreasonは `keychain-timeout`、通常の拒否・item不存在・nonzero終了は `keychain` です。

## 開発

```sh
npm install
npm run check
npm test
./scripts/validate-skills
```

agent から利用する場合は、リポジトリ同梱の `$gb-cli` skill を参照してください。

## サポート方針

現時点の保守対象は、デフォルトブランチ `main` の最新ソースだけです。過去のcommit、fork、変更済みbuild、Grok Bot本体やxAIのサービスは対象外です。IssueとPull Requestは受け付けますが、対応時期や製品更新後の互換性は保証しません。脆弱性の報告は [セキュリティポリシー](./SECURITY.md) に従ってください。

## ライセンス

[MIT](./LICENSE)
