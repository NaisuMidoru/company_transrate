# 現状の設計の流れをいかに示す

1 クライアントアプリc++exeからS3へ入力画像をアップロードするための署名付きURLを発行
クライアントアプリc++exe <-> クライアントアプリc#のexe <-> apigateway <-> lambda <-> S3 
※エラー時はクライアントアプリc++exeへメッセージを表示する必要がある

2 クライアントアプリc#のexeからS3へ入力画像をアップロード
(クライアントアプリc++exe) ← クライアントアプリc#のexe <-> S3
※エラー時はクライアントアプリc++exeへメッセージを表示する必要がある

3 画像生成処理を行い画像をS3へアップロード
(クライアントアプリc++exe) ← クライアントアプリc#のexe <-> apigateway <-> lambda <-> S3 
※エラー時はクライアントアプリc++exeへメッセージを表示する必要がある

4 クライアントアプリc#のexeからS3へ生成画像をダウンロード
(クライアントアプリc++exe) ← クライアントアプリc#のexe <-> S3
※エラー時はクライアントアプリc++exeへメッセージを表示する必要がある

5 クライアントのローカル環境へ画像が生成されたことが確認された4の段階で、クライアントアプリc#のexeから課金処理のLambdaを実行
(クライアントアプリc++exe) ← クライアントアプリc#のexe <-> apigateway <-> lambda <-> 自社独自の課金処理システム
※エラー時はクライアントアプリc++exeへメッセージを表示する必要がある

## 備考
クライアントのローカル環境へ画像が生成されたことが確認された4の段階で、クライアントアプリc#のexeから課金処理のLambdaを実行、これは課金漏れのリスクのある設計だが仕様のため許容すること
リトライ処理を行う場合はC#側で行ってC++側は最後にメッセージを出すだけにしたい
また追加の仕様として、複数画像の対応も存在します。現在クライアントが4枚を指定したらC#のプロセスが4つきどうして、それぞれのフェーズが4つ同時に動いている状態です。このフローは正しいのか、改善の余地はあるのか考えて
独自課金処理システムとはアクセストークンを使用してやりとりを行う

## 指示
上記構成に置いて、エラー処理をどのように行えばいいのか混乱している。全てを網羅して置くことが必要である。課金処理システムのため。apigatewayやLambdaのタイムアウト等の不正な終了、自社課金処理システムの不具合、全てを考えたときにどのようなエラー処理を行うべきか、リトライ処理、エラー時のメッセージ表示、運用方法などの仕様を整理する必要がある
各フェーズで想定されうるエラーとその時の対応を全て網羅して表とかに分かりやすくまとめてほしいです。

「あとから失敗したログのみを抽出したい」という目的がある場合、現在の**「`request_id`のみをキーにする」設計だけでは不十分**です。

DynamoDBで「特定のステータス（FAILEDなど）」を条件に検索する場合、そのままではテーブル全件を調べる「Scan」という非常に効率の悪い（料金が高い）操作が必要になってしまいます。

これを解決するために、**GSI（グローバルセカンダリインデックス）**という「別窓口」を設ける設計にするのがベストです。

---

### 1. 修正後のテーブル設計（GSIの導入）

*   **メインのキー（Partition Key）**: `request_id`
    *   用途：特定の処理の詳細をパッと見たいとき。
*   **追加のインデックス（GSI）**:
    *   **GSIのPartition Key**: `status` （SUCCESS, FAILED など）
    *   **GSIのSort Key**: `timestamp` （いつ起きたか）
    *   **用途**: 「失敗（FAILED）したものを、新しい順に並べて取得したい」ときに使用。

---

### 2. CDKでの設定変更

CDKでテーブルを作成した後に、インデックス（GSI）を追加するコードを加えます。

```typescript
const logTable = new dynamodb.Table(this, 'ProcessLogTable', {
  partitionKey: { name: 'request_id', type: dynamodb.AttributeType.STRING },
  billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
  timeToLiveAttribute: 'ttl',
  removalPolicy: cdk.RemovalPolicy.DESTROY,
});

// ★GSI（追加インデックス）の作成
logTable.addGlobalSecondaryIndex({
  indexName: 'StatusIndex', // インデックスの名前
  partitionKey: { name: 'status', type: dynamodb.AttributeType.STRING }, // 検索条件
  sortKey: { name: 'timestamp', type: dynamodb.AttributeType.STRING },    // 並び順用
  projectionType: dynamodb.ProjectionType.ALL, // 全データを含める
});
```

---

### 3. Pythonでの「失敗ログのみ取得」のコード

データを取得する際、`table.scan` ではなく **`table.query`** を使います。これが圧倒的に速くて安いです。

```python
from boto3.dynamodb.conditions import Key

def get_failed_logs():
    """失敗したログを最新順に取得する"""
    response = table.query(
        IndexName='StatusIndex', # CDKで決めたインデックス名
        KeyConditionExpression=Key('status').eq('FAILED'), # statusがFAILEDのものだけ
        ScanIndexForward=False # Falseにすると降順（新しい順）になる
    )
    return response.get('Items', [])

# 使い方
failed_items = get_failed_logs()
for item in failed_items:
    print(f"Failed ID: {item['request_id']}, Error: {item['details']}")
```

---

### 4. なぜこの設計にする必要があるのか？（Scan vs Query）

DynamoDBを触る上で一番重要な違いです。

*   **Scan（悪い例）**: 
    *   テーブルにある100万件のログを、AWSが全部1枚ずつめくって「FAILED」を探します。
    *   **デメリット**: 100万件分の読取料金がかかり、時間もかかります。
*   **Query（良い例 / GSI使用）**: 
    *   「FAILED」というラベルが貼られた引き出しだけを直接開けます。
    *   **メリット**: 該当する件数分しか料金がかからず、一瞬で終わります。

### まとめ：明日からの設計方針

1.  **書き込み時**: 今まで通り `request_id` と `status`, `timestamp` を含めて保存するだけでOKです（DynamoDBが勝手にインデックスを更新してくれます）。
2.  **読み込み時**: 
    *   IDで検索するときはメインのテーブルから。
    *   「失敗のみ」「成功のみ」を一覧したいときは **`StatusIndex`** から。

この「GSI」という仕組みさえ入れておけば、後から「昨日1日の失敗ログだけCSVで出して」と言われても、数行のコードで対応できるようになります！


DynamoDBのテーブル作成、特にCDKでの設定において「これだけは知っておくべき」ポイントを整理しました。

「オンデマンド課金」と「プロビジョニング課金」の違い、およびログテーブルとしての「ベストな設定」を解説します。

---

### 1. 「オンデマンド課金」とは？（初心者への推奨）

DynamoDBには2つの支払いモードがあります。

*   **オンデマンド (PAY_PER_REQUEST)**
    *   **内容**: 「1回書き込んだら○円」「1回読み込んだら○円」という従量課金。
    *   **メリット**: 使わなければ **0円** です。また、急にアクセスが増えてもAWSが勝手に処理能力を上げてくれます。
    *   **ベストな選択**: 開発中や、今回のシステムのように「いつ、どのくらいの頻度で実行されるか読めない」場合は、**これ一択**です。
*   **プロビジョニング (PROVISIONED)**
    *   **内容**: 「1秒間に○回読み書きする枠」を事前に予約して月額を払う。
    *   **メリット**: 24時間常に大量のアクセスがある場合、オンデマンドより安くなる。
    *   **デメリット**: 枠を使い切るとエラー（スロットリング）になり、使っていなくても予約料金が発生する。

---

### 2. CDKで設定すべき「4つの重要項目」

ログテーブルとして運用する場合、以下の設定を強く推奨します。

#### ① RemovalPolicy（削除ポリシー）
*   **設定**: `cdk.RemovalPolicy.DESTROY` (開発) / `RETAIN` (本番)
*   **注意点**: CDKでは、デフォルトで「スタックを削除してもテーブルはAWSに残る」ようになっています。開発中に何度も作り直すなら `DESTROY` にしないと、AWSにゴミ（空のテーブル）が溜まってしまいます。

#### ② TTL (Time to Live)
*   **設定**: `timeToLiveAttribute: 'ttl'`
*   **重要性**: ログは放っておくと無限に溜まり、ストレージ料金がかさみます。TTLを設定すると、指定した日時（Unixタイムスタンプ）を過ぎたデータを **AWSが無料で自動削除** してくれます。

#### ③ Point-in-Time Recovery (PITR)
*   **設定**: `pointInTimeRecovery: true`
*   **内容**: 過去35日間のどの時点の状態にもテーブルを復元できる機能。
*   **重要性**: 誤ってデータを消してしまった時の保険です。本番環境では必須です。

#### ④ Partition Key（パーティションキー）の設計
*   **設定**: `request_id` などの一意のID。
*   **内容**: DynamoDBはキーによる検索は高速ですが、キー以外での検索（例：特定の日付範囲を全部探す）は苦手で料金も高くつきます。

---

### 3. 【結論】これが「ログ用DynamoDB」のベストなCDKコード

これまでの内容を反映した、最もメンテナンス性が高くコスト効率の良いコードです。

