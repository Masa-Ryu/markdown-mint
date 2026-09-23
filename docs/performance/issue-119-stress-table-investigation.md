# 2000×20 Table Investigation

計測結果は [`editor-performance-stress-investigation.json`](baselines/editor-performance-stress-investigation.json) に保存した。各条件3回。実行環境は Apple M1 Pro、Chromium 153.0.8010.12、1280×900。対象 fixture は434,328 bytes、body rows 2,000、columns 20、body cells 40,000（headerを含めて40,020 cells）。

## Interaction phases

Current の navigation start 起点で、最初の入力文字が対象cell DOMへ反映されるまでの値（ms）。p95/maxは3サンプルから算出している。各行は独立したpercentileなので、p50の各値は合計時間のp50にはならない。

| Phase                                |      p50 |      p95 |      max |
| ------------------------------------ | -------: | -------: | -------: |
| Navigation → editor ready            |  1,274.9 |  1,301.0 |  1,303.9 |
| Editor ready → target found          |     94.9 |     96.8 |     97.0 |
| Target found → visible               |     49.4 |     50.3 |     50.4 |
| Visible → click complete             | 16,032.9 | 16,079.3 | 16,084.4 |
| Click → caret ready (`End` complete) |  7,689.6 | 15,632.6 | 16,515.2 |
| Caret ready → input start            |      3.9 |  7,056.7 |  7,840.3 |
| Input start → DOM reflection         |    390.4 |  7,310.0 |  8,078.8 |
| Navigation → accepted input          | 33,245.9 | 41,299.7 | 42,194.6 |

3回の合計時間は42.195秒、25.026秒、33.246秒。`caret ready → input start` は2回が約3〜4ms、1回が7.840秒で、実行中の停止が試行ごとに異なる段階へ現れている。

Long Task observer は全3サンプルで利用できた。3回分の対象期間で、editor readyからvisibleまでは0件、visibleからclick完了までは15件・合計47.494秒・最長7.920秒、click完了からinput開始までは2件・合計16.123秒・最長8.284秒、input開始からDOM反映までは4件・合計8.716秒・最長7.808秒だった。click区間の実測合計47.779秒に対してLong Task合計は47.494秒で、区間時間の約99.4%が50ms超のmain-thread taskと重なる。input→DOM reflectionも3試行合計8.722秒のうち8.716秒がLong Taskと重なる。ここでの合計は3試行分。

## TableControls

Current 3試行の累計。`maxMs` は1呼び出しの最大値。

| Operation                     | Calls |     Total |     Max |
| ----------------------------- | ----: | --------: | ------: |
| `TableControls.update`        |    18 |   336.7ms | 100.7ms |
| `TableControls.renderTarget`  |     3 |    56.8ms |  19.2ms |
| `TableControls.measureLayout` |    16 | 1,111.4ms |  99.5ms |

`measureLayout` は1回あたり最大で2,001 rows、40,020 cellsを測定し、実際の `getBoundingClientRect()` 呼び出しは最大40,023回だった。16回の累計は640,368 calls。内訳は table/stage rect 41.2ms、cell rect collection 783.3ms、boundary calculation 116.6ms、control positioning 95.6ms、presentation update 73.6ms。

`renderTarget` は1回につき2,000 row handlesと20 column handlesを生成し、3回でそれぞれ6,000個、60個。計測された生成処理は累計58.7ms。

## Direct table validation

`supportsDirectTableOperations`: 12 calls、累計24.6ms、最大2.9ms、訪問cellsは累計480,240。計測中、同じPM table nodeへのfull scanは最大2回で、2回目のscanが6回あった。これらの時間では数十秒の入力遅延を説明できない。

`updateTableToolbar`: 60 calls、累計321.0ms、最大14.7ms。table contextは48 calls / 0.4ms、alignment scanは24 calls / 315.8ms、numbering stateは60 calls / 1.2ms。ProseMirror `dispatchTransaction` は6 calls / 累計919.3ms / 最大296.1ms、内側の `applyTransaction` は6 calls / 累計100.8ms / 最大40.4ms。toolbarとkeyboard transactionの計測時間はいずれも数十秒の遅延より短い。

## Isolation experiments

