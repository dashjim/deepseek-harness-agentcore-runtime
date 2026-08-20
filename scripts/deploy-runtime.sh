#!/usr/bin/env bash
# =============================================================================
# deploy-runtime.sh — provision the DeepSeek Harness AgentCore Runtime (VPC mode).
#
# Reproduces the Phase-2 Runtime deployment recorded in config/deployment-env.md:
#   1. ECR repo (create if absent)
#   2. build + tag + push the self-contained ARM64 image (via build-image.sh)
#   3. least-privilege execution role (bedrock-agentcore trust + SourceAccount /
#      ArnLike SourceArn conditions; policy = 4 Bedrock model ARNs + scoped ECR
#      pull + scoped logs + ecr:GetAuthorizationToken:*)
#   4. VPC networking — REUSE existing ids, or CREATE a dedicated no-NAT/no-IGW
#      VPC with 2 private subnets, a route table (local + S3 prefix list only),
#      Runtime SG (inbound empty), Endpoint SG (443 from VPC CIDR), 6 interface
#      endpoints (bedrock-runtime/ecr.api/ecr.dkr/logs/sts/bedrock-agentcore) and
#      an S3 gateway endpoint
#   5. create-agent-runtime (networkMode=VPC, subnets/SGs from vars, env injected)
#   6. poll until READY
#   7. optional invoke smoke test
#
# Idempotent where the AWS APIs allow (create-if-absent). Steps that cannot be
# made idempotent are flagged inline. Prints resulting IDs; writes nothing to git.
#
# Reads scripts/deploy.env (gitignored) if present. See scripts/deploy.env.example.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
[ -f "${SCRIPT_DIR}/deploy.env" ] && source "${SCRIPT_DIR}/deploy.env"

: "${AWS_REGION:?set AWS_REGION}"
: "${ACCOUNT_ID:?set ACCOUNT_ID}"
: "${RUNTIME_NAME:?}" ; : "${ECR_RUNTIME_REPO:?}" ; : "${RUNTIME_IMAGE_TAG:?}"
: "${RUNTIME_EXEC_ROLE_NAME:?}"
: "${MODEL_INFERENCE_PROFILE_ID:?}" ; : "${MODEL_FOUNDATION_ID:?}" ; : "${MODEL_REGIONS:?}"
: "${REUSE_RUNTIME_VPC:?}"

AWS=(aws --region "${AWS_REGION}")
ECR_URI="${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${ECR_RUNTIME_REPO}"
IMAGE_URI="${ECR_URI}:${RUNTIME_IMAGE_TAG}"

echo "== 1. ECR repository =="
if ! "${AWS[@]}" ecr describe-repositories --repository-names "${ECR_RUNTIME_REPO}" >/dev/null 2>&1; then
  "${AWS[@]}" ecr create-repository --repository-name "${ECR_RUNTIME_REPO}" \
    --image-scanning-configuration scanOnPush=true >/dev/null
  echo "created ECR repo ${ECR_RUNTIME_REPO}"
else
  echo "ECR repo ${ECR_RUNTIME_REPO} exists"
fi

echo "== 2. build + push image ${IMAGE_URI} =="
"${AWS[@]}" ecr get-login-password | docker login --username AWS --password-stdin \
  "${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"
IMAGE_TAG="${ECR_RUNTIME_REPO}:${RUNTIME_IMAGE_TAG}" DSH_REPO_ROOT="${DSH_REPO_ROOT:-}" \
  bash "${SCRIPT_DIR}/build-image.sh"
docker tag "${ECR_RUNTIME_REPO}:${RUNTIME_IMAGE_TAG}" "${IMAGE_URI}"
docker push "${IMAGE_URI}"

echo "== 3. execution role ${RUNTIME_EXEC_ROLE_NAME} =="
ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${RUNTIME_EXEC_ROLE_NAME}"
# Build the Bedrock model resource-ARN JSON array: inference-profile + per-region
# foundation-model (no wildcards).
MODEL_ARNS="\"arn:aws:bedrock:${AWS_REGION}:${ACCOUNT_ID}:inference-profile/${MODEL_INFERENCE_PROFILE_ID}\""
for r in ${MODEL_REGIONS}; do
  MODEL_ARNS="${MODEL_ARNS},\"arn:aws:bedrock:${r}::foundation-model/${MODEL_FOUNDATION_ID}\""