```typescript
const logTable = new dynamodb.Table(this, 'ProcessLogTable', {
  // 1. パーティションキー（一意のID）
  partitionKey: { name: 'request_id', type: dynamodb.AttributeType.STRING },

  // 2. オンデマンド課金（使った分だけ、開発時はほぼ0円）
  billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,

  // 3. 自動削除の設定（有効期限が来たら勝手に消える）
  timeToLiveAttribute: 'ttl',

  // 4. バックアップ（誤削除対策：本番はtrue、開発ならfalseでも可）
  pointInTimeRecovery: true,

  // 5. 削除設定（CDKスタックを消した時にテーブルも一緒に消す設定）
  // 本番環境では .RETAIN に書き換えること！
  removalPolicy: cdk.RemovalPolicy.DESTROY,
});
```

---

### 💡 運用上のアドバイス：Python側でのTTLの書き方

テーブル作成時に `timeToLiveAttribute: 'ttl'` を指定した場合、Pythonコード側で「いつ消すか」を指定する必要があります。

```python
import time

# ログ保存時
item = {
    'request_id': 'abc-123',
    'status': 'SUCCESS',
    # 現在時刻 + 604800秒（7日間）の数値をセット
    'ttl': int(time.time()) + (7 * 24 * 60 * 60) 
}
table.put_item(Item=item)
```

これをやっておくだけで、**「ログが溜まりすぎて数ヶ月後に高額請求が来る」というクラウドの失敗談を確実に回避**できます。

明日の仕事では、まず「オンデマンド」でテーブルを作り、TTLを有効にするところから始めてみてください。
@@---------------------------------------------------

システム全体の可観測性（トレース）を高めるために、DynamoDBへのログ記録は非常に良い選択です。処理ごとの固有ID（`request_id`）をキーにすることで、後から「あの時、何が起きたか」を即座に特定できるようになります。

以下の3つの構成でコードを提示します。

1.  **【CDK】** DynamoDBテーブルの作成とLambdaへの権限付与
2.  **【Python】** DynamoDBへのログ書き込み・読み込みのサンプル
3.  **【Python】** `lambda_handler` への組み込み例

---

### 1. CDKコード (TypeScript)
DynamoDBテーブルを定義し、Lambda関数がそのテーブルを操作できるように権限を渡します。

```typescript
import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';

export class MyStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // 1. DynamoDBテーブルの作成
    const logTable = new dynamodb.Table(this, 'ProcessLogTable', {
      partitionKey: { name: 'request_id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST, // オンデマンド課金
      removalPolicy: cdk.RemovalPolicy.DESTROY, // スタック削除時にテーブルも削除（開発用）
      timeToLiveAttribute: 'ttl', // 期限切れログを自動削除する場合
    });

    // 2. Lambda関数の定義（既存のものがある場合は読み替え）
    const myLambda = new lambda.Function(this, 'MyLambda', {
      // ... 他の設定 ...
      environment: {
        TABLE_NAME: logTable.tableName,
      },
    });

    // 3. Lambdaに読み書き権限を付与
    logTable.grantReadWriteData(myLambda);
  }
}
```

---

### 2. Pythonコード (DynamoDB操作)
`boto3` ライブラリを使用して読み書きを行います。

```python
import boto3
import os
import time
from botocore.exceptions import ClientError

# 環境変数からテーブル名を取得
TABLE_NAME = os.environ.get('TABLE_NAME')
dynamodb = boto3.resource('dynamodb')
table = dynamodb.Table(TABLE_NAME)

def save_log(request_id, status, details):
    """ログを書き込む (PutItem)"""
    try:
        table.put_item(
            Item={
                'request_id': request_id,
                'timestamp': str(time.time()),
                'status': status,
                'details': details,
                'ttl': int(time.time()) + (7 * 24 * 60 * 60) # 7日後に自動削除
            }
        )
    except ClientError as e:
        print(f"DynamoDB Error: {e.response['Error']['Message']}")

def get_log(request_id):
    """ログを読み込む (GetItem)"""
    try:
        response = table.get_item(Key={'request_id': request_id})
        return response.get('Item')
    except ClientError as e:
        print(f"DynamoDB Error: {e.response['Error']['Message']}")
        return None
```

---

### 3. Lambdaへの組み込み例
`context.aws_request_id` を固有IDとして使うのが一般的です。

```python
import json
import uuid

def lambda_handler(event, context):
    # AWSが発行する一意のIDを取得（またはC#側から送られたID）
    request_id = context.aws_request_id 
    
    # 1. 開始ログ
    save_log(request_id, "STARTED", {"event": event})

    try:
        # --- ここで決済や画像生成の処理を行う ---
        # 成功したとする
        result_urls = ["https://example.com/1.jpg"]
        
        # 2. 完了ログ
        save_log(request_id, "SUCCESS", {"urls": result_urls})
        
        return {
            'statusCode': 200,
            'body': json.dumps({'request_id': request_id, 'urls': result_urls})
        }

    except Exception as e:
        # 3. エラーログ
        save_log(request_id, "FAILED", {"error": str(e)})
        raise e
```

---

### 💡 明日の作業へのアドバイス

#### ログに何を書くべきか？
DynamoDBには「後で調査が必要な情報」を絞って書くのがコツです。
*   **Prompt**: どんな指示で画像が生成されたか。
*   **Model**: どのモデルを使ったか。
*   **Error Message**: 失敗時、APIが何と言ってきたか。
*   **Execution Time**: 処理に何秒かかったか。

#### テスト時の注意
DynamoDBへの書き込みも、テストコード（`test_app.py`）ではモック化する必要があります。

```python
# test_app.py での追加例
@patch('app.table.put_item')
def test_handler_with_logging(mock_put):
    # 実行
    app.lambda_handler({...}, mock_context)
    
    # DynamoDBにログを書こうとしたか確認
    assert mock_put.called
```

#### なぜDynamoDBか？
CloudWatch Logsでもログは見れますが、DynamoDBに保存しておくと、**「C#側から `request_id` を投げて、現在の処理ステータスを確認するAPI」** を将来的に作るのが非常に簡単になります。

これで、インフラ（CDK）、サーバー（Python）、クライアント（C#）、呼び出し元（C++）の全ての層がつながる準備が整いました！

@@---------------------------------------------------

Python側のテストコードは、このプロジェクトの**「品質の要」**です。
外部API（fal.ai）や決済システム（payment）に実際につなぐことなく、あらゆる状況をシミュレーションするためのコードを整理して再提示します。

---

### テスト対象のコード (`app.py`)
まず、テストされる側のコードがこちらです。

```python
import fal_client
import payment
from concurrent.futures import ThreadPoolExecutor

def generate_single(model_id, prompt):
    # 1枚生成してURLを返す
    res = fal_client.subscribe(model_id, arguments={"prompt": prompt})
    return res['images'][0]['url']

def lambda_handler(event, context):
    try:
        token = event.get('one_time_token')
        model_id = event.get('model_name', 'fal-ai/flux/dev')
        prompt = event.get('prompt')
        count = max(1, min(event.get('image_count', 1), 4))

        # 1. 決済チェック
        if payment.request(token) != 200:
            return {'status_code': 402, 'image_urls': []}

        # 2. 並列画像生成
        with ThreadPoolExecutor(max_workers=count) as executor:
            futures = [executor.submit(generate_single, model_id, prompt) for _ in range(count)]
            urls = [f.result() for f in futures]

        return {'status_code': 200, 'image_urls': urls}
    except Exception as e:
        return {'status_code': 500, 'message': str(e)}
```

---

### テストコード (`test_app.py`)

ここからが本題のテストコードです。`pytest` で実行することを想定しています。

#### 1. 正常系テスト（複数枚・動的モデル指定）
一番メインとなる「正しく動くはず」のケースです。

```python
from unittest.mock import patch, ANY
import app

def test_success_multiple_images():
    # payment.request と fal_client.subscribe を両方モック化
    with patch('app.payment.request') as mock_pay, \
         patch('app.fal_client.subscribe') as mock_fal:
        
        # 【準備】成功時の戻り値を設定
        mock_pay.return_value = 200
        mock_fal.return_value = {'images': [{'url': 'http://fake.jpg'}]}
        
        # 【実行】
        event = {
            'one_time_token': 'tok_123',
            'model_name': 'fal-ai/nano-banana-pro',
            'prompt': 'cyberpunk city',
            'image_count': 3
        }
        result = app.lambda_handler(event, {})
        
        # 【検証】
        assert result['status_code'] == 200
        assert len(result['image_urls']) == 3
        # 正しいモデル名で呼ばれたか確認
        assert mock_fal.call_args.args[0] == 'fal-ai/nano-banana-pro'
```

#### 2. セキュリティ・引数検証テスト
**「正しいトークンが決済システムに渡されているか」**を確認します。非常に重要です。

```python
def test_argument_integrity():
    with patch('app.payment.request') as mock_pay, \
         patch('app.fal_client.subscribe') as mock_fal:
        
        mock_pay.return_value = 200
        mock_fal.return_value = {'images': [{'url': 'http://ok.jpg'}]}
        
        token = 'STRICT_CONFIDENTIAL_TOKEN'
        app.lambda_handler({'one_time_token': token, 'prompt': 'test'}, {})
        
        # 【検証】決済関数が「このトークン」で「1回だけ」呼ばれたことを保証
        mock_pay.assert_called_once_with(token)
```

#### 3. 異常系テスト（APIがエラーを返した場合）
「カード残高不足」などで決済APIが402を返してきた状況をシミュレーションします。

