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

export interface SigningS3DistibutionStackProps extends cdk.StackProps {
  bucketName: string;
  signingPublicKeySsmParameterName: string;
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

    // 自動で作成されるOAI設定を削除しOACを追加する
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
