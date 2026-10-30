// Preserve existing histories while routing new motion jobs to the shared runner.
export function combinedExecutor(legacy,current){
 const find=async(id,owner)=>{try{await current.get(id,owner);return current}catch(error){if(error.status!==404)throw error;return legacy}};
 return {
  capabilities(){return current.capabilities()},
  async list(owner,kind){const rows=await Promise.all([legacy.list(owner,kind),current.list(owner,kind)]);return [...new Map(rows.flat().map(j=>[j.id,j])).values()].sort((a,b)=>b.createdAt.localeCompare(a.createdAt))},
  async get(id,owner){return (await find(id,owner)).get(id,owner)},
  async importAsset(ref,owner){if(ref.kind==='gallery')return legacy.importAsset(ref,owner);return (await find(ref.id,owner)).importAsset(ref,owner)},
  submit(request,owner){return current.submit(request,owner)},
  async cancel(id,owner){return (await find(id,owner)).cancel(id,owner)},
  async rename(id,name,owner){return (await find(id,owner)).rename(id,name,owner)},
 };
}
