#!/usr/bin/env bash
# =============================================================================
# deploy-web.sh — provision the public Web tier for the DSH BFF.
#
# Reproduces the Phase-2 Web deployment recorded in config/deployment-env.md:
#   1. Cognito User Pool + confidential app client (USER_PASSWORD_AUTH + REFRESH);
#      client secret -> Secrets Manager
#   2. test user(s) with generated passwords -> Secrets Manager (never printed)
#   3. DynamoDB Session Directory table (PK/SK String, PAY_PER_REQUEST)
#   4. BFF secrets (session-cookie / memory-key / origin-verify) -> Secrets Manager
#   5. ECR repo + build/push the BFF image (needs web-bff/static/ staged first)
#   6. least-privilege task role (InvokeAgentRuntime on THIS runtime + DynamoDB on
#      THIS table) and execution role (ECR pull + logs + secrets get, scoped)
#   7. ECS cluster
#   8. ALB (inbound SG = CloudFront prefix list only) + target group (/healthz)
#      + listener; ECS SG admits only the ALB SG
#   9. CloudFront distribution (origin = ALB HTTP-only + X-Origin-Verify header;
#      viewer redirect-to-https; CachingDisabled; AllViewer forwarding)
#  10. ECS task def (arm64, env + secret refs, ALLOWED_ORIGINS = CloudFront URL)
#      + service (private subnets, ECS SG, attached to the target group)
#
# ORDERING NOTE: ALB + CloudFront are created BEFORE the ECS task def/service so
# ALLOWED_ORIGINS can be set to the real CloudFront URL. (deployment-env.md lists
# ECS before CloudFront because that deploy patched the task def afterwards; this
# script resolves the dependency up-front so a from-zero run works.)
#
# Idempotent where APIs allow. Steps flagged "NOT idempotent" (Cognito user pool,
# CloudFront distribution) create a new resource on each run unless a matching one
# is detected — read the inline notes. Secrets/passwords never printed or committed.
#
# Reads scripts/deploy.env (gitignored) if present. See scripts/deploy.env.example.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
BFF_DIR="${PROJECT_ROOT}/web-bff"
[ -f "${SCRIPT_DIR}/deploy.env" ] && source "${SCRIPT_DIR}/deploy.env"

: "${AWS_REGION:?}" ; : "${ACCOUNT_ID:?}"
: "${RUNTIME_ARN:?set RUNTIME_ARN (output of deploy-runtime.sh)}"
: "${COGNITO_POOL_NAME:?}" ; : "${COGNITO_CLIENT_NAME:?}" ; : "${TEST_USER_EMAILS:?}"
: "${DDB_TABLE:?}" ; : "${TENANT_ID:?}"
: "${COGNITO_CLIENT_SECRET_NAME:?}" ; : "${COGNITO_TEST_USERS_SECRET:?}"
: "${BFF_SESSION_COOKIE_SECRET_NAME:?}" ; : "${BFF_MEMORY_KEY_SECRET_NAME:?}" ; : "${BFF_ORIGIN_VERIFY_SECRET_NAME:?}"
: "${ECR_BFF_REPO:?}" ; : "${BFF_IMAGE_TAG:?}"
: "${ECS_CLUSTER:?}" ; : "${ECS_SERVICE:?}" ; : "${ECS_TASK_FAMILY:?}"
: "${ECS_EXEC_ROLE_NAME:?}" ; : "${ECS_TASK_ROLE_NAME:?}"
: "${ALB_NAME:?}" ; : "${TG_NAME:?}" ; : "${BFF_CONTAINER_PORT:?}" ; : "${BFF_LOG_GROUP:?}"
: "${CLOUDFRONT_PREFIX_LIST_ID:?}" ; : "${CLOUDFRONT_COMMENT:?}"
: "${WEB_VPC_ID:?}" ; : "${ALB_SUBNET_IDS:?}" ; : "${ECS_SUBNET_IDS:?}"