```python
def test_payment_failed():
    with patch('app.payment.request') as mock_pay:
        # 【準備】決済失敗(402)を返すように設定
        mock_pay.return_value = 402
        
        result = app.lambda_handler({'one_time_token': 'bad_token'}, {})
        
        # 【検証】
        assert result['status_code'] == 402
        assert result['image_urls'] == [] # 画像生成は行われない
```

#### 4. 異常系テスト（通信事故・例外発生）
ネットワークが切れるなどの「事故」を `side_effect` で再現します。

```python
def test_network_exception():
    with patch('app.payment.request') as mock_pay:
        # 【準備】関数が呼ばれたら例外(Exception)を投げるように設定
        mock_pay.side_effect = Exception("Connection Timeout")
        
        result = app.lambda_handler({'one_time_token': 'tok_123'}, {})
        
        # 【検証】
        assert result['status_code'] == 500
        assert "Connection Timeout" in result['message']
```
C++側のコードを「何をしているか」がひと目でわかるようにモック化・関数化して整理しました。

実務でよく使われる**JSONライブラリ（nlohmann/json）**を想定したパース処理も組み込んでいます。このライブラリはヘッダーのみで使用でき、非常に一般的です。

### 整理されたC++コード

```cpp
#include <windows.h>
#include <iostream>
#include <string>
#include <vector>
#include <memory>

// JSONパース用ライブラリ (nlohmann/json を想定)
// ※導入していない場合は文字列のまま扱ってください
// #include <nlohmann/json.hpp> 
// using json = nlohmann::json;

// 結果を格納する構造体
struct ExeResult {
    int exitCode;
    std::string output; // JSON文字列
};

// --- 内部関数: パイプから全出力を読み取る ---
std::string ReadPipeToString(HANDLE hPipe) {
    std::string result;
    CHAR chBuf[4096];
    DWORD dwRead;

    // パイプが空になるまで読み続ける
    while (ReadFile(hPipe, chBuf, sizeof(chBuf) - 1, &dwRead, NULL) && dwRead > 0) {
        chBuf[dwRead] = '\0';
        result += chBuf;
    }
    return result;
}

// --- 内部関数: プロセスを実行し出力をキャプチャする ---
ExeResult ExecuteProcess(const std::wstring& cmd) {
    ExeResult result = { -1, "" };

    SECURITY_ATTRIBUTES sa = { sizeof(sa), NULL, TRUE };
    HANDLE hStdOutRead, hStdOutWrite;

    // 1. パイプ作成
    if (!CreatePipe(&hStdOutRead, &hStdOutWrite, &sa, 0)) return result;
    SetHandleInformation(hStdOutRead, HANDLE_FLAG_INHERIT, 0);

    // 2. スタートアップ情報の設定
    STARTUPINFOW si = { sizeof(si) };
    si.dwFlags = STARTF_USESTDHANDLES;
    si.hStdOutput = hStdOutWrite;
    si.hStdError = hStdOutWrite; // エラーも同じパイプに流す

    PROCESS_INFORMATION pi = { 0 };
    std::vector<wchar_t> cmdBuf(cmd.begin(), cmd.end());
    cmdBuf.push_back(0);

    // 3. プロセス起動
    if (CreateProcessW(NULL, cmdBuf.data(), NULL, NULL, TRUE, 0, NULL, NULL, &si, &pi)) {
        // 【重要】書き込み用ハンドルは親側では不要なので即閉じる
        // これをしないとReadFileが「まだ書き込まれるかも」と待ち続けて終わらない
        CloseHandle(hStdOutWrite);

        // 4. 出力の読み取り
        result.output = ReadPipeToString(hStdOutRead);

        // 5. 終了待機と終了コードの取得
        WaitForSingleObject(pi.hProcess, INFINITE);
        DWORD exitCode;
        GetExitCodeProcess(pi.hProcess, &exitCode);
        result.exitCode = (int)exitCode;

        CloseHandle(pi.hProcess);
        CloseHandle(pi.hThread);
    } else {
        CloseHandle(hStdOutWrite);
    }

    CloseHandle(hStdOutRead);
    return result;
}

// --- メイン関数: C#側を呼び出してJSONを得る ---
std::string GetJsonFromCSharp(const std::wstring& exePath, const std::wstring& args) {
    std::wstring commandLine = L"\"" + exePath + L"\" " + args;
    
    std::wcout << L"実行中: " << commandLine << std::endl;
    ExeResult res = ExecuteProcess(commandLine);

    if (res.exitCode != 0) {
        std::cerr << "C# EXEがエラーを返しました。Code: " << res.exitCode << std::endl;
        // エラー時は空のJSONやエラー用JSONを返す
        return "{}";
    }

    return res.output;
}

// --- JSONパースの例 ---
void ParseAndDisplay(const std::string& jsonStr) {
    if (jsonStr.empty() || jsonStr == "{}") return;

    std::cout << "\n--- 解析結果 ---" << std::endl;
    
    /* 
    // nlohmann/json を使う場合の例:
    try {
        auto data = json::parse(jsonStr);
        std::string status = data["status"];
        std::cout << "Status: " << status << std::endl;
        for (auto& url : data["image_urls"]) {
            std::cout << "URL: " << url << std::endl;
        }
    } catch (json::parse_error& e) {
        std::cerr << "JSONパース失敗: " << e.what() << std::endl;
    }
    */

    // ライブラリがない場合の簡易表示
    std::cout << jsonStr << std::endl;
}

int main() {
    // 実際の設定に合わせて変更してください
    std::wstring exePath = L"PaymentApp.exe";
    std::wstring args = L"tok_test_12345 fal-ai/flux/dev 4";

    // 1. 実行してJSON文字列を取得
    std::string jsonResponse = GetJsonFromCSharp(exePath, args);

    // 2. パースして表示
    ParseAndDisplay(jsonResponse);

    return 0;
}
```

### 改善のポイント

1.  **`ExeResult` 構造体の導入**:
    単なる文字列だけでなく、`exitCode`（終了コード）もセットで返すようにしました。これにより、「プログラム自体がクラッシュしたのか」「中身が空だったのか」を区別できます。
2.  **`ReadPipeToString` の分離**:
    パイプからの読み取りロジックを独立させたことで、`ExecuteProcess` 関数がすっきりしました。
3.  **`CloseHandle(hStdOutWrite)` のタイミング**:
    `CreateProcess` 成功直後に親プロセス側の書き込みハンドルを閉じています。これはパイプ通信における**鉄則**で、これを忘れると「C#側は終わっているのに、C++側が読み取りを完了できない（フリーズする）」というデッドロックが発生します。
4.  **JSONパースの関数化**:
    `ParseAndDisplay` として分離しました。実際の開発では、ここに `nlohmann/json` などのライブラリを入れるのがベストです。

### 明日からの進め方のアドバイス

C++側でこの関数が完成したら、まずはC#側で以下のような **「テスト用のダミー出力だけするEXE」** を作って連携を確認してください。

```csharp
// C#側のテスト用メイン関数
static void Main(string[] args) {
    // 実際の通信をせずに、決められたJSONを出すだけ
    Console.WriteLine("{\"status\":\"success\", \"image_urls\":[\"http://test1.jpg\", \"http://test2.jpg\"]}");
}
```

これで C++ ↔ C# ↔ Lambda ↔ fal.ai の全経路が繋がります！
---

@@---------------------------------------------------
### Pythonテストのポイントまとめ（明日への備忘録）

1.  **`patch('app.xxxx')` の書き方**
    *   `fal_client` を直接パッチするのではなく、**`app.py` がインポートしている `app.fal_client`** をパッチするのがコツです。
2.  **`return_value` vs `side_effect`**
    *   `return_value`: 「402」や「JSON」など、**特定の値**を返したいとき。
    *   `side_effect`: **「エラー（例外）」**を発生させたいときや、呼ぶたびに戻り値を変えたいとき。
3.  **検証は `assert_called_once_with`**
    *   ただ呼ばれただけでなく、**「意図した引数（トークンや枚数）」**で呼ばれたかを必ずチェックする。これがバグを未然に防ぎます。

このテストコードがしっかりしていれば、C#やC++側で多少変更があっても、Python側のロジックが壊れていないことを一瞬で確認できます。

@@---------------------------------------------------
まとめ２ 自動リトライでも失敗したらどうするのか

自動リトライを繰り返してもなお失敗する場合、それは「一時的なノイズ」ではなく、**「ユーザーの通信環境が極端に悪い（地下、トンネル、Wi-Fi切れ）」**か**「決済サーバーがダウンしている」**かのどちらかです。

ここで諦めて画像を捨ててしまうと、fal.aiの代金（原価）が赤字として確定してしまいます。

これを防ぐための、**「自動リトライの限界を超えた後の3ステップ」**を提案します。

---

### 1. 指数バックオフによる自動リトライ（まずは粘る）
即座に何度も叩くのではなく、間隔を空けてリトライします（Exponential Backoff）。
*   1回目失敗：1秒後にリトライ
*   2回目失敗：3秒後にリトライ
*   3回目失敗：5秒後にリトライ
*   **ここまではユーザーには「決済処理中...」のくるくる画像だけ見せて、エラーは隠します。**

### 2. 「手動リトライ」への切り替え（ユーザーを巻き込む）
5回ほど自動でやってダメな場合、初めてユーザーに状況を伝えます。ただし、**「失敗したから最初からやり直し」とは絶対に言わない**のがコツです。

