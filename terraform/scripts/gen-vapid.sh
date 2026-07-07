#!/usr/bin/env bash
# Chamado por `data "external"` no Terraform. Gera o par de chaves VAPID (Web Push)
# apenas na primeira vez; se ja existir no SSM, reusa (evita invalidar subscriptions
# de push existentes a cada `terraform apply`).
# Entrada (stdin JSON): {"root": "<path do projeto>", "region": "...", "project": "..."}
# Saida (stdout JSON): {"public": "...", "private": "..."}
set -euo pipefail
eval "$(jq -r '@sh "ROOT=\(.root) REGION=\(.region) PROJECT=\(.project)"')"

EXISTING_PUB=$(aws ssm get-parameter --name "/$PROJECT/VAPID_PUBLIC" --with-decryption \
  --region "$REGION" --query Parameter.Value --output text 2>/dev/null || echo "")
EXISTING_PRIV=$(aws ssm get-parameter --name "/$PROJECT/VAPID_PRIVATE" --with-decryption \
  --region "$REGION" --query Parameter.Value --output text 2>/dev/null || echo "")

if [ -n "$EXISTING_PUB" ] && [ -n "$EXISTING_PRIV" ]; then
  jq -n --arg pub "$EXISTING_PUB" --arg priv "$EXISTING_PRIV" '{public:$pub, private:$priv}'
  exit 0
fi

if [ ! -d "$ROOT/node_modules/web-push" ]; then
  (cd "$ROOT" && npm install web-push >/dev/null 2>&1)
fi

node -e "
const { generateVAPIDKeys } = require('$ROOT/node_modules/web-push');
const k = generateVAPIDKeys();
process.stdout.write(JSON.stringify({ public: k.publicKey, private: k.privateKey }));
"