AWS=(aws --region "${AWS_REGION}")
ECR_URI="${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${ECR_BFF_REPO}"
IMAGE_URI="${ECR_URI}:${BFF_IMAGE_TAG}"

# --- helper: create-or-get a Secrets Manager secret; echoes its ARN ----------
put_secret() {  # $1 name  $2 value
  local name="$1" value="$2" arn
  if arn=$("${AWS[@]}" secretsmanager describe-secret --secret-id "${name}" \
        --query ARN --output text 2>/dev/null); then
    "${AWS[@]}" secretsmanager put-secret-value --secret-id "${name}" \
      --secret-string "${value}" >/dev/null
  else
    arn=$("${AWS[@]}" secretsmanager create-secret --name "${name}" \
      --secret-string "${value}" --query ARN --output text)
  fi
  echo "${arn}"
}

echo "== 1. Cognito user pool + confidential app client =="
# NOT idempotent by name — reuse if a pool with this name already exists.
POOL_ID=$("${AWS[@]}" cognito-idp list-user-pools --max-results 60 \
  --query "UserPools[?Name=='${COGNITO_POOL_NAME}'].Id | [0]" --output text 2>/dev/null || echo "None")
if [ "${POOL_ID}" = "None" ] || [ -z "${POOL_ID}" ]; then
  POOL_ID=$("${AWS[@]}" cognito-idp create-user-pool --pool-name "${COGNITO_POOL_NAME}" \
    --username-attributes email --auto-verified-attributes email \
    --query UserPool.Id --output text)
  echo "created user pool ${POOL_ID}"
else
  echo "reusing user pool ${POOL_ID}"
fi
CLIENT_ID=$("${AWS[@]}" cognito-idp list-user-pool-clients --user-pool-id "${POOL_ID}" \
  --max-results 60 --query "UserPoolClients[?ClientName=='${COGNITO_CLIENT_NAME}'].ClientId | [0]" \
  --output text 2>/dev/null || echo "None")
if [ "${CLIENT_ID}" = "None" ] || [ -z "${CLIENT_ID}" ]; then
  CLIENT_ID=$("${AWS[@]}" cognito-idp create-user-pool-client --user-pool-id "${POOL_ID}" \
    --client-name "${COGNITO_CLIENT_NAME}" --generate-secret \
    --explicit-auth-flows ALLOW_USER_PASSWORD_AUTH ALLOW_REFRESH_TOKEN_AUTH \
    --query UserPoolClient.ClientId --output text)
  echo "created app client ${CLIENT_ID}"
else
  echo "reusing app client ${CLIENT_ID}"
fi
CLIENT_SECRET=$("${AWS[@]}" cognito-idp describe-user-pool-client --user-pool-id "${POOL_ID}" \
  --client-id "${CLIENT_ID}" --query UserPoolClient.ClientSecret --output text)
COGNITO_SECRET_ARN=$(put_secret "${COGNITO_CLIENT_SECRET_NAME}" "${CLIENT_SECRET}")
echo "client secret stored at ${COGNITO_SECRET_ARN}"

echo "== 2. test users (passwords generated, stored in Secrets Manager only) =="
TEST_USERS_JSON=""
IFS=',' read -ra EMAILS <<< "${TEST_USER_EMAILS}"
for email in "${EMAILS[@]}"; do
  email="$(echo "${email}" | xargs)"   # trim
  [ -z "${email}" ] && continue
  # Strong password: satisfy default Cognito policy. Not echoed anywhere.
  pw="$(openssl rand -base64 18)Aa1!"
  "${AWS[@]}" cognito-idp admin-create-user --user-pool-id "${POOL_ID}" \
    --username "${email}" --message-action SUPPRESS \
    --user-attributes Name=email,Value="${email}" Name=email_verified,Value=true >/dev/null 2>&1 || true
  "${AWS[@]}" cognito-idp admin-set-user-password --user-pool-id "${POOL_ID}" \
    --username "${email}" --password "${pw}" --permanent >/dev/null
  TEST_USERS_JSON="${TEST_USERS_JSON}{\"username\":\"${email}\",\"password\":\"${pw}\"}
