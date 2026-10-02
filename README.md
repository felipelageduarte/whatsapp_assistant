# WhatsApp Assistant

Monitora WhatsApp, lê mensagens novas, gera resposta sugerida com Claude (via
Amazon Bedrock) e **só envia depois da sua aprovação**. Multi-usuário (com
aprovação de admin), e **cada usuário pode conectar vários números**. Dois
frontends de aprovação: **Web app** (SPA + Web Push) e **bot do Telegram**.

> **Status: projeto pausado.** Infraestrutura AWS de produção foi desligada e
> desalocada em 2026-07-07 (custo não justificava uso ocioso). Todo o código,
> documentação e o Terraform para recriar a infra do zero ficam preservados
> neste repositório — ver [`terraform/README.md`](terraform/README.md) para
> reviver o projeto no futuro.

## Arquitetura

```
                 ┌─────────── EC2 t4g.small (Node 22+, sempre ligado) ──────────┐
                 │                                                              │
 user (login) ──▶│  Express API ── JWT auth ──┬── accounts (N por user)         │
                 │                            │      │                          │
 WhatsApp ─QR─▶  │  Session Manager ──────────┘   Map<accountId, BaileysSocket> │
   (N números)   │      │ msg nova                                              │
                 │      ▼                                                       │
                 │  store (SQLite) ──▶ Bedrock/Claude ──▶ fila "pending" ──▶ EventBus │
                 │                     (sob demanda, cacheado)      │            │
                 └───────────────────────────────────────────────────┼──────────┘
                                              ┌────────────────────┬─┴───────────┐
                                              ▼                    ▼             ▼
                                        Bot Telegram         Web app (SSE)   Web Push
                                         (push p/ dono)   aprovar/editar   (VAPID, PWA
                                                            /rejeitar      + Apple Watch)
```

Modelo de dados: `user(email)` 1─N `account(número)` 1─N
`messages/suggestions/media`. Tudo escopado por `owner` — usuário só vê/age
nas próprias sugestões. **Auth**: scrypt + JWT HS256, 1º cadastro vira admin,
demais aguardam aprovação, roles `admin`/`user`. **SQLite-backed** (instância
única, sem necessidade de banco gerenciado).

## Funcionalidades

- **Sugestão de resposta sob demanda**: ao abrir um chat, o backend gera (ou
  reusa do cache) uma sugestão com Claude, usando o histórico da conversa e o
  estilo de escrita do próprio dono naquele chat específico. Cache invalida
  automaticamente se chegou mensagem nova desde a última geração — evita
  chamada de LLM redundante em reaberturas.
- **Rascunho por conversa**: o texto sendo digitado (ou editado a partir da
  sugestão) é isolado por chat — trocar de conversa não perde nem mistura
  rascunhos.
- **Mídia inline**: imagens, figurinhas, vídeos, áudios e documentos
  recebidos são baixados sob demanda do WhatsApp, cacheados no S3 (dedupe por
  `wa_id`) e servidos via streaming HTTP para renderização direta no chat.
- **Web Push (VAPID)**: notifica o dono quando chega mensagem nova — funciona
  em browser desktop e em PWA instalado no iPhone (iOS 16.4+), que espelha a
  notificação no Apple Watch.
- **Telegram** (opcional): bot compartilhado entre usuários, cada um vincula o
  próprio `chat_id`; aprovar/editar/rejeitar sugestões direto pelo Telegram.
- **Multi-conta**: cada usuário conecta N números de WhatsApp via QR code,
  todos gerenciados no mesmo processo (`Map<accountId, BaileysSocket>`).
- **Persistência de sessão via S3**: credenciais Baileys (pareamento do
  WhatsApp) ficam no S3 em vez de disco local — sobrevivem à substituição da
  instância EC2, sem precisar re-escanear o QR a cada deploy.

## Rodar local

```bash
cp .env.example .env          # preencha JWT_SECRET (openssl rand -hex 32)
npm install
npm start                     # http://localhost:3000
```

Sem `WA_AUTH_BUCKET` definido, credenciais Baileys e mídia caem em disco local
(`data/auth/`, sem cache de mídia em S3). Sem credencial AWS válida, o LLM
(Bedrock) e o Web Push (se `VAPID_*` vazio) ficam desativados — o app roda,
mas sem sugestão automática nem notificação push.

