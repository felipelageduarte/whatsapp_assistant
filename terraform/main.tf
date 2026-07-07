# =============================================================================
# WhatsApp Assistant — infraestrutura completa (recriacao do que aws/deploy-ec2.sh
# provisiona via AWS CLI). Uso: reviver o projeto no futuro sem reconstruir os
# passos manualmente.
#
# Recursos criados:
#   - 2x S3 bucket (bundle de codigo, auth/midia Baileys — privado)
#   - IAM role + instance profile (Bedrock InvokeModel, SSM GetParameter, S3 R/W)
#   - Security Group (80/443 publico, 22 restrito ao seu IP)
#   - Key pair EC2 (gerado pelo Terraform, salvo localmente)
#   - Elastic IP (endereco estavel para o registro DNS)
#   - EC2 t4g.small (Amazon Linux 2023 ARM64) com user-data: Node 22 + Caddy
#     (TLS automatico) + systemd
#   - Parametros SSM SecureString: JWT_SECRET, TELEGRAM_BOT_TOKEN, VAPID_*
#
# NAO recriado automaticamente (fora do escopo de infraestrutura):
#   - dados da aplicacao (SQLite em data/assistant.db, sessao Baileys pareada)
#     -> apos subir a infra, sera necessario re-parear o WhatsApp via QR code.
# =============================================================================

terraform {
  required_version = ">= 1.5"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    tls = {
      source  = "hashicorp/tls"
      version = "~> 4.0"
    }
    external = {
      source  = "hashicorp/external"
      version = "~> 2.3"
    }
    http = {
      source  = "hashicorp/http"
      version = "~> 3.4"
    }
  }
}

provider "aws" {
  region  = var.aws_region
  profile = var.aws_profile
}

data "aws_caller_identity" "current" {}

locals {
  root_dir      = abspath("${path.module}/..")
  account_id    = data.aws_caller_identity.current.account_id
  bundle_bucket = "${var.project}-bundle-${local.account_id}"
  auth_bucket   = "${var.project}-auth-${local.account_id}"
  role_name     = "${var.project}-role"
  profile_name  = "${var.project}-instance-profile"
  sg_name       = "${var.project}-sg"
  key_name      = "${var.project}-key"
}

# ── IP publico atual (para restringir SSH) ───────────────────────────────────
data "http" "my_ip" {
  url = "https://checkip.amazonaws.com"
}

locals {
  ssh_cidr = var.allowed_ssh_cidr != null ? var.allowed_ssh_cidr : "${trimspace(data.http.my_ip.response_body)}/32"
}

# ── VAPID keys (Web Push) — gera uma vez, reusa nas proximas execucoes ───────
data "external" "vapid" {
  program = ["bash", "${path.module}/scripts/gen-vapid.sh"]
  query = {
    root    = local.root_dir
    region  = var.aws_region
    project = var.project
  }
}

# ── Segredos SSM (SecureString) ──────────────────────────────────────────────
resource "aws_ssm_parameter" "jwt_secret" {
  name      = "/${var.project}/JWT_SECRET"
  type      = "SecureString"
  value     = var.jwt_secret
  overwrite = true
}

resource "aws_ssm_parameter" "telegram_bot_token" {
  count     = var.telegram_bot_token != "" ? 1 : 0
  name      = "/${var.project}/TELEGRAM_BOT_TOKEN"
  type      = "SecureString"
  value     = var.telegram_bot_token
  overwrite = true
}

resource "aws_ssm_parameter" "vapid_public" {
  name      = "/${var.project}/VAPID_PUBLIC"
  type      = "SecureString"
  value     = data.external.vapid.result.public
  overwrite = true
}

resource "aws_ssm_parameter" "vapid_private" {
  name      = "/${var.project}/VAPID_PRIVATE"
  type      = "SecureString"
  value     = data.external.vapid.result.private
  overwrite = true
}

resource "aws_ssm_parameter" "vapid_subject" {
  name      = "/${var.project}/VAPID_SUBJECT"
  type      = "SecureString"
  value     = var.vapid_subject
  overwrite = true
}

# ── S3: bundle de codigo ──────────────────────────────────────────────────────
resource "aws_s3_bucket" "bundle" {
  bucket = local.bundle_bucket
}