*   **表示メッセージ：**
    「通信状態が不安定です。電波の良い場所へ移動してから『再試行』ボタンを押してください。」
*   **UIの工夫：**
    *   **「再試行」ボタン**を大きく出す。
    *   **「キャンセル」ボタンは出さない、あるいは小さくする。**
    *   **画像は「人質」としてプレビュー表示し続ける。**（「これを保存したければ支払いを完了させてね」という状態を維持します）

これで、ユーザーが電波の良いところに移動してボタンを押してくれれば、**原価を回収できます。**

### 3. 「後で支払う（一時保存）」の実装（※もし工数が許せば）
リトライボタンを何度押してもダメで、ユーザーがその場を立ち去らなければならない場合、**「今の画像をローカルに暗号化して一時保存し、次回起動時に強制的に課金フローから再開する」**という方法が最強です。

1.  課金が完了していない画像を、アプリ専用の「一時フォルダ」に、ユーザーが勝手に開けない形式で書き出す。
2.  その際、`order_id` も一緒に記録しておく。
3.  **次にアプリを起動したとき、真っ先にその「未払い画像」があるかチェックする。**
4.  あれば、「前回の未完了の決済があります」と出し、課金APIを叩くところからスタートさせる。

---

### 【結論】どうすべきか？

リトライに失敗した際の「運用・実装」の優先順位は以下の通りです。

1.  **【必須】諦めないUI:** 
    「通信エラーです。再試行しますか？」というダイアログを出し、**「はい（再試行）」を押すまで画像を絶対にメモリから消さない。**（ユーザーがアプリを強制終了しない限り、原価回収のチャンスは残ります）
2.  **【推奨】原因の切り分け:** 
    「決済サーバー側のエラー（500系）」なのか「ユーザーの通信エラー（タイムアウト）」なのかをログに残す。サーバーダウンなら、ユーザーを待たせても解決しないので、「後で再開してください」と伝える必要があります。
3.  **【理想】アプリ終了の阻止:**
    リトライに失敗した状態でユーザーが「×」ボタンで閉じようとしたら、**「今閉じると、この画像は消去され、二度と手に入りません。本当によろしいですか？」**と強い警告を出し、心理的に引き止めます。

**「リトライが失敗した＝赤字の危機」**ですので、**「画像を人質にしたまま、ユーザーに次のアクション（電波の良い所へ行く、または後でリトライする）を選ばせる」**のが、ビジネス上の正解です。
@@---------------------------------------------------
DBいる理由

仰る通りです。**「二重課金の最終的な阻止」**に関しては、これまでの議論の通り、**独自課金サーバー側にID（冪等性）の仕組みがあれば、技術的にはそれだけで防げます。** そこにDynamoDBは必須ではありません。

ここまでの話を整理すると、DynamoDBを導入する理由は「二重課金防止」そのものよりも、**「システム全体の整合性と防衛」**にシフトしています。

質問者様の「二重課金はサーバー側だけでいいはずだ」という正しい認識を前提に、**なぜそれでもDBを挟むのが「プロの設計」と言われるのか**、その理由を3点に絞って最終確認させてください。

---

### 1. 「課金サーバーへの無駄打ち」を減らす（フロントガード）

課金サーバー側に冪等性（重複チェック）があるとしても、アプリ側でリトライが何度も走った場合、Lambdaはその都度「決済サーバー」へ通信しに行きます。

*   **DBがない場合:** リトライのたびに「Lambda → 決済サーバー」という重い通信が発生し、決済サーバーが「それ、もう終わってるよ」と答えるのを待つことになります。
*   **DBがある場合:** Lambdaが最初にDBを見て「あ、PAID（支払い済み）だ」と分かれば、**決済サーバーに問い合わせることなく即座に完了**を返せます。
    *   → 決済サーバーの負荷を減らし、ユーザーへのレスポンスも速くなります。

### 2. 「すり替え詐欺」の検知（これがDBの真の存在意義）

これが前回の回答で一番伝えたかったポイントです。二重課金防止よりも**セキュリティ面**での理由です。

*   **決済サーバー:** 「ID: abc、金額500円」と言われれば、それが正しいか疑わずに決済します。
*   **DynamoDB:** 「ID: abc は、もともと500円のプラン（機能A）で作られたものだ」という**「正解」を保持**しています。

もしDBがないと、悪意あるユーザーが「ID: abc（本当は500円）を、100円のプラン（機能B）として決済して」というリクエストを送ってきた時に、**誰もそれが「嘘（すり替え）」だと気づけません。**

### 3. 「失敗した処理（赤字）」の可視化と分析

質問者様が仰った「エクセルの表のようにあとから分析したい」という要望を叶えるための最短ルートです。

*   **CloudWatchの場合:**
    「始まったログ」はあるが「終わったログ」がないものを、膨大なテキストから探し出すのは非常に困難です。
*   **DynamoDBの場合:**
    「ステータスが `PENDING（未決済）` のまま 1時間以上経過している注文」を検索するだけで、**「画像の原価だけかかって、課金までたどり着けなかった＝損をした注文」**が一瞬でリストアップできます。
    *   → 「今月は何件失敗して、いくら損害が出たか」というビジネス分析がExcel一本でできるようになります。

---

### まとめ

おっしゃる通り、**「二重課金の防止」だけで言えば、課金サーバー側のID識別があれば十分**です。

しかし、以下の**「付加価値」**を考えると、DynamoDBはやはり「あったほうが良い（実質的に必須に近い）」という結論になります。

1.  **セキュリティ:** 高い画像を安いプランの料金で買われる「すり替え」を阻止できる。
2.  **パフォーマンス:** 決済済みなら、決済サーバーに聞かずに即レスできる。
3.  **分析（Excel化）:** どの注文が決済まで完了せず「赤字（食い逃げ）」になったかを簡単に集計できる。

**「二重課金防止は決済サーバー」に任せ、「ビジネスの正当性と分析はDynamoDB」に任せる**という役割分担が、最も漏れがなく、将来的に「入れておけばよかった」と後悔しない設計です。

DynamoDBを「ログ的な状態管理」に使う際の料金、確かに気になりますよね。特に「全件保存し続けると高くなるのでは？」という懸念はもっともです。

しかし、結論から言うと、今回の決済管理のような**「1レコードが小さく、一定期間で不要になる」**ケースでは、**DynamoDBはCloudWatch Logs Insightを使うよりも安く済む可能性が高く、工夫次第で月額「数円〜数十円」に抑えられます。**

料金を安く抑えるための具体的な戦略と、なぜ怖くないのかを解説します。

---

### 1. 【最強の節約術】TTL（Time To Live）機能を活用する
DynamoDBには**TTL（生存期間）**という機能があります。これが「ログ的運用」において最大の武器になります。

*   **仕組み:** レコードに「削除時間（例：作成から30日後）」を書き込んでおくと、AWSが**無料**で自動的にデータを削除してくれます。
*   **メリット:**
    *   **ストレージ料金がたまらない:** 古いデータが勝手に消えるので、数GBも溜まることがありません。
    *   **運用が楽:** 削除用のバッチプログラムを組む必要がありません。
*   **今回のケース:** 決済の調査が必要なのはせいぜい数日〜1ヶ月程度です。30日程度で消えるように設定すれば、データ量は常に「直近1ヶ月分」だけに保たれ、料金はほぼ最低ラインで維持されます。

### 2. 「オンデマンドモード」を選択する
DynamoDBには「プロビジョニング（固定枠）」と「オンデマンド（従量課金）」があります。

*   **オンデマンド:** 使った分（書き込み・読み込み回数）だけ課金されます。
*   **メリット:** 
    *   アクセスがない時間は**0円**です。
    *   Windowsアプリのユーザーが少ない深夜や初期段階では、月額数セント（数円）で済みます。
    *   100万回書き込んでも約1.25ドル（約180円）程度です。個人の趣味レベルなら無料枠（後述）に収まります。

### 3. AWS無料利用枠を使い倒す
DynamoDBには**「期限なしの無料枠」**があります（※2024年現在の情報）。

*   **25GBのストレージ:** 決済ログのような小さなデータなら、数千万件保存しても25GBには届きません。
*   **25 WCU / 25 RCU（プロビジョニング時）:** これをうまく設定しておけば、一定のトラフィックまでは**完全無料**で使い続けることができます。

### 4. データのサイズを極限まで小さくする
DynamoDBは「書き込むデータのサイズ」で料金が決まります。

*   **対策:** 
    *   「画像のBase64データ」などは絶対に入れない。
    *   `order_id`, `user_id`, `status`, `amount`, `feature_name`, `ttl_timestamp` のような、**必要最低限の英数字だけ**を保存するようにします。
    *   1レコード数百バイト程度に抑えれば、課金単位（1KB）を最小限に抑えられます。

---

### 5. CloudWatch Logs（ログ）との料金比較

実は、**CloudWatch Logsの方が高くつくケース**があります。

*   **CloudWatch Logs Insights（検索）の料金:** 1GBのスキャンにつき $0.005。
    *   大量のログの中から特定のUUIDを探すために検索を何度も走らせると、DynamoDBの読み込み料金（GetItem）よりも高くなることがよくあります。
*   **DynamoDBの読み込み:** 特定のキー（ID）を指定して1件取るだけなら、料金は極めて微々たるものです。

---

### 結論：どれくらいの料金になるか？

