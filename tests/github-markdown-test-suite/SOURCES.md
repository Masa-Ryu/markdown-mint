# Official Sources and Verification Scope

確認日: 2026-09-11。公式ドキュメント・GFM仕様・GitHub公式リポジトリを参照しました。記載のURLは検証根拠であり、このパッケージをGitHub実画面で描画して合格済みという意味ではありません。

各ケースの期待結果は `EXPECTED.json` と `github-test.md` に対応付けています。本文内の用語・図・数値・データはテスト用に作成した架空の試料です。

## basic

[Basic writing and formatting syntax](https://docs.github.com/en/get-started/writing-on-github/getting-started-with-writing-and-formatting-on-github/basic-writing-and-formatting-syntax)

## gfm

[GitHub Flavored Markdown Spec](https://github.github.com/gfm/)

## tables

[Organizing information with tables](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/organizing-information-with-tables)

## code

[Creating and highlighting code blocks](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/creating-and-highlighting-code-blocks)

## math

[Writing mathematical expressions](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/writing-mathematical-expressions)

## diagrams

[Creating diagrams](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/creating-diagrams)

## details

[Organizing information with collapsed sections](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/organizing-information-with-collapsed-sections)

## refs

[Autolinked references and URLs](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/autolinked-references-and-urls)

## permalinks

[Creating a permanent link to a code snippet](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/creating-a-permanent-link-to-a-code-snippet)

## tasks

[About tasklists](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/about-tasklists)

## attachments

[Attaching files](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/attaching-files)

## markup

[github/markup: rendering pipeline](https://github.com/github/markup)

## noncode

[Working with non-code files](https://docs.github.com/en/repositories/working-with-files/using-files/working-with-non-code-files)

## 対象外・観察扱い

GitHub Pages/Jekyll、全GitHub Enterprise Serverバージョン、GitHubと無関係なMarkdown拡張、全Mermaid文法、全LaTeXマクロ、GitHubが許可する全HTMLタグ・属性は網羅保証しません。

GitHubはGFM解析後にサニタイズ・構文着色・追加変換を行います。ローカルの一般的なMarkdownパーサーによる構造チェックを、そのままGitHubでの表示検証と呼びません。

Frontmatterの特定表示、pictureのテーマ設定とHTML画像属性の実効表示、未対応構文の細かな見た目は観察項目です。スクリプト・任意CSSの扱いは通常の本文表示と区別します。
