/** Pure orchestration for the background repair pass; the native module and the signed sync are injected. */
type RepairServer={id:string;deviceId:string;parent?:string};
type Ports<S extends RepairServer>={
  signal:AbortSignal;
  servers:S[];
  online:string;
  status:(server:string,device:string)=>Promise<{active:boolean;needsSync?:boolean}>;
  sync:(server:S,signal:AbortSignal)=>Promise<unknown>;
};
// One pass at a time for the whole app. Each effect run used to keep its own flag, so a store write that restarted the
// effect could start a second pass while the first was still syncing.
let running=false;
export async function repairEncryptedPush<S extends RepairServer>({signal,servers,online,status,sync}:Ports<S>):Promise<void>{
  if(running || signal.aborted)return;running=true;
  try{for(const server of servers.filter(s=>!s.parent && online.split('|').includes(s.id))){
    if(signal.aborted)break;
    try{const local=await status(server.id,server.deviceId);
      if(local.active && local.needsSync && !signal.aborted)await sync(server,signal);
    }catch{/* Repair remains visible in notification settings. */}
  }}finally{running=false;}
}
