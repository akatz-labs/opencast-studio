export type ReferenceSheet={image:string;portraitImage:string;bodyImage:string;mode:string;seed:number;bodySeed:number;prompt:string;fullBodyPrompt:string;direction:string;storageVersion:string;placement:{height:string;proportions:string;sourceWidth:number;top:number;seam:number}};
export type Character = {referenceSheet?:ReferenceSheet;gridView?:'portrait'|'body';id:string;name:string;tag:string;family:string;image:string;aspect:number;position?:string;traits:Record<string,string>;generation?:{jobId:string;prompt:string;direction:string;framing:string;seed:number;steps:number;model:string;storageVersion:string}};
export const media=(key:string,width=480)=>`${import.meta.env.BASE_URL}media/${key}-${width}.webp`;
const legacyCharacters:Character[]=[
{id:'nyra',name:'Nyra Vale',tag:'Sculptural · Confident',family:'Human',image:'nyra',aspect:0.667,traits:{'Character type':'Expressive','Gender':'Female','Hairstyle':'Silver curls','Style':'Tailored','Build':'Tall'}},
{id:'ren',name:'Ren Aoki',tag:'Modern · Eclectic',family:'Human',image:'ren',aspect:0.87,traits:{'Character type':'Expressive','Gender':'Male','Hairstyle':'Blue bob','Style':'Streetwear','Build':'Slim'}},
{id:'elise',name:'Elise Moreau',tag:'Timeless · Avant-garde',family:'Human',image:'elise',aspect:0.79,traits:{'Character type':'Natural','Gender':'Female','Hairstyle':'Silver swept','Style':'Avant-garde','Build':'Average'}},
{id:'jasper',name:'Jasper Quinn',tag:'Freckled · Free-spirited',family:'Human',image:'jasper',aspect:0.92,traits:{'Character type':'Natural','Gender':'Non-binary','Hairstyle':'Copper curls','Style':'Workwear','Build':'Slim'}},
{id:'milo',name:'Milo Park',tag:'Relaxed · Bold',family:'Human',image:'milo',aspect:0.667,traits:{'Character type':'Expressive','Gender':'Male','Hairstyle':'Pink crop','Style':'Tailored','Build':'Broad'}},
{id:'felix',name:'Felix Grey',tag:'Curious · Well-dressed',family:'Animal',image:'felix',aspect:0.83,traits:{'Character type':'Fox','Style':'Vintage','Build':'Average'}},
{id:'mei',name:'Mei Sora',tag:'Playful · Sculptural',family:'Human',image:'mei',aspect:0.82,traits:{'Character type':'Surreal','Gender':'Female','Hairstyle':'Sculpted updo','Style':'Avant-garde','Build':'Slim'}},
{id:'zuri',name:'Zuri Adeyemi',tag:'Golden · Effortless',family:'Human',image:'zuri',aspect:0.667,traits:{'Character type':'Expressive','Gender':'Female','Hairstyle':'Sculpted braids','Style':'Editorial','Build':'Tall'}},
];
import gallery from './gallery.json';
// The import script validates these generated records; tests verify their replay contract.
export const characters=gallery as unknown as Character[];
export const allCharacters:Character[]=[...characters,...legacyCharacters];
export type TraitOption={label:string;image?:string;thumbnail?:string;color?:string;symbol?:string};
export type TraitCategory={name:string;icon:string;thumbnailLayout?:string;options:TraitOption[]};
import catalog from '../shared/traits.json' with {type:'json'};
export const traitCategories:TraitCategory[]=catalog;
// Preserve existing drafts while removing obsolete nested choices and lock state.
export function normalizeTraits(input:Record<string,string>){
 const traits={...input};
 if(traits['Character type']==='Expressive')traits['Character type']='Bold';
 if(traits['Character type']==='Surreal')traits['Character type']='Extreme';
 if(traits.Hair&&!traits.Hairstyle)traits.Hairstyle=traits.Hair;
 if(traits['Character type']==='Animal')traits['Character type']=traits.Animal||'Fox';
 return Object.fromEntries(traitCategories.flatMap(c=>c.options.some(o=>o.label===traits[c.name])?[[c.name,traits[c.name]]]:[]));
}