1. Abra o web app, **crie a conta** (a primeira vira admin).
2. Aba **Números** › *Conectar número* › escaneie o QR (WhatsApp › Aparelhos
   conectados).
3. Mensagens recebidas aparecem na aba **Sugestões**; abrir um chat gera a
   sugestão sob demanda. Aprove/edite/rejeite.
4. **Telegram** (opcional): ponha `TELEGRAM_BOT_TOKEN` no `.env`, `/start` no
   bot, cole o chat id em *Configurações*.

## Deploy AWS (EC2 t4g.small ARM)

Baileys mantém um WebSocket vivo 24/7 por número — **não cabe em Lambda**. Por
isso EC2 sempre-ligado, com LLM via **Amazon Bedrock** (autenticação por IAM
role da instância, sem API key armazenada).

```bash
# AWS CLI logado no profile felipelageduarte; .env com JWT_SECRET preenchido
DOMAIN=assistant.seudominio.com bash aws/deploy-ec2.sh
```

O script (idempotente) provisiona: bundle do código no S3, segredos no SSM
Parameter Store (SecureString: `JWT_SECRET`, `TELEGRAM_BOT_TOKEN`,
`VAPID_PUBLIC/PRIVATE/SUBJECT`), bucket S3 privado para credenciais Baileys +
mídia, IAM role (Bedrock + SSM + S3), security group (80/443 público, 22 só
do seu IP), Elastic IP (endereço estável) e a EC2 com user-data que instala
**Node 24 + Caddy (HTTPS automático via Let's Encrypt) + systemd**. Aponte um
registro A do domínio para o IP de saída.

- Sem `DOMAIN`: serve em HTTP na porta 80 (**inseguro para login** em internet
  pública — use só para teste, ou restrinja o SG ao seu IP).
- Atualizar código: re-suba o bundle e `systemctl restart wa-assistant` (via
  `aws ssm start-session`).
- **Destruir tudo**: `bash aws/teardown-ec2.sh` — termina a EC2, libera o
  Elastic IP, apaga os 2 buckets S3 (**incluindo sessão WhatsApp pareada e
  mídia cacheada** — religar exige novo QR scan), IAM role, security group,
  key pair e todos os parâmetros SSM. Irreversível.
- **Reviver do zero no futuro**: use o [Terraform em
  `terraform/`](terraform/README.md), que recria toda essa infra de forma
  declarativa a partir do estado atual do código.

Custo: ~US$ 6–8/mês (t4g.small + EBS 20GB + Elastic IP associado) + uso da API
Bedrock (Claude) por token.

## Config (.env)

| Var | Função |
|-----|--------|
| `AWS_REGION` | Região AWS para Bedrock/S3/SSM (padrão `us-east-1`) |
| `BEDROCK_MODEL` | ID do modelo Bedrock (ex: `us.anthropic.claude-sonnet-4-6`) |
| `JWT_SECRET` | Segredo de sessão — **gere forte** (`openssl rand -hex 32`) |
| `WA_AUTH_BUCKET` | Bucket S3 para credenciais Baileys + mídia. Vazio = disco local (`data/auth/`), sem cache de mídia |
| `VAPID_PUBLIC` / `VAPID_PRIVATE` / `VAPID_SUBJECT` | Chaves Web Push (gerar com `web-push` ou via `aws/deploy-ec2.sh`). Vazio = push desativado |
| `TELEGRAM_BOT_TOKEN` | Bot compartilhado (vazio = Telegram off; chat id é por-usuário) |
| `PORT` | Porta HTTP do Express (padrão `3000`) |
| `IGNORE_GROUPS` | Ignora mensagens de grupo, só processa DMs (padrão `true`) |
| `CONTEXT_WINDOW` | Nº de mensagens anteriores usadas como contexto pro LLM (padrão `15`) |
| `PERSONA` | Instrução de tom/estilo passada ao LLM ao gerar sugestões |

## Estrutura

| Arquivo | Responsabilidade |
|---------|------------------|
| `src/index.js` | Bootstrap: restaura sessões WhatsApp salvas, sobe o servidor HTTP |
| `src/config.js` | Carrega `.env`, exporta config tipada com defaults |
| `src/whatsapp.js` | Session Manager: N sockets Baileys, QR, restore no boot, download+cache de mídia (S3), envio de mensagem |
| `src/s3auth.js` | Auth state do Baileys persistido no S3 (substitui disco local, sobrevive à troca de instância) |
| `src/auth.js` | scrypt + JWT HS256, register/login, middleware de autenticação |
| `src/store.js` | SQLite: users, accounts, messages, suggestions, media, push subscriptions — queries per-chat para contexto/tom |
| `src/actions.js` | Aprovar/rejeitar sugestão — lógica única compartilhada por Web e Telegram, valida posse (`owner`) |
| `src/llm.js` | Geração de sugestão via Bedrock/Claude a partir do histórico e estilo do dono naquele chat |
| `src/bus.js` | EventBus em processo — conecta core aos frontends (eventos `suggestion`, `updated`, `wa-status`, `incoming`) |
| `src/push.js` | Web Push (VAPID) — notifica o dono em mensagem nova |
| `src/api.js` | REST + SSE: auth, accounts, sugestão sob demanda, stream de mídia, admin |
| `src/telegram.js` | Bot multi-usuário (push pro chat id do dono, aprovação inline) |
| `web/` | SPA: login, números+QR, chat com mídia inline, sugestões, config, admin |
| `aws/deploy-ec2.sh` | Provisão EC2 idempotente (imperativo, via AWS CLI) |
| `aws/teardown-ec2.sh` | Desprovisiona tudo criado por `deploy-ec2.sh` |
| `terraform/` | Recriação declarativa completa da infra (ver seu próprio README) |

## Modo ponte (integração com BotImóvel)

Quando `BOTIMOVEL_API_URL`/`BOTIMOVEL_BRIDGE_SECRET` estão setados (`.env.example`), este
processo vira uma camada fina de conexão: mensagem recebida (`src/whatsapp.js` `handleIncoming`)
é encaminhada pra `POST {BOTIMOVEL_API_URL}/whatsapp/inbound` em vez de só alimentar a
sugestão/aprovação local — o rascunho é gerado lá (com acesso a fornecedores/clientes/projetos
cadastrados no BotImóvel, não só estilo de escrita) e a aprovação acontece no Telegram do
BotImóvel ("aprovar N"/"editar N: texto"/"rejeitar N"), não na UI web deste app. Um polling em
`GET {BOTIMOVEL_API_URL}/whatsapp/outbox` (`src/bridge.js`, a cada `BOTIMOVEL_POLL_MS`) entrega o
que foi aprovado via `sendFromAccount` e confirma em `POST /whatsapp/outbox/{id}/delivered`.

Sem essas variáveis o app continua funcionando 100% standalone (sugestão/aprovação local via
Bedrock + web app/Telegram deste próprio repo) — o modo ponte é aditivo, não substitui nada.

Ver `docs/agent.md` (seção "Ponte WhatsApp") no repositório do BotImóvel pro desenho completo do
outro lado.

## Decisões de design relevantes

- **Sugestão sob demanda, não em background**: versão anterior gerava
  sugestão via timer debounced (7s) para toda mensagem recebida em qualquer
  conversa — custo de LLM proporcional ao volume de mensagens, não ao
  engajamento real do usuário. Migrado para geração no momento em que o chat é
  aberto, com cache invalidado por timestamp (só regenera se chegou mensagem
  nova desde a última sugestão). Custo passa a ser por-chat-aberto, não
  por-mensagem-recebida.
- **Bedrock em vez de API key direta da Anthropic**: autenticação via IAM role
  da instância EC2 — nenhuma API key para gerenciar/rotacionar/vazar.
- **SQLite em vez de banco gerenciado**: instância única, sem necessidade de
  alta disponibilidade — reduz custo e complexidade operacional.

## Avisos

- **Não-oficial:** Baileys usa o protocolo do WhatsApp Web. Viola os ToS —
  risco de ban (maior com vários números no mesmo IP). Use números
  secundários.
- **Privacidade:** o texto das conversas é enviado à API do Claude (via
  Bedrock) para gerar sugestões.
- **Persistência das sessões:** com `WA_AUTH_BUCKET` definido, credenciais
  Baileys ficam no S3 e sobrevivem à troca de instância EC2. Sem essa
  variável, ficam em `data/auth/<accountId>` (disco local) e **não**
  sobrevivem à troca de instância — re-parear o QR nesse caso.