仮に **月間10,000件** の画像生成が行われる場合（オンデマンドモード）：

1.  **書き込み（生成時＋決済完了時）:** 20,000回 ＝ 約 0.025 ドル（約4円）
2.  **読み込み（決済時のチェック）:** 10,000回 ＝ 約 0.0025 ドル（約0.4円）
3.  **ストレージ:** 10,000件（1ヶ月分保持） ＝ 数MB ＝ **無料枠内（0円）**
4.  **合計:** **月額 5円〜10円程度**

これくらいの金額で、**「二重課金の防止」「金額改ざんの防御」「失敗した処理のExcel分析」「カスタマーサポートの迅速化」**が手に入るのであれば、コストパフォーマンスは非常に高いと言えます。

**「TTLで古いデータを消す」**ことと**「オンデマンドモード」**を選ぶことさえ忘れなければ、DynamoDBの料金を心配する必要は全くありません。

@@---------------------------------------------------
まとめ

---

### 1. システム構成の結論
**「Client主導 + 独自サーバーでの冪等性担保」**

*   **構成:** `Client` → `Gateway` → `Lambda (Pass-through)` → `独自課金サーバー`
*   **特徴:** Lambda側にDB（DynamoDB）は持たず、**「独自課金サーバーが正解データを持つ」** というシンプルな構成。
*   **必須条件:** 独自課金サーバーに**「同じ注文IDは2回処理しない（冪等性）」**機能があること。

---

### 2. 懸念点・不具合発生時の対応（完全版）

#### フェーズA：画像生成 〜 ダウンロード完了
**状況：** fal.aiで画像を生成し、クライアントがメモリ上にダウンロードするまで。

| 発生箇所 | 不具合・状況 | 損害 | **対応策・実装要件** |
|:---|:---|:---|:---|
| **Gen Lambda**<br>(fal実行後) | 画像は生成されたが、Lambdaのタイムアウト等で返却に失敗。 | **貴社の損失**<br>(fal代金) | **【許容する】**<br>ユーザーは画像を見ていないため、課金は不可。エラー表示して終了する（必要経費）。 |
| **Client**<br>(DL中) | **通信切断で画像DL失敗**。<br>またはDL直後にアプリが強制終了/クラッシュ。 | **貴社の損失**<br>(fal代金) | **【許容する】**<br>これも防ぎようがない。アプリ起動時に一時ファイルを掃除する等の処理のみ入れる。 |
| **Client**<br>(DL完了後) | **食い逃げリスク**。<br>課金成功前に画像を保存される。 | **貴社の損失**<br>(fal代金) | **【UIロック（必須）】**<br>・DLが完了しても、課金成功のレスポンスが来るまでは**保存ボタンを無効化（Disabled）**しておく。<br>・プレビューには透かしを入れる等で対策。 |

#### フェーズB：自動課金処理 〜 完了レスポンス
**状況：** DL完了を検知し、アプリが自動で課金APIを叩く（ここが実装の肝）。

| 発生箇所 | 不具合・状況 | 損害 | **対応策・実装要件** |
|:---|:---|:---|:---|
| **Client**<br>(送信時) | **リクエスト通信エラー**。<br>（サーバーに届かない） | **貴社の損失**<br>(fal代金) | **【自動リトライ】**<br>・画像をメモリに保持したまま、アプリ内で即座に再送信を行う。<br>・ユーザーにはエラーを見せない。 |
| **Pay Lambda**<br>(中継時) | **Lambdaの途中クラッシュ**。<br>（独自サーバーに投げた後、返事待ちで落ちる） | **二重課金の危機** | **【サーバー側の冪等性で解決】**<br>・クライアントがリトライしてくるが、独自サーバー側で「このIDは処理中/済みだ」と判定し、重複処理を防ぐ。 |
| **独自サーバー**<br>↓<br>**Client** | **★決済完了後のレスポンス消失**<br>（ご質問のケース）<br>独自サーバーで決済は完了したが、クライアントへの返信中に通信が切れた。 | **なし**<br>（自動解決） | **【リトライ + 冪等性で自動復旧】**<br>1. クライアントは「失敗」と判定して**自動リトライ**する。<br>2. 独自サーバーはIDを見て**「あ、これはさっき決済済みだ」**と気づく。<br>3. 新たな課金はせず、**「成功」ステータスだけ**を返す。<br>4. クライアントは正常終了し、画像の保存が可能になる。<br>→ **ユーザーはエラーに気づかず、二重課金も起きない。** |
| **独自サーバー**<br>(決済処理) | **決済エラー**。<br>（カード限度額オーバー等） | 未回収 | **【カード変更誘導】**<br>・ここだけはユーザー操作が必要。<br>・「カードが使えません」と表示し、**画像を破棄せず**にカード情報変更画面へ誘導する。 |

---

### 3. 開発者への実装指示書（チェックリスト）

以下の要件が満たされているか、各担当者に確認してください。

#### ① クライアントアプリ担当
*   [ ] **IDのバケツリレー:** 生成時に受け取った `order_id` を、必ず課金APIのリクエストに含める。
*   [ ] **画像の人質化:** 課金APIが「成功(200)」を返すまで、ファイル保存機能をロックする。
*   [ ] **粘り強いリトライ:** 課金APIがネットワークエラーになった場合、**画像を消さずに自動で再試行（リトライ）** するループ処理を入れる。
*   [ ] **離脱防止:** 課金処理中にアプリを閉じようとしたら「画像が破棄されますが宜しいですか？」と警告を出す。

#### ② Pay Lambda担当（中継役）
*   [ ] **パススルー:** クライアントからのリクエスト（`order_id`等）を独自サーバーへそのまま流す。
*   [ ] **構造化ログ:** 分析用に、以下のJSONログを出力する。
    ```javascript
    console.log(JSON.stringify({
        log_type: "TRANSACTION",
        order_id: event.order_id,
        user_id: event.user_id,
        amount: 100,
        status: "PROCESSING", // 結果に応じて SUCCESS / ERROR
        timestamp: new Date().toISOString()
    }));
    ```

#### ③ 独自課金サーバー担当（最重要）
*   [ ] **冪等性（Idempotency）の実装:**
    *   リクエストを受け取った際、まずDBで `order_id` を検索する。
    *   **データなし:** 新規決済を実行し、結果を保存して返す。
    *   **決済済み:** **決済処理はスキップ**し、保存済みの「成功」結果を即座に返す。

---

### 4. 運用・分析（CloudWatchのみ）

*   **Excel分析:**
    *   CloudWatch Logs Insights で `log_type = "TRANSACTION"` を検索・CSV出力する。
    *   これで「誰が・いつ・どのIDで・成功したか」を一覧化できます。
*   **アラート通知:**
    *   Lambdaの標準メトリクス `Errors` が発生、またはログ内の `status: "ERROR"` を検知したらメール通知する設定を入れる。

以上が、今回の要件における**「ユーザーファースト（クレームゼロ）」かつ「ビジネスリスク最小化」**を実現する最終的な仕様となります。
@@---------------------------------------------------
# 課金サーバー側に処理を識別する一意な識別が必要な理由

課金処理でリトライする場合に以下のことが考えられる

そのケース（Lambdaが**「決済リクエストを投げた後、レスポンスを受け取る前（またはDB更新前）」に落ちる**ケース）では、**自前のDynamoDBの管理だけでは二重課金を防げません。**

1.  Lambda(1回目)がStripe等へ「課金して！」と投げる。
2.  Stripe側で処理完了（課金成立）。
3.  しかし、Lambdaがその返事を受け取る前（あるいはDBを「決済済み」に更新する前）に、タイムアウトやメモリ不足で強制終了する。
4.  DynamoDBは「未決済」のまま。
5.  クライアントがリトライして、Lambda(2回目)が動き出す。
6.  DBは「未決済」なので、Lambda(2回目)は再度Stripeへ「課金して！」と投げる。
7.  **Stripeは「新しい注文だ」と思って再び課金する（二重課金成立）。**

この穴を塞ぐための「最後の切り札」があります。
それは、**決済プロバイダー（Stripeなど）側の「冪等性キー（Idempotency Key）」機能を使うこと**です。

---

### 解決策：決済APIに「Idempotency Key」を渡す

Stripeなどの主要な決済サービスには、APIリクエスト時に**「これはユニークなID（Idempotency Key）ですよ」**と伝えると、**「同じIDのリクエストなら、2回目以降は課金処理をスキップして、最初の結果だけを返す」**という機能が標準で備わっています。

これを使えば、Lambdaが途中で死んでも大丈夫です。

#### 具体的な処理フロー

クライアントから送られてくる `order_id` を、Lambda内のDB管理だけでなく、**決済APIを呼ぶときにもそのまま渡します。**

1.  **Client:**
    *   `order_id: "abc-123"` を送る。
2.  **Lambda (1回目):**
    *   StripeのAPIを呼ぶときに、オプションで `Idempotency-Key: "abc-123"` を指定して送信。
    *   Stripe: 「"abc-123" は初めてだな。決済しよう」 → **決済成功**。
    *   **★ここでLambdaがクラッシュ！** （DB更新できず、Clientへ返事もできず）
3.  **Client:**
    *   通信エラーと判断し、自動リトライ。 `order_id: "abc-123"` を再度送る。
