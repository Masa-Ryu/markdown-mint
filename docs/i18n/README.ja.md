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

Markdown Mint は VS Code 公開の Language Model API を使い、利用可能な GitHub Copilot
モデルから文章の続きを要求します。エディターでの応答時間を考慮し、取得結果に `mini` family
があれば優先し、それ以外はモデルID順の安定した方法で選びます。AI機能は信頼済みworkspace上のローカルdesktop
Extension Host（macOS、Windows、Linux）で動作します。対象外環境でも通常の編集は使えます。
Language Model APIはVS Code 1.91でStableになりました。1.90ではMintの通常編集は引き続き使えますが、
AI提案はAPI unavailableとして無効になります。

Copilotによる自動提案は初期状態で有効です。初回はMarkdown MintのツールバーにあるCopilotアイコンを
クリックすると、必要な場合にVS Code標準のモデル利用許可を行います。このクリックはセットアップだけを行い、
候補生成はしません。セットアップ後は同じアイコンで自動提案をON/OFFでき、ユーザー設定
`markdownMint.aiSuggestions.autoTrigger` からも変更できます。ONにした後は次の通常入力から300ms debounceで
提案します。**Markdown Mint: Suggest Continuation** はCommand Paletteの手動1回提案として残り、
自動提案がOFFでも利用できます。
セットアップ時に選択したモデルのIDとversion（秘密ではない識別情報）も保存します。モデル本体や利用許可は
保存しません。Extension Host再起動後は、実際の文字入力と通常の300ms debounceを待ってから、そのモデルだけを
公開APIの完全一致selectorで再取得します。自動復元時にCopilotの全モデル一覧は列挙しません。各要求前に
`canSendRequest(model)` を確認し、falseまたは不明なら生成を停止します。保存したモデルが利用できない場合は、
Suggest Continuationを明示的に実行して現在のモデルを選び直せます。起動時や設定変更だけでモデル選択は
行いません。この再起動経路はfake modelでテスト済みですが、実際のVS Code/Copilotセッションでは未確認です。
公開アクセス変更イベントで利用許可が戻ったと確認できた場合は、次の実入力から最新文脈で新しい要求を開始し、
失効した要求や候補は復活させません。
要求は **Copilot の利用枠を消費する場合があります**。

候補対象は本文・見出し・リストの文中と文末、および文脈のある空段落です。hostはアクティブな
未保存Markdownからカーソル周辺の段落、見出し、近くの文章だけを上限付きで選びます。他ファイル、
ターミナル、クリップボード、Git差分は送りません。リンク先URL、インラインコード内、表、コード
ブロック、Mermaid、数式、raw HTML編集領域、範囲選択中、Source、Preview、モーダル入力欄は対象外です。
任意のプロンプトにもCopilotのcontent exclusionが同じように適用される、またはキャンセルすれば利用枠を
消費しない、とは主張しません。Mintは本文や候補をログ・永続化しません。

候補は一時表示で、**Tab** で採用、**Esc** で破棄します。モデル一覧の変更後に候補が残っている場合、Tabの前に
ホストが選択モデルのIDとversionを再確認します。無関係なモデルの追加・削除なら候補を採用でき、選択モデルが
なくなった場合や編集対象が変わった場合は候補を破棄します。元の文章と構造が保たれることをsource mappingで
確認できた挿入だけ表示します。候補表示だけではMarkdown、dirty/復旧状態、クリップボード、プレビュー/出力、
Undo履歴は変化しません。採用は通常の編集transactionを通り、native Undo/Redo境界を維持します。

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
