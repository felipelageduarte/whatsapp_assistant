// Auth state do Baileys persistido no S3 (sobrevive a troca de instancia EC2).
// Modela useMultiFileAuthState, mas cada "arquivo" e um objeto S3 sob
// wa-auth/<accountId>/. Cache em memoria evita round-trip por leitura de chave.
import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand,
         ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { initAuthCreds, BufferJSON, proto } from '@whiskeysockets/baileys';
import { config } from './config.js';

const s3 = new S3Client({ region: config.awsRegion });
const BUCKET = config.authBucket;
const keyFor = (accountId, file) => `wa-auth/${accountId}/${file}`;

const streamToString = async (body) => {
  const chunks = [];
  for await (const c of body) chunks.push(typeof c === 'string' ? Buffer.from(c) : c);
  return Buffer.concat(chunks).toString('utf-8');
};

export async function useS3AuthState(accountId) {
  const cache = new Map(); // file -> parsed value

  const readData = async (file) => {
    if (cache.has(file)) return cache.get(file);
    try {
      const r = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: keyFor(accountId, file) }));
      const value = JSON.parse(await streamToString(r.Body), BufferJSON.reviver);
      cache.set(file, value);
      return value;
    } catch (err) {
      if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) return null;
      throw err;
    }
  };

  const writeData = async (data, file) => {
    cache.set(file, data);
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: keyFor(accountId, file),
      Body: JSON.stringify(data, BufferJSON.replacer),
      ContentType: 'application/json',
    }));
  };

  const removeData = async (file) => {
    cache.delete(file);
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: keyFor(accountId, file) })).catch(() => {});
  };

  const creds = (await readData('creds.json')) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(ids.map(async (id) => {
            let value = await readData(`${type}-${id}.json`);
            if (type === 'app-state-sync-key' && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }
            data[id] = value;
          }));
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const file = `${category}-${id}.json`;
              tasks.push(value ? writeData(value, file) : removeData(file));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: () => writeData(creds, 'creds.json'),
  };
}

// Remove todas as credenciais de um account (logout).
export async function deleteS3Auth(accountId) {
  const prefix = `wa-auth/${accountId}/`;
  let token;
  do {
    const list = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix, ContinuationToken: token }));
    const objs = (list.Contents || []).map((o) => ({ Key: o.Key }));
    if (objs.length) {
      await s3.send(new DeleteObjectsCommand({ Bucket: BUCKET, Delete: { Objects: objs } }));
    }
    token = list.IsTruncated ? list.NextContinuationToken : undefined;
  } while (token);
}
