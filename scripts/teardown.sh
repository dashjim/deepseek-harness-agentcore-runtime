#!/usr/bin/env bash
# =============================================================================
# teardown.sh — delete resources created by deploy-runtime.sh / deploy-web.sh.
#
# SAFETY: only touches resources matching THIS project's configured names /
# prefixes (from scripts/deploy.env). It never deletes a VPC/subnet/SG it did not
# create, and by default LEAVES the Runtime VPC alone when REUSE_RUNTIME_VPC=true.
# Review every line before running. Nothing here is reversible.
#
# Usage:  CONFIRM=yes bash scripts/teardown.sh
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -f "${SCRIPT_DIR}/deploy.env" ] && source "${SCRIPT_DIR}/deploy.env"
: "${AWS_REGION:?}" ; : "${ACCOUNT_ID:?}"
AWS=(aws --region "${AWS_REGION}")

if [ "${CONFIRM:-no}" != "yes" ]; then
  echo "Refusing to delete. Re-run with CONFIRM=yes to proceed."
  echo "Will remove (if present): ECS service/cluster/taskdefs, ALB+TG+listener,"
  echo "CloudFront dist (${CLOUDFRONT_COMMENT:-?}), AgentCore runtime ${RUNTIME_NAME:-?},"
  echo "ECR repos ${ECR_RUNTIME_REPO:-?}/${ECR_BFF_REPO:-?}, IAM roles, DynamoDB ${DDB_TABLE:-?},"
  echo "Cognito pool ${COGNITO_POOL_NAME:-?}, project Secrets Manager secrets, SGs."
  exit 0
fi

echo "== ECS service + cluster =="
"${AWS[@]}" ecs update-service --cluster "${ECS_CLUSTER}" --service "${ECS_SERVICE}" \
  --desired-count 0 >/dev/null 2>&1 || true
"${AWS[@]}" ecs delete-service --cluster "${ECS_CLUSTER}" --service "${ECS_SERVICE}" --force >/dev/null 2>&1 || true
"${AWS[@]}" ecs delete-cluster --cluster "${ECS_CLUSTER}" >/dev/null 2>&1 || true

echo "== ALB + listener + target group =="
ALB_ARN=$("${AWS[@]}" elbv2 describe-load-balancers --names "${ALB_NAME}" \
  --query "LoadBalancers[0].LoadBalancerArn" --output text 2>/dev/null || echo "")
if [ -n "${ALB_ARN}" ] && [ "${ALB_ARN}" != "None" ]; then
  "${AWS[@]}" elbv2 delete-load-balancer --load-balancer-arn "${ALB_ARN}" >/dev/null 2>&1 || true
fi
TG_ARN=$("${AWS[@]}" elbv2 describe-target-groups --names "${TG_NAME}" \
  --query "TargetGroups[0].TargetGroupArn" --output text 2>/dev/null || echo "")
[ -n "${TG_ARN}" ] && [ "${TG_ARN}" != "None" ] && \
  "${AWS[@]}" elbv2 delete-target-group --target-group-arn "${TG_ARN}" >/dev/null 2>&1 || true

echo "== CloudFront (disable, then delete requires waiting for Deployed) =="
DIST_ID=$("${AWS[@]}" cloudfront list-distributions \
  --query "DistributionList.Items[?Comment=='${CLOUDFRONT_COMMENT}'].Id | [0]" --output text 2>/dev/null || echo "None")
if [ "${DIST_ID}" != "None" ] && [ -n "${DIST_ID}" ]; then
  echo "  disable ${DIST_ID} manually (get-distribution-config -> set Enabled=false ->"
  echo "  update-distribution --if-match ETAG), wait Deployed, then delete-distribution."
  echo "  (CloudFront delete is a multi-step wait; left manual to avoid a long block.)"
fi

echo "== AgentCore runtime =="
RID=$("${AWS[@]}" bedrock-agentcore-control list-agent-runtimes \
  --query "agentRuntimes[?agentRuntimeName=='${RUNTIME_NAME}'].agentRuntimeId | [0]" \
  --output text 2>/dev/null || echo "None")
[ "${RID}" != "None" ] && [ -n "${RID}" ] && \
  "${AWS[@]}" bedrock-agentcore-control delete-agent-runtime --agent-runtime-id "${RID}" >/dev/null 2>&1 || true

echo "== DynamoDB table =="
"${AWS[@]}" dynamodb delete-table --table-name "${DDB_TABLE}" >/dev/null 2>&1 || true

echo "== IAM roles (delete inline policy first) =="
for role in "${RUNTIME_EXEC_ROLE_NAME}" "${ECS_TASK_ROLE_NAME}" "${ECS_EXEC_ROLE_NAME}"; do
  for p in $("${AWS[@]}" iam list-role-policies --role-name "${role}" \
      --query "PolicyNames[]" --output text 2>/dev/null || true); do
    "${AWS[@]}" iam delete-role-policy --role-name "${role}" --policy-name "${p}" >/dev/null 2>&1 || true
  done
  "${AWS[@]}" iam delete-role --role-name "${role}" >/dev/null 2>&1 || true
done

echo "== ECR repos =="
"${AWS[@]}" ecr delete-repository --repository-name "${ECR_RUNTIME_REPO}" --force >/dev/null 2>&1 || true
"${AWS[@]}" ecr delete-repository --repository-name "${ECR_BFF_REPO}" --force >/dev/null 2>&1 || true

echo "== Secrets Manager (force delete, no recovery window) =="
for s in "${COGNITO_CLIENT_SECRET_NAME}" "${COGNITO_TEST_USERS_SECRET}" \
         "${BFF_SESSION_COOKIE_SECRET_NAME}" "${BFF_MEMORY_KEY_SECRET_NAME}" "${BFF_ORIGIN_VERIFY_SECRET_NAME}"; do
  "${AWS[@]}" secretsmanager delete-secret --secret-id "${s}" \
    --force-delete-without-recovery >/dev/null 2>&1 || true
done

echo "== Cognito user pool =="
POOL_ID=$("${AWS[@]}" cognito-idp list-user-pools --max-results 60 \
  --query "UserPools[?Name=='${COGNITO_POOL_NAME}'].Id | [0]" --output text 2>/dev/null || echo "None")
[ "${POOL_ID}" != "None" ] && [ -n "${POOL_ID}" ] && \
  "${AWS[@]}" cognito-idp delete-user-pool --user-pool-id "${POOL_ID}" >/dev/null 2>&1 || true

echo "== log group =="
"${AWS[@]}" logs delete-log-group --log-group-name "${BFF_LOG_GROUP}" >/dev/null 2>&1 || true

echo "== security groups created by deploy-web.sh (by name) =="
for sgname in "${ALB_NAME}-sg" "${ECS_SERVICE}-sg"; do
  SG=$("${AWS[@]}" ec2 describe-security-groups \
    --filters "Name=group-name,Values=${sgname}" "Name=vpc-id,Values=${WEB_VPC_ID}" \
    --query "SecurityGroups[0].GroupId" --output text 2>/dev/null || echo "None")
  [ "${SG}" != "None" ] && [ -n "${SG}" ] && \
    "${AWS[@]}" ec2 delete-security-group --group-id "${SG}" >/dev/null 2>&1 || true
done

echo
echo "Teardown pass complete."
echo "NOTE: the Runtime VPC / subnets / endpoints are NOT deleted here."
echo "      If REUSE_RUNTIME_VPC=false created a dedicated VPC, delete its"
echo "      endpoints, SGs, subnets and VPC manually after confirming ownership."
