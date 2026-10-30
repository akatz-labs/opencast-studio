import catalog from './traits.json' with {type:'json'};
export const TEMPLATE_VERSION='opencast-krea-v4';
export const TEMPLATE_STRUCTURE='{medium_and_framing} {character_type} {age} {gender} {ethnicity} {skin_or_surface} {build} {height} {proportions} {head_and_neck} {facial_geometry} {eyes_and_features} {hairstyle} {hair_color} {facial_hair} {wardrobe_from_style} {accessories} {pose} {lighting_and_texture} {additional_direction}';
export const presets=[
 {name:'Split chin',traits:{'Character type':'Extreme',Gender:'Male',Build:'Slim',Hairstyle:'Curly mullet','Hair color':'Black',Style:'Streetwear',Age:'Adult','Skin tone':'Tan','Head shape':'Narrow',Jaw:'Wide shelf',Chin:'Double-lobed',Cheeks:'Lean',Mouth:'Small',Neck:'Long','Facial hair':'Pencil mustache'}},
 {name:'Long face',traits:{'Character type':'Extreme',Gender:'Non-binary',Build:'Slim',Hairstyle:'Bowl cut','Hair color':'Blonde',Style:'Vintage',Age:'Adult','Head shape':'Long',Jaw:'Tapered',Chin:'Pointed',Nose:'Long',Ears:'Protruding',Neck:'Extra long'}},
 {name:'Wide jaw',traits:{'Character type':'Bold',Gender:'Male',Build:'Broad',Hairstyle:'Swept quiff','Hair color':'Silver',Style:'Tailored',Age:'Older adult',Jaw:'Square',Chin:'Short cleft',Cheeks:'Lean',Brows:'Heavy ridge','Facial hair':'Horseshoe mustache'}},
 {name:'Tailored fox',traits:{'Character type':'Fox',Gender:'Non-binary',Build:'Average',Style:'Vintage',Age:'Adult',Accessories:'Neck scarf'}},
];
export function validateTraits(input){
 if(!input||Array.isArray(input)||typeof input!=='object')throw new Error('Traits must be an object.');
 const traits={...input};
 if(traits['Character type']==='Expressive')traits['Character type']='Bold';
 if(traits['Character type']==='Surreal')traits['Character type']='Extreme';
 for(const [k,v] of Object.entries(traits))if(!catalog.find(c=>c.name===k)?.options.some(o=>o.label===v))throw new Error(`Unknown trait: ${k}: ${v}`);
 return traits;
}
const hair={
 'Silver curls':['voluminous sculpted curls','silver'], 'Blue bob':['a blunt geometric bob','blue'],
 'Silver swept':['swept-back hair with a clean sculptural crest','silver'], 'Copper curls':['loose individual curls','copper'],
 'Pink crop':['a short textured crop','pink'], 'Sculpted updo':['a tall architectural updo','black'],
 'Sculpted braids':['carefully sculpted braids in a graphic arrangement','black'],
 'Sculptural afro':['an enormous oval sculptural afro, a continuous cloud of tightly coiled hair with a crisp rounded silhouette','black'],
 'Bowl cut':['a glossy mushroom bowl cut with a perfectly curved heavy fringe','black'],
 'Beehive':['a towering sculptural beehive hairstyle','silver'], Bald:['a clean bald head',null],
 'Curly mullet':['a curly mullet with short curls on top and long curls behind the shoulders','black'],
 'Swept quiff':['a high swept-back quiff with sculpted waves','silver'],
 'Flared bob':['a wide flared bob with a short straight fringe','blonde'],
};
export function compilePrompt(input,{direction='',framing='full-body'}={}){
 const traits=validateTraits(input),t=traits,notes=[],slots={};
 if(typeof direction!=='string'||direction.length>2000)throw new Error('Direction must be at most 2,000 characters.');
 if(!['full-body','portrait'].includes(framing))throw new Error('Unknown framing.');
 const kind=t['Character type']||'Bold', animal=!['Natural','Bold','Extreme'].includes(kind),extreme=kind==='Extreme';
 const gender={Female:'woman',Male:'man','Trans man':'man','Trans woman':'woman','Non-binary':'non-binary person'}[t.Gender]||'person';
 const age={'Young adult':'in their mid-twenties',Adult:'around forty years old','Older adult':'around seventy years old, with visible age lines'}[t.Age]||'around thirty years old';
 slots.character_type=animal?`a fictional anthropomorphic ${kind.toLowerCase()} fashion character, with a clearly recognizable ${kind.toLowerCase()} head and species-specific face, an upright clothed body and visible natural animal surface texture`:`one original fictional adult ${gender} ${age}`;
 if(animal){slots.age=`The character is an adult ${age}.`;if(t.Gender)slots.gender=`${t.Gender} gender presentation.`;if(t.Ethnicity&&t.Ethnicity!=='Unspecified')slots.ethnicity=`The character's human cultural identity is ${t.Ethnicity}; the face remains recognizably ${kind.toLowerCase()}.`;}
 else {if(t.Ethnicity&&t.Ethnicity!=='Unspecified')slots.ethnicity=`The subject is ${t.Ethnicity}.`;if(['Trans man','Trans woman'].includes(t.Gender))notes.push(`${t.Gender} is retained in settings; no stereotyped anatomy is inferred.`);}
 const tones={Porcelain:'very light porcelain',Fair:'fair',Olive:'olive',Tan:'warm tan',Deep:'deep brown'};
 if(t['Skin tone'])slots.skin_or_surface=`${tones[t['Skin tone']]} ${animal?'exposed skin; natural species markings remain visible':'skin with consistent natural coloration'}.`;
 slots.build={Slim:'A slender torso and narrow shoulders.',Average:'An average-sized torso and shoulders.',Athletic:'An athletic torso with defined arm muscles.',Broad:'Broad shoulders and a substantial torso.',Tall:'A tall, elongated body silhouette.',Strongman:'Massive shoulders and upper arms, a thick powerful torso and substantial legs.'}[t.Build]||'';
 if(t.Height){slots.height=`${t.Height==='Average'?'Average':t.Height} height.`;if(t.Build==='Tall'&&t.Height!=='Tall'){slots.build='An elongated torso silhouette.';notes.push('Explicit Height takes precedence over the legacy Tall build label.');}}
 slots.proportions={Natural:'Natural arm and leg lengths.','Long-limbed':'Exceptionally long arms and legs.',Exaggerated:'An exaggerated silhouette with short torso and elongated limbs.',Compact:'A compact torso with short substantial arms and legs.','Oversized head':'An oversized head above a small narrow-shouldered body.'}[t.Proportions]||'';
 const head={Natural:'a naturally proportioned head',Round:'a round head with a curved forehead',Angular:'an angular head with sharply defined planes',Long:extreme?'an extremely elongated head, much taller than it is wide':'a long rectangular head',Square:'a square head with straight sides','Pear-shaped':'a pear-shaped head with a narrow upper face above a broad lower face',Narrow:'a narrow forehead and slim upper face'}[t['Head shape']];
 const neck={Natural:'a naturally proportioned neck',Long:extreme?'a very long slender neck, one full head-length between jaw and collarbones':'an unusually long slender neck',Column:'a thick column-like neck','Pencil-thin':'a very thin neck, much narrower than the jaw','Extra long':'an extraordinarily elongated neck, longer than the head, clearly exposed above the collar'}[t.Neck];
 slots.head_and_neck=[head,neck].filter(Boolean).join(', ');
 if(slots.head_and_neck)slots.head_and_neck+='.';
 // Concrete geometry from the retained face-prompt study. Explicit choices
 // override intensity defaults; body mass is never applied to the whole face.
 const faceDefaults=animal||kind==='Natural'?{}:extreme?{Jaw:'Wide shelf',Chin:'Double-lobed',Cheeks:'Lean',Mouth:'Small'}:{Jaw:'Square',Chin:'Short cleft',Cheeks:'Lean'};
 const face={...faceDefaults,...t};
 const geometry={
  Jaw:{Natural:'A naturally proportioned jaw.',Square:'A square jaw with sharply defined corners.','Wide shelf':extreme?'Enormous jaw corners project far beyond the cheekbones, forming a wide shelf below the narrow upper face.':'Jaw corners slightly wider than the cheekbones.',Tapered:'A narrow jaw tapering sharply toward the chin.'},
  Chin:{Natural:'A naturally proportioned chin.','Short cleft':'A short wide flat-bottomed chin with a central cleft.','Long cleft':'An elongated rectangular chin extends far below the lower lip, split by a deep central groove.','Double-lobed':extreme?'Two enormous rounded chin lobes hang far below the mouth, separated by a deep vertical cleft.':'Two rounded chin lobes separated by a visible central cleft.',Pointed:'A long pointed chin with a narrow tip.'},
  Cheeks:{Natural:'Naturally shaped cheeks.',Lean:'Clearly defined cheekbones and lean upper cheeks.',Round:'Full rounded lower cheeks below small high cheekbones.'},
  Nose:{Natural:'A naturally proportioned nose.',Long:extreme?'An exceptionally long nose projects prominently from the face.':'A long pointed nose.',Broad:'A broad nose with a rounded tip.',Upturned:'A small upturned nose.'},
  Brows:{Natural:'Natural eyebrows.','Heavy ridge':'A pronounced heavy brow ridge extending across both eyes.',Unibrow:'A thick continuous unibrow across a projecting brow ridge.',Arched:'High sharply arched eyebrows.'},
  Ears:{Natural:'Naturally proportioned ears.',Protruding:'Prominent ears project sideways from the head.',Oversized:'Exceptionally large ears extend far beyond the sides of the head.'},
  Mouth:{Natural:'A naturally proportioned mouth.',Small:'A tiny mouth sits high above the chin.',Wide:'A wide expressive mouth.','Gap teeth':'Two prominent front teeth separated by a visible gap.'},
 };
 slots.facial_geometry=Object.entries(geometry).map(([field,options])=>options[face[field]]||'').filter(Boolean).join(' ');
 slots.eyes_and_features=[t['Eye shape']?`${t['Eye shape'].toLowerCase()} eyes`:'',t['Eye color']?`${t['Eye color'].toLowerCase()} irises`:'',{Freckles:'visible freckles across the nose and cheeks',Dimples:'distinct dimples','Beauty mark':'a small beauty mark on one cheek',None:'clear skin without decorative facial marks'}[t.Features]].filter(Boolean).join(', ');
 if(slots.eyes_and_features)slots.eyes_and_features+='.';
 if(t.Hairstyle){const [shape,defaultColor]=hair[t.Hairstyle];const color=t['Hair color']?.toLowerCase()||defaultColor;slots.hairstyle=t.Hairstyle==='Bald'?shape+'.':`${shape}, ${color} hair${animal?' styled as a crest above the animal face':''}.`;if(t['Hair color']&&defaultColor&&color!==defaultColor)notes.push('Hair color overrides the color in the hairstyle thumbnail name.');if(t.Hairstyle==='Bald'&&t['Hair color'])notes.push('Hair color is saved but has no visible effect on a bald head.');}
 else if(t['Hair color'])slots.hair_color=`${t['Hair color'].toLowerCase()} ${animal?'hair crest':'hair'}.`;
 slots.facial_hair={None:animal?'No added human facial hair; natural animal whiskers remain.':'Clean-shaven face.',Stubble:'Neat visible facial stubble.',Mustache:'A bold carefully groomed mustache.',Beard:'A full shaped beard.','Horseshoe mustache':'A thick black horseshoe mustache with long downward ends.'}[t['Facial hair']]||'';
 if(t['Facial hair']==='Pencil mustache')slots.facial_hair='A thin pencil mustache.';
 if(t['Facial hair']==='Bushy mustache')slots.facial_hair='A thick bushy mustache extending to both sides of the mouth.';
 if(t['Hair color']&&t['Facial hair']==='Horseshoe mustache')slots.facial_hair=`A thick ${t['Hair color'].toLowerCase()} horseshoe mustache with long downward ends.`;
 slots.wardrobe_from_style=`Clothing style: ${t.Style||'Tailored'}.`;
 if(framing==='portrait')notes.push('Portrait framing shows the head and upper torso; height and lower-body proportions remain recorded but may not be visible.');
 slots.accessories={None:'The outfit is free of jewelry, glasses and scarves.',Earrings:'Large brushed-silver sculptural earrings.',Glasses:'Distinctive round translucent glasses.','Neck scarf':'A patterned silk neck scarf with a vivid ochre accent.'}[t.Accessories]||'';
 slots.pose=framing==='portrait'?'The face is turned slightly toward the camera, with a composed self-possessed expression.':'A calm front-facing standing pose with a slight shift of weight, relaxed arms, clearly separated hands, a self-possessed deadpan expression.';
 const tier=extreme?'A playfully absurd sculptural character, with the specified extraordinary facial anatomy as the defining feature.':kind==='Bold'?'A distinctive eccentric fashion character with a striking silhouette.':'An individual character with a calm deadpan expression.';
 slots.medium_and_framing=framing==='portrait'?'Tightly cropped front-facing studio headshot. The complete hairstyle and face occupy nearly all of the image. Only the tops of the shoulders and the garment neckline appear along the lower edge.':'Full-body front-facing studio photograph, showing the complete hairstyle and both shoes with space around the silhouette. One character centered at eye level.';
 slots.lighting_and_texture=`${tier} ${animal?'Lifelike animal surface texture':'Lifelike human skin'} and real clothing. Plain white seamless background, soft broad frontal light, gentle contact shadows, individual hair strands, visible pores and detailed fabric. Quiet neutral color. One character, without lettering, logos, borders or collage.`;
 slots.additional_direction=direction.trim();
 const prompt=[slots.medium_and_framing,`The photograph shows ${slots.character_type}.`,...Object.entries(slots).filter(([k])=>!['medium_and_framing','character_type'].includes(k)).map(([,v])=>v)].filter(Boolean).join(' ');
 if(animal&&t.Ethnicity)notes.push('Ethnicity describes cultural identity; it does not replace the animal species or infer clothing stereotypes.');
 return {version:TEMPLATE_VERSION,structure:TEMPLATE_STRUCTURE,traits,slots,notes,prompt,negativePrompt:'',framing,direction};
}

export function compileCharacterSheet(traits,{direction='',promptOverride='',fullBodyPromptOverride=''}={}){
 for(const [name,value] of Object.entries({promptOverride,fullBodyPromptOverride}))if(typeof value!=='string'||value.length>12000)throw new Error(`${name} must be at most 12,000 characters.`);
 const compiled=compilePrompt(traits,{direction,framing:'portrait'});
 const bodyCompiled=compilePrompt(traits,{direction,framing:'full-body'});
 const prompt=promptOverride.trim()?promptOverride:compiled.prompt;
 const fullBodyPrompt=fullBodyPromptOverride.trim()?fullBodyPromptOverride:promptOverride.trim()
  ? `Full-body front-facing studio photograph, head to shoes. Show the complete hairstyle, both hands and both shoes with visible floor below the feet. One character centered at eye level, relaxed standing pose on a seamless background. Expand the reference portrait into a complete body, continuing its outfit, colors and lighting. Preserve the reference identity. No lettering or collage. The following describes the source character; any close-up or crop instructions describe only the source portrait, not this full-body output: ${promptOverride}`
  : bodyCompiled.prompt;
 return {compiled,bodyCompiled,prompt,fullBodyPrompt};
}
