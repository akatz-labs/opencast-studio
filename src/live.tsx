import React,{useState,useEffect,useRef} from 'react';
import {compileCharacterSheet,type Compiled} from '../shared/prompt.mjs';
import {Modal} from './ui';
import {Download,RotateCcw,LoaderCircle,Pencil,Plus,ScanFace} from 'lucide-react';
export type GenerationOptions={direction:string;framing:string;steps:number;seed:string;override:string;bodyOverride?:string;bodySeed?:string;referenceTop?:number};
const jobStatus:Record<string,string>={queued:'Queued', 'queued-worker':'Waiting for worker',submitting:'Submitting',preparing:'Starting runtime',running:'Generating',retaining:'Saving character sheet',uncertain:'Needs attention',failed:'Generation failed',cancelled:'Cancelled',complete:'Complete'};
export type LiveJob={id:string;name:string;number:number;requestKey?:string;batchId:string;batchIndex:number;status:string;created:string;traits:Record<string,string>;prompt:string;seed:number;steps:number;cfg:number;width:number;height:number;templateVersion:string;framing:string;direction:string;manualPrompt:boolean;image:string|null;manifest:string;error?:string;executionSeconds?:number;compiled:Compiled;model?:string;fullBodyPrompt?:string;bodySeed?:number;passes?:number;placement?:{top:number};downloads?:Record<string,string>;artifacts?:Record<string,string>};
export {api} from './api';
export function PromptControls({traits,options,onChange}:{traits:Record<string,string>;options:GenerationOptions;onChange:(o:GenerationOptions)=>void}){
 const [open,setOpen]=useState(false);const {compiled,fullBodyPrompt}=compileCharacterSheet(traits,{direction:options.direction,promptOverride:options.override,fullBodyPromptOverride:options.bodyOverride||''});const update=(key:keyof GenerationOptions,value:string|number)=>onChange({...options,[key]:value,override:key==='override'?String(value):key==='direction'||key==='framing'?'':options.override,bodyOverride:key==='bodyOverride'?String(value):key==='direction'?'':options.bodyOverride,bodySeed:key==='bodySeed'?String(value):key==='seed'?'':options.bodySeed});
 return <section className="live-controls">
 <label>Art direction<textarea aria-label="Character art direction" placeholder="Outfit, pose, expression…" maxLength={2000} value={options.direction} onChange={e=>update('direction',e.target.value)}/></label>
 <button className="outline-button prompt-open" onClick={()=>setOpen(true)}>Edit prompt <span>{options.override?'Edited':'Auto'}</span></button>
 <Modal open={open} onClose={()=>setOpen(false)} title="Character sheet prompts" description="Changing traits restores the automatic prompt." wide>
 <div className="prompt-editor"><div className="parameter-tags">{Object.entries(traits).map(([k,v])=><span key={k}>{k}: {v}</span>)}</div><label>Close-up prompt<textarea aria-label="Exact prompt" rows={10} maxLength={12000} value={options.override||compiled.prompt} onChange={e=>update('override',e.target.value)}/></label>
 <label>Full-body prompt<textarea aria-label="Full-body prompt" rows={7} maxLength={12000} value={fullBodyPrompt} onChange={e=>update('bodyOverride',e.target.value)}/></label>
 <label>Seed <small>leave blank for a fresh image</small><input aria-label="Generation seed" type="number" min={0} max={2147483647} value={options.seed} placeholder="Random" onChange={e=>update('seed',e.target.value)}/></label>
 <label>Full-body seed <small>leave blank to derive from the close-up seed</small><input aria-label="Full-body seed" type="number" min={0} max={2147483647} value={options.bodySeed||''} placeholder="Automatic" onChange={e=>update('bodySeed',e.target.value)}/></label>
 {compiled.notes.map(n=><p key={n} className="prompt-note">{n}</p>)}{options.override&&<p className="prompt-note">Your edited prompt is sent as written. It can override the picked settings.</p>}
 <details><summary>Template slots · {compiled.version}</summary><code>{compiled.structure}</code><dl>{Object.entries(compiled.slots).filter(([,v])=>v).map(([k,v])=><React.Fragment key={k}><dt>{k.replaceAll('_',' ')}</dt><dd>{v}</dd></React.Fragment>)}</dl></details>
 <div className="live-actions"><button className="outline-button" onClick={()=>onChange({...options,override:'',bodyOverride:''})}>Restore automatic prompt</button><button className="generate-button" onClick={()=>setOpen(false)}>Use this prompt</button></div></div></Modal></section>
}
export function LiveHistory({jobs,onOpen,onCancel,onUse,useLabel='Use in swap'}:{jobs:LiveJob[];onOpen:(j:LiveJob)=>void;onCancel:(j:LiveJob)=>void;onUse:(j:LiveJob)=>void;useLabel?:string}){
 const dragPreview=useRef<HTMLDivElement|null>(null);
 useEffect(()=>()=>dragPreview.current?.remove(),[]);
 return <div className="history-grid" aria-label="Generated characters">{jobs.map(j=>{
  const pending=!['complete','failed','cancelled','uncertain'].includes(j.status);
  return <article className="character-card history-card" key={j.id} data-job-id={j.id} data-status={j.status} data-framing={j.artifacts?.portrait?'portrait':j.framing}>
   <button className="card-image" aria-label={`View ${j.name}`} onClick={()=>onOpen(j)} draggable={!!j.image} onDragStart={e=>{
    e.dataTransfer.setData('application/x-cast-job',j.id);e.dataTransfer.effectAllowed='copy';
    // Isolate the native drag snapshot from the History panel while retaining the visible card.
    dragPreview.current?.remove();
    const card=e.currentTarget,rect=card.getBoundingClientRect();
    const preview=document.createElement('div');preview.className='history-card history-drag-preview';
    preview.dataset.framing=j.artifacts?.portrait?'portrait':j.framing;preview.setAttribute('aria-hidden','true');
    preview.style.width=`${rect.width}px`;preview.style.height=`${rect.height}px`;
    preview.style.borderRadius=getComputedStyle(card.parentElement!).borderRadius;
    const copy=card.cloneNode(true) as HTMLButtonElement;copy.draggable=false;copy.tabIndex=-1;
    const originalImage=card.querySelector('img')!,copiedImage=copy.querySelector('img')!;
    copiedImage.loading='eager';copiedImage.style.transform=getComputedStyle(originalImage).transform;
    copiedImage.style.transformOrigin=getComputedStyle(originalImage).transformOrigin;
    preview.append(copy);document.body.append(preview);dragPreview.current=preview;
    e.dataTransfer.setDragImage(preview,e.clientX-rect.left,e.clientY-rect.top);
   }} onDragEnd={()=>{dragPreview.current?.remove();dragPreview.current=null}}>
    {j.image?<img src={j.artifacts?.portrait||j.image} alt={j.name} draggable={false} loading="lazy"/>:<span className="history-skeleton" role="status">{pending&&<LoaderCircle className="spin" size={26}/>}<span>{jobStatus[j.status]||j.status}</span>{j.error&&<small className="generation-error">{j.error}</small>}</span>}
    {j.image&&<span className="card-reveal">View character</span>}
   </button>
   <div className="card-caption"><div><h3 title={j.name}>{j.name}</h3><p>{new Date(j.created).toLocaleString()}</p></div>{j.image&&<button className="use-look" onClick={()=>onUse(j)} aria-label={`Use ${j.name} ${useLabel==='Use in motion'?'in motion':'in swap'}`}>{useLabel} <Plus size={14}/></button>}{pending&&<button className="use-look" aria-label={`Cancel ${j.name}`} onClick={()=>onCancel(j)}>Cancel</button>}</div>
  </article>
 })}</div>
}
function CharacterName({job,onRename}:{job:LiveJob;onRename:(job:LiveJob,name:string)=>Promise<void>}){
 const [editing,setEditing]=useState(false),[value,setValue]=useState(job.name),[error,setError]=useState(''),[saving,setSaving]=useState(false);
 const inFlight=useRef(false),cancelled=useRef(false);
 const edit=()=>{cancelled.current=false;setValue(job.name);setError('');setEditing(true)};
 async function save(){
  if(inFlight.current||cancelled.current)return;
  const name=value.trim();if(!name){setError('Enter a character name.');return}if(name===job.name){setEditing(false);return}
  inFlight.current=true;setSaving(true);setError('');
  try{await onRename(job,name);setEditing(false)}catch(e){setError(String(e))}finally{inFlight.current=false;setSaving(false)}
 }
 return <span className="character-name">{editing?<input autoFocus aria-label="Character name" maxLength={80} value={value} disabled={saving} onFocus={e=>e.target.select()} onChange={e=>setValue(e.target.value)} onBlur={()=>void save()} onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();void save()}if(e.key==='Escape'){e.preventDefault();e.stopPropagation();cancelled.current=true;setEditing(false);setError('')}}}/>:<><span onDoubleClick={edit} title="Double-click to rename">{job.name}</span><button className="icon-button" aria-label="Rename character" onClick={edit}><Pencil size={14}/></button></>}{error&&<span className="name-error" role="alert">{error}</span>}</span>
}
export function LiveResult({job,onClose,onRecreate,onRename,onUse,useLabel='Use in swap'}:{job:LiveJob|null;onClose:()=>void;onRecreate:(j:LiveJob)=>void;onRename:(j:LiveJob,name:string)=>Promise<void>;onUse:(j:LiveJob)=>void;useLabel?:string}){
 return <Modal open={!!job} onClose={onClose} title={job?job.manifest?<CharacterName key={job.id} job={job} onRename={onRename}/>:job.name: 'Character'} description="Generated character" className="character-viewer">{job&&<div className="character-viewer-layout">
  <div className="character-viewer-image">{job.image?<a href={job.image} target="_blank" rel="noopener"><img src={job.image} alt={`Full character reference of ${job.name}`}/></a>:<div className="history-skeleton result-skeleton" role="status">{!['complete','failed','cancelled','uncertain'].includes(job.status)&&<LoaderCircle className="spin" size={32}/>}<strong>{jobStatus[job.status]||job.status}</strong><p>{job.error||'Your character sheet will appear here.'}</p></div>}</div>
  <aside className="character-parameters live-result-parameters"><h3><ScanFace size={14}/>Character parameters</h3><div className="parameter-tags">{Object.entries(job.traits).map(([k,v])=><span key={k} title={k}>{v}</span>)}</div>
   <p>{job.width} × {job.height} · Seed {job.seed}{job.bodySeed!==undefined?` · Body seed ${job.bodySeed}`:''}</p>
   <details className="gallery-prompt"><summary>Prompt & generation settings</summary><p>{job.model} · {job.passes?`${job.passes} × `:''}{job.steps} steps{job.executionSeconds?` · ${job.executionSeconds.toFixed(1)}s`:''}</p><label>Close-up prompt<textarea aria-label="Result prompt" readOnly rows={7} value={job.prompt}/></label>{job.fullBodyPrompt&&<label>Full-body prompt<textarea aria-label="Result full-body prompt" readOnly rows={7} value={job.fullBodyPrompt}/></label>}<p>{job.templateVersion}{job.manualPrompt?' · manually edited':''}</p></details>
   <div className="character-viewer-actions">{job.image&&<button className="outline-button" onClick={()=>onUse(job)}><Plus size={15}/>{useLabel}</button>}<button className="generate-button" onClick={()=>onRecreate(job)}><RotateCcw size={15}/>Reuse settings & seed</button>{job.image&&<a className="outline-button" href={job.downloads?.image||job.image} download><Download size={15}/>Download {job.passes?'character sheet':'original PNG'}</a>}{['portrait','full-body'].map(name=>job.artifacts?.[name]&&<a className="outline-button" key={name} href={job.downloads?.[name]||job.artifacts[name]} download><Download size={15}/>Download {name==='portrait'?'close-up':'full body'}</a>)}{job.manifest&&<a className="text-button" href={job.manifest} download>Prompt & workflow</a>}</div>
  </aside>
 </div>}</Modal>
}
