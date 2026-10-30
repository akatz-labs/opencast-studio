/** Contract transport only; ComfyGit owns environment, upload and run semantics. */
export class ComfyGitClient {
  constructor(origin, sessionId, { fetch: transport = globalThis.fetch } = {}) {
    this.origin = new URL(origin).origin; this.sessionId = sessionId; this.fetch = transport;
  }
  async request(path, init = {}) {
    const url = new URL(path, this.origin);
    if (url.origin !== this.origin || url.username || url.password || url.hash) throw new Error('Invalid ComfyGit destination');
    const response = await this.fetch(url, { ...init, headers: { ...init.headers, 'x-comfygit-studio-session': this.sessionId }, signal: AbortSignal.timeout(120000) });
    if (!response.ok) {
      let message;try { const value=await response.json();message=value.message||value.error; }catch{}
      throw Object.assign(new Error(typeof message==='string'?message:`Worker request failed (${response.status})`),{status:502,transient:response.status>=500});
    }
    return response;
  }
  async upload(bytes, { filename, mime }) {
    const slot=await (await this.request('/uploads/prepare',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({filename,content_type:mime,size:bytes.length})})).json();
    const destination=new URL(slot.upload_url,this.origin);
    if(!slot.ref || destination.origin!==this.origin || destination.username || destination.password || destination.hash || !/^\/uploads\/upload_[a-z0-9]+$/.test(destination.pathname))throw new Error('Worker returned an invalid upload destination');
    await this.request(destination.pathname+destination.search,{method:'PUT',headers:{'content-type':mime},body:bytes});
    return slot.ref;
  }
  async run(workflow, inputs) {
    if(!/^[a-zA-Z0-9._-]+$/.test(workflow))throw new Error('Invalid workflow name');
    return (await this.request(`/contracts/${workflow}/default/run`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({inputs,wait:false})})).json();
  }
  async runs() { return (await this.request('/runs')).json(); }
}
