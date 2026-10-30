import {z} from 'zod';

export const assetId = z.uuid();
const key = z.uuid();
const seed = z.number().int().min(0).max(2147483647);
export const characterParameters = z.strictObject({
 traits:z.record(z.string().max(80),z.string().max(200)), direction:z.string().max(2000).default(''),
 framing:z.enum(['character-sheet','portrait','full-body']).default('character-sheet'),
 promptOverride:z.string().max(12000).default(''), fullBodyPromptOverride:z.string().max(12000).default(''),
 steps:z.literal(8).default(8), batchSize:z.number().int().min(1).max(4).default(1), seed,
 bodySeed:seed.optional(), referenceTop:z.number().int().min(0).max(512).default(48),
});
const motionParameters = z.strictObject({
 prompt:z.string().max(2000).default(''), quality:z.enum(['480p','720p']), keepAudio:z.boolean(),
 seed:seed.optional(),anchorSeed:seed.optional(),
});
export const generationRequest = z.discriminatedUnion('kind',[
 z.strictObject({idempotencyKey:key,kind:z.literal('character'),parameters:characterParameters}),
 z.strictObject({idempotencyKey:key,kind:z.literal('character-swap'),inputs:z.strictObject({video:assetId,character:assetId}),parameters:motionParameters}),
 z.strictObject({idempotencyKey:key,kind:z.literal('motion-transfer'),inputs:z.strictObject({video:assetId,character:assetId,background:assetId.optional()}),parameters:motionParameters}),
]);
export const uploadRequest = z.strictObject({idempotencyKey:key,kind:z.enum(['image','video']),name:z.string().min(1).max(160),contentType:z.enum(['image/png','image/jpeg','image/webp','video/mp4','video/webm','video/quicktime']),bytes:z.number().int().positive().max(200*1024*1024)}).superRefine((v,c)=>{
 if(!v.contentType.startsWith(v.kind+'/')||(v.kind==='image'&&v.bytes>10*1024*1024))c.addIssue({code:'custom',message:'Unsupported media type or size'});
});
export const importRequest = z.strictObject({kind:z.enum(['gallery','generated']),id:z.string().regex(/^[\w-]+$/),role:z.enum(['sheet','portrait','body','manifest']).default('sheet')});
export const renameRequest = z.strictObject({name:z.string().trim().min(1).max(80).regex(/^[^\u0000-\u001f\u007f]+$/)});
export const access = z.strictObject({url:z.string(),downloadUrl:z.string(),expiresAt:z.iso.datetime().nullable()});
export const uploadResponse = z.object({asset:z.object({id:assetId,status:z.enum(['pending','ready','rejected'])}),upload:z.object({url:z.string(),method:z.enum(['PUT','POST']),headers:z.record(z.string(),z.string()),fields:z.record(z.string(),z.string()).optional(),expiresAt:z.iso.datetime()}).nullable()});
export const job = z.object({id:z.string(),kind:z.enum(['character','character-swap','motion-transfer']),name:z.string(),status:z.enum(['queued','dispatching','queued-worker','starting','preparing','submitting','running','rendering','retaining','finalizing','complete','failed','cancelled','uncertain']),createdAt:z.iso.datetime(),requestKey:z.string().optional(),details:z.record(z.string(),z.unknown()),outputs:z.record(z.string(),z.object({assetId,access})),error:z.string().optional()});
export type GenerationRequest = z.infer<typeof generationRequest>;
export type Job = z.infer<typeof job>;
export const schemas = {generationRequest,uploadRequest,importRequest,renameRequest,uploadResponse,job,access};
