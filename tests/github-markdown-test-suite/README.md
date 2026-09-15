# GitHub Markdown Test Suite

確認日: **2026-09-11**。既存のサンプルを継ぎ足さず、GitHub公式のMarkdown説明とGFM仕様を基に作り直した試料です。

## 最初に開くファイル

`github-test.md` を開いてください。画像を含む試験では `assets/` を一緒に置きます。ZIP内のディレクトリ構成を維持すれば、通常の画像・相対リンクに外部ホスティングは不要です。

正常例と、特殊表示されないことを確認する例を混ぜないため、以下に分割しています。

| ファイル | 目的 |
| --- | --- |
| `github-test.md` | 通常表示・複合構文・500行×12列・30行×24列・40行×12列の座標表 |
| `github-negative-test.md` | 列数不一致、未対応方言、ネストしたAlert、HTMLサニタイズなど |
| `github-context-test.md` | Issue・PR・Discussion・設定・実在する参照先が必要なケース |
| `stress/github-table-2000x20.md` | 任意の性能観察用、40,000データセル |
| `stress/github-long-lines.md` | 約16K文字の空白なし文字列と長い段落・URL |
| `edge-cases/` | 真の末尾表・画像・コード、未閉鎖フェンス、CRLF、BOM、Frontmatter保持 |
| `assets/` | PNG/JPEG/GIF/SVG、相対リンク先、プレーンテキストのTSV |
| `EXPECTED.json` | ケースID、期待値、公式根拠、表サイズ、コピー範囲 |
| `SOURCES.md` | 公式URLと検証範囲 |
| `validation-report.json` | 作成時に実施した静的・構造チェック。GitHub画面の検証結果ではない |
| `verify-fixtures.py` | 初期試料のSHA-256照合用。Python標準ライブラリだけを使用 |

## GitHubでの表示条件

