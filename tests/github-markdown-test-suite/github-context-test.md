# GitHub Conversation Context Test

これは**Issue・PR・Discussion等の会話欄の条件付き試験用**です。このファイルをリポジトリ内で表示するだけでは、同じ結果にはなりません。

外部の利用者・プロジェクトを通知する試験はしません。参照番号、ユーザー名、リポジトリ、SHA、ラベル、カスタム参照は、自分で管理するテスト環境の値に置き換えてください。プレースホルダーを解決済みリンクとして描画してはいけません。

## CTX-01 — ソフト改行の比較

根拠: [Line breaks](https://docs.github.com/en/get-started/writing-on-github/getting-started-with-writing-and-formatting-on-github/basic-writing-and-formatting-syntax#line-breaks)

一行目。末尾スペースとバックスラッシュはありません。
二行目。.mdファイルの表示と、会話欄での表示を比較します。

## CTX-02 — 色チップ

根拠: [Supported color models](https://docs.github.com/en/get-started/writing-on-github/getting-started-with-writing-and-formatting-on-github/basic-writing-and-formatting-syntax#supported-color-models)

`#0969DA`、`rgb(12, 34, 56)`、`hsl(210, 50%, 40%)`。

期待: Issue・PR・Discussionの対応欄では色チップの対象。.mdでは普通のインラインコードとして比較する。

## CTX-03 — Issue・PRの自動参照

根拠: [Autolinked references and URLs](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/autolinked-references-and-urls)

この試験では、先に同じテストリポジトリで対応番号を用意する。

#123

GH-123

OWNER/REPOSITORY#123

期待: 有効な会話コンテキストと参照先がある場合に評価する。.mdやWikiで同じ自動参照解決を要求しない。番号だけでIssueとPRを区別しない。

## CTX-04 — Commit SHAとカスタム自動リンク

実在するコミットの40桁SHA、`OWNER/REPOSITORY@SHA`、設定済み外部参照接頭辞などへ置換してから確認する。

```text
FULL_40_CHARACTER_COMMIT_SHA
OWNER/REPOSITORY@FULL_40_CHARACTER_COMMIT_SHA
TEST-123
```

期待: プレースホルダーや未設定接頭辞は未解決。設定・権限・参照先が揃った場合だけリンク解決を判定する。

## CTX-05 — ユーザー・チームのメンション

根拠: [Mentioning people and teams](https://docs.github.com/en/get-started/writing-on-github/getting-started-with-writing-and-formatting-on-github/basic-writing-and-formatting-syntax#mentioning-people-and-teams)

通知が発生し得るため、以下はコードのまま保護する。自分の検証用アカウント・チームだけに置換する。

```text
@YOUR_TEST_USERNAME
@YOUR_TEST_ORGANIZATION/YOUR_TEST_TEAM
```

## CTX-06 — ラベルURL

根拠: [Labels](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/autolinked-references-and-urls#labels)

```text
https://github.com/OWNER/REPOSITORY/labels/fixture-label
```

同一リポジトリと別リポジトリのURLで比較する。ラベル名にピリオドが含まれる場合も別試験にする。.mdでの実効表示は観察項目とし、会話欄と一律に同じとは仮定しない。

## CTX-07 — コードのパーマリンク展開

根拠: [Creating a permanent link to a code snippet](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/creating-a-permanent-link-to-a-code-snippet)

```text
https://github.com/OWNER/REPOSITORY/blob/COMMIT_SHA/path/to/file.ext#L1-L5
```

期待: 元コードと同じリポジトリ内のコメントという条件で確認する。リポジトリ内.mdではコードスニペット展開を期待しない。

## CTX-08 — 通常タスクリストとIssue連携

根拠: [About tasklists](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/about-tasklists)

- [ ] 独立したチェック項目
- [x] 完了したチェック項目
- [ ] #123

通常のチェックボックス表示と、参照先の状態表示・Issue進捗・タスク移動などのGitHub側のUI連携を別々に確認する。廃止されたtasklist blocksを要求しない。

## CTX-09 — 添付画像と動画

根拠: [Attaching files](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/attaching-files)

画像は同梱の `assets/sample.png` をテスト用の入力欄へドロップし、GitHubが生成する実際のURL・Markdownを確認する。動画は手元の検証用ファイルを使う。架空のアップロードURLは用意しない。

このファイル作成時点で、GitHubへのアップロード・投稿・通知・API書き込みは行っていない。

**END-OF-CONTEXT-FIXTURE**
