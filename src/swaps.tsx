import {useEffect,useState} from 'react';
import {Download,LoaderCircle} from 'lucide-react';
import {Modal} from './ui';
import {api,uploadMedia} from './api';

export type SwapJob={id:string;name:string;status:string;created:string;error?:string;prompt:string;target:string;seed:number;quality:string;keepAudio:boolean;sourceName:string;referenceName:string;duration:number;width?:number;height?:number;executionSeconds?:number;video:string|null;poster:string|null;manifest:string;source:string;reference:string;downloads?:Record<string,string>};
export const swapStatus=(status:string)=>({queued:'Queued',dispatching:'Sending to worker','queued-worker':'Waiting for GPU',starting:'Loading models',submitting:'Preparing video',running:'Generating',retaining:'Saving video',complete:'Complete',failed:'Generation failed',uncertain:'Needs attention',cancelled:'Cancelled'}[status]||status);
const pending=(job:SwapJob)=>!['complete','failed','uncertain','cancelled'].includes(job.status);

export function useSwaps(){
 const [jobs,setJobs]=useState<SwapJob[]>([]);
 useEffect(()=>{let stopped=false;async function refresh(){try{const data=await api('swaps');if(!stopped)setJobs(data.jobs)}catch{/* Keep the last snapshot while the connection recovers. */}}void refresh();const timer=setInterval(refresh,3000);return()=>{stopped=true;clearInterval(timer)}},[]);
 return {jobs,setJobs};
}
export const uploadSwapFile=uploadMedia;
export function SwapHistory({jobs,onOpen,onCancel}:{jobs:SwapJob[];onOpen:(id:string)=>void;onCancel:(id:string)=>void}){
 return <div className="history-grid swap-history" aria-label="Generated swaps">{jobs.map(job=><article className="character-card history-card" key={job.id} data-swap-id={job.id} data-status={job.status}>
  <button className="card-image" onClick={()=>onOpen(job.id)} aria-label={`View ${job.name}`} style={{aspectRatio:'2/3'}}>{job.poster?<img src={job.poster} alt={job.referenceName}/>:<span className="history-skeleton" role="status">{pending(job)&&<LoaderCircle className="spin" size={26}/>}<span>{swapStatus(job.status)}</span></span>}<span className="card-reveal">{job.video?'Play video':'View swap'}</span></button>
  <div className="card-caption"><div><h3>{job.name} · {job.referenceName}</h3><p>{new Date(job.created).toLocaleString()}</p></div>{job.status==='queued'&&<button className="use-look" onClick={()=>onCancel(job.id)}>Cancel</button>}</div>
 </article>)}{!jobs.length&&<p className="empty-swap-history">Your generated swap videos will appear here.</p>}</div>;
}
export function SwapResult({job,onClose}:{job:SwapJob|null;onClose:()=>void}){
 return <Modal open={!!job} onClose={onClose} title={job?.name||'Character swap'} description={job?`${job.referenceName} · ${swapStatus(job.status)}`:''} wide>{job&&<div className="swap-result">
  {job.video?<video aria-label="Generated swap video" src={job.video} poster={job.poster||undefined} controls playsInline preload="metadata"/>:<div className="history-skeleton swap-result-pending" role="status">{pending(job)&&<LoaderCircle className="spin" size={32}/>}<strong>{swapStatus(job.status)}</strong><p>{job.error||'You can close this window. Your video will appear in History when it is ready.'}</p></div>}
  <div className="live-actions">{job.video&&<a className="outline-button" href={job.downloads?.video||job.video} download><Download size={16}/>Download video</a>}<a className="text-button" href={job.downloads?.workflow||job.manifest} download>{job.downloads?.workflow?'Workflow JSON':'Prompt & settings'}</a></div>
  <details><summary>Source & character reference</summary><div className="swap-inputs"><video src={job.source} controls playsInline preload="metadata" aria-label="Original source video"/><img src={job.reference} alt={job.referenceName}/></div></details>
  <details><summary>Prompt & settings</summary><p>{job.width&&job.height?`${job.width} × ${job.height}`:job.quality==='480p'?'Standard':'High'} · Seed {job.seed} · {job.keepAudio?'Generated audio':'Muted export'}{job.executionSeconds?` · ${(job.executionSeconds/60).toFixed(1)} min`:''}</p><textarea aria-label="Swap prompt" readOnly value={job.prompt} rows={8}/></details>
 </div>}</Modal>;
}
