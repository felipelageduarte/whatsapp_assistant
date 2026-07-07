# Terraform — reviver a infra do WhatsApp Assistant

Este diretório recria do zero **toda** a infraestrutura AWS que o projeto usava em
produção (equivalente declarativo de `aws/deploy-ec2.sh`). Use isto se decidir
reativar o projeto no futuro, depois que a infra original foi desligada e
desalocada.

## O que é criado

| Recurso | Detalhe |
|---|---|
| `aws_instance` | EC2 `t4g.small` (ARM/Graviton), Amazon Linux 2023, 20GB gp3 |
| `aws_eip` | IP público estável (associado à instância) |
| `aws_s3_bucket` × 2 | `wa-assistant-bundle-<account>` (código) e `wa-assistant-auth-<account>` (sessão Baileys + mídia, privado) |
| `aws_iam_role` + `aws_iam_instance_profile` | Permissões: `bedrock:InvokeModel*`, `ssm:GetParameter` (escopo `/wa-assistant/*`), `kms:Decrypt`, S3 R/W no bucket de auth, S3 read no bucket de bundle, + `AmazonSSMManagedInstanceCore` (Session Manager, sem precisar abrir SSH) |
| `aws_security_group` | 80/443 público, 22 restrito ao seu IP público atual (detectado em tempo de apply) |
| `aws_key_pair` + `tls_private_key` | Par de chaves gerado pelo Terraform, salvo em `../aws/wa-assistant-key.pem` |
| `aws_ssm_parameter` × 5 | `JWT_SECRET`, `TELEGRAM_BOT_TOKEN` (se definido), `VAPID_PUBLIC/PRIVATE/SUBJECT` — todos `SecureString` |
| `null_resource.bundle` | Empacota `src/` + `web/` + `package*.json` em tar.gz e sobe pro S3 sempre que o conteúdo mudar |

O `user_data` da instância (template em `templates/user-data.sh.tftpl`) instala
Node 24, Caddy (TLS automático via Let's Encrypt) e registra um serviço
`systemd` que roda `node src/index.js` sempre ligado — Baileys mantém um
WebSocket vivo 24/7 por número conectado, por isso não cabe em Lambda.

## O que NÃO é recriado

- **Dados da aplicação**: SQLite (`data/assistant.db`) e sessão WhatsApp
  pareada. Isso é estado de runtime, não infraestrutura — se o bucket de auth
  foi apagado no teardown, será necessário **re-parear o WhatsApp via QR code**
  na primeira vez que a nova instância subir.
- **Registro DNS**: aponte manualmente um registro `A` do seu domínio para o
  `public_ip` do output, no seu provedor de DNS (ex: registro.br).

## Pré-requisitos

```bash
brew install terraform jq awscli
aws configure --profile felipelageduarte   # ou o profile que preferir
```

## Uso

```bash
cd terraform
cp terraform.tfvars.example terraform.tfvars
# edite terraform.tfvars: jwt_secret (openssl rand -hex 32), domain, etc.

terraform init
terraform plan
terraform apply
```

Após `apply` (bootstrap leva ~3-5 min):

```bash
terraform output                      # IP, comando SSH, URL do app
terraform output -raw bootstrap_logs_command | sh   # acompanha o boot via SSM
```

No provedor de DNS, crie o registro A:

```
assistant.seudominio.com.  A  <public_ip do output>
```

Aguarde a propagação — o Caddy emite o certificado TLS sozinho e o app fica em
`https://<domain>`.

Abra o app, crie sua conta (a primeira vira admin), vá em **Números** e
escaneie o QR para reparear o WhatsApp.

## Atualizar código depois de mudanças

O bundle é re-empacotado e reenviado automaticamente sempre que `terraform
apply` detecta mudança em `src/`, `web/` ou `package*.json` (hash de conteúdo
como trigger). Depois de subir o bundle novo, reinicie o serviço na instância:

```bash
aws ssm send-command --instance-ids "$(terraform output -raw instance_id)" \
  --document-name AWS-RunShellScript \
  --parameters 'commands=["cd /opt/wa && aws s3 cp s3://'"$(terraform output -raw bundle_bucket)"'/bundle.tgz . && tar -xzf bundle.tgz && rm bundle.tgz && npm install --omit=dev && systemctl restart wa-assistant"]' \
  --region us-east-1 --profile felipelageduarte
```

## Destruir de novo

```bash
terraform destroy
```

Isso apaga tudo criado por este Terraform, **incluindo o bucket de auth**
(sessão WhatsApp + mídia cacheada). Se preferir manter a sessão pareada entre
ciclos de subir/derrubar infra, use `terraform destroy -target=...` excluindo
`aws_s3_bucket.auth`, ou remova o recurso do state antes (`terraform state
rm aws_s3_bucket.auth`) e apague-o manualmente depois.

## Custo estimado

~US$ 6–8/mês (EC2 t4g.small + EBS 20GB + Elastic IP associado) + uso da API
Bedrock (Claude) por token.
