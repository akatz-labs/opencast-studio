// Preserve the tested FLUX3 recipe and Pika video stage; only replace the anchor.
import fs from 'node:fs';
const root=new URL('../resources/motion/',import.meta.url);
const graph=JSON.parse(fs.readFileSync(new URL('source/pika-auto.api.json',root)));
const flux=JSON.parse(fs.readFileSync(new URL('source/flux3-edit.api.json',root)));
const node=(type,inputs)=>({class_type:type,inputs});
for(const id of Object.keys(graph))if(id.startsWith('508:'))delete graph[id];
graph['7000']=node('GetVideoComponents',{video:['31',0]});
graph['7001']=node('ImageFromBatch',{image:['7000',0],batch_index:0,length:1});
graph['7002']=node('ComfySwitchNode',{switch:['504',0],on_false:['12',0],on_true:['13',0]});
graph['7003']=node('ComfySwitchNode',{switch:['503',0],on_false:['7001',0],on_true:['7002',0]});
const mapping={'10':'7001','11':'12','12':'7002'};
for(const id of Object.keys(flux))if(!mapping[id])mapping[id]=String(7100+Number(id));
for(const [id,n]of Object.entries(flux)){
 if(['10','11','12','9'].includes(id))continue;
 graph[mapping[id]]={...n,inputs:Object.fromEntries(Object.entries(n.inputs).map(([k,v])=>[k,Array.isArray(v)?[mapping[v[0]],v[1]]:v]))};
}
const instruction='Edit Image 1 using the character from Image 2. Keep the target’s exact pose, expression, gaze, screen position, scale and camera framing. Preserve the reference character’s identity, distinctive proportions, hairstyle, complete outfit and accessories. Image 2 shows multiple views of one character.';
graph['7010']=node('PrimitiveStringMultiline',{value:instruction+' Keep the background, other people and scene lighting unchanged. Produce one finished scene, not a character sheet.'});
graph['7011']=node('PrimitiveStringMultiline',{value:instruction+' Replace the entire background with Image 3, remove all other people, and match its lighting. Produce one finished scene, not a character sheet.'});
graph['7012']=node('ComfySwitchNode',{switch:['503',0],on_false:['7010',0],on_true:['7011',0]});
graph['7013']=node('StringConcatenate',{string_a:['25',0],string_b:['7012',0],delimiter:' '});
graph['7147'].inputs.prompt=['7013',0];
graph['7014']=node('PrimitiveStringMultiline',{value:graph['7147'].inputs.system_prompt});
graph['7147'].inputs.system_prompt=['7014',0];
graph['7107'].inputs.seed=['501',0];
// Lazy switches preserve the tested two-image swap and three-image transfer.
graph['7151']=node('BatchImagesNode',{'images.image0':['7001',0],'images.image1':['12',0],'images.image2':['7002',0]});
graph['7153']=node('ComfySwitchNode',{switch:['503',0],on_false:['7150',0],on_true:['7151',0]});
graph['7147'].inputs.image=['7153',0];
graph['7118']=structuredClone(graph['7117']);graph['7118'].inputs['images.image2']=['7002',0];
for(let index=0;index<3;index++)graph[String(7160+index)]=node('ComfySwitchNode',{switch:['503',0],on_false:['7117',index],on_true:['7118',index]});
Object.assign(graph['7107'].inputs,{positive:['7160',0],negative:['7161',0],latent_image:['7162',0]});
for(const n of Object.values(graph))for(const [key,value]of Object.entries(n.inputs)){
 if(!Array.isArray(value))continue;
 if(value[0]==='508:247')n.inputs[key]=['7108',0];
 if(value[0]==='508:309')n.inputs[key]=['7001',0];
 if(value[0]==='508:321')n.inputs[key]=['7003',0];
}
graph['10'].inputs.file='source.mp4';graph['12'].inputs.image='character.png';graph['13'].inputs.image='background.png';
graph['25'].inputs.value='Replace the main person in the video.';
graph['23'].inputs.filename_prefix='OpenCast/video';graph['248'].inputs.filename_prefix='OpenCast/anchor';
// Numeric IDs let the native frontend author actual subgraphs from the flat API.
const ids=Object.fromEntries(Object.keys(graph).map((id,index)=>[id,id.includes(':')?String(8000+index):id]));
const flat=Object.fromEntries(Object.entries(graph).map(([id,n])=>[ids[id],{...n,inputs:Object.fromEntries(Object.entries(n.inputs).map(([key,v])=>[key,Array.isArray(v)?[ids[v[0]],v[1]]:v]))}]));
for(const n of Object.values(flat))for(const value of Object.values(n.inputs))if(Array.isArray(value)&&!flat[value[0]])throw new Error('Unresolved graph connection');
fs.writeFileSync(new URL('pipeline.flat.api.json',root),JSON.stringify(flat,null,2)+'\n');
fs.writeFileSync(new URL('members.json',root),JSON.stringify({anchor:Object.keys(flat).filter(id=>Number(id)>=7000&&Number(id)<8000),models:Object.keys(graph).filter(id=>id.startsWith('509:')).map(id=>ids[id]),video:Object.keys(graph).filter(id=>id.startsWith('510:')).map(id=>ids[id])},null,2)+'\n');