4.  **Lambda (2回目):**
    *   DBを見る → まだ「未決済」になっている（さっき更新できなかったから）。
    *   「じゃあ決済しなきゃ」と思い、Stripeへ再度リクエスト。
    *   **重要：** ここでも `Idempotency-Key: "abc-123"` を指定して送信。
5.  **Stripe (決済サーバー):**
    *   「お、 "abc-123" はさっき処理したやつだな」と気づく。
    *   **二重課金はせず**、さっきの「成功」という結果データだけをLambdaに返す。
6.  **Lambda (2回目):**
    *   「決済成功した」と受け取る（実はキャッシュされた結果だが、Lambdaは知らなくていい）。
    *   DBを「決済済み」に更新。
    *   Clientへ成功レスポンスを返す。

---

### 実装イメージ（Node.js / Stripeの場合）

もしStripeを使っている場合、以下のようにたった1行追加するだけで解決します。

```javascript
// Lambdaのコード例

async function handlePayment(event) {
  const { order_id, token } = JSON.parse(event.body);

  try {
    // DynamoDBチェック（あくまで自社サーバーの負荷軽減用）
    const isPaid = await checkDynamoDB(order_id);
    if (isPaid) return { statusCode: 200, body: "Already Paid" };

    // ★ここが二重課金防止の命綱
    const charge = await stripe.charges.create({
      amount: 1000,
      currency: 'jpy',
      source: token,
    }, {
      // APIリクエストに「冪等性キー」として order_id を渡す
      idempotencyKey: order_id 
    });

    // 決済成功後、DynamoDBを更新
    await updateDynamoDB(order_id, "Paid");

    return { statusCode: 200, body: JSON.stringify(charge) };

  } catch (error) {
    return { statusCode: 500, body: error.message };
  }
}
```

### 結論：2段階の防御壁を作る

ご指摘の通り、DynamoDBだけでは「Lambda〜決済サーバー間」の事故は防げません。
ですので、以下の**2段構え**にしてください。

1.  **第1の壁（自社DB）：** DynamoDBで `order_id` を管理する。
    *   **目的：** すでに完了しているのにStripeのAPIを叩きに行くと通信時間が無駄なので、Lambdaレベルで即レスするためのキャッシュ的な役割。
2.  **第2の壁（決済プロバイダー）：** `Idempotency Key` を指定してAPIを叩く。
    *   **目的：** **Lambdaが途中終了してリトライが発生した際の、真の二重課金防止策。**


この「第2の壁」さえ実装すれば、Lambdaがどのタイミングで爆発しようとも、二重課金は確実に防げます。使用している決済サービスのAPIドキュメントで「Idempotency Keys（冪等性キー）」の項目を必ず確認してください。


@@---------------------------

これまでの議論（C#シングルプロセス構成、ディスクログなし、リスク許容方針、冪等性担保）に基づいた、**ログ・追跡基盤（DynamoDB）の設計**および**運用・サポートマニュアル**の最終確定版仕様書です。

---

# 1. ログ・追跡基盤 設計仕様書 (Amazon DynamoDB)

本システムにおける全トランザクション（画像生成〜課金）の状態、エラー、およびユーザー利用履歴を一元管理するためのデータベース設計です。

## 1.1 テーブル基本定義

| 設定項目 | 値 | 備考 |
| :--- | :--- | :--- |
| **テーブル名** | `TransactionLogs` | 環境別 (dev/prod) に作成 |
| **Partition Key (PK)** | `PK` (String) | `TX#{TransactionID}` |
| **Sort Key (SK)** | `SK` (String) | `#SUMMARY` または `LOG#{Timestamp}` |
| **課金モード** | **On-Demand** | アクセススパイクに対応するため |
| **暗号化** | **有効 (AWS KMS)** | デフォルト設定 |
| **TTL属性** | `ExpireAt` (Number) | ログ保存期間（例: 1年後のUnixTimestamp）を設定し自動削除 |

---

## 1.2 データモデル (Single Table Design)

1つのトランザクションに対し、「概要レコード」と「詳細ログレコード」の2種類を格納します。

### A. トランザクション概要レコード (Summary)
処理全体のステータス、課金結果、ユーザー情報を管理する親レコード。
**作成タイミング:** Phase 1開始時 (Status=PENDING) / Phase 5完了時更新 (Status=SUCCESS/FAILED)

| 属性名 | 型 | 値の例 | 説明 |
| :--- | :--- | :--- | :--- |
| **PK** | S | `TX#abc-123...` | C#で生成したUUID (TransactionID) |
| **SK** | S | `#SUMMARY` | 固定値 (検索用) |
| `UserID` | S | `user_001` | ユーザー識別子 |
| `Status` | S | `SUCCESS` / `FAILED` | 最終的な課金・処理ステータス |
| `Amount` | N | `100` | 課金金額 |
| `CreatedAt` | S | `2024-01-01T10:00:00Z` | 開始日時 (ISO8601) |
| `ErrorCode` | S | `E502` | 最終エラーコード (失敗時のみ) |

### B. フェーズ詳細ログレコード (Detail Logs)
各フェーズ（1〜5）の実行結果、AWSからのエラーレスポンス等を時系列で記録する子レコード。
**作成タイミング:** 各フェーズ終了時にLambda/C#から書き込み

| 属性名 | 型 | 値の例 | 説明 |
| :--- | :--- | :--- | :--- |
| **PK** | S | `TX#abc-123...` | 親と同じTransactionID |
| **SK** | S | `LOG#20240101-100005` | `LOG#` + タイムスタンプ |
| `Phase` | S | `PHASE3_GEN` | 実行フェーズ (1:URL, 2:Up, 3:Gen, 4:Down, 5:Bill) |
| `Level` | S | `INFO` / `ERROR` | ログレベル |
| `Message` | S | `Lambda Timeout (29s)` | 詳細メッセージやスタックトレース |

---

## 1.3 検索用インデックス (GSI) 設計

管理画面やAWSコンソールから、特定の切り口でデータを検索するための設定です。

### GSI-1: ユーザー履歴検索用 (UserHistoryIndex)
*   **用途:** 「ユーザーAさんの最近の利用履歴（成功・失敗含む）を見たい」
*   **Partition Key:** `UserID`
*   **Sort Key:** `CreatedAt`
*   **Projection:** `ALL` (または必要な属性のみ)

### GSI-2: ステータス・集計用 (StatusIndex)
*   **用途:** 「今日のエラー発生状況を見たい」「今月の課金成功分を集計したい」
*   **Partition Key:** `Status` (値: `SUCCESS`, `FAILED`)
*   **Sort Key:** `CreatedAt`
*   **Projection:** `KEYS_ONLY` または `Amount` を含む

---

# 2. 運用・サポートマニュアル

カスタマーサポートおよびシステム管理者が、ユーザーからの問い合わせに対応するための手順書です。

## 2.1 調査・検索手順

ユーザーから問い合わせがあった際、DynamoDBを検索して状況を特定するフローです。

1.  **AWSコンソール (DynamoDB) にアクセスする。**
2.  **「インデックスを使用してクエリ」を選択する。**
3.  **[GSI-1 (UserHistoryIndex)] を選択する。**
4.  **検索条件を入力する:**
    *   `UserID`: 問い合わせユーザーのID (メールアドレス等)
    *   ソート順: `降順` (新しい順)
5.  **結果を確認する:**
    *   直近のレコードの `Status` (SUCCESS/FAILED) を確認する。
    *   失敗している場合、その `PK` (TransactionID) をコピーし、メインテーブルを `PK` で検索し直して詳細ログ (`LOG#...`) を確認する。

---

## 2.2 ケース別対応フロー

本システムの仕様（リスク許容・ログ保存なし）に基づいた対応基準です。

### ケースA: 「エラーで止まった」との問い合わせ
*   **調査:** 上記手順でログを確認。
*   **原因:** Phase 3 (生成) での AWS Timeout や、Phase 4 (保存) でのディスク容量不足など。
*   **回答:**
    *   「サーバーが混み合っていたため処理が中断されました。課金は発生しておりませんので、再度お試しください。」
    *   （ディスク不足の場合）「PCの空き容量をご確認ください。」

### ケースB: 「画像は保存されたが、最後に『決済失敗』のエラーが出た」
*   **状況:** Phase 5 (課金) での通信エラー、またはトークン期限切れ。
*   **確認:** DynamoDBのステータスが `FAILED` であること。
*   **方針:** **課金漏れ（タダ乗り）を許容する仕様**です。
*   **回答:**
    *   「通信エラーにより決済処理が完了しませんでしたが、**生成された画像はそのままお使いいただいて問題ございません。**」
    *   ※後から請求を行ったり、画像を削除させたりはしない。

### ケースC: 「二重に請求されている気がする」
*   **状況:** C#のリトライ処理による重複懸念。
*   **確認:** DynamoDBのステータスが `SUCCESS` のレコードを確認。
*   **判定:**
    *   **TransactionIDが1つしかない場合:** システム的には1回のみ課金されています。ユーザーの勘違い、またはカード明細の速報反映ラグです。「システム上は1回のみの処理となっております」と回答。
    *   **TransactionIDが異なるレコードが複数ある場合:** ユーザーが「生成ボタン」を複数回クリックした（別取引としての成立）と判断されます。「別々の生成処理として承っております」と回答。

### ケースD: 「何もしていないのに『決済サーバーエラー』が頻発する」
*   **状況:** GSI-2 (StatusIndex) で `FAILED` が急増している場合。
*   **対応:**
    *   自社課金システム、またはAWS (Lambda/APIGW) の障害の可能性があります。
    *   開発チームへエスカレーションし、システム障害情報をアナウンスしてください。

