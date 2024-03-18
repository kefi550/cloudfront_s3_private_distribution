# private file distribution using cloudfront + s3


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