done

TRUST_JSON=$(cat <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "Service": "bedrock-agentcore.amazonaws.com" },
      "Action": "sts:AssumeRole",
      "Condition": {
        "StringEquals": { "aws:SourceAccount": "${ACCOUNT_ID}" },
        "ArnLike": { "aws:SourceArn": "arn:aws:bedrock-agentcore:${AWS_REGION}:${ACCOUNT_ID}:runtime/*" }
      }
    }
  ]
}
JSON
)

POLICY_JSON=$(cat <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "InvokeApprovedModels",
      "Effect": "Allow",
      "Action": ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
      "Resource": [${MODEL_ARNS}]
    },
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
      "Resource": "arn:aws:ecr:${AWS_REGION}:${ACCOUNT_ID}:repository/${ECR_RUNTIME_REPO}"
    },
    {
      "Sid": "RuntimeLogs",
      "Effect": "Allow",
      "Action": ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams"],
      "Resource": "arn:aws:logs:${AWS_REGION}:${ACCOUNT_ID}:log-group:/aws/bedrock-agentcore/runtimes/*"
    }
  ]
}
JSON
)

if ! "${AWS[@]}" iam get-role --role-name "${RUNTIME_EXEC_ROLE_NAME}" >/dev/null 2>&1; then
  "${AWS[@]}" iam create-role --role-name "${RUNTIME_EXEC_ROLE_NAME}" \
    --assume-role-policy-document "${TRUST_JSON}" >/dev/null
  echo "created role ${RUNTIME_EXEC_ROLE_NAME}"
else
  "${AWS[@]}" iam update-assume-role-policy --role-name "${RUNTIME_EXEC_ROLE_NAME}" \
    --policy-document "${TRUST_JSON}" >/dev/null
  echo "role exists; trust policy updated"
fi
# Inline policy is put/overwritten (idempotent).
"${AWS[@]}" iam put-role-policy --role-name "${RUNTIME_EXEC_ROLE_NAME}" \
  --policy-name "dsh-runtime-exec" --policy-document "${POLICY_JSON}" >/dev/null
echo "execution role: ${ROLE_ARN}"

echo "== 4. VPC networking =="
if [ "${REUSE_RUNTIME_VPC}" = "true" ]; then
  : "${RUNTIME_VPC_ID:?}" ; : "${RUNTIME_SUBNET_IDS:?}" ; : "${RUNTIME_SG_ID:?}"
  echo "reusing VPC ${RUNTIME_VPC_ID}, subnets [${RUNTIME_SUBNET_IDS}], SG ${RUNTIME_SG_ID}"
  VPC_ID="${RUNTIME_VPC_ID}"
  RUNTIME_SG="${RUNTIME_SG_ID}"
  SUBNETS="${RUNTIME_SUBNET_IDS}"