---

## 2.3 月次集計・分析フロー

売上やエラー率を集計する場合の手順です。

1.  **GSI-2 (StatusIndex) を使用。**
2.  **検索条件:** `Status = SUCCESS` かつ `CreatedAt` が対象月の範囲。
3.  **集計:** 取得したレコードの `Amount` を合計する。
    *   ※件数が多い場合は、DynamoDBからS3へエクスポートし、Amazon Athena (SQL) で集計することを推奨。

@@----0222

### Step 1: アップロードURL発行時（並列処理の準備）

このタイミングで「今回は何枚処理するか」を宣言してしまいます。

**何を書き込むか (`UPDATE`)**:
* `status`: `URL_ISSUED`
* `total_items`: `3` （今回処理する枚数）
* `processed_items`: `0`

---

### Step 3: 画像生成処理（複数Lambdaが並列実行）

ここが最重要ポイントです。3つのLambdaが同時にDynamoDBを更新しにいく可能性があるため、**「条件付き更新（Conditional Update）」と「ADD演算子」**を使って、競合を防ぎつつカウントアップしていきます。

#### ① 各Lambdaの開始時
各Lambdaは開始時に `status` を無理に更新する必要はありません（3つ同時に走るため意味が薄いため）。 もし書くとしたら、CloudWatch ログの方に `transaction_id` と `image_id` をつけて開始ログを出すだけで十分です。

#### ② 各Lambdaの完了時（画像1枚出力ごとに実行）
画像の生成とS3への保存が終わったLambdaから順番に、以下のようにDynamoDBを更新します。

**何を書き込むか (`UpdateItem` 式)**:
1. `processed_items` を `+1` する（`ADD` 演算子を使用）
   ※ 単なる上書きではなく「現在の値に1を足す」というアトミック操作にすることで、複数Lambdaが同時更新しても正確にカウントされます。
2. `detail` に生成した画像のS3キーを追記する。

**同時に「すべて完了したか」を判定する**:
DynamoDBの `UpdateItem` リクエストは、「更新後の最新のレコード情報 (`ReturnValues="ALL_NEW"`)」 を返すことができます。 Lambda内でこの返り値を受け取り、以下の判定を行います。

```python
# 疑似コード
if updated_record['processed_items'] >= updated_record['total_items']:
    # ★ このLambdaが「最後の1枚」を完了させた！
    # status を PROCESSED に更新する
    update_status(transaction_id, 'PROCESSED')
```

---

### 結果としてどうなるか？

* **Lambda A が完了**: `processed_items` が `1` になる。（`1 >= 3` は `False` なので何もしない）
* **Lambda B が完了**: `processed_items` が `2` になる。（`2 >= 3` は `False` なので何もしない）
* **Lambda C が完了**: `processed_items` が `3` になる。
  **「3（完了） >= 3（合計）」になったので、このLambda Cが代表して `status` を `PROCESSED`（生成完了・課金待ち）に更新する！**

---

### なぜこの設計が良いのか？

1. **競合（レースコンディション）が起きない**: 
   DynamoDBの `ADD` を使うため、同時にLambdaが完了してもカウントがずれません。
2. **状態が明確になる**: 
   異常検知バッチを回したときに、「`status` はまだ `PROCESSED` になっていないが、`processed_items` は `2/3` で止まっているな」といった途中経過でのスタックダウンも詳細に把握できるようになります。
3. **Step4以降に影響を与えない**: 
   クライアントや課金Lambdaから見れば、最終的に `status` が `PROCESSED` になったことだけを確認すればよく、裏側が並列処理である複雑さを隠蔽できます。

```python
import boto3
from botocore.exceptions import ClientError

dynamodb = boto3.resource('dynamodb')
table = dynamodb.Table('TransactionStateTable')

def complete_image_generation(transaction_id: str, output_s3_key: str):
    """
    画像生成が1枚終わるごとに呼ばれる処理。
    自身をカウントアップし、「最後の1人」であれば全体ステータスを完了にする。
    """
    try:
        # 1. 自身の完了をアトミックに加算 (+1) する
        update_response = table.update_item(
            Key={'transaction_id': transaction_id},
            # SET ではなく ADD を使い、processed_items に :inc(つまり1) を足す
            # 完了したS3キーもリスト(またはセット)に追加しておく設計例
            UpdateExpression="ADD processed_items :inc SET detail.output_keys = list_append(if_not_exists(detail.output_keys, :empty_list), :new_key)",
            ExpressionAttributeValues={
                ':inc': 1,
                ':empty_list': [],
                ':new_key': [output_s3_key]
            },
            # ★重要★ 更新【後】の最新の全カラムデータを返してもらう
            ReturnValues="ALL_NEW"
        )
        
        # 2. 戻り値から、加算後の最新の数字を取り出す
        updated_record = update_response.get('Attributes', {})
        total = updated_record.get('total_items', 1) # Null対策
        processed = updated_record.get('processed_items', 0)
        
        print(f"Transaction: {transaction_id} - 進捗: {processed} / {total}")
        
        # 3. 自分が「最後の1人」だった場合の追加処理
        if processed >= total:
            print("すべての画像生成が完了しました。ステータスをPROCESSEDに更新します。")
            mark_transaction_as_processed(transaction_id)
            
    except ClientError as e:
        print(f"DynamoDB更新エラー: {e}")
        # 実際はここにエラー時のERRORステータス更新処理などを入れる
        raise

def mark_transaction_as_processed(transaction_id: str):
    """
    全体のステータスを「生成完了（PROCESSED）」に進める処理
    """
    table.update_item(
        Key={'transaction_id': transaction_id},
        UpdateExpression="SET #s = :status",
        ExpressionAttributeNames={
            '#s': 'status' # statusは予約語なのでエスケープ
        },
        ExpressionAttributeValues={
            ':status': 'PROCESSED'
        }
    )

# ---------
# 実行イメージ
# ---------
# Lambdaが処理を終えた最後に以下を実行
# complete_image_generation("tx-uuid-1234", "s3://my-bucket/outputs/image_2.jpg")

```
このコードのポイント（解説）
アトミックカウンター (ADD processed_items :inc) プログラム側で processed = current + 1 のような計算や読み込み（GetItem）を一切行っていません。DynamoDBのエンジン側に「今の数字に 1 を足して」とだけ伝えています。これにより、他Lambdaとの競合（レースコンディション）が絶対に起きません。
ReturnValues="ALL_NEW" を使う 足し算をした結果、DBの中に入っている数字が「今いくつになったのか」を、別通信で読み込み直すことなく、この戻り値で正確に知ることができます。
最後に自分が引導を渡す (if processed >= total:) 戻り値を見て、「あっ、自分の＋1のせいで、processed が total と同じ数字になったぞ！」と気づいたLambdaだけが、後段の mark_transaction_as_processed()（全体ステータスの更新）を呼び出します。（他の2つのLambdaは 1/3, 2/3 なのでこのif文に入らず、そのまま静かに終了します）。
この一連のシンプルなロジックだけで、並列分散システムにおける「処理の待ち合わせ（Join）」を安全かつ完璧に実装できます。

### 各ステップで何をログに出すべきか

**【Step 0】 残高確認Lambda**
* **INFO**: リクエスト受信（ユーザーID、リクエストされた枚数などを記録）
* **INFO**: 課金システムAPIへのリクエスト開始（`/api/v1/balance` 等の叩く先のURLを出す）
* **INFO**: 課金システムAPIからのレスポンス受信（HTTPステータスコード 200 や、確保した金額）
* **ERROR**: （万が一）残高不足だった場合の内容
* **INFO**: `transaction_id` の新規発行完了ログ

**【Step 1】 URL発行Lambda**
* **INFO**: URL発行リクエスト受信
* **INFO**: S3のPresigned URLをX件発行したという完了報告と、発行したS3キー（`inputs/tx-123.jpg`など）。※実際の長いURL文字列自体は出さなくてよい。

**【Step 3】 画像生成Lambda（※並列で走る一番重要な箇所）**
ここには処理の過程を細かく残します。万が一落ちたときに、自側（Lambda）の原因か、他側（fal.ai）の原因かを切り分けるためです。
* **INFO**: 処理開始（「3枚中X枚目の処理を開始します」など）
* **INFO**: fal.ai へのリクエスト送信（使用するモデル名、リクエストのパラメータ）
* **WARN/INFO**: fal.aiからの完了待ち（ポーリングしているなら「X秒待機中…」など）
* **INFO**: fal.ai からの生成成功レスポンス（取得できた画像URLなど）
* **ERROR**: fal.ai からの500エラーやタイムアウト時（返ってきたRawエラーメッセージをそのまま `detail` に突っ込む）
* **INFO**: S3への画像ダウンロード＆再アップロード完了（保存先のS3キー）
* **INFO**: DynamoDBへのアトミックカウントアップ(ADD)の実行結果（「現在 2/3完了」などの戻り値）

**【Step 5】 課金処理Lambda**
* **INFO**: 課金リクエスト受信（S3からのダウンロードが完了した報告）
* **INFO**: 自社課金システムへの本決済リクエスト送信
* **INFO**: 決済成功レスポンス（領収IDなど）
* **ERROR**: 決済システム側がダウンしている場合のエラー詳細

