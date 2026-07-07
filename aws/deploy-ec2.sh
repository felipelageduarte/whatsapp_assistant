#!/usr/bin/env bash
set -euo pipefail
# =============================================================================
# Deploy do WhatsApp Assistant numa EC2 t4g.small (ARM, Amazon Linux 2023).
# LLM via Amazon Bedrock (sem API key — IAM role da instancia autentica).
# Stateful: Baileys mantem WebSocket vivo 24/7 -> nao cabe Lambda.
#
# Recursos (idempotente):
#   S3 bundle, SSM (JWT_SECRET + TELEGRAM_BOT_TOKEN), IAM role (Bedrock+SSM+S3),
#   Security Group, Elastic IP (A record estavel), EC2 com Node22+Caddy(TLS)+systemd.
#
# Uso:
#   bash aws/deploy-ec2.sh                       # usa DOMAIN do .env/abaixo
#   DOMAIN=assistant.exemplo.com bash aws/deploy-ec2.sh
# =============================================================================

REGION="${AWS_REGION:-us-east-1}"
export AWS_PROFILE="${AWS_PROFILE:-felipelageduarte}"
export PATH="/opt/homebrew/bin:$PATH"

PROJECT="wa-assistant"
INSTANCE_TYPE="${INSTANCE_TYPE:-t4g.small}"
DOMAIN="${DOMAIN:-assistant.felipelageduarte.com.br}"
BEDROCK_MODEL="${BEDROCK_MODEL:-us.anthropic.claude-sonnet-4-6}"
SG_NAME="${PROJECT}-sg"; ROLE="${PROJECT}-role"; PROFILE_NAME="${PROJECT}-instance-profile"
KEY_NAME="${PROJECT}-key"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BLUE='\033[0;34m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
log(){ echo -e "${BLUE}[wa]${NC} $1"; }; ok(){ echo -e "${GREEN}[✓]${NC} $1"; }
warn(){ echo -e "${YELLOW}[!]${NC} $1"; }; die(){ echo -e "${RED}[x]${NC} $1"; exit 1; }

command -v aws >/dev/null 2>&1 || die "AWS CLI nao encontrado."
ACCOUNT="$(aws sts get-caller-identity --query Account --output text 2>/dev/null)" \
  || die "Credenciais AWS nao configuradas (profile: $AWS_PROFILE)."
ok "Conta AWS: $ACCOUNT | profile: $AWS_PROFILE | regiao: $REGION"
BUNDLE_BUCKET="${PROJECT}-bundle-${ACCOUNT}"
AUTH_BUCKET="${PROJECT}-auth-${ACCOUNT}"   # creds Baileys (sobrevive troca de instancia)

# ── segredo (JWT) do .env local ──────────────────────────────────────────────
[ -f "$ROOT_DIR/.env" ] || die "Crie $ROOT_DIR/.env com JWT_SECRET (openssl rand -hex 32)."
JWT_SECRET=$(grep -E '^JWT_SECRET=' "$ROOT_DIR/.env" | head -1 | cut -d= -f2-)
TELEGRAM_BOT_TOKEN=$(grep -E '^TELEGRAM_BOT_TOKEN=' "$ROOT_DIR/.env" | head -1 | cut -d= -f2- || true)
[ -n "${JWT_SECRET:-}" ] || die "JWT_SECRET ausente no .env."

put_param(){ aws ssm put-parameter --name "/$PROJECT/$1" --type SecureString --value "$2" \
  --overwrite --region "$REGION" >/dev/null; }
