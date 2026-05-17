# AIエージェント × ローカルデスクトップアプリ × MCP × AWS Bedrock 構成理解メモ

作成日: 2026-05-17  
目的: 現在のPoC構成、MCP/Host/LLM/ローカルアプリの責務、製品化時の配布構成、権利・ライセンス・セキュリティ上の論点を整理する。

---

## 1. 現在のPoCの理解

現在のPoCは、**AIがデスクトップアプリの画面を直接クリックして操作する構成ではない**。

現状は、以下のような**ファイル連携型PoC**である。

```text
Claude CLI / Claude Code
  ↓
ローカルMCPサーバー
  ↓
CSV生成・CSVルール適用
  ↓
CSVファイル出力
  ↓
ViewerアプリがCSVを読み込む
  ↓
Viewer上に反映
```

つまり、本質的には次の検証をしている。

```text
ユーザー指示
  ↓
AIが解釈
  ↓
Viewerが読めるCSVを生成
  ↓
ViewerがCSVを取り込んで反映
```

このPoCは、**AIがGUIを直接操作するPoC**ではなく、より正確には、

> AIが生成した構造化データを、ローカルデスクトップアプリに取り込ませて業務操作の一部を代替できるか

を検証している。

これは本番化を考えるうえでは、画面クリック型よりも安定しやすい方向である。

---

## 2. 重要な前提整理

### 2.1 「クラウド」ではなく「Claude」

当初「クラウドCLI」と表現していたが、正しくは **Claude CLI / Claude Code**。

現PoCでは、Claude CLI / Claude Code が以下を担っている。

```text
Claude CLI / Claude Code
  - ユーザー入力を受け取る
  - LLMへ問い合わせる
  - MCPサーバーのツール一覧を扱う
  - LLMのtool_useを受け取る
  - MCPサーバーへtool callを送る
  - MCPサーバーの結果をLLMへ戻す
  - 最終結果をユーザーへ返す
```

つまり、現在のPoCでは **Claude CLI / Claude Code がMCP Hostの役割を担っている**。

---

## 3. MCPの正しい役割

MCPは、AIアプリケーションが外部ツールやデータソースと接続するための標準プロトコルである。公式仕様上、MCPは **Host / Client / Server** のアーキテクチャで説明される。

```text
MCP Host
  └─ MCP Client
       └─ MCP Server
```

参考: MCP公式仕様では、Hostが複数のClientインスタンスを持ち、ClientがServerと通信する構成とされている。  
<https://modelcontextprotocol.io/specification/2025-06-18/architecture>

このプロジェクトに当てはめると、こうなる。

```text
MCP Host:
  Claude CLI / Claude Code
  将来的には自社AI Host / 自社AI操作クライアント

MCP Client:
  Host内でMCPサーバーと通信する部品

MCP Server:
  CSV生成・CSV検証・Viewer連携などのローカルツールを提供するサーバー

LLM:
  Claude / Bedrock上のClaude / OpenAI等
```

---

## 4. 「LLM → MCPサーバー」ではない

誤解しやすいが、**LLMがMCPサーバーを直接呼んでいるわけではない**。

間にHostが存在する。

```text
誤解:
LLM → MCPサーバー

正しい理解:
LLM
  ↓ tool_useを返す
Host / AI操作クライアント
  ↓ 実際にMCPサーバーを呼ぶ
MCPサーバー
```

LLMは「このツールを使うべき」と判断する。  
実際にMCPサーバーを呼ぶのはHostである。

---

## 5. tool use / agent loop の理解

ユーザーから見ると「1回の指示」でも、内部では複数回のやりとりが起きる。

```text
ユーザーの1回の指示
  ↓
HostがLLMへ問い合わせる
  ↓
LLMがtool_useを返す
  ↓
HostがMCPサーバーを呼ぶ
  ↓
MCPサーバーがtool_resultを返す
  ↓
Hostがtool_resultをLLMへ戻す
  ↓
LLMが次の判断をする
  ↓
必要なら再度tool_use
  ↓
最終回答または完了
```

