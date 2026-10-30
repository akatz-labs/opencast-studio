/** Browser-safe HTTP client. No Node imports or secrets in URLs. */
export class MediaClient {
  constructor(baseUrl, { fetch: transport = globalThis.fetch } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, ''); this.fetch = transport;
  }
  async request(path, init = {}) {
    const response = await this.fetch(this.baseUrl + '/v1' + path, { signal: AbortSignal.timeout(120000), ...init });
    if (!response.ok) {
      let message; try { message = (await response.json()).message; } catch {}
      throw Object.assign(new Error(message || `Media service request failed (${response.status})`), { status: response.status });
    }
    return response;
  }
  async health() {
    const value = await (await this.request('/health')).json();
    if (value.apiVersion !== 1) throw new Error('Incompatible media API; version 1 is required');
    return value;
  }
  async list(filters = {}) { return (await this.request('/media?' + new URLSearchParams(Object.entries(filters).filter(([,v])=>v!==undefined).map(([k,v])=>[k,String(v)])))).json(); }
  async registerApp(value) { return (await this.request('/apps', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(value)})).json(); }
  async registerProject(value) { return (await this.request('/projects', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(value)})).json(); }
  async apps(filters = {}) { return (await this.request('/apps?' + new URLSearchParams(filters))).json(); }
  async projects(filters = {}) { return (await this.request('/projects?' + new URLSearchParams(filters))).json(); }
  async get(id) { return (await this.request('/media/' + encodeURIComponent(id))).json(); }
  async import(bytes, metadata) {
    return (await this.request('/media?metadata=' + encodeURIComponent(JSON.stringify(metadata)), { method: 'POST', body: bytes, duplex: 'half', headers: { 'content-type': 'application/octet-stream' } })).json();
  }
  async link(id, association, method = 'POST') { return (await this.request('/media/' + encodeURIComponent(id) + '/links', { method, headers:{'content-type':'application/json'}, body:JSON.stringify(association) })).json(); }
  async trash(id) { return (await this.request('/media/' + encodeURIComponent(id) + '/trash', {method:'POST'})).json(); }
  async restore(id) { return (await this.request('/media/' + encodeURIComponent(id) + '/trash', {method:'DELETE'})).json(); }
  fileUrl(id) { return this.baseUrl + '/v1/media/' + encodeURIComponent(id) + '/file'; }
  async file(id, init) { return this.request('/media/' + encodeURIComponent(id) + '/file', init); }
}