log "Gravando segredos no SSM..."
put_param JWT_SECRET "$JWT_SECRET"
[ -n "${TELEGRAM_BOT_TOKEN:-}" ] && put_param TELEGRAM_BOT_TOKEN "$TELEGRAM_BOT_TOKEN" || true
# VAPID (Web Push) — gera uma vez e reusa
if ! aws ssm get-parameter --name "/$PROJECT/VAPID_PUBLIC" --region "$REGION" >/dev/null 2>&1; then
  [ -d "$ROOT_DIR/node_modules/web-push" ] || (cd "$ROOT_DIR" && npm install web-push >/dev/null 2>&1)
  VKEYS=$(cd "$ROOT_DIR" && node -e "const k=require('web-push').generateVAPIDKeys();process.stdout.write(k.publicKey+'\n'+k.privateKey)")
  put_param VAPID_PUBLIC "$(printf '%s' "$VKEYS" | sed -n '1p')"
  put_param VAPID_PRIVATE "$(printf '%s' "$VKEYS" | sed -n '2p')"
  ok "VAPID gerado."
fi
put_param VAPID_SUBJECT "${VAPID_SUBJECT:-mailto:felipelageduarte@gmail.com}"
ok "Segredos no SSM."

# ── bundle do codigo -> S3 ───────────────────────────────────────────────────
aws s3api head-bucket --bucket "$BUNDLE_BUCKET" >/dev/null 2>&1 || {
  log "Criando bucket $BUNDLE_BUCKET..."
  aws s3api create-bucket --bucket "$BUNDLE_BUCKET" --region "$REGION" \
    $([ "$REGION" != us-east-1 ] && echo "--create-bucket-configuration LocationConstraint=$REGION") >/dev/null
}
TAR=/tmp/${PROJECT}-bundle.tgz
tar -C "$ROOT_DIR" -czf "$TAR" src web package.json package-lock.json
aws s3 cp "$TAR" "s3://$BUNDLE_BUCKET/bundle.tgz" --region "$REGION" >/dev/null
ok "Bundle enviado."

# ── bucket de auth (creds Baileys, privado) ──────────────────────────────────
aws s3api head-bucket --bucket "$AUTH_BUCKET" >/dev/null 2>&1 || {
  log "Criando bucket de auth $AUTH_BUCKET..."
  aws s3api create-bucket --bucket "$AUTH_BUCKET" --region "$REGION" \
    $([ "$REGION" != us-east-1 ] && echo "--create-bucket-configuration LocationConstraint=$REGION") >/dev/null
  aws s3api put-public-access-block --bucket "$AUTH_BUCKET" --public-access-block-configuration \
    BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true >/dev/null
}
ok "Bucket de auth: $AUTH_BUCKET"