このループを現在はClaude CLI / Claude Codeが隠れて実行している。

製品化時には、Claude CLI / Claude Codeを顧客へ使わせるわけにはいかないため、このHost相当の処理を自社側で用意する必要がある。

---

## 6. 現PoCにおける各コンポーネントの責務

```text
Claude CLI / Claude Code:
  - 現在のHost
  - LLMとMCPサーバーの仲介
  - ユーザー入力の受付
  - tool_use / tool_result ループの管理

LLM:
  - 指示理解
  - 判断
  - CSVに入れるべき内容の生成
  - 次に使うツールの選定

MCPサーバー:
  - AIから呼べるツールを提供
  - CSV生成ルールの適用
  - CSV検証
  - CSV保存
  - Viewer連携の境界

Viewer:
  - CSVの読み込み
  - 結果表示
  - プレビュー
  - 反映
```

---

## 7. MCPサーバーにCSV生成ルールを書いていることの評価

現在、MCPサーバー内にCSVを作るための処理やルールがある。

これは、MCPの使い方として必ずしも間違いではない。

MCPサーバーがAIに対して以下のようなツールを提供しているなら、自然な使い方である。

```text
get_csv_schema()
create_viewer_csv()
validate_viewer_csv()
save_viewer_csv()
get_last_error()
```

ただし注意点がある。

### 7.1 MCPサーバーに持たせてよいもの

```text
- AIに公開するツール定義
- ツールの入出力スキーマ
- CSV生成処理の呼び出し
- CSV検証処理の呼び出し
- Viewer用ファイル保存
- ローカルAPI呼び出し
- 操作ログ
- エラー整形
```

### 7.2 MCPサーバーに持たせすぎない方がよいもの

```text
- 業務ロジック全体
- Viewer本体の状態管理
- ユーザー管理
- 認証・ライセンス管理
- 課金処理
- 長期データ保存
- UI表示ロジック
- 任意コマンド実行
- 任意ファイル読み書き
```

MCPサーバーは、**AIとローカルアプリ操作の境界層**として使うべきであり、アプリケーション本体やバックエンドの代用品にしない方がよい。

---

## 8. 推奨する内部分割

CSV生成ロジックをMCPサーバーにベタ書きするより、以下のように分ける方がよい。

```text
mcp-server/
  tools/
    getCsvSchemaTool.ts
    createViewerCsvTool.ts
    validateViewerCsvTool.ts
    saveViewerCsvTool.ts

viewer-csv-core/
  schema.ts
  generator.ts
  validator.ts
  writer.ts
  types.ts

app-adapter/
  fileAdapter.ts
  localApiAdapter.ts
  viewerStateAdapter.ts
```

責務は以下。

```text
MCP tools:
  AIからの呼び出し口

viewer-csv-core:
  CSV仕様・生成・検証の本体

app-adapter:
  Viewer / デスクトップアプリとの接続

MCP server:
  toolを束ねる境界層
```

こうすれば、将来的に以下のような再利用ができる。

```text
Claude CLI → MCP → viewer-csv-core
自社AI Host → MCP → viewer-csv-core
自社アプリ → viewer-csv-core
テスト → viewer-csv-core
```

---

## 9. 製品化で一番重要な置き換え

現在:

```text
Claude CLI / Claude Code
  ↓
ローカルMCPサーバー
  ↓
CSV生成
  ↓
Viewer
```

製品化時:

```text
自社デスクトップアプリのAIボタン
  ↓
自社AI Host / 自社AI操作クライアント
  ↓
クラウドLLM
  ↓
自社AI HostがローカルMCPサーバーを呼ぶ
  ↓
CSV生成・検証
  ↓
Viewer / 自社アプリに反映
```

つまり、置き換えるのはここ。

```text
Claude CLI / Claude Code
  ↓
自社AI Host / 自社AI操作クライアント
```

MCPサーバーは残す価値がある。  
Claude CLI / Claude CodeはPoC用Hostとしては便利だが、顧客にそのまま使わせるものではない。

