import { Dialog } from '@base-ui/react/dialog';
import { Accordion } from '@base-ui/react/accordion';
import { Switch } from '@base-ui/react/switch';
import { X,ChevronDown } from 'lucide-react';
import type {ReactNode} from 'react';
export function Modal({open,onClose,title,description,children,wide=false,className=''}:{open:boolean;onClose:()=>void;title:ReactNode;description?:string;children:ReactNode;wide?:boolean;className?:string}){
return <Dialog.Root open={open} onOpenChange={v=>{if(!v)onClose()}}><Dialog.Portal><Dialog.Backdrop className="modal-backdrop"/><Dialog.Popup className={`modal ${wide?'wide':''} ${className}`}><header className="modal-header"><div><Dialog.Title>{title}</Dialog.Title>{description&&<Dialog.Description>{description}</Dialog.Description>}</div><Dialog.Close className="icon-button" aria-label="Close dialog"><X size={20}/></Dialog.Close></header>{children}</Dialog.Popup></Dialog.Portal></Dialog.Root>;
}
export function Fold({value,title,icon,summary,children}:{value:string;title:string;icon:ReactNode;summary?:string;children:ReactNode}){
return <Accordion.Item value={value} className="fold"><Accordion.Header><Accordion.Trigger className="fold-trigger">{icon}<span>{title}{summary&&<small>{summary}</small>}</span><ChevronDown size={14} className="chevron"/></Accordion.Trigger></Accordion.Header><Accordion.Panel className="fold-panel">{children}</Accordion.Panel></Accordion.Item>;
}
export function Toggle({checked,onChange,label}:{checked:boolean;onChange:(v:boolean)=>void;label:string}){return <Switch.Root checked={checked} onCheckedChange={onChange} aria-label={label} className="switch"><Switch.Thumb className="switch-thumb"/></Switch.Root>}
export {Accordion};
