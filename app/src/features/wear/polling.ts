/**
 * The Wear screen's refresh clock. `refresh` resolves false only when the watch setup is known to be unsupported here;
 * then polling stops (or no timer starts). Ticks are skipped while a watch action is running (that action refreshes when it ends).
 * Returns the function that stops it.
 */
export function startWearPolling({refresh,busy,everyMs=3000,setTimer=setInterval,clearTimer=clearInterval}:{
  refresh:()=>Promise<boolean>;busy:()=>boolean;everyMs?:number;
  setTimer?:(fn:()=>void,ms:number)=>unknown;clearTimer?:(id:any)=>void;
}):()=>void{
  let stopped=false,timer:unknown;
  const stop=()=>{stopped=true;if(timer!==undefined){clearTimer(timer);timer=undefined;}};
  void refresh().then(supported=>{
    if(stopped || !supported)return;
    timer=setTimer(()=>{if(!stopped && !busy())void refresh().then(supported=>{if(!supported)stop();});},everyMs);
  });
  return stop;
}
