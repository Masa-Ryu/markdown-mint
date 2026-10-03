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

Mint の Rich Editor を開き、コマンドパレットから **Markdown Mint: Suggest
Continuation** を実行します。初回は、送信範囲と Copilot の利用枠への影響を確認し、
利用できる Copilot チャットモデルを選んで認可します。モデルの変更には **Markdown
Mint: Select Suggestion Model** を使います。ユーザー設定でショートカットを割り当てられますが、
既定のショートカットは追加しません。

段落・見出し・リスト内の文章末尾に短い候補を薄く表示します。**Tab** で採用し、
**Esc** で破棄します。採用前の候補はファイル、コピー、プレビュー、HTML/PDF 出力、
復旧用の下書きに入りません。採用後は通常の Undo/Redo で戻せます。
表、コード、リンク、インラインコード、Details/Alerts、Source、Preview、範囲選択中は対象外です。

自動提案は初期 **OFF** です。VS Code の **ユーザー設定** で
`markdownMint.aiSuggestions.autoTrigger` を有効にすると、入力停止から約 1 秒後に要求します。
OFF にしても手動コマンドは使えます。選択したモデル ID は
`markdownMint.aiSuggestions.model` に保存します（初期値は空文字）。両方とも application
スコープの設定で、ワークスペースの設定から送信を有効にしたりモデルを変更したりできません。
Mint のツールバーに ON/OFF ボタンは追加しません。

VS Code の公開 Language Model API を拡張ホストから呼び出します。Mint 用の API キーや
サーバー、必須の Copilot 依存はありません。API やモデルが使えなくても通常の編集は続けられます。
自動送信には API による認可確認と信頼済みワークスペースが必要です。
再起動、認可取消、モデル一覧の変更後は、手動コマンドから再開してください。
別のモデルに自動で切り替えることはありません。

送信するのは現在文書のカーソル周辺の文章のみです。UTF-16 単位で前方最大 4,000、後続最大
1,000、近くの見出し最大 512 に絞り、モデルのトークン上限に合わせてさらに縮小します。
他のファイル、パス、画像、Git 差分、クリップボードは AI 用に取得せず、プロンプトや候補を
ログ・永続キャッシュへ保存しません。この要求は **Copilot の利用枠を消費し得ます**。
標準のインライン補完とは別のチャット要求であり、キャンセルしても消費がゼロになる保証はありません。
標準 Copilot の content exclusion、リポジトリ文脈、custom instructions がこの要求にも
適用されるとは保証しません。文書を送信する際は所属組織の方針に従ってください。

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
