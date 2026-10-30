import { ExecutorClient } from './executor-client.mjs';
import { isEnvironmentBusy } from './executor-readiness.mjs';
import { bootstrapPlan, bootstrapExecutor, ensureLocalExecutor } from './executor-bootstrap.mjs';
import { placementSnapshot, rankPlacement } from '../dist/auto-placement.js';
import { compatibility } from '../dist/session-contracts.js';

/** App servers and the launcher share this management API. Browser code never
 * receives SSH handles or opens the worker queue database. */
export class AppExecutors {
  constructor(appId,{localClient=new ExecutorClient(),autoBootstrap=true,installationPlan}={}) {
    this.appId=appId;this.local=localClient;this.autoBootstrap=autoBootstrap;this.installationPlan=installationPlan;this.placementObservations=new Map();
  }
  async ready() {if(this.autoBootstrap)await ensureLocalExecutor({id:'local',name:'This machine',...this.local.target});}
  async list() {await this.ready();return this.local.registry(this.appId);}
  target(item) {
    // A remote registry's `local` row means that registry's machine.
    return {...(item.id==='local'?this.local.target:{kind:item.kind,port:item.port,...(item.kind==='ssh'?{host:item.host,sshPort:item.sshPort}:{})}),id:item.id,name:item.name};
  }
  async observation(item) {
    const target=this.target(item),key=JSON.stringify([target,item.executorId]),prior=this.placementObservations.get(key);
    if(prior && prior.expiresAt>Date.now())return prior.promise;
    const observation={expiresAt:Date.now()+1000,promise:new ExecutorClient(target).json('/v1/status').then(value=>placementSnapshot(value,item.executorId))};
    this.placementObservations.set(key,observation);
    try{return await observation.promise;}catch(error){this.placementObservations.delete(key);throw error;}
  }
  async bind(feature,requestedId,options={}) {
    if(!options || typeof options!=='object' || Array.isArray(options) || Object.keys(options).some(k=>!['installationRevision','permittedTargetIds','compatibility'].includes(k)))throw new Error('Unknown placement option');
    if(options.permittedTargetIds!==undefined && (!Array.isArray(options.permittedTargetIds) || options.permittedTargetIds.some(id=>typeof id!=='string')))throw new Error('Permitted targets require explicit IDs');
    if(options.compatibility!==undefined)compatibility(options.compatibility);
    const registry=await this.list();
    const canQueue=value=>(value.ready && value.features.includes(feature)) ||
      (value.installation.features.includes(feature) && isEnvironmentBusy(value,feature));
    const exact=value=>canQueue(value) && (!options.installationRevision || value.installation.revision===options.installationRevision);
    const eligible=registry.items.filter(item=>item.online && ['local','ssh'].includes(item.kind) &&
      (!options.permittedTargetIds || options.permittedTargetIds.includes(item.id)) && item.installations.some(exact));
    const preferred=requestedId || registry.selectedExecutorId;
    let target=eligible.find(item=>item.id===preferred),placement;
    if(requestedId==='auto') {
      const candidates=await Promise.all(eligible.map(async(item,index)=>{
        try{const observed=await this.observation(item),installation=item.installations.find(exact).installation;
          if(observed.fenced)return null;
          return {item,index,...rankPlacement(observed,installation.id,options.compatibility)};
        }catch{return null;}
      }));
      const selected=candidates.filter(Boolean).sort((a,b)=>a.score-b.score || a.index-b.index)[0];
      target=selected?.item;placement=selected?.decision;
    }
    if(!target)throw Object.assign(new Error('The selected generation machine is unavailable or needs resources. Choose a ready machine or finish its setup before generating.'),{status:409,code:'executor_setup_required'});
    if(requestedId!=='auto')await this.local.json('/v1/preferences',{appId:this.appId,executorId:target.id});
    const installation=target.installations.find(exact).installation;
    return {target:this.target(target),executorId:target.executorId,installationId:installation.id,revision:installation.revision,feature,...(placement?{placement}:{})};
  }
  async client(binding) {
    const client=new ExecutorClient(binding.target),health=await client.health();
    if(health.executorId!==binding.executorId)throw new Error('The selected machine has a different executor identity. Reconnect it before submitting new jobs.');
    return client;
  }
  async savePlan(record){return this.local.json('/v1/management-plans',{...record,appId:this.appId});}
  async loadPlan(id){const record=await this.local.json('/v1/management-plans/'+encodeURIComponent(id));if(record.appId!==this.appId)throw new Error('Setup plan belongs to another app');return record;}
  async operation(action,input={}) {
    if(action==='list')return this.list();
    await this.ready();
    if(action==='rename'){const registry=await this.list(),target=registry.items.find(item=>item.id===input.executorId);if(!target)throw new Error('Unknown machine');return this.local.json('/v1/executors',{...target,name:input.name});}
    if(action==='preferences')return this.local.json('/v1/preferences?appId='+encodeURIComponent(this.appId));
    if(action==='use-default')return this.local.json('/v1/preferences',{appId:this.appId,executorId:null});
    if(action==='select' || action==='default')return this.local.json('/v1/preferences',{executorId:input.executorId,...(action==='select'?{appId:this.appId}:{})});
    if(action==='connect-plan') {
      // Validate by the same authoritative registry schema, without registering yet.
      const target={id:input.id,name:input.name,kind:input.kind || 'ssh',host:input.host,sshPort:input.sshPort || 22,port:input.port || 8841};
      if(!/^[a-z0-9][a-z0-9-]*$/.test(target.id || '') || !target.name?.trim() || !['ssh','local'].includes(target.kind))throw new Error('Enter an executor name and connection');
      const plan=await bootstrapPlan(target),{id}=await this.savePlan({kind:'connect',plan});
      return {id,digest:plan.digest,description:plan.description,writes:plan.writes,downloads:plan.downloads,requires:plan.requires,target:plan.target};
    }
    if(action==='connect-confirm') {
      const record=await this.loadPlan(input.id);if(record?.kind!=='connect')throw new Error('Review a new connection plan');
      const receipt=await bootstrapExecutor(record.plan,input.digest);await this.local.json('/v1/executors',record.plan.target);return receipt;
    }
    if(action==='install-plan') {
      if(!this.installationPlan)throw new Error('This app has not supplied an executor installer');
      const registry=await this.list(),target=registry.items.find(item=>item.id===input.executorId);
      if(!target?.online)throw new Error('Connect this executor before installing app resources');
      const client=new ExecutorClient(target),plan=await this.installationPlan(client,target,input.settings || {});
      const {id}=await this.savePlan({kind:'install',target,plan});return {...plan,id};
    }
    if(action==='install-confirm') {
      const record=await this.loadPlan(input.id);if(record?.kind!=='install')throw new Error('Review a new installation plan');
      const result=await new ExecutorClient(record.target).json('/v1/install',{planId:record.plan.id,digest:input.digest});
      return result;
    }
    throw new Error('Unknown executor operation');
  }
}