"
done
# Store as JSON-lines in Secrets Manager (matches deployment-env.md's format).
TEST_USERS_ARN=$(put_secret "${COGNITO_TEST_USERS_SECRET}" "${TEST_USERS_JSON}")
echo "test-user credentials stored at ${TEST_USERS_ARN}"

echo "== 3. DynamoDB Session Directory table =="
if ! "${AWS[@]}" dynamodb describe-table --table-name "${DDB_TABLE}" >/dev/null 2>&1; then
  "${AWS[@]}" dynamodb create-table --table-name "${DDB_TABLE}" \
    --attribute-definitions AttributeName=PK,AttributeType=S AttributeName=SK,AttributeType=S \
    --key-schema AttributeName=PK,KeyType=HASH AttributeName=SK,KeyType=RANGE \
    --billing-mode PAY_PER_REQUEST >/dev/null
  "${AWS[@]}" dynamodb wait table-exists --table-name "${DDB_TABLE}"
  echo "created table ${DDB_TABLE}"
else
  echo "table ${DDB_TABLE} exists"
fi

echo "== 4. BFF secrets (generated) =="
COOKIE_ARN=$(put_secret "${BFF_SESSION_COOKIE_SECRET_NAME}" "$(openssl rand -hex 32)")
MEMORY_ARN=$(put_secret "${BFF_MEMORY_KEY_SECRET_NAME}" "$(openssl rand -hex 32)")
ORIGIN_VERIFY_VALUE="$(openssl rand -hex 32)"
ORIGIN_ARN=$(put_secret "${BFF_ORIGIN_VERIFY_SECRET_NAME}" "${ORIGIN_VERIFY_VALUE}")
# Re-read origin-verify so CloudFront's custom-header value matches what the BFF
# will validate (handles the reuse case where a value already existed).
ORIGIN_VERIFY_VALUE=$("${AWS[@]}" secretsmanager get-secret-value \
  --secret-id "${BFF_ORIGIN_VERIFY_SECRET_NAME}" --query SecretString --output text)
echo "bff secrets: ${COOKIE_ARN} ${MEMORY_ARN} ${ORIGIN_ARN}"

echo "== 5. build + push BFF image ${IMAGE_URI} =="
# The image bakes the DSH Web UI static closure (web-bff/static/, a gitignored
# derived artifact). Capture it from `dsh web` when it is missing, or whenever
# CAPTURE_STATIC=true forces a refresh. See web-bff/capture-static.mjs.
if [ "${CAPTURE_STATIC:-false}" = "true" ] || [ ! -f "${BFF_DIR}/static/index.html" ]; then
  if [ -z "${DSH_REPO_ROOT:-}" ]; then
    echo "ERROR: web-bff/static/ must be (re)generated but DSH_REPO_ROOT is unset."
    echo "       Point DSH_REPO_ROOT at the built DSH monorepo checkout and re-run,"
    echo "       or stage web-bff/static/ manually per web-bff/README.md."
    exit 1
  fi
  echo "capturing DSH web static closure into ${BFF_DIR}/static (DSH_REPO_ROOT=${DSH_REPO_ROOT})"
  DSH_REPO_ROOT="${DSH_REPO_ROOT}" node "${BFF_DIR}/capture-static.mjs"
fi
if [ ! -f "${BFF_DIR}/static/index.html" ]; then
  echo "ERROR: web-bff/static/ is still missing (gitignored derived DSH web closure)."
  echo "       Regenerate it: DSH_REPO_ROOT=<dsh-repo> node web-bff/capture-static.mjs"
  echo "       (or set CAPTURE_STATIC=true with DSH_REPO_ROOT and re-run this script)."
  exit 1
fi
if ! "${AWS[@]}" ecr describe-repositories --repository-names "${ECR_BFF_REPO}" >/dev/null 2>&1; then
  "${AWS[@]}" ecr create-repository --repository-name "${ECR_BFF_REPO}" \
    --image-scanning-configuration scanOnPush=true >/dev/null
  echo "created ECR repo ${ECR_BFF_REPO}"
