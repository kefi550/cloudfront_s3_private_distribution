# private s3 media distributor

## Overview
A secure delivery system for files stored in a private S3 bucket, accessible through an authentication-required page.

## Preparation
- create a key pair for cloudfront signing

```sh
# private key
openssl genrsa -out private.pem 2048

# public key
openssl rsa -in private.pem -pubout --outform pem -out public.pem
```

- store the key pair to SSM parameter store
  - private key as SecureStringParameter
  - public key as StringParameter (for use from cdk)


# deploy

```
npm ci
npm run build
npm run cdk diff
npm run cdk deploy
```