# ── IAM role + instance profile ──────────────────────────────────────────────
aws iam get-role --role-name "$ROLE" >/dev/null 2>&1 || {
  log "Criando IAM role $ROLE..."
  aws iam create-role --role-name "$ROLE" --assume-role-policy-document '{
    "Version":"2012-10-17","Statement":[{"Effect":"Allow",
    "Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}' >/dev/null
  aws iam attach-role-policy --role-name "$ROLE" \
    --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore >/dev/null
}
aws iam put-role-policy --role-name "$ROLE" --policy-name "${PROJECT}-access" \
  --policy-document "{\"Version\":\"2012-10-17\",\"Statement\":[
    {\"Effect\":\"Allow\",\"Action\":[\"bedrock:InvokeModel\",\"bedrock:InvokeModelWithResponseStream\"],\"Resource\":\"*\"},
    {\"Effect\":\"Allow\",\"Action\":[\"ssm:GetParameter\",\"ssm:GetParameters\"],\"Resource\":\"arn:aws:ssm:${REGION}:${ACCOUNT}:parameter/${PROJECT}/*\"},
    {\"Effect\":\"Allow\",\"Action\":[\"kms:Decrypt\"],\"Resource\":\"*\"},
    {\"Effect\":\"Allow\",\"Action\":[\"s3:GetObject\"],\"Resource\":\"arn:aws:s3:::${BUNDLE_BUCKET}/*\"},
    {\"Effect\":\"Allow\",\"Action\":[\"s3:GetObject\",\"s3:PutObject\",\"s3:DeleteObject\"],\"Resource\":\"arn:aws:s3:::${AUTH_BUCKET}/*\"},
    {\"Effect\":\"Allow\",\"Action\":[\"s3:ListBucket\"],\"Resource\":\"arn:aws:s3:::${AUTH_BUCKET}\"}]}" >/dev/null
aws iam get-instance-profile --instance-profile-name "$PROFILE_NAME" >/dev/null 2>&1 || {
  aws iam create-instance-profile --instance-profile-name "$PROFILE_NAME" >/dev/null
  aws iam add-role-to-instance-profile --instance-profile-name "$PROFILE_NAME" --role-name "$ROLE" >/dev/null
  sleep 8
}
ok "IAM pronto (Bedrock + SSM + S3)."

# ── Security Group ───────────────────────────────────────────────────────────
VPC=$(aws ec2 describe-vpcs --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId' --output text --region "$REGION")
SG=$(aws ec2 describe-security-groups --filters Name=group-name,Values="$SG_NAME" Name=vpc-id,Values="$VPC" \
  --query 'SecurityGroups[0].GroupId' --output text --region "$REGION" 2>/dev/null || echo None)
[ "$SG" = None ] || [ -z "$SG" ] && SG=$(aws ec2 create-security-group --group-name "$SG_NAME" \
  --description "WhatsApp Assistant" --vpc-id "$VPC" --query GroupId --output text --region "$REGION")
MYIP=$(curl -s https://checkip.amazonaws.com || echo 0.0.0.0)
ing(){ aws ec2 authorize-security-group-ingress --group-id "$SG" "$@" --region "$REGION" >/dev/null 2>&1 || true; }
ing --protocol tcp --port 80 --cidr 0.0.0.0/0
ing --protocol tcp --port 443 --cidr 0.0.0.0/0
ing --protocol tcp --port 22 --cidr "${MYIP}/32"
ok "SG: $SG"

# ── Key pair ─────────────────────────────────────────────────────────────────
aws ec2 describe-key-pairs --key-names "$KEY_NAME" --region "$REGION" >/dev/null 2>&1 || {
  aws ec2 create-key-pair --key-name "$KEY_NAME" --query KeyMaterial --output text --region "$REGION" \
    > "$SCRIPT_DIR/${KEY_NAME}.pem"; chmod 600 "$SCRIPT_DIR/${KEY_NAME}.pem"
  ok "Chave em aws/${KEY_NAME}.pem"
}

AMI=$(aws ssm get-parameter --region "$REGION" \
  --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64 --query Parameter.Value --output text)

# ── user-data ────────────────────────────────────────────────────────────────
USERDATA=$(cat <<EOF
#!/bin/bash
set -e
exec > /var/log/wa-deploy.log 2>&1
cd /opt && curl -fsSL https://nodejs.org/dist/v24.14.0/node-v24.14.0-linux-arm64.tar.xz -o node.tar.xz
tar -xf node.tar.xz && mv node-v24.14.0-linux-arm64 node && rm node.tar.xz
ln -sf /opt/node/bin/node /usr/local/bin/node && ln -sf /opt/node/bin/npm /usr/local/bin/npm
dnf install -y 'dnf-command(copr)'
dnf copr enable -y @caddy/caddy epel-9-aarch64 || true
dnf install -y caddy || (curl -fsSL "https://caddyserver.com/api/download?os=linux&arch=arm64" -o /usr/local/bin/caddy && chmod +x /usr/local/bin/caddy)
mkdir -p /opt/wa && cd /opt/wa
aws s3 cp s3://$BUNDLE_BUCKET/bundle.tgz . --region $REGION
tar -xzf bundle.tgz && rm bundle.tgz
/usr/local/bin/npm install --omit=dev
get(){ aws ssm get-parameter --name "/$PROJECT/\$1" --with-decryption --region $REGION --query Parameter.Value --output text 2>/dev/null; }
cat > /opt/wa/.env <<ENV
AWS_REGION=$REGION
BEDROCK_MODEL=$BEDROCK_MODEL
WA_AUTH_BUCKET=$AUTH_BUCKET
VAPID_PUBLIC=\$(get VAPID_PUBLIC)
VAPID_PRIVATE=\$(get VAPID_PRIVATE)
VAPID_SUBJECT=\$(get VAPID_SUBJECT)
JWT_SECRET=\$(get JWT_SECRET)
TELEGRAM_BOT_TOKEN=\$(get TELEGRAM_BOT_TOKEN)
PORT=3000
IGNORE_GROUPS=true
CONTEXT_WINDOW=15
ENV
cat > /etc/systemd/system/wa-assistant.service <<UNIT
[Unit]
Description=WhatsApp Assistant
After=network.target
[Service]
WorkingDirectory=/opt/wa
ExecStart=/usr/local/bin/node src/index.js
Restart=always
RestartSec=5
User=root
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload && systemctl enable --now wa-assistant
mkdir -p /etc/caddy
cat > /etc/caddy/Caddyfile <<CADDY
$DOMAIN {
    reverse_proxy localhost:3000
}
CADDY
systemctl enable --now caddy 2>/dev/null || (caddy run --config /etc/caddy/Caddyfile &)
EOF
)

# ── instancia (idempotente) ──────────────────────────────────────────────────
IID=$(aws ec2 describe-instances --region "$REGION" \
  --filters "Name=tag:Name,Values=$PROJECT" "Name=instance-state-name,Values=running,pending,stopped" \
  --query 'Reservations[0].Instances[0].InstanceId' --output text 2>/dev/null || echo None)
if [ "$IID" != None ] && [ -n "$IID" ]; then
  warn "Instancia ja existe ($IID). Para atualizar codigo: re-suba bundle + 'systemctl restart wa-assistant' via SSM."
else
  log "Lancando EC2 $INSTANCE_TYPE..."
  IID=$(aws ec2 run-instances --region "$REGION" --image-id "$AMI" --instance-type "$INSTANCE_TYPE" \
    --key-name "$KEY_NAME" --security-group-ids "$SG" --iam-instance-profile Name="$PROFILE_NAME" \
    --block-device-mappings '[{"DeviceName":"/dev/xvda","Ebs":{"VolumeSize":20,"VolumeType":"gp3"}}]' \
    --user-data "$USERDATA" \
    --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$PROJECT}]" \
    --query 'Instances[0].InstanceId' --output text)
  ok "Instancia: $IID"
fi
aws ec2 wait instance-running --instance-ids "$IID" --region "$REGION"

# ── Elastic IP (A record estavel) ────────────────────────────────────────────
EIP_ALLOC=$(aws ec2 describe-addresses --region "$REGION" \
  --filters "Name=tag:Name,Values=$PROJECT" --query 'Addresses[0].AllocationId' --output text 2>/dev/null || echo None)
if [ "$EIP_ALLOC" = None ] || [ -z "$EIP_ALLOC" ]; then
  EIP_ALLOC=$(aws ec2 allocate-address --domain vpc --region "$REGION" \
    --tag-specifications "ResourceType=elastic-ip,Tags=[{Key=Name,Value=$PROJECT}]" \
    --query AllocationId --output text)
fi
aws ec2 associate-address --instance-id "$IID" --allocation-id "$EIP_ALLOC" --region "$REGION" >/dev/null
IP=$(aws ec2 describe-addresses --allocation-ids "$EIP_ALLOC" --region "$REGION" --query 'Addresses[0].PublicIp' --output text)

echo ""
ok "Deploy disparado. Bootstrap (Node+Caddy+app) leva ~3-5 min."
echo "  Instancia  : $IID"
echo "  Elastic IP : $IP   (estavel — nao muda em restart)"
echo ""
echo "  >>> No registro.br, crie um registro A:"
echo "        ${DOMAIN}.   ->   A   ->   $IP"
echo "  Apos o DNS propagar, o Caddy emite o certificado TLS sozinho e o app fica em:"
echo "        https://$DOMAIN"
echo ""
echo "  Logs do bootstrap: aws ssm start-session --target $IID  ->  tail -f /var/log/wa-deploy.log"