fi
"${AWS[@]}" ecr get-login-password | docker login --username AWS --password-stdin \
  "${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"
docker build --platform linux/arm64 -t "${IMAGE_URI}" "${BFF_DIR}"
docker push "${IMAGE_URI}"

echo "== 6. IAM roles =="
ECS_TRUST='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ecs-tasks.amazonaws.com"},"Action":"sts:AssumeRole"}]}'

# --- task role: InvokeAgentRuntime on THIS runtime (+ endpoint) + DDB on table ---
TASK_ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${ECS_TASK_ROLE_NAME}"
TASK_POLICY=$(cat <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "InvokeThisRuntime",
      "Effect": "Allow",
      "Action": ["bedrock-agentcore:InvokeAgentRuntime"],
      "Resource": ["${RUNTIME_ARN}", "${RUNTIME_ARN}/runtime-endpoint/*"]
    },
    {
      "Sid": "SessionDirectory",
      "Effect": "Allow",
      "Action": ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Query", "dynamodb:UpdateItem"],
      "Resource": "arn:aws:dynamodb:${AWS_REGION}:${ACCOUNT_ID}:table/${DDB_TABLE}"
    }
  ]
}
JSON
)
if ! "${AWS[@]}" iam get-role --role-name "${ECS_TASK_ROLE_NAME}" >/dev/null 2>&1; then
  "${AWS[@]}" iam create-role --role-name "${ECS_TASK_ROLE_NAME}" \
    --assume-role-policy-document "${ECS_TRUST}" >/dev/null
fi
"${AWS[@]}" iam put-role-policy --role-name "${ECS_TASK_ROLE_NAME}" \
  --policy-name "dsh-bff-task" --policy-document "${TASK_POLICY}" >/dev/null

# --- execution role: ECR pull (scoped) + logs (scoped) + secrets get (4 secrets) ---
EXEC_ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${ECS_EXEC_ROLE_NAME}"
EXEC_POLICY=$(cat <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "EcrAuthToken",
      "Effect": "Allow",
      "Action": "ecr:GetAuthorizationToken",
      "Resource": "*"
    },
    {
      "Sid": "EcrPullThisRepo",
      "Effect": "Allow",
      "Action": ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer", "ecr:BatchCheckLayerAvailability"],
      "Resource": "arn:aws:ecr:${AWS_REGION}:${ACCOUNT_ID}:repository/${ECR_BFF_REPO}"
    },
    {
      "Sid": "Logs",
      "Effect": "Allow",
      "Action": ["logs:CreateLogStream", "logs:PutLogEvents"],
      "Resource": "arn:aws:logs:${AWS_REGION}:${ACCOUNT_ID}:log-group:${BFF_LOG_GROUP}:*"
    },
    {
      "Sid": "SecretsForInjection",
      "Effect": "Allow",
      "Action": "secretsmanager:GetSecretValue",
      "Resource": ["${COOKIE_ARN}", "${MEMORY_ARN}", "${ORIGIN_ARN}", "${COGNITO_SECRET_ARN}"]
    }
  ]
}
JSON
)
if ! "${AWS[@]}" iam get-role --role-name "${ECS_EXEC_ROLE_NAME}" >/dev/null 2>&1; then
  "${AWS[@]}" iam create-role --role-name "${ECS_EXEC_ROLE_NAME}" \
    --assume-role-policy-document "${ECS_TRUST}" >/dev/null
fi
"${AWS[@]}" iam put-role-policy --role-name "${ECS_EXEC_ROLE_NAME}" \
  --policy-name "dsh-bff-exec" --policy-document "${EXEC_POLICY}" >/dev/null
echo "task role ${TASK_ROLE_ARN}; execution role ${EXEC_ROLE_ARN}"

