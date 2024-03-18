#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { SigningS3DistributionStack } from '../lib/signing-s3-distribution-stack';

const app = new cdk.App();
new SigningS3DistributionStack(app, 'RingVideoDistributionStack', {
  bucketName: "kefi550-ring-video",
  bucketRemovalPolicy: cdk.RemovalPolicy.RETAIN,
  signingPublicKeySsmParameterName: '/ring-video-distribution/cloudfront-public-key',
  certificateArn: "arn:aws:acm:us-east-1:793529295184:certificate/8e9be9db-653c-4238-92bf-107f470b2612",
  distributionDomainName: "ring-distribution.kefiwild.com",
  route53HostedZoneId: "Z3G68JQJMVBLGU",
  route53HostedZoneName: "kefiwild.com",
});
