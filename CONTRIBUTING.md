# コントリビューションガイド

Issue や Pull Request を歓迎します。このツールは観測した非公開契約に依存するため、変更は小さく保ち、確認できた挙動と推測を区別してください。

## 開発

```sh
npm install
npm run check
npm test
./scripts/validate-skills
```

変更前に既存の構成と package scripts を確認してください。bug fix には可能な範囲で regression test を追加し、ユーザーに見える変更では README 更新の要否も確認してください。

## Pull Request

- 変更の目的、範囲、検証結果を書く。
- 関係のないリファクタや整形を混ぜない。
- commit message は Conventional Commits に従う。
- token、credential、private URL、実会話、ローカル調査資料を含めない。
- protocol に関する記述は Grok Bot desktop v0.24.0 の観測結果、根拠を明記したv0.30.0の静的調査・read-only観測、または別途明記した推測かを区別する。私的契約やローカル調査資料そのものはコピーしない。

release、version bump、publish は保守者が明示的に実施します。

## 公開前の保守者確認

初回公開前に、保守者はGitHubでPrivate vulnerability reportingを有効化し、`SECURITY.md` のadvisory linkがprivate report作成画面へ到達することを確認してください。このリポジトリのコード変更だけではGitHub側の設定は変更されません。