---

## 10. Hostはローカルかクラウドか

結論:

> Hostは基本的にユーザーのローカルPCに置く。

理由は、ローカルMCPサーバーがユーザーPC上のデスクトップアプリやローカルファイルを扱うためである。

正しい通信方向は以下。

```text
ローカルHost → クラウドLLM / AWS Bedrock
ローカルHost → ローカルMCPサーバー
ローカルMCPサーバー → ローカルViewer / 自社アプリ
```

誤った、または避けるべき構成:

```text
クラウドLLM / クラウドHost
  ↓ インターネット越し
ユーザーPC上のローカルMCPサーバー
```

これは、NAT、ファイアウォール、社内プロキシ、セキュリティ審査、外部公開リスクの面で不利である。

---

## 11. LLMはどこにあるか

推奨構成では、LLMはクラウド側にある。

```text
ユーザーPC / ローカル:
  - 自社デスクトップアプリ
  - 自社AI Host
  - ローカルMCPサーバー
  - CSV生成core
  - ローカル作業ディレクトリ
  - ローカルログ

クラウド:
  - AWS Bedrock
  - Claude等のLLM
  - 自社バックエンド
  - 認証
  - 利用量管理
  - プロンプト管理
  - ログ集約
```

LLMそのものはローカルMCPサーバーの中にはない。  
MCPサーバーはAIではなく、AIが使うツールを提供するローカル制御層である。

---

## 12. AWS Bedrockを使う場合の理解

現PoCをAWS Bedrock構成に置き換える場合、以下のようなイメージになる。

```text
[ユーザーPC / ローカル]
  Viewer / 自社デスクトップアプリ
    ↓
  自社AI Host
    ├─ AWS Bedrockを呼ぶ
    └─ ローカルMCPサーバーを呼ぶ
          ↓
        CSV生成・検証
          ↓
        ViewerにCSVを読ませる

[AWS]
  Amazon Bedrock
    └─ ClaudeなどのLLM
```

重要なのは、**Bedrockが直接ローカルMCPサーバーを呼ぶわけではない**こと。

Amazon Bedrockのtool useでも、モデルがツール使用を要求し、実際にツールを呼んでtool_resultを返すのはアプリケーション側コードである。  
参考: <https://docs.aws.amazon.com/bedrock/latest/userguide/model-parameters-anthropic-claude-messages-tool-use.html>

---

## 13. 「Bedrock + MITのMCPサーバー」でよいか

大枠としては近いが、正確には以下。

```text
AWS Bedrock上のClaude
+
ローカルに配布する自社AI Host
+
MCP SDKを使ったローカル自社MCPサーバー
+
CSV生成・検証core
+
Viewer / 自社デスクトップアプリ
```

「MITのMCPサーバー」というより、

```text
MIT / Apache-2.0系のMCP SDKを使って、
自社のローカルMCPサーバーを実装する
```

と表現する方が正確である。

MCP TypeScript SDKは、公式GitHub上でライセンス移行中であり、既存コードはMIT、新規コード・仕様はApache-2.0と説明されている。  
参考: <https://github.com/modelcontextprotocol/typescript-sdk/blob/main/LICENSE>

---

## 14. 配布構成

ユーザーPCに配布するものは、基本的には以下。

```text
1. 自社デスクトップアプリ
2. 自社AI Host / 自社AI操作クライアント
3. ローカルMCPサーバー
4. CSV生成・検証core
5. 設定ファイル
6. ローカル作業ディレクトリ
7. ログ出力機構
```

インストーラーのイメージ:

```text
installer.exe
  ├─ desktop-app.exe
  ├─ ai-host.exe
  ├─ mcp-server.exe
  ├─ viewer-csv-core.dll / package
  ├─ config/
  └─ licenses/
```

ユーザーには、MCPやHostを意識させない。

ユーザーから見ると以下。

