import base64
import os
from datetime import datetime, timedelta

from aws_lambda_powertools.event_handler import APIGatewayHttpResolver, Response
from boto3 import client
from botocore.signers import CloudFrontSigner
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding
from jinja2 import Template

region = os.getenv('REGION')
domain_name = os.getenv('CLOUDFRONT_DOMAIN_NAME')
bucket = os.getenv('BUCKET_NAME')
cloudfront_key_id = os.getenv('CLOUDFRONT_SIGNING_PUBLIC_KEY_ID')
cloudfront_private_key_ssm_parameter_name = os.getenv('CLOUDFRONT_SIGNING_PRIVATE_KEY_SSM_PARAMETER_NAME')
auth_username_ssm_parameter_name = os.getenv('AUTH_USERNAME_SSM_PARAMETER_NAME')
auth_password_ssm_parameter_name = os.getenv('AUTH_PASSWORD_SSM_PARAMETER_NAME')


def get_secure_string_parameter(name):
    response = ssm.get_parameter(Name=name, WithDecryption=True)
    return response['Parameter']['Value']


def rsa_signer(message):
    private_key = serialization.load_pem_private_key(private_key_pem.encode(), password=None)
    return private_key.sign(message, padding.PKCS1v15(), hashes.SHA1())


app = APIGatewayHttpResolver()
s3 = client('s3', region_name=region)
ssm = client('ssm', region_name=region)
cloudfront_signer = CloudFrontSigner(cloudfront_key_id, rsa_signer)
auth_username = get_secure_string_parameter(auth_username_ssm_parameter_name)
auth_password = get_secure_string_parameter(auth_password_ssm_parameter_name)
private_key_pem = get_secure_string_parameter(cloudfront_private_key_ssm_parameter_name)


def list_s3_objects_by_prefix(prefix):
    response = s3.list_objects_v2(Bucket=bucket, Prefix=f'{prefix}/')
    # '/'で終わるものは除外
    objects = [obj['Key'].replace(f'{prefix}/', '') for obj in response.get('Contents', []) if not obj['Key'].endswith('/')]
    return objects


def get_prefix_list():
    response = s3.list_objects_v2(Bucket=bucket, Delimiter='/')
    prefixes = [prefix['Prefix'] for prefix in response.get('CommonPrefixes', [])]
    return prefixes


def sign_url(object_key):
    url = f'https://{domain_name}/{object_key}'
    expire_date = datetime.now() + timedelta(minutes=30)
    signed_url = cloudfront_signer.generate_presigned_url(url, date_less_than=expire_date)
    return signed_url


@app.get('/objects/.+/[^/]+')
def get_video():
    path = app.current_event.path
    s3_path = path.replace('/objects/', '')
    video_stream_template = """
        <video controls autoplay>
            <source src={{ video_url }}>
        </video>
    """
    video_url = sign_url(s3_path)
    html = Template(video_stream_template, autoescape=True).render(video_url=video_url)
    return Response(
        status_code=200,
        headers={
            "Content-Type": "text/html",
        },
        body=html,
    )


@app.get('/objects/.+/')
def list_objects_by_prefix():
    path = app.current_event.path
    prefix = path.replace('/objects/', '').rstrip('/')
    html_template = """
        <ul>
        {% for item in objects %}
            <li><a href=/objects/{{ prefix }}/{{ item }}>{{ item }}</a></li>
        {% endfor %}
        </ul>
    """
    try:
        objects = list_s3_objects_by_prefix(prefix)
        html = Template(html_template, autoescape=True).render(objects=objects, prefix=prefix)
        return Response(
            status_code=200,
            headers={
                "Content-Type": "text/html",
            },
            body=html,
        )
    except Exception as e:
        if 'NoSuchKey' in str(e):
            return "404 Not Found", 404


@app.get('/')
def index():
    html_template = """
        <ul>
        {% for prefix in prefixes %}
            <li><a href=/objects/{{ prefix }}>{{ prefix }}</a></li>
        {% endfor %}
        </ul>
    """
    prefixes = get_prefix_list()
    template = Template(html_template, autoescape=True)
    html = template.render(prefixes=prefixes)
    return Response(
        status_code=200,
        headers={
            "Content-Type": "text/html",
        },
        body=html,
    )


def check_authorization_header(headers: list) -> bool:
    if not headers:
        return False

    authorization_header = headers.get('Authorization') or headers.get('authorization')
    if not authorization_header:
        return False

    auth_type, encoded = authorization_header.split(' ')
    if auth_type.lower() != 'basic':
        return False

    decoded = base64.b64decode(encoded).decode('utf-8')
    username, password = decoded.split(':')

    if username != auth_username:
        return False

    if password != auth_password:
        return False

    return True


def handler(event, context):
    headers = event['headers']
    if not check_authorization_header(headers):
        return {
            'statusCode': 401,
            'body': 'Unauthorized',
            'headers': {
                'WWW-Authenticate': 'Basic',
            }
        }

    return app.resolve(event, context)
