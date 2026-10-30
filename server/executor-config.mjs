import {z} from 'zod';
const identifier=z.string().regex(/^[\w.-]+$/);
export const executorConfiguration=z.strictObject({
 appId:identifier.default('opencast'),instanceId:identifier,executorId:identifier,
 target:z.strictObject({kind:z.enum(['local','ssh']),port:z.number().int().min(1).max(65535).default(8841),host:z.string().min(1).optional(),sshPort:z.number().int().min(1).max(65535).optional()}).refine(v=>v.kind!=='ssh'||!!v.host,'SSH target requires a host'),
 recipes:z.partialRecord(z.enum(['character','character-swap','motion-transfer']),z.strictObject({
  installationId:identifier,feature:identifier,revision:identifier,module:z.string().min(1),
  outputs:z.record(identifier,z.strictObject({name:z.string().regex(/^[\w.-]+$/).refine(v=>v!=='.'&&v!=='..'),contentType:z.enum(['image/png','image/jpeg','image/webp','video/mp4','video/webm','video/quicktime','application/json'])})),
 })).default({}),
});