```text
自社アプリをインストール
  ↓
アプリ内のAIボタンを押す
  ↓
AIがCSV/反映案を生成
  ↓
プレビュー
  ↓
ユーザー確認
  ↓
反映
```

---

## 15. 起動方式

初期MVPでは以下がよい。

```text
自社デスクトップアプリがAI Hostを起動
  ↓
AI HostがMCPサーバーを子プロセスとして起動
  ↓
stdioで接続
```

構成:

```text
desktop-app.exe
  ↓ 起動
ai-host.exe
  ↓ stdio
mcp-server.exe
```

MCPの標準トランスポートには、stdioとStreamable HTTPがある。ローカルプロセス間ではstdioが扱いやすい。  
参考: <https://modelcontextprotocol.io/specification/2025-03-26/basic/transports>

メリット:

```text
- 外部ポートを開けなくてよい
- ユーザーがMCPを意識しない
- バージョン整合性を取りやすい
- アプリ終了時に一緒に停止できる
- ログの場所を統一しやすい
- セキュリティ説明がしやすい
```

---

## 16. ローカルMCPサーバーとデスクトップアプリの接続方式

候補は以下。

### 16.1 ファイル連携

```text
MCPサーバー
  ↓
CSV / JSON生成
  ↓
Viewer / 自社アプリが読み込み
```

向いているもの:

```text
- 一覧生成
- 分類結果
- 設定候補
- バッチ結果
- AIが作った構造化データの取り込み
```

メリット:

```text
- 実装しやすい
- デバッグしやすい
- 証跡が残る
- 既存アプリに組み込みやすい
```

弱点:

```text
- リアルタイム状態取得に弱い
- キャンセルや進捗管理が面倒
- 対話的操作には弱い
```

### 16.2 ローカルAPI方式

```text
MCPサーバー
  ↓ HTTP / gRPC / named pipe
デスクトップアプリ
```

例:

```text
GET  /status
POST /import-csv
POST /preview
POST /apply
GET  /last-error
```

向いているもの:

```text
- 現在状態取得
- CSV取込指示
- プレビュー表示
- 反映実行
- エラー取得
- ジョブ状態取得
- キャンセル
```

本番では、ファイル連携からローカルAPI方式へ進化させる余地がある。

### 16.3 CLI方式

```text
MCPサーバー
  ↓
myapp.exe import --file result.csv
```

バッチ処理中心なら候補になる。

### 16.4 UI Automation / 画面操作

最後の手段。  
本番の主軸にはしない方がよい。

---

## 17. ユーザーはどうAIを使うか

ユーザーにClaude CLIを使わせない。

推奨UIは、以下。

```text
自社デスクトップアプリ
  ├─ AIボタン
  ├─ 指示入力欄
  ├─ 結果プレビュー
  └─ 反映ボタン
```

基本フロー:

```text
1. ユーザーが対象データを選ぶ
2. 「AIで生成」ボタンを押す
3. 必要なら追加指示を入力
4. HostがBedrock/LLMへ問い合わせる
5. MCPサーバーがCSVを生成・検証
6. ViewerがCSVをプレビュー
7. ユーザーが確認
8. 反映
```

最初のリリースでは、AI結果を即反映しない方がよい。

```text
AI生成
  ↓
検証
  ↓
プレビュー
  ↓
ユーザー確認
  ↓
反映
```

---

## 18. 最初から汎用Agent Hostを作らなくてよい

Claude CLIのように、自由指示からAIがツールを何度も選び、自律的に完了するHostを最初から作る必要はない。

初期MVPでは、**固定フロー型Host**でよい。

```text
1. ユーザー指示を受ける
2. LLMに構造化データを作らせる
3. MCPのcreate_viewer_csvを呼ぶ
4. MCPのvalidate_viewer_csvを呼ぶ
5. CSVをViewerに読み込ませる
6. プレビューする
```

この場合、AIに任せるのは主に以下。

```text
CSVに入れる内容の判断
分類
補完
説明
```

Hostが決めるのは以下。

```text
どのツールを
どの順番で
何回まで
どの条件で止めるか
```