echo "== 7. ECS cluster + log group =="
"${AWS[@]}" ecs create-cluster --cluster-name "${ECS_CLUSTER}" >/dev/null 2>&1 || true
"${AWS[@]}" logs create-log-group --log-group-name "${BFF_LOG_GROUP}" >/dev/null 2>&1 || true
"${AWS[@]}" logs put-retention-policy --log-group-name "${BFF_LOG_GROUP}" --retention-in-days 30 >/dev/null 2>&1 || true

echo "== 8. security groups + ALB + target group + listener =="
# ALB SG: inbound 80 ONLY from the CloudFront managed prefix list (no 0.0.0.0/0).
ALB_SG=$("${AWS[@]}" ec2 describe-security-groups \
  --filters "Name=group-name,Values=${ALB_NAME}-sg" "Name=vpc-id,Values=${WEB_VPC_ID}" \
  --query "SecurityGroups[0].GroupId" --output text 2>/dev/null || echo "None")
if [ "${ALB_SG}" = "None" ] || [ -z "${ALB_SG}" ]; then
  ALB_SG=$("${AWS[@]}" ec2 create-security-group --group-name "${ALB_NAME}-sg" \
    --description "DSH BFF ALB SG (CloudFront prefix list only)" --vpc-id "${WEB_VPC_ID}" \
    --query GroupId --output text)
  "${AWS[@]}" ec2 authorize-security-group-ingress --group-id "${ALB_SG}" \
    --ip-permissions "IpProtocol=tcp,FromPort=80,ToPort=80,PrefixListIds=[{PrefixListId=${CLOUDFRONT_PREFIX_LIST_ID}}]" >/dev/null
fi
# ECS SG: inbound container port ONLY from the ALB SG.
ECS_SG=$("${AWS[@]}" ec2 describe-security-groups \
  --filters "Name=group-name,Values=${ECS_SERVICE}-sg" "Name=vpc-id,Values=${WEB_VPC_ID}" \
  --query "SecurityGroups[0].GroupId" --output text 2>/dev/null || echo "None")
if [ "${ECS_SG}" = "None" ] || [ -z "${ECS_SG}" ]; then
  ECS_SG=$("${AWS[@]}" ec2 create-security-group --group-name "${ECS_SERVICE}-sg" \
    --description "DSH BFF ECS SG (ALB only)" --vpc-id "${WEB_VPC_ID}" --query GroupId --output text)
  "${AWS[@]}" ec2 authorize-security-group-ingress --group-id "${ECS_SG}" \
    --ip-permissions "IpProtocol=tcp,FromPort=${BFF_CONTAINER_PORT},ToPort=${BFF_CONTAINER_PORT},UserIdGroupPairs=[{GroupId=${ALB_SG}}]" >/dev/null
fi

TG_ARN=$("${AWS[@]}" elbv2 describe-target-groups --names "${TG_NAME}" \
  --query "TargetGroups[0].TargetGroupArn" --output text 2>/dev/null || echo "None")
if [ "${TG_ARN}" = "None" ] || [ -z "${TG_ARN}" ]; then
  TG_ARN=$("${AWS[@]}" elbv2 create-target-group --name "${TG_NAME}" \
    --protocol HTTP --port "${BFF_CONTAINER_PORT}" --vpc-id "${WEB_VPC_ID}" \
    --target-type ip --health-check-path "/healthz" \
    --query "TargetGroups[0].TargetGroupArn" --output text)
fi
ALB_ARN=$("${AWS[@]}" elbv2 describe-load-balancers --names "${ALB_NAME}" \
  --query "LoadBalancers[0].LoadBalancerArn" --output text 2>/dev/null || echo "None")
if [ "${ALB_ARN}" = "None" ] || [ -z "${ALB_ARN}" ]; then
  ALB_ARN=$("${AWS[@]}" elbv2 create-load-balancer --name "${ALB_NAME}" \
    --scheme internet-facing --type application --subnets ${ALB_SUBNET_IDS} \
    --security-groups "${ALB_SG}" --query "LoadBalancers[0].LoadBalancerArn" --output text)
fi
ALB_DNS=$("${AWS[@]}" elbv2 describe-load-balancers --load-balancer-arns "${ALB_ARN}" \
  --query "LoadBalancers[0].DNSName" --output text)