resource "aws_s3_bucket_public_access_block" "bundle" {
  bucket                  = aws_s3_bucket.bundle.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Empacota src/ + web/ + package*.json em tar.gz e sobe pro bucket sempre que
# o conteudo mudar (hash dos arquivos como trigger).
locals {
  src_files = fileset("${local.root_dir}/src", "**")
  web_files = fileset("${local.root_dir}/web", "**")
  bundle_hash = sha1(join("", concat(
    [for f in local.src_files : filesha1("${local.root_dir}/src/${f}")],
    [for f in local.web_files : filesha1("${local.root_dir}/web/${f}")],
    [filesha1("${local.root_dir}/package.json"), filesha1("${local.root_dir}/package-lock.json")]
  )))
}

resource "null_resource" "bundle" {
  triggers = {
    hash = local.bundle_hash
  }

  provisioner "local-exec" {
    command = <<-EOT
      set -euo pipefail
      TAR=$(mktemp -t wa-bundle-XXXX).tgz
      tar -C '${local.root_dir}' -czf "$TAR" src web package.json package-lock.json
      aws s3 cp "$TAR" 's3://${local.bundle_bucket}/bundle.tgz' --region '${var.aws_region}' --profile '${var.aws_profile}'
      rm -f "$TAR"
    EOT
  }

  depends_on = [aws_s3_bucket.bundle]
}

# ── S3: auth/midia Baileys (privado, sobrevive troca de instancia) ──────────
resource "aws_s3_bucket" "auth" {
  bucket = local.auth_bucket
}

resource "aws_s3_bucket_public_access_block" "auth" {
  bucket                  = aws_s3_bucket.auth.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# ── IAM role + instance profile ──────────────────────────────────────────────
data "aws_iam_policy_document" "assume_ec2" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "this" {
  name               = local.role_name
  assume_role_policy = data.aws_iam_policy_document.assume_ec2.json
}

resource "aws_iam_role_policy_attachment" "ssm_core" {
  role       = aws_iam_role.this.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

data "aws_iam_policy_document" "app_access" {
  statement {
    sid       = "Bedrock"
    actions   = ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"]
    resources = ["*"]
  }
  statement {
    sid       = "ReadOwnParams"
    actions   = ["ssm:GetParameter", "ssm:GetParameters"]
    resources = ["arn:aws:ssm:${var.aws_region}:${local.account_id}:parameter/${var.project}/*"]
  }
  statement {
    sid       = "DecryptOwnParams"
    actions   = ["kms:Decrypt"]
    resources = ["*"]
  }
  statement {
    sid       = "ReadBundle"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.bundle.arn}/*"]
  }
  statement {
    sid       = "AuthObjectRW"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["${aws_s3_bucket.auth.arn}/*"]
  }
  statement {
    sid       = "AuthListBucket"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.auth.arn]
  }
}

resource "aws_iam_role_policy" "app_access" {
  name   = "${var.project}-access"
  role   = aws_iam_role.this.id
  policy = data.aws_iam_policy_document.app_access.json
}

resource "aws_iam_instance_profile" "this" {
  name = local.profile_name
  role = aws_iam_role.this.name
}

# ── Security Group ────────────────────────────────────────────────────────────
data "aws_vpc" "default" {
  default = true
}

resource "aws_security_group" "this" {
  name        = local.sg_name
  description = "WhatsApp Assistant"
  vpc_id      = data.aws_vpc.default.id

  ingress {
    description = "HTTP"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  ingress {
    description = "HTTPS"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  ingress {
    description = "SSH (seu IP)"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = [local.ssh_cidr]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = var.project }
}

# ── Key pair (gerado pelo Terraform) ─────────────────────────────────────────
resource "tls_private_key" "this" {
  algorithm = "RSA"
  rsa_bits  = 4096
}

resource "aws_key_pair" "this" {
  key_name   = local.key_name
  public_key = tls_private_key.this.public_key_openssh
}

resource "local_sensitive_file" "private_key" {
  content         = tls_private_key.this.private_key_pem
  filename        = "${path.module}/../aws/${local.key_name}.pem"
  file_permission = "0600"
}

# ── AMI Amazon Linux 2023 ARM64 (mais recente) ───────────────────────────────
data "aws_ssm_parameter" "al2023_arm64" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64"
}

# ── user-data (bootstrap: Node 22 + Caddy + systemd) ─────────────────────────
locals {
  user_data = templatefile("${path.module}/templates/user-data.sh.tftpl", {
    project        = var.project
    region         = var.aws_region
    bundle_bucket  = local.bundle_bucket
    auth_bucket    = local.auth_bucket
    bedrock_model  = var.bedrock_model
    domain         = var.domain
    ignore_groups  = var.ignore_groups
    context_window = var.context_window
  })
}

resource "aws_instance" "this" {
  ami                    = data.aws_ssm_parameter.al2023_arm64.value
  instance_type          = var.instance_type
  key_name               = aws_key_pair.this.key_name
  vpc_security_group_ids = [aws_security_group.this.id]
  iam_instance_profile   = aws_iam_instance_profile.this.name
  user_data              = local.user_data
  # Substitui a instancia se o bootstrap mudar — o app em si atualiza via bundle,
  # nao por replace de instancia.
  user_data_replace_on_change = false

  root_block_device {
    volume_size = 20
    volume_type = "gp3"
  }

  tags = { Name = var.project }

  depends_on = [
    null_resource.bundle,
    aws_ssm_parameter.jwt_secret,
    aws_ssm_parameter.vapid_public,
    aws_ssm_parameter.vapid_private,
    aws_ssm_parameter.vapid_subject,
  ]
}

# ── Elastic IP (endereco estavel p/ registro DNS) ────────────────────────────
resource "aws_eip" "this" {
  domain   = "vpc"
  instance = aws_instance.this.id
  tags     = { Name = var.project }
}