else
  : "${RUNTIME_VPC_CIDR:?}" ; : "${RUNTIME_SUBNET_A_CIDR:?}" ; : "${RUNTIME_SUBNET_B_CIDR:?}"
  : "${RUNTIME_AZ_A:?}" ; : "${RUNTIME_AZ_B:?}" ; : "${S3_PREFIX_LIST_ID:?}"
  echo "creating dedicated no-NAT/no-IGW VPC ${RUNTIME_VPC_CIDR}"
  VPC_ID=$("${AWS[@]}" ec2 create-vpc --cidr-block "${RUNTIME_VPC_CIDR}" \
    --tag-specifications "ResourceType=vpc,Tags=[{Key=Name,Value=dsh-agentcore-vpc}]" \
    --query Vpc.VpcId --output text)
  "${AWS[@]}" ec2 modify-vpc-attribute --vpc-id "${VPC_ID}" --enable-dns-support
  "${AWS[@]}" ec2 modify-vpc-attribute --vpc-id "${VPC_ID}" --enable-dns-hostnames
  SUB_A=$("${AWS[@]}" ec2 create-subnet --vpc-id "${VPC_ID}" --cidr-block "${RUNTIME_SUBNET_A_CIDR}" \
    --availability-zone "${RUNTIME_AZ_A}" --query Subnet.SubnetId --output text)
  SUB_B=$("${AWS[@]}" ec2 create-subnet --vpc-id "${VPC_ID}" --cidr-block "${RUNTIME_SUBNET_B_CIDR}" \
    --availability-zone "${RUNTIME_AZ_B}" --query Subnet.SubnetId --output text)
  SUBNETS="${SUB_A} ${SUB_B}"
  # Route table: local only + S3 gateway prefix list. NO 0.0.0.0/0 (no NAT/IGW).
  RTB=$("${AWS[@]}" ec2 create-route-table --vpc-id "${VPC_ID}" \
    --query RouteTable.RouteTableId --output text)
  for s in ${SUBNETS}; do
    "${AWS[@]}" ec2 associate-route-table --route-table-id "${RTB}" --subnet-id "${s}" >/dev/null
  done
  # Security groups.
  RUNTIME_SG=$("${AWS[@]}" ec2 create-security-group --group-name dsh-agentcore-runtime-sg \
    --description "DSH Runtime SG (inbound empty)" --vpc-id "${VPC_ID}" --query GroupId --output text)
  # create-security-group adds a default allow-all egress rule; drop it so egress
  # is added explicitly (only to the endpoint SG / S3 prefix list).
  "${AWS[@]}" ec2 revoke-security-group-egress --group-id "${RUNTIME_SG}" \
    --ip-permissions 'IpProtocol=-1,IpRanges=[{CidrIp=0.0.0.0/0}]' >/dev/null 2>&1 || true
  ENDPOINT_SG=$("${AWS[@]}" ec2 create-security-group --group-name dsh-agentcore-endpoint-sg \
    --description "DSH VPC endpoint SG (443 from VPC CIDR)" --vpc-id "${VPC_ID}" --query GroupId --output text)
  "${AWS[@]}" ec2 authorize-security-group-ingress --group-id "${ENDPOINT_SG}" \
    --protocol tcp --port 443 --cidr "${RUNTIME_VPC_CIDR}" >/dev/null
  # Runtime SG egress: 443 to endpoint SG + S3 prefix list (for ECR layer pull).
  "${AWS[@]}" ec2 authorize-security-group-egress --group-id "${RUNTIME_SG}" \
    --ip-permissions "IpProtocol=tcp,FromPort=443,ToPort=443,UserIdGroupPairs=[{GroupId=${ENDPOINT_SG}}]" >/dev/null
  "${AWS[@]}" ec2 authorize-security-group-egress --group-id "${RUNTIME_SG}" \
    --ip-permissions "IpProtocol=tcp,FromPort=443,ToPort=443,PrefixListIds=[{PrefixListId=${S3_PREFIX_LIST_ID}}]" >/dev/null
  # S3 gateway endpoint (route via prefix list) + 6 interface endpoints.
  "${AWS[@]}" ec2 create-vpc-endpoint --vpc-id "${VPC_ID}" --vpc-endpoint-type Gateway \
    --service-name "com.amazonaws.${AWS_REGION}.s3" --route-table-ids "${RTB}" >/dev/null
  for svc in bedrock-runtime ecr.api ecr.dkr logs sts bedrock-agentcore; do
    "${AWS[@]}" ec2 create-vpc-endpoint --vpc-id "${VPC_ID}" --vpc-endpoint-type Interface \
      --service-name "com.amazonaws.${AWS_REGION}.${svc}" \
      --subnet-ids ${SUBNETS} --security-group-ids "${ENDPOINT_SG}" \
      --private-dns-enabled >/dev/null
    echo "created interface endpoint ${svc}"
  done
  echo "created VPC ${VPC_ID} subnets [${SUBNETS}] runtimeSG ${RUNTIME_SG} endpointSG ${ENDPOINT_SG} rtb ${RTB}"
fi

