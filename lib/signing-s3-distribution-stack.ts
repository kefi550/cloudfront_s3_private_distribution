import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as cloudfrontOrigins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigwv2Integration from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as lambdaPython from '@aws-cdk/aws-lambda-python-alpha';

export interface SigningS3DistibutionStackProps extends cdk.StackProps {
  bucketName: string;
  signingPublicKeySsmParameterName: string;
  signingPrivateKeySsmParameterName: string;
  authUsernameSsmParameterName: string;
  authPasswordSsmParameterName: string;
  bucketRemovalPolicy?: cdk.RemovalPolicy;
  certificateArn?: string;
  distributionDomainName?: string;
  route53HostedZoneId?: string;
  route53HostedZoneName?: string;
  enableS3Logging?: boolean;
  enableCloudfrontLogging?: boolean;
}

export class SigningS3DistributionStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: SigningS3DistibutionStackProps) {
    super(scope, id, props);

    const useCustomRecord = this.checkIfUseCustomRecord(props);

    let certificate, domainNames;
    if (useCustomRecord && props.certificateArn && props.distributionDomainName) {
      certificate = acm.Certificate.fromCertificateArn(this, 'Certificate', props.certificateArn);
      domainNames = [props.distributionDomainName];
    }

    const bucket = new s3.Bucket(this, 'Bucket', {
      removalPolicy: props.bucketRemovalPolicy,
      bucketName: props.bucketName,
    });

    const publicKey = ssm.StringParameter.fromStringParameterAttributes(this, 'PublicKey', {
      parameterName: props.signingPublicKeySsmParameterName,
    });
    const cloudfrontPublicKey = new cloudfront.PublicKey(this, 'CloudfrontPublicKey', {
      encodedKey: publicKey.stringValue,
    });
    const keyGroup = new cloudfront.KeyGroup(this, 'KeyGroup', {
      items: [ cloudfrontPublicKey ],
    });

    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      defaultBehavior: {
        origin: new cloudfrontOrigins.S3Origin(bucket),
        trustedKeyGroups: [ keyGroup ],
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD_OPTIONS,
        compress: true,
      },
      domainNames,
      certificate,
      enableLogging: props.enableCloudfrontLogging ? true : false,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
    });

    const oac = new cloudfront.CfnOriginAccessControl(this, 'OAC', {
      // https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-properties-cloudfront-originaccesscontrol-originaccesscontrolconfig.html#cfn-cloudfront-originaccesscontrol-originaccesscontrolconfig-signingbehavior
      originAccessControlConfig: {
        name: `${this.stackName}-oac`,
        originAccessControlOriginType: "s3",
        signingBehavior: "always",
        signingProtocol: "sigv4",
      }
    });

    // remove OAI settings that are automatically created and add OAC
    const cfnDistribution = distribution.node.defaultChild as cloudfront.CfnDistribution;
    cfnDistribution.addPropertyOverride('DistributionConfig.Origins.0.S3OriginConfig.OriginAccessIdentity', '');
    cfnDistribution.addPropertyOverride('DistributionConfig.Origins.0.OriginAccessControlId', oac.getAtt('Id').toString());

    const bucketPolicyForOAC = new iam.PolicyStatement({
      actions: ['s3:GetObject'],
      effect: iam.Effect.ALLOW,
      principals: [ new iam.ServicePrincipal('cloudfront.amazonaws.com') ],
      resources: [bucket.arnForObjects('*')],
      conditions: {
        "StringEquals": {
          'AWS:SourceArn': `arn:aws:cloudfront::${this.account}:distribution/${distribution.distributionId}`,
        },
      }
    });
    bucket.addToResourcePolicy(bucketPolicyForOAC);

    if ( useCustomRecord && props.route53HostedZoneId && props.route53HostedZoneName ) {
      const hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
        hostedZoneId: props.route53HostedZoneId,
        zoneName: props.route53HostedZoneName,
      });
      new route53.ARecord(this, 'Record', {
        zone: hostedZone,
        target: route53.RecordTarget.fromAlias(new route53Targets.CloudFrontTarget(distribution)),
        recordName: props.distributionDomainName,
      });
    }

    const lambdaFunction = new lambdaPython.PythonFunction(this, 'LambdaFunction', {
      runtime: lambda.Runtime.PYTHON_3_11,
      handler: 'handler',
      entry: 'lambda/python',
      index: 'main.py',
      bundling: {
        assetExcludes: ['.venv'],
      },
      environment: {
        BUCKET_NAME: props.bucketName,
        CLOUDFRONT_SIGNING_PRIVATE_KEY_SSM_PARAMETER_NAME: props.signingPrivateKeySsmParameterName,
        REGION: this.region,
        CLOUDFRONT_DOMAIN_NAME: props.distributionDomainName || distribution.distributionDomainName,
        CLOUDFRONT_SIGNING_PUBLIC_KEY_ID: cloudfrontPublicKey.publicKeyId,
        AUTH_USERNAME_SSM_PARAMETER_NAME: props.authUsernameSsmParameterName,
        AUTH_PASSWORD_SSM_PARAMETER_NAME: props.authPasswordSsmParameterName,
      }
    });
    bucket.grantRead(lambdaFunction);

    lambdaFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cloudfront:GetPublicKey'],
      effect: iam.Effect.ALLOW,
      resources: ["*"],
    }));
    lambdaFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter'],
      effect: iam.Effect.ALLOW,
      resources: [
        `arn:aws:ssm:${this.region}:${this.account}:parameter${props.signingPrivateKeySsmParameterName}`,
        `arn:aws:ssm:${this.region}:${this.account}:parameter${props.authUsernameSsmParameterName}`,
        `arn:aws:ssm:${this.region}:${this.account}:parameter${props.authPasswordSsmParameterName}`,
      ],
    }));

    const api = new apigwv2.HttpApi(this, 'HttpApi', {
      defaultIntegration: new apigwv2Integration.HttpLambdaIntegration('lambdaIntegration', lambdaFunction),
    });
  }

  private checkIfUseCustomRecord(props: SigningS3DistibutionStackProps): boolean {
    if (props.certificateArn && props.distributionDomainName && props.route53HostedZoneId && props.route53HostedZoneName) {
      return true;
    } else if (props.certificateArn || props.distributionDomainName || props.route53HostedZoneId || props.route53HostedZoneName) {
      console.log('Warning: When setting an alternate domain name on a CloudFront distribution, all parameters certificateArn, distributionDomainName, route53HostedZoneId, and route53HostedZoneName must be specified.');
    }
    return false;
  } 
}