この方が実装難易度と安全性のバランスがよい。

---

## 19. Host実装に使える一般的な方法

tool loop / agent loop をゼロから完全自作する必要はない。一般的には以下を検討できる。

```text
- MCP公式SDK
- OpenAI Agents SDK
- LangChain / LangGraph + MCP adapters
- Microsoft Semantic Kernel
- Microsoft Agent Framework
- Mastra
```

ただし、最初は大きなAgent Frameworkを導入するより、以下のような小さなHostから始める方が現実的。

```text
固定フローHost
  - LLM呼び出し
  - MCP Client
  - create_csv / validate_csvの決め打ち呼び出し
  - CSV検証
  - Viewerプレビュー
  - ログ
```

OpenAI Agents SDKにはMCP連携のドキュメントがあり、MCPを使ってアプリケーションがツールやコンテキストをLLMへ提供する方法が説明されている。  
参考: <https://openai.github.io/openai-agents-python/mcp/>

LangChain MCP Adaptersは、MCPツールをLangChain/LangGraph互換にするアダプタを提供している。  
参考: <https://docs.langchain.com/oss/javascript/langchain/mcp>

Semantic KernelでもMCP ServerのプラグインをAgentへ追加する方法が説明されている。  
参考: <https://learn.microsoft.com/en-us/semantic-kernel/concepts/plugins/adding-mcp-plugins>

---

## 20. ライセンス・商用配布の理解

Host SDKやMCP SDKは、商用利用・顧客PCへの同梱配布が可能なものが多い。ただし、必ずバージョンごとのライセンス確認が必要。

重要なのは、以下を分けること。

```text
SDKのライセンス:
  自社アプリに組み込んで配布できるか

LLM APIの利用規約:
  顧客データを送ってよいか
  商用提供してよいか
  ログ・学習利用・保持条件はどうか
```

MCP TypeScript SDKはライセンス移行中で、既存コードはMIT、新規コード・仕様はApache-2.0と説明されている。  
参考: <https://github.com/modelcontextprotocol/typescript-sdk/blob/main/LICENSE>

配布前にやるべきこと:

```text
1. 使用SDKとバージョンを固定する
2. 依存ライブラリのライセンス一覧を作る
3. MIT / Apache-2.0 / BSD以外が混ざっていないか確認する
4. GPL / AGPL / SSPL系が混ざっていないか確認する
5. THIRD_PARTY_NOTICES.txtを同梱する
6. LICENSEファイルを同梱する
7. LLM API利用規約を別途確認する
8. 顧客データ送信・ログ・学習利用について契約/説明を用意する
```

---

## 21. セキュリティ設計

ローカルだから安全、ではない。  
MCPサーバーはローカルアプリやファイルに触るため、強い制限が必要。

### 21.1 やるべきこと

```text
- MCPツールは業務操作単位にする
- 任意ファイルパスを受け取らない
- 保存先ディレクトリを固定する
- 任意コマンド実行を禁止する
- 破壊的操作はユーザー確認を必須にする
- 最大tool call回数を制限する
- タイムアウトを設定する
- ログを残す
- 顧客データをログに丸ごと出さない
- 異常時に停止できるようにする
```

### 21.2 避けるべきMCPツール

```text
write_file(path, content)
read_any_file(path)
run_command(command)
call_api(url, body)
execute_sql(query)
click(x, y)
```

### 21.3 推奨するMCPツール

```text
get_csv_schema()
create_viewer_csv(input)
validate_viewer_csv(csv_id)
save_viewer_csv(csv_id)
preview_viewer_csv(csv_id)
apply_viewer_csv(csv_id)
get_viewer_state()
get_last_error()
```

---

## 22. ログ設計

本番化を考えるなら、最初からログを設計する。

例:

