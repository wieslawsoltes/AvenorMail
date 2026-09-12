import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { randomBytes,createCipheriv,createDecipheriv } from 'node:crypto';

/** Shared encrypted attachment storage for independently deployed API nodes. */
export class S3Bucket {
  constructor({env,client}) {
    this.bucket=env.S3_BUCKET;this.prefix=(env.S3_PREFIX||'avenor/').replace(/^\/+/, '');
    this.key=Buffer.from(env.DATA_KEY||'','base64');
    if(!this.bucket||this.key.length!==32)throw Error('S3_BUCKET and a 32-byte DATA_KEY are required');
    this.client=client||new S3Client({region:env.AWS_REGION||'us-east-1',endpoint:env.S3_ENDPOINT||undefined,forcePathStyle:env.S3_FORCE_PATH_STYLE==='true',maxAttempts:3});
  }
  path(id){if(!/^[a-zA-Z0-9:_-]{1,250}$/.test(id))throw Error('Invalid file identifier');return this.prefix+id;}
  async put(id,data){
    const key=this.path(id),plain=Buffer.from(data instanceof ReadableStream?await new Response(data).arrayBuffer():data);
    const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.key,iv);cipher.setAAD(Buffer.from(key));
    const body=Buffer.concat([Buffer.from('AVN2'),iv,cipher.update(plain),cipher.final(),cipher.getAuthTag()]);
    await this.client.send(new PutObjectCommand({Bucket:this.bucket,Key:key,Body:body,ContentType:'application/octet-stream',Metadata:{format:'AVN2'},ChecksumAlgorithm:'SHA256'}));
  }
  async get(id){
    const key=this.path(id);let result;
    try{result=await this.client.send(new GetObjectCommand({Bucket:this.bucket,Key:key}));}catch(error){if(error.name==='NoSuchKey'||error.$metadata?.httpStatusCode===404)return null;throw error;}
    const bytes=Buffer.from(await result.Body.transformToByteArray());
    if(bytes.length<32||bytes.subarray(0,4).toString()!=='AVN2')throw Error('Invalid encrypted attachment');
    const decipher=createDecipheriv('aes-256-gcm',this.key,bytes.subarray(4,16));decipher.setAAD(Buffer.from(key));decipher.setAuthTag(bytes.subarray(-16));
    const plain=Buffer.concat([decipher.update(bytes.subarray(16,-16)),decipher.final()]);
    return {body:new Blob([plain]).stream(),arrayBuffer:async()=>plain.buffer.slice(plain.byteOffset,plain.byteOffset+plain.byteLength)};
  }
  async head(id){try{const result=await this.client.send(new HeadObjectCommand({Bucket:this.bucket,Key:this.path(id)}));return {size:Math.max(0,Number(result.ContentLength)-32)};}catch(error){if(error.name==='NotFound'||error.$metadata?.httpStatusCode===404)return null;throw error;}}
  async delete(id){await this.client.send(new DeleteObjectCommand({Bucket:this.bucket,Key:this.path(id)}));}
}
