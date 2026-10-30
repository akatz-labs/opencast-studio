import {useLayoutEffect,useRef,useState} from 'react';

export function PickedSettings({traits,onRemove,onReset}:{traits:Record<string,string>;onRemove:(key:string)=>void;onReset:()=>void}){
 const entries=Object.entries(traits);
 const measureRef=useRef<HTMLDivElement>(null);
 const [visibleCount,setVisibleCount]=useState(entries.length);
 const [expanded,setExpanded]=useState(false);
 useLayoutEffect(()=>{
  const measure=measureRef.current!;
  function update(){
   const width=measure.clientWidth;if(!width)return;
   const chips=Array.from(measure.children) as HTMLElement[];
   const toggleWidth=chips.at(-1)!.getBoundingClientRect().width;
   const gap=parseFloat(getComputedStyle(measure).columnGap);
   let row=1,used=0,fit=0;
   for(const [index,chip]of chips.slice(0,-1).entries()){
    const chipWidth=chip.getBoundingClientRect().width;
    if(used&&used+gap+chipWidth>width+.5){row++;used=0}
    used+=(used?gap:0)+chipWidth;
    const toggleRow=used+gap+toggleWidth>width+.5?row+1:row;
    if(toggleRow<=2)fit=index+1;
   }
   setVisibleCount(row<=2?entries.length:fit);
   if(row<=2)setExpanded(false);
  }
  update();const observer=new ResizeObserver(update);observer.observe(measure);
  let active=true;void document.fonts.ready.then(()=>{if(active)update()});
  return()=>{active=false;observer.disconnect()};
 },[traits]);
 const overflow=visibleCount<entries.length;
 return <section className="picked-settings" aria-label="Picked settings">
  <div className="picked-heading"><span>Picked settings</span><button onClick={onReset} disabled={!entries.length}>Reset all</button></div>
  <div className="picked-values" id="picked-values">
   {(expanded?entries:entries.slice(0,visibleCount)).map(([key,value])=><button className="picked-chip" key={key} title={`${key}: ${value} · click to remove`} aria-label={`Remove ${key}: ${value}`} onClick={()=>onRemove(key)}>{value}</button>)}
   {overflow&&<button className="picked-chip picked-toggle" aria-expanded={expanded} aria-controls="picked-values" onClick={()=>setExpanded(v=>!v)}>{expanded?'Show less':'Show more'}</button>}
   {!entries.length&&<span className="picked-empty">Choose traits above</span>}
  </div>
  <div ref={measureRef} className="picked-values picked-measure" aria-hidden="true" inert>
   {entries.map(([key,value])=><span className="picked-chip" key={key}>{value}</span>)}<span className="picked-chip picked-toggle">Show more</span>
  </div>
 </section>;
}