```text
ai_requests.jsonl:
  - request_id
  - timestamp
  - user_instruction_summary
  - model
  - status

tool_calls.jsonl:
  - request_id
  - tool_name
  - input_summary
  - output_summary
  - duration_ms
  - success
  - error_code

csv_validation.jsonl:
  - request_id
  - csv_id
  - schema_version
  - row_count
  - validation_result
  - warnings
  - errors

app_actions.jsonl:
  - request_id
  - action
  - previewed
  - applied
  - applied_by_user
  - timestamp
```

注意:

```text
- 顧客データを丸ごとログに残さない
- ID、件数、ステータス、エラー種別中心にする
- 必要ならローカルログとクラウド集約ログを分ける
```

---

## 23. AWSの役割

AWSはローカルアプリを直接操作する場所ではない。

AWSの役割は以下。

```text
- BedrockによるLLM提供
- 認証
- ライセンス管理
- 利用量管理
- LLM APIキー管理
- プロンプト管理
- モデル選択
- 設定配信
- ログ集約
- 監視・アラート
```

ローカルの役割は以下。

```text
- デスクトップアプリ実行
- AI Host実行
- MCPサーバー実行
- CSV生成・検証
- Viewerへの反映
- ローカルログ
```

---

## 24. 推奨する段階的ロードマップ

### Phase 0: 現在

```text
Claude CLI / Claude Code
  ↓
ローカルMCPサーバー
  ↓
CSV生成
  ↓
Viewer読込
```

目的:

```text
- CSV連携でViewerに反映できるか
- MCPツール設計が成立するか
- CSVルールで安定出力できるか
```

### Phase 1: PoC強化

```text
Claude CLI
  ↓
MCPサーバー
  ↓
CSV生成・検証
  ↓
Viewerプレビュー
```

追加すべきもの:

```text
- CSVスキーマ固定
- CSVバリデーション
- エラー構造化
- ログ
- プレビュー
```

### Phase 2: 自社固定フローHost

```text
自社AI Host
  ↓
AWS Bedrock
  ↓
MCPサーバー
  ↓
CSV生成・検証
  ↓
Viewer
```

ポイント:

```text
- Claude CLIを外す
- ただし汎用Agentではなく固定フローにする
- Bedrock呼び出しとMCP呼び出しをHostが仲介する
```

### Phase 3: アプリ内AIボタン統合

```text
自社デスクトップアプリ
  ↓
AIボタン
  ↓
自社AI Host
  ↓
Bedrock + MCP
  ↓
プレビュー
  ↓
反映
```

### Phase 4: ローカルAPI連携

```text
MCPサーバー
  ↓
ローカルAPI
  ↓
デスクトップアプリ
```

CSVだけでは足りない状態取得、プレビュー指示、反映指示、エラー取得、キャンセルなどをローカルAPI化する。

### Phase 5: 半Agent化

```text
LLMが一部のツール選択を行う
ただし許可ツール、最大回数、確認ステップを制限
```

---

## 25. 最終的な推奨アーキテクチャ

```text
[ユーザーPC / ローカル]

自社デスクトップアプリ
  ├─ AIボタン
  ├─ 指示入力欄
  ├─ CSV読込
  ├─ プレビュー
  └─ 反映ボタン
        ↓
自社AI Host / AI操作クライアント
  ├─ Bedrock呼び出し
  ├─ MCP Client
  ├─ tool_use処理
  ├─ 固定フロー制御
  ├─ タイムアウト制御
  ├─ 最大実行回数制御
  └─ ログ出力
        ↓
ローカルMCPサーバー
  ├─ get_csv_schema
  ├─ create_viewer_csv
  ├─ validate_viewer_csv
  ├─ save_viewer_csv
  ├─ get_viewer_state
  └─ get_last_error
        ↓
viewer-csv-core
  ├─ schema
  ├─ generator
  ├─ validator
  └─ writer
        ↓
Viewer / 自社アプリ
  └─ CSV読込・プレビュー・反映


[AWS / クラウド]

自社バックエンド
  ├─ 認証
  ├─ ライセンス管理
  ├─ 利用量管理
  ├─ プロンプト管理
  ├─ ログ集約
  └─ LLM中継
        ↓
Amazon Bedrock
  └─ Claude等のLLM
```