# networkConfiguration + artifact JSON (subnets as JSON array).
SUBNET_JSON=$(printf '"%s",' ${SUBNETS}); SUBNET_JSON="[${SUBNET_JSON%,}]"
NET_CONFIG="{\"networkMode\":\"VPC\",\"networkModeConfig\":{\"subnets\":${SUBNET_JSON},\"securityGroups\":[\"${RUNTIME_SG}\"]}}"
ARTIFACT="{\"containerConfiguration\":{\"containerUri\":\"${IMAGE_URI}\"}}"
ENV_VARS="{\"AWS_REGION\":\"${AWS_REGION}\",\"DSH_RUNTIME_MODE\":\"bundled\"}"

echo "== 5. create-agent-runtime (VPC mode) =="
# NOTE: not idempotent. If a runtime named ${RUNTIME_NAME} already exists this
# call fails; use update-agent-runtime (full-replace: resend env+network+role) or
# delete it first. We detect an existing one and switch to update.
EXISTING_ID=$("${AWS[@]}" bedrock-agentcore-control list-agent-runtimes \
  --query "agentRuntimes[?agentRuntimeName=='${RUNTIME_NAME}'].agentRuntimeId | [0]" \
  --output text 2>/dev/null || echo "None")
if [ "${EXISTING_ID}" = "None" ] || [ -z "${EXISTING_ID}" ]; then
  RUNTIME_ID=$("${AWS[@]}" bedrock-agentcore-control create-agent-runtime \
    --agent-runtime-name "${RUNTIME_NAME}" \
    --agent-runtime-artifact "${ARTIFACT}" \
    --network-configuration "${NET_CONFIG}" \
    --protocol-configuration '{"serverProtocol":"HTTP"}' \
    --role-arn "${ROLE_ARN}" \
    --environment-variables "${ENV_VARS}" \
    --query agentRuntimeId --output text)
  echo "created runtime ${RUNTIME_ID}"
else
  RUNTIME_ID="${EXISTING_ID}"
  echo "runtime ${RUNTIME_ID} exists -> update-agent-runtime (full-replace of artifact/network/env/role)"
  "${AWS[@]}" bedrock-agentcore-control update-agent-runtime \
    --agent-runtime-id "${RUNTIME_ID}" \
    --agent-runtime-artifact "${ARTIFACT}" \
    --network-configuration "${NET_CONFIG}" \
    --protocol-configuration '{"serverProtocol":"HTTP"}' \
    --role-arn "${ROLE_ARN}" \
    --environment-variables "${ENV_VARS}" >/dev/null
fi
RUNTIME_ARN="arn:aws:bedrock-agentcore:${AWS_REGION}:${ACCOUNT_ID}:runtime/${RUNTIME_ID}"

echo "== 6. poll until READY =="
for _ in $(seq 1 60); do
  STATUS=$("${AWS[@]}" bedrock-agentcore-control get-agent-runtime \
    --agent-runtime-id "${RUNTIME_ID}" --query status --output text 2>/dev/null || echo "PENDING")
  echo "  status=${STATUS}"
  case "${STATUS}" in
    READY) break ;;
    CREATE_FAILED|UPDATE_FAILED|DELETE_FAILED) echo "ERROR: runtime status ${STATUS}"; exit 1 ;;
  esac
  sleep 10
done

echo
echo "Runtime ready."
echo "  RUNTIME_ID  = ${RUNTIME_ID}"
echo "  RUNTIME_ARN = ${RUNTIME_ARN}"
echo "  (feed RUNTIME_ARN into deploy-web.sh)"

# == 7. optional invoke smoke =================================================
if [ "${SMOKE:-false}" = "true" ]; then
  echo "== 7. invoke smoke =="
  SID="dsh-smoke-$(date +%s)-000000000000000000"   # >=33 chars
  OUT="$(mktemp)"
  "${AWS[@]}" bedrock-agentcore invoke-agent-runtime \
    --agent-runtime-arn "${RUNTIME_ARN}" \
    --runtime-session-id "${SID}" \
    --payload '{"action":"status"}' \
    --cli-binary-format raw-in-base64-out "${OUT}"
  echo "invoke response:"; cat "${OUT}"; echo; rm -f "${OUT}"
fi
