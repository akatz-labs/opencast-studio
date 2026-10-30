import fs from 'node:fs';
import path from 'node:path';

const mime={'.svg':'image/svg+xml','.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp','.mp4':'video/mp4','.woff2':'font/woff2','.zip':'application/zip'};

// Only versioned asset names may bypass revalidation. HTML and mutable paths stay fresh.
export function immutableAsset(route){
 return /^\/media\/(?:options\/)?[\w-]+-[a-f0-9]{10}-(?:160|320|480|960|1600)\.webp$/.test(route)
  || /^\/assets\/[\w-]+-[\w-]{8,}\.(?:js|css|woff2)$/.test(route);
}

export function file(req,res,p,download,{immutable=false,contentType}={}){
 const stat=fs.statSync(p,{throwIfNoEntry:false});
 if(!stat?.isFile()){res.writeHead(404,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({error:'Not found'}));return}
 const etag=`W/"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"`;
 const headers={'Content-Type':contentType||mime[path.extname(p)]||'application/octet-stream','Cache-Control':immutable?'private, max-age=31536000, immutable':'private, no-cache',ETag:etag,'Last-Modified':stat.mtime.toUTCString(),...(download?{'Content-Disposition':`attachment; filename="${download}"`}:{})};
 const tags=req.headers['if-none-match'];
 const unchanged=tags?tags.split(',').some(t=>t.trim()==='*'||t.trim().replace(/^W\//,'')===etag.replace(/^W\//,''))
  :req.headers['if-modified-since']&&Math.floor(stat.mtimeMs/1000)*1000<=Date.parse(req.headers['if-modified-since']);
 if(unchanged){res.writeHead(304,headers);res.end();return}
 if((contentType||mime[path.extname(p)]||'').startsWith('video/')){
  headers['Accept-Ranges']='bytes';
  const range=req.headers.range;
  if(range){
   const match=/^bytes=(\d*)-(\d*)$/.exec(range);
   const start=match?.[1]?Number(match[1]):Math.max(0,stat.size-Number(match?.[2]));
   const end=match?.[1]&&match[2]?Math.min(Number(match[2]),stat.size-1):stat.size-1;
   if(!match||(!match[1]&&!match[2])||!Number.isSafeInteger(start)||start<0||start>=stat.size||end<start){res.writeHead(416,{...headers,'Content-Range':`bytes */${stat.size}`});res.end();return}
   res.writeHead(206,{...headers,'Content-Length':end-start+1,'Content-Range':`bytes ${start}-${end}/${stat.size}`});
   if(req.method==='HEAD'){res.end();return}fs.createReadStream(p,{start,end}).pipe(res);return;
  }
 }
 res.writeHead(200,{...headers,'Content-Length':stat.size});
 if(req.method==='HEAD'){res.end();return}
 fs.createReadStream(p).pipe(res);
}