---

## 26. 重要な結論

### 26.1 今のPoCの正体

```text
Claude CLIをHostとして使った、
ローカルMCPサーバー経由のCSVファイル連携PoC
```

### 26.2 製品化で外すもの

```text
Claude CLI / Claude Code
```

### 26.3 製品化で残すもの

```text
ローカルMCPサーバー
CSV生成・検証ロジック
ViewerのCSV読込機能
```

### 26.4 製品化で追加するもの

```text
自社AI Host / AI操作クライアント
アプリ内AIボタン
Bedrock連携
認証・利用量管理
ログ
プレビュー・確認フロー
```

### 26.5 Hostの場所

```text
Hostはローカル。
LLMはクラウド。
MCPサーバーもローカル。
```

### 26.6 AWS Bedrockとの関係

```text
Bedrock = LLM提供
Host = BedrockとローカルMCPの仲介
MCPサーバー = ローカルアプリ操作・CSV生成ツール
Viewer = CSVを読んで反映
```

### 26.7 最初に目指すべき姿

```text
汎用Agentではなく、固定フロー型AI Host。
まずは「AIでCSVを作ってViewerに反映する」1ユースケースに絞る。
```

---

## 27. 面接・職務経歴書用の表現

### 短め

> AIエージェントを活用したデスクトップアプリ連携PoCを担当。Claude CLIをMCP Hostとして利用し、ローカルMCPサーバー経由でViewer向けCSVを生成・検証し、Viewerに読み込ませて結果を反映するファイル連携型の構成を検証した。

### 技術寄り

> Claude CLI / Claude Code とローカルMCPサーバーを用いたAIエージェント連携PoCを実施。MCPサーバー上にViewer向けCSV生成・検証ツールを実装し、AIが生成した構造化データをCSVとして出力、Viewerアプリに取り込ませることでローカルデスクトップアプリとの連携可能性を検証した。将来的な製品化を見据え、Claude CLIを自社AI Hostへ置き換え、AWS Bedrock上のLLMとローカルMCPサーバーを仲介する構成を検討した。

### 設計寄り

> PoCではClaude CLIが担っていたMCP Hostの役割を分析し、製品化時には自社AI Hostをローカルに配布し、AWS Bedrock上のLLMとローカルMCPサーバーを仲介する構成を整理した。MCPサーバーはAIから安全に呼び出せるローカル操作ゲートウェイとして位置づけ、CSV生成・検証・Viewer連携を業務操作単位のツールとして提供する方針を検討した。

---

## 28. 参照情報

- Model Context Protocol 2025-06-18 Specification  
  <https://modelcontextprotocol.io/specification/2025-06-18>

- MCP Architecture: Host / Client / Server  
  <https://modelcontextprotocol.io/specification/2025-06-18/architecture>

- MCP Transports: stdio / Streamable HTTP  
  <https://modelcontextprotocol.io/specification/2025-03-26/basic/transports>

- MCP TypeScript SDK License  
  <https://github.com/modelcontextprotocol/typescript-sdk/blob/main/LICENSE>

- Amazon Bedrock: Claude tool use  
  <https://docs.aws.amazon.com/bedrock/latest/userguide/model-parameters-anthropic-claude-messages-tool-use.html>

- Amazon Bedrock: Tool use  
  <https://docs.aws.amazon.com/bedrock/latest/userguide/tool-use.html>

- Claude API Docs: Tool use overview  
  <https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview>

- Claude API Docs: How tool use works  
  <https://platform.claude.com/docs/en/agents-and-tools/tool-use/how-tool-use-works>

- OpenAI Agents SDK: MCP  
  <https://openai.github.io/openai-agents-python/mcp/>

- LangChain MCP Adapters  
  <https://docs.langchain.com/oss/javascript/langchain/mcp>

- Semantic Kernel: Add plugins from MCP Server  
  <https://learn.microsoft.com/en-us/semantic-kernel/concepts/plugins/adding-mcp-plugins>
