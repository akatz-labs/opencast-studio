import {z} from 'zod';
import path from 'node:path';

export const resourceAction=z.discriminatedUnion('action',[
 z.strictObject({action:z.literal('setup')}),z.strictObject({action:z.literal('model-folder'),path:z.string().trim().min(1).max(4096).refine(v=>path.posix.isAbsolute(v)&&!/[\0\r\n]/.test(v)&&!['/','/home','/data','/tmp','/usr','/var','/opt'].includes(path.posix.resolve(v)),'Choose a dedicated absolute model directory')}),z.strictObject({action:z.literal('initialize')}),z.strictObject({action:z.literal('scan')}),
 z.strictObject({action:z.literal('download'),resourceIds:z.array(z.string()).min(1).max(32)}),
]);