| Condition                 | CSS                                  | TableControls                                     | Total input p50 / p95 / max |
| ------------------------- | ------------------------------------ | ------------------------------------------------- | --------------------------: |
| Current                   | current                              | enabled                                           |  33,246 / 41,300 / 42,195ms |
| TableControls disabled    | current                              | disabled                                          |  25,306 / 39,746 / 41,351ms |
| Geometry-only             | current                              | disabled; editor ready後に対象cellのrectを1回取得 |     rect: 0 / 0.09 / 0.10ms |
| Experimental fixed layout | benchmark-only `table-layout: fixed` | enabled                                           |  40,812 / 40,941 / 40,956ms |

Geometry-only の対象cell queryはeditor ready後に実行し、単独の `getBoundingClientRect()` はp50 0ms、max 0.1msだった。対象cell query完了まではp50 29.9ms、target foundからvisibleまではCurrentでp50 49.4ms。単発geometry queryまたはvisibility待ちが約40秒の説明になる測定結果ではない。

TableControlsを無効にした今回の3試行では合計p50がCurrentより7.940秒短かったが、p95は39.746秒、maxは41.351秒だった。visibleからclick完了はCurrentの16.033秒に対して23.578秒へ延び、click後はcaret readyまで17.3ms、入力からDOM反映まで281.1msだった。Long Taskは無効条件でもclick期間に6件・合計46.819秒発生した。遅延の現れ方が条件間で移動しており、3回ずつの比較だけではTableControlsが合計時間の差を引き起こしたとは確定できない。無効化によって長いclick区間そのものは解消していない。

Fixed-layout overrideは適用され、computed `table-layout` は `fixed` になった。一方でcomputed table widthは3回とも987.25pxでcurrentと同じ。合計p50は今回40.812秒でcurrentより長く、click区間はp50 15.804秒でcurrentとほぼ同じだった。click→caretとcaret→inputの各phaseがp50でそれぞれ約7.75秒となり、今回のサンプル数ではfixed layoutの性能改善は確認できない。

## Conclusion

| 候補                                         | 測定値                                                                                                                | 判定                                                                     |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Chromium table layout / 最初のgeometry query | editor ready後の1回のcell rect queryはp50 0ms、max 0.1ms。visible待ちはp50 49.4ms                                     | 約40秒の主因ではない。click内のlayout負荷はLong Taskだけでは分離できない |
| `TableControls.measureLayout`                | 16回、640,368 rect calls、累計1.111秒、最大99.5ms/call                                                                | 全体遅延を支配しない                                                     |
| row/column handle DOM生成                    | 2,000 row + 20 column handles/render、累計56.8ms                                                                      | 支配しない                                                               |
| `supportsDirectTableOperations`              | 12回、480,240 cells、累計24.6ms                                                                                       | 支配しない                                                               |
| `updateTableToolbar` / keyboard transaction  | toolbar 321.0ms、`dispatchTransaction` 919.3ms、`applyTransaction` 100.8ms（各3試行分）                               | いずれも数十秒より短く、支配しない                                       |
| Browser main-thread Long Task                | visible→click は合計47.779秒のうち47.494秒がLong Taskと重なる。input→DOM reflectionも合計8.722秒のうち8.716秒が重なる | 今回の計測で支配的だった信号                                             |

Currentではeditor ready→target visibleがp50約144msなのに対し、visible→clickがp50 16.033秒だった。TableControls無効でもclickはp50 23.578秒かかり、Long Taskが6件・合計46.819秒発生した。無効化で合計p50は短くなったものの長いclickは残り、遅延区間も試行ごとに移っている。

したがって、**約40秒の入力遅延は計測済みのTableControls内部処理、行handle生成、table scan、toolbar、ProseMirror transaction単体では説明できない。支配的な測定区間はbrowser/Webview main-thread Long Taskを伴うclick/input経路**。今回のデータは仮説B、C、Dを支持せず、仮説Aも「最初のvisibility/geometry queryが全時間を使う」という形では支持しない。Long Task APIは時間を記録するもので、個々のtaskのJavaScript/native stackは特定しないため、taskの発生元がChromium内部、Playwrightのactionability確認、別の同期処理のどれかまでは未特定。
