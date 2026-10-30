import aboutLinks from './about-links.json';
import {useEffect,useRef,useState} from 'react';
import {z} from 'zod';
import {SlidersHorizontal,Database,Info,RefreshCw,Download,Check,LoaderCircle,ExternalLink,Monitor,Globe} from 'lucide-react';
import {toast} from 'sonner';
import {Modal,Toggle} from './ui';
import {request} from './api';

const modelSchema=z.object({id:z.string(),name:z.string(),group:z.enum(['character','motion']),relativePath:z.string(),sizeBytes:z.number(),sha256:z.string(),acquisition:z.enum(['manual','download']),state:z.string(),verified:z.boolean(),url:z.string().optional(),sourcePage:z.string().optional(),sourceNote:z.string().optional()});
const snapshotSchema=z.object({onboarding:z.object({state:z.enum(['checking','required','ready','unavailable']),message:z.string()}).optional(),modelDirectory:z.object({path:z.string().nullable(),currentPath:z.string().nullable(),pending:z.boolean()}).optional(),connection:z.enum(['checking','connected','unconfigured','unregistered','offline','mismatch']),executorName:z.string(),message:z.string().optional(),models:z.array(modelSchema),jobs:z.array(z.object({id:z.string(),status:z.string(),kind:z.string(),progress:z.number().nullable().optional(),message:z.string().optional(),error:z.string().nullable().optional()})),runtimes:z.array(z.object({id:z.string(),name:z.string(),installed:z.boolean(),detail:z.string().optional()})),executorKind:z.enum(['local','ssh','cloud']).optional(),setupAvailable:z.boolean().optional(),setupJob:z.object({id:z.string(),status:z.string(),message:z.string(),progress:z.number(),error:z.string().optional()}).nullable().optional(),storage:z.object({freeBytes:z.number().nullable(),path:z.string().optional()}).nullable()});
type Snapshot=z.infer<typeof snapshotSchema>;
const appearanceSchema=z.object({accent:z.enum(['green','amber','ice']).default('green'),reduceMotion:z.boolean().default(false)});
const accents={green:{name:'Neon green',color:'#2CFF05'},amber:{name:'Amber',color:'#FFD34E'},ice:{name:'Ice',color:'#73E0FF'}};
const size=(value:number)=>`${(value/1024**3).toFixed(value>1024**3?1:2)} GB`;
const active=(status:string)=>!['blocked','succeeded','completed','complete','failed','cancelled','interrupted'].includes(status);

