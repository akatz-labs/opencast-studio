export const TEMPLATE_VERSION:string;
export const TEMPLATE_STRUCTURE:string;
export const presets:{name:string;traits:Record<string,string>}[];
export type Compiled={version:string;structure:string;traits:Record<string,string>;slots:Record<string,string>;notes:string[];prompt:string;negativePrompt:string;framing:string;direction:string};
export function validateTraits(input:unknown):Record<string,string>;
export function compilePrompt(input:Record<string,string>,options?:{direction?:string;framing?:string}):Compiled;
export function compileCharacterSheet(input:Record<string,string>,options?:{direction?:string;promptOverride?:string;fullBodyPromptOverride?:string}):{compiled:Compiled;bodyCompiled:Compiled;prompt:string;fullBodyPrompt:string};