---

### なぜこのフォーマット（JSON + Transaction ID）で書くのか？

万が一、DynamoDBの監視バッチで「`tx-123` が Step3プロセスの途中でスタックして何時間も止まっている」というアラートがSlackに飛んできたとします。

運用担当者（あなた）は AWS コンソールを開き、CloudWatch Logs Insights の画面で以下のクエリを1行叩くだけで済みます。

```text
fields @timestamp, step, level, message, detail.error_reason
| filter transaction_id = "tx-123"
| sort @timestamp asc
```

すると、以下のような時系列ストーリーが全Lambdaの垣根を越えて一瞬で表示されます。

```text
18:00:00 [Step0] 残高確保しました（500円）
18:00:01 [Step1] S3アップロードURLを発行しました
18:00:10 [Step3] fal.aiへリクエストを開始（1枚目）
18:00:10 [Step3] fal.aiへリクエストを開始（2枚目）
18:00:12 [Step3] fal.aiへリクエストを開始（3枚目）
18:00:15 [Step3] 1枚目完了、S3へアップロード成功
18:00:18 [Step3] 3枚目完了、S3へアップロード成功
18:01:40 [Step3] ERROR: 2枚目のfal.aiリクエストがHTTP 504 Gateway Timeoutで失敗しました
```

「ああ、2枚目の画像生成の時にfal.ai側がタイムアウトしてエラー落ちしたせいで、DynamoDBのアトミックカウンターが3/3に到達せず、全体がスタックしていたんだな」 という原因が秒速で特定できます。

このように、**「DynamoDBで『誰が止まっているか』を見つけ、CloudWatchで『なぜ止まったか』を調べる」**という分業が、このアーキテクチャの監視における最大のベストプラクティスです。

----




1人につき1つのキーを作るとなると、**「えっ、お客さんが来るたびに私が手作業でポチポチ発行するの？1000人来たら過労死しない？」**と疑問に思いますよね。

実際の運用は、サービスの**「規模（ターゲット）」**によって、大きく2つのパターンに分かれます。

---

### パターン1：手作業での運用（スモールスタート・法人B2B向け）
最初はここから始めることが多いです。お客さんが数十社程度の規模なら、これで十分回ります。

1.  **申し込み：** お客さんから「無料プランを使いたいです」とWebフォームやメールで連絡が来る。
2.  **キー作成：** あなたがAWSの管理画面（コンソール）を開き、「APIキー作成」ボタンを押す。（名前はわかりやすく `CompanyA-Free` などにする）
3.  **紐付け：** そのキーを「無料の使用量プラン」にポチッと追加する。
4.  **お渡し：** 発行されたキー（例：`xyz123...`）をコピーして、お客さんにメールで「こちらのキーをお使いください」と送る。

---

### パターン2：完全自動化での運用（一般的なSaaS・Webサービス）
お客さんが何百人、何千人と増える場合、**手作業はゼロ**にします。
AWSの操作は、人間の手だけでなく**「プログラム（コード）から自動で操作できる」**ようになっています（これをAWS SDKと呼びます）。

お客さん用の「マイページ（ダッシュボード）」を作り、裏側でシステムにすべてやらせます。

1.  **自動発行：** お客さんがWebサイトで「無料会員登録」をすると、裏側のプログラムが自動でAWSに「APIキーを作って無料プランに入れて！」と命令を出し、数秒でお客さんの画面にキーを表示する。
2.  **有料への切り替え（アップグレード）：** お客さんが画面でクレジットカード決済を完了すると、プログラムが自動でAWSに「この人のキーを『無料プラン』から外し、『有料プラン』に付け替えて！」と命令する（※キーの文字列は同じままで、制限だけが解放されます）。
3.  **キーの再発行（漏えい対策）：** お客さんが「キーが外部に漏れちゃった！」という場合、マイページにある「キーを再生成する」ボタンを押すだけで、古いキーが即座に無効化され、新しいキーが発行される。

---

### 日常の「運用・管理」で管理者がやること（全体像）

システムを自動化してしまえば、あなた（管理者）が日常的にやることは**「監視」と「トラブル対応」**だけになります。

| 起きる出来事 | あなた（またはシステム）がやること |
| :--- | :--- |
| **無料枠を超えた人が出た** | API Gateway が勝手に「429 エラー（制限オーバー）」で弾いてくれるので、**あなたは何もしなくてOK**。 |
| **お客さんが退会した** | システムが自動的にその人の APIキーを「削除」または「無効（Inactive）」にする。これで一切アクセスできなくなります。 |
| **利用状況を見たい** | AWSの画面から「使用量プラン」を開けば、「誰のキーが、今月何回APIを叩いているか」のランキングやグラフが見られます。 |
| **ヤバい奴が現れた** | 「無料キーを大量に作って攻撃してくる奴がいる！」と気づいたら、AWS画面からそのキーを探して「無効化」ボタンを手動で押して即BAN（強制退場）させます。 |

---

### まとめ

運用はどうなるの？という疑問に対する答えは、以下のようになります。

*   **最初は：** あなたがAWS画面で「キー発行 ➔ プランに紐付け ➔ メールで送る」という手作業（アナログ運用）。
*   **本格稼働したら：** お客さんが使う「マイページ」を作り、会員登録から有料アップグレードまで、プログラムが自動でAWSのキーを操作する仕組みを作る（自動化運用）。

このように、**「APIキーのライフサイクル（発行・変更・停止・削除）をどう管理するか」**を設計するのが、APIビジネスの運用のキモになります！イメージ湧きましたでしょうか？




API Gatewayの「プロキシ統合」を使ってLambdaを呼び出した場合の、Python（Python 3.x）によるサンプルコードです。

このコードでは、**「無料プランならデータを3件だけ返す」「有料プランならデータを10件返す＋おまけ機能をつける」**という分岐処理を行っています。

### Lambda側のサンプルコード（Python）

```python
import json
import os

def lambda_handler(event, context):
    # 1. API Gatewayから渡された情報（requestContext）を取得
    request_context = event.get('requestContext', {})
    
    # 2. どの「使用量プラン（プランID）」でアクセスしてきたかを取得
    usage_plan_id = request_context.get('usagePlanId')
    
    # （おまけ）どのAPIキーが使われたかを取得（ログ用）
    identity = request_context.get('identity', {})
    api_key = identity.get('apiKey', 'unknown')
    print(f"Access from API Key: {api_key}, Plan ID: {usage_plan_id}")

    # 3. プランIDを変数にセット
    # ※実際の運用では、ID直書きではなくLambdaの「環境変数」に入れるのがベストです
    FREE_PLAN_ID = os.environ.get('FREE_PLAN_ID', 'plan-xxxxxx') # 無料プランのID
    PRO_PLAN_ID = os.environ.get('PRO_PLAN_ID', 'plan-yyyyyy')   # 有料プランのID

    # 4. プランによる分岐処理
    if usage_plan_id == FREE_PLAN_ID:
        # ▼ 無料プランのお客さんへの処理
        response_data = {
            "status": "success",
            "plan": "Free",
            "message": "無料プランのアクセスです。データは3件まで表示されます。",
            "results":["データ1", "データ2", "データ3"] # 制限されたデータ
        }
        
    elif usage_plan_id == PRO_PLAN_ID:
        # ▼ 有料プランのお客さんへの処理
        response_data = {
            "status": "success",
            "plan": "Pro",
            "message": "Proプランのご利用ありがとうございます！全データを出力します。",
            "results":["データ1", "データ2", "データ3", "データ4", "データ5"], # フルデータ
            "premium_feature": "有効" # 有料限定の項目
        }
        
    else:
        # ▼ プランが紐付いていない、または不明な場合（フェールセーフ）
        response_data = {
            "status": "error",
            "message": "プラン情報が特定できませんでした。"
        }
        return {
            "statusCode": 403,
            "body": json.dumps(response_data, ensure_ascii=False)
        }

    # 5. API Gatewayに結果を返す（お約束のフォーマット）
    return {
        "statusCode": 200,
        "headers": {
            "Content-Type": "application/json"
        },
        "body": json.dumps(response_data, ensure_ascii=False)
    }
```

### 実運用のための3つのポイント

#### 1. 情報の取り出し方
API Gatewayから送られてくる `event` データの中の `event['requestContext']['usagePlanId']` に、AWSで作成したプランのID（例：`abc1234` のような文字列）が入ってきます。これを見るだけで識別が完了します。

#### 2. プランIDは「環境変数」に入れるのがプロの書き方
コードの中に `FREE_PLAN_ID = "plan-abc123"` と直接書いてしまうと、AWS側でプランを作り直してIDが変わったときに、プログラムを書き直さなければいけません。
そのため、`os.environ.get()` を使い、**Lambdaの設定画面（環境変数）**にIDを登録しておくのが実務での一般的なやり方です。

#### 3. 返し方のルール（プロキシ統合）
API Gatewayにデータを返すときは、必ず以下のような「辞書（ディクショナリ）型」にして返すルールがあります。
*   `statusCode`: 成功(200)やエラー(400など)のHTTPステータス
*   `headers`: コンテンツの種類など
*   `body`: 返したい中身（**必ず `json.dumps()` で文字列に変換する**）

このコードをベースにすれば、「無料版は機能Aだけ」「有料版は機能Aと機能Bが使える」といったコントロールが簡単に実装できます！