export function Settings({open,onClose,onSetupRequired}:{open:boolean;onClose:()=>void;onSetupRequired:(open:boolean)=>void}){
 const [section,setSection]=useState<'general'|'resources'|'about'>('resources');
 const [appearance,setAppearance]=useState(()=>{try{return appearanceSchema.parse(JSON.parse(localStorage.getItem('opencast-appearance')||'{}'))}catch{return appearanceSchema.parse({})}});
 const [snapshot,setSnapshot]=useState<Snapshot|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(''),[refreshing,setRefreshing]=useState(false);
 const reading=useRef(false),startupResolved=useRef(false);
 const [modelFolder,setModelFolder]=useState(''),[folderEdited,setFolderEdited]=useState(false);
 useEffect(()=>{
  let stopped=false,timer:ReturnType<typeof setTimeout>;
  async function inspectStartup(){
   if(startupResolved.current)return;
   try{
    const value=snapshotSchema.parse(await request('resources'));
    if(stopped)return;setSnapshot(value);
    if(value.onboarding&&value.onboarding.state!=='checking'){
     startupResolved.current=true;
     if(value.onboarding.state==='required'){setSection('resources');onSetupRequired(true)}
     return;
    }
   }catch{/* A temporary API outage is not evidence that installation is missing. */}
   if(!stopped)timer=setTimeout(()=>void inspectStartup(),4000);
  }
  void inspectStartup();return()=>{stopped=true;clearTimeout(timer)};
 },[onSetupRequired]);
 useEffect(()=>{if(!folderEdited)setModelFolder(snapshot?.modelDirectory?.path||'')},[snapshot?.modelDirectory?.path,folderEdited]);
 async function saveModelFolder(){
  setBusy('model-folder');setError('');
  try{await request('resources',{action:'model-folder',path:modelFolder});setFolderEdited(false);await refresh(true)}
  catch(e){setError(e instanceof Error?e.message:'Could not save the model folder.')}
  finally{setBusy('')}
 }

 useEffect(()=>{
  document.documentElement.style.setProperty('--accent',accents[appearance.accent].color);
  document.documentElement.dataset.reduceMotion=String(appearance.reduceMotion);
  try{localStorage.setItem('opencast-appearance',JSON.stringify(appearance))}catch{toast.error('Appearance could not be saved in this browser.')}
 },[appearance]);
 async function refresh(force=false){
  if(reading.current)return;reading.current=true;setRefreshing(true);
  try{setSnapshot(snapshotSchema.parse(await request(`resources${force?'?refresh=1':''}`)));setError('')}catch(e){setError(e instanceof Error?e.message:'Resources could not be loaded.')}
  finally{reading.current=false;setRefreshing(false)}
 }
 useEffect(()=>{if(!open||section!=='resources')return;void refresh();const timer=setInterval(()=>void refresh(),4000);return()=>clearInterval(timer)},[open,section]);
 async function action(action:'setup'|'scan'|'initialize'|'download',resourceIds?:string[]){
  if(busy)return;setBusy(resourceIds?.[0]||action);setError('');
  try{await request('resources',{action,...(resourceIds?{resourceIds}:{})});await refresh(true)}
  catch(e){setError(e instanceof Error?e.message:'The executor did not confirm this action. Refresh before retrying.')}
  finally{setBusy('')}
 }
 const connected=snapshot?.connection==='connected',working=!!snapshot?.jobs.some(j=>active(j.status))||!!(snapshot?.setupJob&&active(snapshot.setupJob.status));
 const installable=snapshot?.models.filter(m=>m.state==='missing'&&m.acquisition==='download')||[];
 const downloadBytes=snapshot?.models.filter(m=>m.acquisition==='download'&&['missing','unknown'].includes(m.state)).reduce((n,m)=>n+m.sizeBytes,0)||0;
 const actionsDisabled=!!busy||working||!connected;
 return <Modal open={open} onClose={()=>{startupResolved.current=true;onClose()}} title="Settings" wide className="settings-modal">
  <div className="settings-layout">
   <nav className="settings-nav" aria-label="Settings sections">
    {([['general','General',SlidersHorizontal],['resources','Resources',Database],['about','About',Info]] as const).map(([id,label,Icon])=><button key={id} aria-current={section===id?'page':undefined} onClick={()=>setSection(id)}><Icon size={18}/><span>{label}</span></button>)}
   </nav>
   <section className="settings-content" aria-label={section==='general'?'General settings':section==='resources'?'Resources':'About OpenCast Studio'}>
    {section==='general'&&<><h2>General</h2><div className="settings-section"><h3>Generation executor</h3><p>{snapshot?.executorName||'This machine'}</p><p className="settings-note">New local installations use the computer running OpenCast. A deployment can configure a remote executor without changing the frontend.</p><button className="outline-button" onClick={()=>setSection('resources')}>Manage resources</button></div><div className="settings-section"><h3>Appearance</h3><fieldset className="accent-options"><legend>Accent color</legend>{Object.entries(accents).map(([id,value])=><label key={id}><input type="radio" name="accent" value={id} checked={appearance.accent===id} onChange={()=>setAppearance({...appearance,accent:id as keyof typeof accents})}/><span className="accent-swatch" style={{background:value.color}}/>{value.name}</label>)}</fieldset><div className="settings-setting"><div><strong>Reduce interface motion</strong><p>Keep transitions and loading indicators still.</p></div><Toggle checked={appearance.reduceMotion} onChange={reduceMotion=>setAppearance({...appearance,reduceMotion})} label="Reduce interface motion"/></div><p className="settings-note">Appearance settings are saved in this browser.</p></div></>}
    {section==='resources'&&<>
     <div className="resources-heading"><h2>Resources</h2><div className="resource-header-actions"><button className="outline-button" disabled={refreshing||!!busy} onClick={()=>void refresh(true)}><RefreshCw size={14} className={refreshing?'spin':''}/>Refresh</button>{snapshot?.executorKind!=='cloud'&&<button className="generate-button install-missing" disabled={folderEdited||!!busy||working||!snapshot||snapshot.connection==='mismatch'||(!snapshot.setupAvailable&&(actionsDisabled||!installable.length))} onClick={()=>void action(snapshot?.setupAvailable?'setup':'download',snapshot?.setupAvailable?undefined:installable.map(m=>m.id))}><Download size={15}/>{working?'Installing…':'Install missing'}</button>}</div></div>
     <div className="executor-summary"><Monitor size={18}/><strong>{snapshot?.executorName||'Connecting to executor…'}</strong>{snapshot&&<span className={`resource-status ${connected?'installed':''}`}>{({checking:'Checking',connected:'Connected',unconfigured:'Not configured',unregistered:'Setup needed',offline:'Offline',mismatch:'Identity changed'})[snapshot.connection]}</span>}</div>
     <p className="settings-note">{snapshot?.executorKind==='cloud'?'No GPU or model downloads are required on your device.':snapshot?.executorKind==='ssh'?'Setup runs on your configured remote worker.':'This machine means the computer running the OpenCast backend.'}</p>
     {snapshot?.onboarding&&<p className="settings-note" role="status">{snapshot.onboarding.message}</p>}
     {snapshot?.setupAvailable&&<div className="model-folder settings-section"><label htmlFor="model-folder">Model folder</label><div><input id="model-folder" value={modelFolder} placeholder={snapshot.executorKind==='ssh'?'/absolute/path/on/worker':'/absolute/path/to/models'} disabled={working||!!busy} onChange={e=>{setModelFolder(e.target.value);setFolderEdited(true)}}/><button className="outline-button" disabled={!folderEdited||!modelFolder.trim()||working||!!busy} onClick={()=>void saveModelFolder()}>Use folder</button></div><p className="settings-note">{snapshot.executorKind==='ssh'?'Path on the remote worker.':'Path on the computer running OpenCast.'} Existing matching models are reused. Save your choice, then select Install missing. Changing this shared ComfyGit folder affects its environments; files in the previous folder stay in place.</p>{folderEdited&&<p className="settings-note">Save this folder before installing.</p>}{snapshot.modelDirectory?.pending&&<p className="settings-note">Current folder: {snapshot.modelDirectory.currentPath}. New folder will be applied during setup.</p>}</div>}
     {snapshot?.setupAvailable&&downloadBytes>0&&<p className="settings-note">Up to {size(downloadBytes)} of models, plus runtime packages. Matching files are reused.</p>}
     {snapshot?.setupJob&&<div className="setup-progress" role="status"><strong>{snapshot.setupJob.message}</strong>{active(snapshot.setupJob.status)&&<progress max={1} value={snapshot.setupJob.progress}/>}</div>}
     {error&&<p className="settings-error" role="alert">{error}</p>}
     {snapshot?.message&&<div className="settings-notice"><p>{snapshot.message}</p>{snapshot.connection==='unregistered'&&<button className="outline-button" disabled={!!busy} onClick={()=>void action('initialize')}>Connect resources</button>}</div>}
     {!snapshot&&!error&&<div className="settings-loading" role="status"><LoaderCircle size={22} className="spin"/>Checking resources…</div>}
     {snapshot&&snapshot.executorKind!=='cloud'&&<>
      {snapshot.runtimes.length>0&&<details className="runtime-status"><summary>Runtime readiness</summary>{snapshot.runtimes.map(runtime=><div key={runtime.id}><strong>{runtime.name}</strong><span className={`resource-status ${runtime.installed?'installed':''}`}>{runtime.installed?'Ready':'Needs setup'}</span><p>{runtime.detail}</p></div>)}</details>}
      <div className="resource-toolbar"><span>{snapshot.models.filter(m=>m.state==='installed').length} of {snapshot.models.length} models installed{snapshot.storage?.freeBytes!=null?` · ${size(snapshot.storage.freeBytes)} free`:''}</span><button className="text-button" disabled={actionsDisabled} onClick={()=>void action('scan')}>Scan models</button></div>
      {(['character','motion'] as const).map(group=><div className="resource-group" key={group}><header><h3>{group==='character'?'Character generation':'Motion · Pika H3 Flex'}</h3><span>{group==='character'?'Krea 2':'FLUX3 anchors + Pika video'}</span></header>{snapshot.models.filter(m=>m.group===group).map(model=>{
       const state=model.state==='installed'?'Installed':model.acquisition==='manual'?'Download link pending':({missing:'Missing',changed:'Needs verification',unindexed:'Needs scan'}[model.state]||'Not checked');
       return <div className="resource-row" key={model.id} data-resource-id={model.id}><div className="resource-description"><strong>{model.name}</strong><span>{size(model.sizeBytes)}</span><details><summary>File & source</summary><code>{model.relativePath}</code>{model.sourcePage&&<a href={model.sourcePage} target="_blank" rel="noreferrer">Model source <ExternalLink size={12}/></a>}{model.sourceNote&&<p>{model.sourceNote}</p>}<small>SHA256</small><code>{model.sha256}</code></details></div><span className={`resource-status ${model.state==='installed'?'installed':''}`}>{model.state==='installed'&&<Check size={13}/>} {state}</span><div className="resource-action">{model.acquisition==='download'&&model.state!=='installed'&&<button className="outline-button" aria-label={`${model.state==='unindexed'?'Scan':model.state==='changed'?'Verify':'Install'} ${model.name}`} disabled={actionsDisabled} onClick={()=>void action(model.state==='unindexed'?'scan':'download',model.state==='unindexed'?undefined:[model.id])}>{busy===model.id?<LoaderCircle size={14} className="spin"/>:<Download size={14}/>} {model.state==='unindexed'?'Scan':model.state==='changed'?'Verify':'Install'}</button>}</div></div>;
      })}</div>)}
      {snapshot.jobs.length>0&&<div className="resource-progress" aria-live="polite"><h3>Recent activity</h3>{snapshot.jobs.slice(-4).reverse().map(j=><div key={j.id}><span>{j.message||j.kind} · {j.status}</span>{active(j.status)&&<progress max={1} value={j.progress??undefined}/>}{j.error&&<p className="settings-error">{j.error}</p>}</div>)}</div>}
      <p className="settings-note">{snapshot.setupAvailable?'Install missing prepares the shared worker, pinned ComfyGit environments and published models. Existing environments and matching models are reused.':'Models install on the configured executor.'}{installable.length?` Model downloads: ${size(installable.reduce((n,m)=>n+m.sizeBytes,0))}.`:''}</p>
     </>}
    </>}
    {section==='about'&&<div className="settings-about"><span className="about-wordmark">OpenCast <i>/</i> <em>Studio</em></span><p>OpenCast Studio is an open-source app by Akatz Labs for creating fictional characters and bringing them into video.</p><p>Create a character sheet with a close-up and full-body reference, then use it for character swaps or motion transfer. Prompts, settings and original outputs stay with each generation.</p><div className="settings-section"><h3>Local or hosted</h3><p>The same interface connects to a configured backend. Local execution uses your shared ComfyUI runner. Available workflows depend on that backend.</p></div><div className="settings-section about-lab"><div className="about-lab-heading"><span className="about-lab-logo"><img src={`${import.meta.env.BASE_URL}brand/akatz-labs.png`} alt="" width="131" height="145"/></span><h3>Akatz Labs</h3></div><p>Explore the models, follow new experiments, and find more open-source tools.</p><div className="about-badges">{aboutLinks.slice(0,4).map(link=><a key={link.id} href={link.href} target="_blank" rel="noopener noreferrer" style={{backgroundColor:link.color}}>{link.iconSource?<img src={`${import.meta.env.BASE_URL}badges/${link.id}.svg`} alt="" width="17" height="17"/>:<Globe size={17} aria-hidden="true"/>}<span>{link.label}</span></a>)}</div><h3>Support the next experiment</h3><p>Your support helps fund model training, GPU experiments, and the development of open-source workflows and tools like OpenCast. Thanks for helping Akatz Labs keep building and sharing.</p><div className="about-badges">{aboutLinks.slice(4).map(link=><a key={link.id} href={link.href} target="_blank" rel="noopener noreferrer" style={{backgroundColor:link.color}}>{link.iconSource?<img src={`${import.meta.env.BASE_URL}badges/${link.id}.svg`} alt="" width="17" height="17"/>:<Globe size={17} aria-hidden="true"/>}<span>{link.label}</span></a>)}</div></div><p className="settings-note">OpenCast Studio 0.2.0 · Model licenses are listed at their sources in Resources.</p><a className="about-repository" href="https://github.com/akatz-labs/opencast-studio" target="_blank" rel="noopener noreferrer"><img src={`${import.meta.env.BASE_URL}badges/github.svg`} width="17" height="17" alt=""/>GitHub · akatz-labs/opencast-studio<ExternalLink size={14} aria-hidden="true"/></a></div>}
   </section>
  </div>
 </Modal>;
}