リポジトリ内.mdと会話欄では条件が異なります。Issue/PR番号の自動参照、色チップ、コードリンクのスニペット展開を、通常の.mdで必ず動く機能とは扱いません。各条件の根拠は [自動参照](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/autolinked-references-and-urls)、[色チップ](https://docs.github.com/en/get-started/writing-on-github/getting-started-with-writing-and-formatting-on-github/basic-writing-and-formatting-syntax#supported-color-models)、[コードのパーマリンク](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/creating-a-permanent-link-to-a-code-snippet)です。

MathJaxの対象には `$...$`、バッククォート併用、`$$...$$`、`math`フェンスを含めています。[公式数式説明](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/writing-mathematical-expressions)

図の試験はMermaid・GeoJSON・TopoJSON・ASCII STLです。Mermaidの実バージョンは `info` で記録します。GitHubの地図や図を表示するにはGitHub側の処理が必要で、単にHTMLへ変換しただけでは同じ画面にはなりません。[公式図表説明](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/creating-diagrams)

通常タスクリストと廃止されたtasklist blocksを区別します。新規のsub-issues管理機能はMarkdown表示の機能テストには含めません。[公式タスク説明](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/about-tasklists)

## 表の判定

正例はパイプをコードスパン内でもエスケープしています。表セルの列数が多い場合のGFMの「表示上の無視」は、未編集ソースからその文字を削除してよいという許可ではありません。[GFM表仕様](https://github.github.com/gfm/#tables-extension-)

表のヘッダーは以下の行数に含めません。

| 試料 | データ行 | 列 | 主な目的 |
| --- | ---: | ---: | --- |
| GH-TABLE-06 | 500 | 12 | 縦スクロール、長文、空セル、コード内パイプ、番兵保持 |
| GH-TABLE-07 | 30 | 24 | 横スクロール、広い選択範囲 |
| GH-TABLE-08 | 40 | 12 | 座標によるコピー・貼り付け結果の照合 |
| 任意ストレス表 | 2000 | 20 | 入力・スクロール・同期の性能測定 |

## 拡張の操作テスト

以下はGitHubの閲覧画面に同じ編集機能があるという説明ではなく、開発中の拡張の受け入れ試験案です。

| ID | 操作 | 期待する結果 |
| --- | --- | --- |
| EDITOR-01 | GH-TABLE-08でR05C03〜R15C06をドラッグしてコピー、R25C08へ貼る | 11行×4列が行25〜35・列8〜11に入る。Undo一回で元の座標へ戻る |
| EDITOR-02 | 同じ範囲をR38C10へ貼る | 自動拡張仕様なら48行×13列にする。そうでなければ明示的に警告し、無言で切り詰めない |
| EDITOR-03 | 空セルを含む範囲を選択・コピー・貼り付け | 空セルも位置情報として保持し、右側の値を左詰めしない |
| EDITOR-04 | 一つのセル内で一単語だけを選択 | セル全体の選択と区別する |
| EDITOR-05 | 500行表で表示領域を越えて選択 | スクロール後も起点・終点・範囲が安定する |
| EDITOR-06 | 24列表で横にドラッグ | 列末端まで到達し、選択解除やツールバーの干渉がない |
| EDITOR-07 | 書式ボタンを押す | 選択が失われず、意図した文字またはセルだけに適用される |
| EDITOR-08 | 保存・整形・プレビュー更新中に日本語IME変換 | 変換中の文字を消さず、カーソルを別の場所に飛ばさない |
| EDITOR-09 | 外部から同じ文書を更新 | 古いエディター状態で上書きしない |
| EDITOR-10 | EOF専用ファイルで末尾の表・画像・コードの後へ入力 | 新しい段落を作成できる |
| EDITOR-11 | `assets/clipboard-3x4.tsv` の内容をコピーして表へ貼る | 3行×4列、空セル、001、結合文字、末尾空列を保持する |
| EDITOR-12 | ファイルを開いて閉じるだけ | 自動整形などを明示的に有効にしていない条件で変更を発生させない |

数値らしい文字や`=1+2`はテキストとして作っています。外部表計算ソフトへの貼り付けで型推測・式評価が起きるかは、ソフト側の挙動として別途検証してください。

## プレビュー比較

同じファイルを拡張とGitHubで表示し、本文幅、ズーム、テーマ、フォント条件を揃えて比較します。選択枠・カーソル・操作ハンドルを除き、段落の折り返し、表の列幅・行高、画像サイズ、コードや数式のレイアウトを記録します。文書内の「期待結果」の文章も幅に影響するので、部分スクリーンショットでは同じ範囲を使ってください。

同一幅に揃えられない場合は構文・内容の一致とピクセル比較を分けて記録します。図の描画待ちやGIFのフレーム差も別に扱います。スクロールの滑らかさ、コピー操作、Undoは静止画では判定できません。

## 整形・原文保持

初期ファイルのコピーを作って試験してください。整形1回目で記法が変わることと、意味が変わることは別です。開始番号42を1にする、コード内パイプで列を分裂させる、二スペース改行を通常の改行に変える、参照定義・HTMLコメントを消す、といった変化を検知します。

整形2回目は追加差分ゼロを期待します。Markdownファイルのハッシュは正規化によって変わり得るため、「整形前後のSHA-256一致」を合格条件にはしません。

`edge-cases/frontmatter-preservation.md` は原文保持の試料です。FrontmatterのGitHub独自表示の正解画像を定義したものではありません。

## 検証済み／未実施

作成時には表のサイズ、閉じたフェンス、JSON、相対ファイル、STLの面と辺、末尾・改行コードなどを静的に検査します。実施結果は `validation-report.json` へ記録します。

**GitHubの実画面へのアップロード・全ケースのレンダリング検証、あなたのVS Code拡張でのマウス・IME・Undo操作は未実施です。** このパッケージは合格済み製品の証明ではなく、比較に使う試験入力と期待条件です。

初期試料の破損を調べる場合だけ、次を実行します。編集後のファイルで不一致が出るのは正常です。

```bash
python3 verify-fixtures.py
```

`.vsix`の操作やGitHubへの投稿を行うスクリプトは含めていません。
