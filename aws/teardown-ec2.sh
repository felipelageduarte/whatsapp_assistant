#!/usr/bin/env bash
set -euo pipefail
# Remove os recursos criados por deploy-ec2.sh. Idempotente.
REGION="${AWS_REGION:-us-east-1}"
export AWS_PROFILE="${AWS_PROFILE:-felipelageduarte}"
export PATH="/opt/homebrew/bin:$PATH"
PROJECT="wa-assistant"
ROLE="${PROJECT}-role"; PROFILE_NAME="${PROJECT}-instance-profile"
SG_NAME="${PROJECT}-sg"; KEY_NAME="${PROJECT}-key"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
BUNDLE_BUCKET="${PROJECT}-bundle-${ACCOUNT}"
AUTH_BUCKET="${PROJECT}-auth-${ACCOUNT}"
say(){ echo "[teardown] $1"; }

IID=$(aws ec2 describe-instances --region "$REGION" \
  --filters "Name=tag:Name,Values=$PROJECT" "Name=instance-state-name,Values=running,pending,stopped" \
  --query 'Reservations[].Instances[].InstanceId' --output text)
for i in $IID; do say "terminando $i"; aws ec2 terminate-instances --instance-ids "$i" --region "$REGION" >/dev/null; done
[ -n "$IID" ] && aws ec2 wait instance-terminated --instance-ids $IID --region "$REGION"

# Elastic IP (nao liberado automaticamente ao terminar instancia -> cobra hora parada)
EIP_ALLOC=$(aws ec2 describe-addresses --region "$REGION" \
  --filters "Name=tag:Name,Values=$PROJECT" --query 'Addresses[0].AllocationId' --output text 2>/dev/null || echo None)
[ "$EIP_ALLOC" != "None" ] && [ -n "$EIP_ALLOC" ] && { say "liberando EIP $EIP_ALLOC"; aws ec2 release-address --allocation-id "$EIP_ALLOC" --region "$REGION" 2>/dev/null || true; }

SG=$(aws ec2 describe-security-groups --filters Name=group-name,Values="$SG_NAME" \
  --query 'SecurityGroups[0].GroupId' --output text --region "$REGION" 2>/dev/null || echo None)
[ "$SG" != "None" ] && { say "removendo SG $SG"; aws ec2 delete-security-group --group-id "$SG" --region "$REGION" 2>/dev/null || true; }

aws ec2 delete-key-pair --key-name "$KEY_NAME" --region "$REGION" 2>/dev/null || true
rm -f "$(dirname "${BASH_SOURCE[0]}")/${KEY_NAME}.pem"
aws iam remove-role-from-instance-profile --instance-profile-name "$PROFILE_NAME" --role-name "$ROLE" 2>/dev/null || true
aws iam delete-instance-profile --instance-profile-name "$PROFILE_NAME" 2>/dev/null || true
aws iam delete-role-policy --role-name "$ROLE" --policy-name "${PROJECT}-access" 2>/dev/null || true
aws iam detach-role-policy --role-name "$ROLE" --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore 2>/dev/null || true
aws iam delete-role --role-name "$ROLE" 2>/dev/null || true
for p in JWT_SECRET TELEGRAM_BOT_TOKEN VAPID_PUBLIC VAPID_PRIVATE VAPID_SUBJECT; do
  aws ssm delete-parameter --name "/$PROJECT/$p" --region "$REGION" 2>/dev/null || true
done
aws s3 rb "s3://$BUNDLE_BUCKET" --force 2>/dev/null || true
# Bucket de auth guarda sessao WhatsApp pareada (Baileys) + midia cacheada — apagar exige novo QR scan ao reativar.
aws s3 rb "s3://$AUTH_BUCKET" --force 2>/dev/null || true
say "concluido. (Confira o console se algo ficou para tras.)"
