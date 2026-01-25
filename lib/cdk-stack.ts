import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as logs from 'aws-cdk-lib/aws-logs';
import { RemovalPolicy } from 'aws-cdk-lib';
import { Construct } from 'constructs';

export class CdkStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    //ロググループ作成(自動作成の場合cdk destroyで消えないため)
    const log_group_functionName = 'test-lambda-function_cdk';
    const logGroup = new logs.LogGroup(this, 'TestFunctionLogGroup', {
      logGroupName: `/aws/lambda/${log_group_functionName}`,
      removalPolicy: RemovalPolicy.DESTROY, 
    });

    //Lambda作成
    const testFunction = new lambda.Function(this, 'TestFunction', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.lambda_handler', //エントリポイント
      code: lambda.Code.fromAsset('lambda/get_all_weather_public'), //対象のLambda
      functionName: 'test-lambda-function', // AWSコンソール上の表示名
      memorySize: 256,
      timeout: cdk.Duration.seconds(30), 
      logGroup: logGroup, // 明示的にロググループを渡す
    });


    // DynamoDB読み取り権限をLambda関数に付与
    const dynamoDbPolicy = new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'dynamodb:Scan',
        'dynamodb:GetItem'
      ],
      resources: [
        'arn:aws:dynamodb:*:*:table/simple-weather-news-table'
      ]
    });
    testFunction.addToRolePolicy(dynamoDbPolicy); //Day08-03

    // REST API Gatewayの定義
    const restApi = new apigateway.RestApi(this, 'test-rest-api-gateway-id', {
      restApiName: 'test-rest-api-gateway',
      description: 'test-rest-api-gateway',
      // デプロイオプション（ステージ名などを指定したい場合）
      deployOptions: {
        stageName: 'dev',
      },
    });

    // Lambda統合の設定
    const getAllIntegration = new apigateway.LambdaIntegration(testFunction);

    // endpoint_name エンドポイントの作成
    const allResource = restApi.root.addResource('endpoint_name');
    allResource.addMethod('GET', getAllIntegration);
  }
}