# HTTP:80 listener -> TG (idempotent: create only if none on :80).
if ! "${AWS[@]}" elbv2 describe-listeners --load-balancer-arn "${ALB_ARN}" \
     --query "Listeners[?Port==\`80\`]" --output text | grep -q .; then
  "${AWS[@]}" elbv2 create-listener --load-balancer-arn "${ALB_ARN}" \
    --protocol HTTP --port 80 \
    --default-actions "Type=forward,TargetGroupArn=${TG_ARN}" >/dev/null
fi
echo "ALB ${ALB_DNS} (SG ${ALB_SG}); TG ${TG_ARN}; ECS SG ${ECS_SG}"

echo "== 9. CloudFront distribution =="
# NOT idempotent — create-distribution makes a new one every run. Reuse if one
# with this comment already exists.
DIST_ID=$("${AWS[@]}" cloudfront list-distributions \
  --query "DistributionList.Items[?Comment=='${CLOUDFRONT_COMMENT}'].Id | [0]" \
  --output text 2>/dev/null || echo "None")
if [ "${DIST_ID}" = "None" ] || [ -z "${DIST_ID}" ]; then
  CALLER_REF="dsh-bff-$(date +%s)"
  DIST_CONFIG=$(cat <<JSON
{
  "CallerReference": "${CALLER_REF}",
  "Comment": "${CLOUDFRONT_COMMENT}",
  "Enabled": true,
  "Origins": {
    "Quantity": 1,
    "Items": [
      {
        "Id": "alb-origin",
        "DomainName": "${ALB_DNS}",
        "CustomOriginConfig": {
          "HTTPPort": 80,
          "HTTPSPort": 443,
          "OriginProtocolPolicy": "http-only",
          "OriginSslProtocols": { "Quantity": 1, "Items": ["TLSv1.2"] }
        },
        "CustomHeaders": {
          "Quantity": 1,
          "Items": [
            { "HeaderName": "X-Origin-Verify", "HeaderValue": "${ORIGIN_VERIFY_VALUE}" }
          ]
        }
      }
    ]
  },
  "DefaultCacheBehavior": {
    "TargetOriginId": "alb-origin",
    "ViewerProtocolPolicy": "redirect-to-https",
    "AllowedMethods": {
      "Quantity": 7,
      "Items": ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"],
      "CachedMethods": { "Quantity": 2, "Items": ["GET", "HEAD"] }
    },
    "Compress": false,
    "CachePolicyId": "4135ea2d-6df8-44a3-9df3-4b5a84be39ad",
    "OriginRequestPolicyId": "216adef6-5c7f-47e4-b989-5492eafa07d3"
  }
}
JSON
)
  read -r DIST_ID CF_DOMAIN < <("${AWS[@]}" cloudfront create-distribution \
    --distribution-config "${DIST_CONFIG}" \
    --query "[Distribution.Id, Distribution.DomainName]" --output text)
  echo "created CloudFront ${DIST_ID}"
else
  CF_DOMAIN=$("${AWS[@]}" cloudfront get-distribution --id "${DIST_ID}" \
    --query "Distribution.DomainName" --output text)
  echo "reusing CloudFront ${DIST_ID}"
fi
CLOUDFRONT_URL="https://${CF_DOMAIN}"
echo "CloudFront URL: ${CLOUDFRONT_URL}"

