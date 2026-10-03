// Transcricao de audio (mensagens de voz do WhatsApp) via Amazon Transcribe.
// O audio ja esta no S3 (ensureMedia em whatsapp.js) — inicia um batch job,
// faz poll ate concluir e devolve o texto. Autentica pela IAM role da EC2
// (mesmo padrao do Bedrock em llm.js); o Transcribe le o objeto do S3 com as
// permissoes do caller, entao a policy de s3:GetObject do auth bucket basta.
import {
  TranscribeClient,
  StartTranscriptionJobCommand,
  GetTranscriptionJobCommand,
  DeleteTranscriptionJobCommand,
} from '@aws-sdk/client-transcribe';
import { config } from './config.js';

const client = new TranscribeClient({ region: config.awsRegion });

// mime do WhatsApp (ex.: "audio/ogg; codecs=opus") -> MediaFormat do Transcribe
function mediaFormat(mime = '') {
  const m = mime.toLowerCase();
  if (m.includes('ogg') || m.includes('opus')) return 'ogg';
  if (m.includes('mp4') || m.includes('m4a') || m.includes('aac')) return 'mp4';
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3';
  if (m.includes('wav')) return 'wav';
  if (m.includes('webm')) return 'webm';
  if (m.includes('amr')) return 'amr';
  if (m.includes('flac')) return 'flac';
  return 'ogg';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Transcreve s3://<authBucket>/<s3Key> e devolve o texto (ou null se falhar).
// Poll de 3s ate 120s — mensagens de voz tipicas (<2min) concluem em ~10-40s.
export async function transcribeAudio({ s3Key, mime, jobHint }) {
  const safe = String(jobHint || 'audio').replace(/[^0-9a-zA-Z._-]/g, '');
  const jobName = `wa-${safe}-${Date.now()}`.slice(0, 200);
  await client.send(new StartTranscriptionJobCommand({
    TranscriptionJobName: jobName,
    LanguageCode: 'pt-BR',
    MediaFormat: mediaFormat(mime),
    Media: { MediaFileUri: `s3://${config.authBucket}/${s3Key}` },
  }));
  try {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      await sleep(3000);
      const { TranscriptionJob: job } = await client.send(
        new GetTranscriptionJobCommand({ TranscriptionJobName: jobName })
      );
      const status = job?.TranscriptionJobStatus;
      if (status === 'COMPLETED') {
        const uri = job.Transcript?.TranscriptFileUri;
        if (!uri) return null;
        const res = await fetch(uri);
        if (!res.ok) return null;
        const data = await res.json();
        const text = (data?.results?.transcripts || [])
          .map((t) => t.transcript)
          .join(' ')
          .trim();
        return text || null;
      }
      if (status === 'FAILED') {
        console.error(`[transcribe] job ${jobName} falhou:`, job?.FailureReason);
        return null;
      }
    }
    console.error(`[transcribe] timeout aguardando job ${jobName}`);
    return null;
  } finally {
    // Job concluido/abandonado nao precisa ficar listado no servico.
    client.send(new DeleteTranscriptionJobCommand({ TranscriptionJobName: jobName })).catch(() => {});
  }
}
