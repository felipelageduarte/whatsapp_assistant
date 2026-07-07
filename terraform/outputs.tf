output "instance_id" {
  value = aws_instance.this.id
}

output "public_ip" {
  description = "Elastic IP — aponte o registro A do dominio para este endereco."
  value       = aws_eip.this.public_ip
}

output "bundle_bucket" {
  value = aws_s3_bucket.bundle.bucket
}

output "auth_bucket" {
  value = aws_s3_bucket.auth.bucket
}

output "ssh_key_path" {
  description = "Chave privada SSH gerada (nao versionada — .gitignore)."
  value       = local_sensitive_file.private_key.filename
}

output "ssh_command" {
  value = "ssh -i ${local_sensitive_file.private_key.filename} ec2-user@${aws_eip.this.public_ip}"
}

output "bootstrap_logs_command" {
  description = "Acompanhar o bootstrap (Node+Caddy+app) via SSM, sem precisar de SSH."
  value       = "aws ssm start-session --target ${aws_instance.this.id} --profile ${var.aws_profile} --region ${var.aws_region}"
}

output "app_url" {
  value = var.domain != "" ? "https://${var.domain}" : "http://${aws_eip.this.public_ip}"
}
