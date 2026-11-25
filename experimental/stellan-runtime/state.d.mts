export interface NativeStateRecord {exists:boolean;revision:string;text:string}
export interface NativeState {closed:Promise<void>;readonly isClosed:boolean;get(key:string):Promise<NativeStateRecord>;put(key:string,revision:string,text:string):Promise<{revision:string}>;close():Promise<void>}
export function openNativeState(options:{executable:string;executableSha256:string;root:string;signal?:AbortSignal;startupTimeoutMs?:number}):Promise<NativeState>;
