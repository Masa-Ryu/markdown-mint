[English](../../README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [Español](README.es.md) | [Français](README.fr.md) | [Português (Brasil)](README.pt-BR.md) | [Русский](README.ru.md) | [Deutsch](README.de.md) | **日本語** | [Türkçe](README.tr.md) | [한국어](README.ko.md) | [Italiano](README.it.md) | [Polski](README.pl.md) | [Čeština](README.cs.md)

# Markdown Mint

## **見たまま書ける。Markdown のままで。**

VS Code 向けのビジュアル WYSIWYG Markdown エディターです。

文章、表、チェックリスト、技術文書をビジュアルエディターで直接編集できます。細かく調整したくなったら、いつでも Markdown ソースに切り替えられます。

移行は不要です。お使いの Markdown ファイルを開くだけで、すぐに書き始められます。

![概要](../media/overview.gif)

## 書くことに集中

Markdown Mint は、書式設定に気を取られず、内容に集中できるように設計されています。

**スラッシュコマンド** `/` を使えば、Markdown の構文を入力せずに、ブロックや要素をすばやく挿入できます。

文字を選択すると、その場で必要な書式設定を選べるコンテキストツールバーが表示されます。

キーボード操作にも対応しています。**Tab キー**で選択可能な要素を移動できるので、キーボードから手を離す必要がありません。

表の操作も簡単です。Markdown の構文を手作業で編集することなく、表の内容を直接コピー＆ペーストできます。

![執筆に集中するための機能のデモ](../media/focus-on-writing-demo.gif)

## プラットフォーム固有の Markdown に対応

Markdown Mint は、GitHub や GitLab などのプラットフォームが提供する Markdown 機能に対応しています。

**GitHub Mode**（GitHub モード）では、**Alerts**（アラート）や **Mermaid 図**など、GitHub 固有の機能をビジュアルエディターで直接利用できます。

GitHub／GitLab モードでは、完成図を見ながら13件のMermaidテンプレートから選び、
**Next: Edit code**で候補を下書きへ取り込んでライブプレビューの隣で編集します。
選択コードのない新規作成では最初にテンプレートを選びます。コード編集画面の
**← Templates**から一覧へ戻れます。既存図や選択したコードは直接コード編集で開きます。
現在のコードを置き換えるときは確認を表示します。Markdown本文を変更するのは
**Insert diagram**／**Update diagram**だけです。

![プラットフォーム固有の機能のデモ](../media/platform-specific-demo.gif)

## ほかにも便利な機能を搭載

Markdown Mint には、実際の Markdown 文書の編集に役立つツールも備わっています。

✅表に自動ナンバリングを追加できます。

✅Excel や Google Sheets のセルをコピーして、Markdown の表に直接貼り付けられます。

✅VS Code の外から画像をドラッグ＆ドロップして、文書に挿入できます。

✅自動候補表示と検索を使って、画像参照、URL、内部リンクをすばやく作成できます。

## Copilot による文章の続きの提案

Markdown Mint は GitHub 公式の `@github/copilot-language-server` 1.551.2 を
`textDocument/inlineCompletion` で使用します。チャットモデルの選択や Mint 独自のチャット
プロンプト送信は行いません。固定したSDK版のネイティブ実行ファイルを各対象VSIXへ同梱し、
実行時に `PATH` 上の `node`、`npm`、`npx` は起動に使いません。サーバーと同梱バイナリは
MIT ライセンスです。各VSIXには対応するupstreamのライセンス本文と第三者通知を含めます。

初回の準備が必要なときは、**Markdown Mint: Sign in to GitHub Copilot** を実行します。
Language Server がデバイス認証コードを返し、ユーザーが確認した後に GitHub の認証を開始します。
その後、`markdownMint.aiSuggestions.autoTrigger` が有効なら通常の入力中に候補を表示します。
手動の場合は **Markdown Mint: Suggest Continuation** を実行してください。モデル選択と既定の
ショートカットはありません。このユーザースコープ設定の初期値は **false** で、ツールバーに
ON/OFF ボタンはありません。自動提案をOFFにしても手動提案を使えます。認証や利用可否に問題が
ある場合はステータス表示と手動コマンドが状態を知らせます。VS Code 再起動後にサーバーが保存済み
認証を再利用できる場合、自動提案は手動コマンドなしで再開します。

通常の本文・見出し・リスト文章の文中と文末、および文脈のある空段落に候補を表示できます。
段落内にリンクがあっても周囲の文章は対象です。リンク先URL、インラインコード内、表、コードブロック、
Mermaid、数式、raw HTML 編集領域、範囲選択中、Source、Preview、モーダル入力欄は対象外です。
候補は一時表示で、**Tab** で採用、**Esc** で破棄します。元のprefixとsuffixの両方を維持できる場合に限り、
置換範囲を挿入専用候補へ変換します。候補表示だけではMarkdown、dirty/復旧状態、クリップボード、
プレビュー/出力、Undo履歴は変化しません。

Mint は現在の補完対象である未保存Markdown全文を、本来のファイルURIとversionでローカルの
Language Serverへ同期します。同じ文書内のコード、表、補完対象外の内容もこの同期に含まれます。
拡張が同期する文書はアクティブなRich Editorだけで、他文書、ターミナル、クリップボード、Git差分を
独自に走査・同期しません。一方、Language Serverにはworkspace folderを渡すため、サーバー独自の
リポジトリ文脈利用の全範囲、サービス側のcontent exclusion、サービス側のデータ処理をMintが個別に
検証したとは主張しません。組織ポリシーやサービス側の除外を迂回しません。SDKの任意テレメトリは
OFFに設定しますが、これはサービス運用上のデータ処理が一切ないという意味ではありません。
要求は **Copilot の利用枠を消費する場合があります**。Mintは文書本文や候補内容をログ・永続化しません。

ネイティブサーバーはmacOS/Linux/Windowsのx64/arm64向けVSIXに準備します。現在AIを有効にするのは
信頼済みworkspace上のdesktop macOS arm64 Extension Hostのみです。Remote、Web、その他の未確認環境では
通常のMarkdown編集を維持し、AI機能を無効にします。実Copilot、Node/npmがPATHにない環境、日本語を含む
インストール先、再起動後の認証復元、プロセス終了については別途受入確認が必要です。

## Markdown は Markdown のまま

Markdown Mint は、独自の文書形式を導入しません。

`.md` ファイルが、引き続き唯一の正本です。

ビジュアル編集を使いながら、元の Markdown を直接確認・編集したくなったら、いつでも **Source** に切り替えられます。

ビジュアルエディターで作成したものは、すべて Markdown のままです。

![Markdown ソースとの切り替えのデモ](../media/markdown-stays-markdown-demo.md.gif)

## 簡単に使い始められる

既存の Markdown ファイルで、そのまま Markdown Mint を使い始められます。

VS Code の標準エディターで Markdown ファイルを開き、**Markdown Mint** ボタンをクリックすると、ビジュアルエディターで開けます。

Markdown Mint を Markdown ファイルの既定のエディターに設定して、ファイルを自動的に Mint で開くこともできます。

![使い始め方のデモ](../media/easy-to-set-up-demo.gif)
