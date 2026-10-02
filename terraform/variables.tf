variable "aws_region" {
  description = "Regiao AWS onde a infra e criada."
  type        = string
  default     = "us-east-1"
}

variable "aws_profile" {
  description = "Profile do AWS CLI/SDK usado pelo provider."
  type        = string
  default     = "felipelageduarte"
}

variable "project" {
  description = "Prefixo usado em todos os nomes de recurso (deve bater com aws/deploy-ec2.sh)."
  type        = string
  default     = "wa-assistant"
}

variable "instance_type" {
  description = "Tipo da instancia EC2. t4g.small (ARM/Graviton) e o mesmo usado no deploy original."
  type        = string
  default     = "t4g.small"
}

variable "domain" {
  description = "Dominio publico do app (Caddy emite TLS via Let's Encrypt automaticamente). Vazio = HTTP puro na porta 80 SEM dominio proprio — modo usado quando o BotImovel (CloudFront) serve este app via path /whatsapp/* na frente, terminando TLS la (ver infra/terraform/cloudfront.tf no repo BotImovelWeb). So' use um dominio aqui se for expor esta EC2 direto, sem CloudFront na frente."
  type        = string
  default     = "whatsapp-bridge.botimovel.com.br"
}

variable "bedrock_model" {
  description = "ID do modelo Bedrock usado pelo LLM (ver AWS_REGION x disponibilidade de modelo)."
  type        = string
  default     = "us.anthropic.claude-sonnet-4-6"
}

variable "allowed_ssh_cidr" {
  description = "CIDR permitido na porta 22 (SSH). Default: seu IP publico atual, detectado em tempo de apply."
  type        = string
  default     = null
}

variable "jwt_secret" {
  description = "Segredo de sessao JWT (HS256). Gere com: openssl rand -hex 32. Sensivel — passe via TF_VAR_jwt_secret ou terraform.tfvars (nao versionado)."
  type        = string
  sensitive   = true
}

variable "telegram_bot_token" {
  description = "Token do bot Telegram (opcional). Vazio = integracao Telegram desativada."
  type        = string
  sensitive   = true
  default     = ""
}

variable "vapid_subject" {
  description = "Contato do Web Push VAPID (mailto: ou https://)."
  type        = string
  default     = "mailto:felipelageduarte@gmail.com"
}

variable "ignore_groups" {
  description = "Ignorar mensagens de grupos do WhatsApp (so processa DMs)."
  type        = bool
  default     = true
}

variable "context_window" {
  description = "Quantidade de mensagens anteriores usadas como contexto para o LLM."
  type        = number
  default     = 15
}

variable "botimovel_api_url" {
  description = "URL base da API do BotImóvel (ex.: https://api.botimovel.com.br). Vazio = modo standalone, sem ponte."
  type        = string
  default     = ""
}

variable "botimovel_bridge_secret" {
  description = "Secret gerado em POST /whatsapp/bridge/rotate-secret (BotImóvel, admin) — autentica esta instância em /whatsapp/inbound e /whatsapp/outbox*."
  type        = string
  sensitive   = true
  default     = ""
}
