import policy from '../custom_nodes/cast-character-sheet/reference-placement.json' with {type:'json'};

// Traits have already passed the prompt compiler's validation boundary.
export function referencePlacement(traits){
 const height=traits.Height||(traits.Build==='Tall'?'Tall':'Average');
 const proportions=traits.Proportions||'Natural';
 return {height,proportions,sourceWidth:policy[height][proportions==='Oversized head'?'oversized':'default'],top:48,seam:16};
}