echo "== 10. ECS task definition + service =="
# Secret ARNs use versionless base ARNs; ECS resolves JSON keys via :key:: syntax
# if needed — here each secret's whole string is one value.
TASKDEF_FILE="$(mktemp)"
cat > "${TASKDEF_FILE}" <<JSON
{
  "family": "${ECS_TASK_FAMILY}",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "${ECS_TASK_CPU:-512}",
  "memory": "${ECS_TASK_MEMORY:-1024}",
  "runtimePlatform": { "cpuArchitecture": "ARM64", "operatingSystemFamily": "LINUX" },
  "executionRoleArn": "${EXEC_ROLE_ARN}",
  "taskRoleArn": "${TASK_ROLE_ARN}",
  "containerDefinitions": [
    {
      "name": "dsh-bff",
      "image": "${IMAGE_URI}",
      "essential": true,
      "portMappings": [ { "containerPort": ${BFF_CONTAINER_PORT}, "protocol": "tcp" } ],
      "environment": [
        { "name": "AWS_REGION", "value": "${AWS_REGION}" },
        { "name": "ALLOWED_ORIGINS", "value": "${CLOUDFRONT_URL}" },
        { "name": "COOKIE_SECURE", "value": "true" },
        { "name": "RUNTIME_ARN", "value": "${RUNTIME_ARN}" },
        { "name": "RUNTIME_QUALIFIER", "value": "DEFAULT" },
        { "name": "DDB_TABLE", "value": "${DDB_TABLE}" },
        { "name": "COGNITO_POOL_ID", "value": "${POOL_ID}" },
        { "name": "COGNITO_CLIENT_ID", "value": "${CLIENT_ID}" },
        { "name": "TENANT_ID", "value": "${TENANT_ID}" },
        { "name": "STATIC_DIR", "value": "/app/static" }
      ],
      "secrets": [
        { "name": "SESSION_COOKIE_SECRET", "valueFrom": "${COOKIE_ARN}" },
        { "name": "MEMORY_KEY", "valueFrom": "${MEMORY_ARN}" },
        { "name": "ORIGIN_VERIFY_SECRET", "valueFrom": "${ORIGIN_ARN}" },
        { "name": "COGNITO_CLIENT_SECRET", "valueFrom": "${COGNITO_SECRET_ARN}" }
      ],
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "${BFF_LOG_GROUP}",
          "awslogs-region": "${AWS_REGION}",
          "awslogs-stream-prefix": "dsh-bff"
        }
      }
    }
  ]
}
JSON
TASKDEF_ARN=$("${AWS[@]}" ecs register-task-definition --cli-input-json "file://${TASKDEF_FILE}" \
  --query "taskDefinition.taskDefinitionArn" --output text)
rm -f "${TASKDEF_FILE}"
echo "registered task def ${TASKDEF_ARN}"

NET_CONFIG="awsvpcConfiguration={subnets=[$(echo ${ECS_SUBNET_IDS} | tr ' ' ',')],securityGroups=[${ECS_SG}],assignPublicIp=DISABLED}"
if "${AWS[@]}" ecs describe-services --cluster "${ECS_CLUSTER}" --services "${ECS_SERVICE}" \
     --query "services[?status=='ACTIVE'] | [0]" --output text 2>/dev/null | grep -q .; then
  echo "service exists -> update to new task def (force new deployment)"
  "${AWS[@]}" ecs update-service --cluster "${ECS_CLUSTER}" --service "${ECS_SERVICE}" \
    --task-definition "${TASKDEF_ARN}" --force-new-deployment >/dev/null
else
  "${AWS[@]}" ecs create-service --cluster "${ECS_CLUSTER}" --service-name "${ECS_SERVICE}" \
    --task-definition "${TASKDEF_ARN}" --desired-count 1 --launch-type FARGATE \
    --network-configuration "${NET_CONFIG}" \
    --load-balancers "targetGroupArn=${TG_ARN},containerName=dsh-bff,containerPort=${BFF_CONTAINER_PORT}" >/dev/null
  echo "created service ${ECS_SERVICE}"
fi

echo
echo "Web tier deployed."
echo "  Public URL     : ${CLOUDFRONT_URL}"
echo "  Cognito pool   : ${POOL_ID}  client: ${CLIENT_ID}"
echo "  ALB DNS        : ${ALB_DNS}"
echo "  Runtime ARN    : ${RUNTIME_ARN}"
echo "NOTE: if the Cognito app client needs OAuth callback URLs, they must point"
echo "      at ${CLOUDFRONT_URL}/auth/callback (this BFF uses USER_PASSWORD_AUTH,"
echo "      so hosted-UI callbacks are not required)."
