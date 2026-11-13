import {useEffect,useLayoutEffect} from 'react';
import {Platform} from 'react-native';
import {configureWebPushScope,webPushServer} from '../../lib/push';
import {useLock} from '../../lib/appLock';
import {usePrefs} from '../../lib/prefs';
import {useApp} from '../../lib/store';
import {pushNative} from './native';
import {syncEncryptedPush} from './api';
import {repairEncryptedPush} from './repair';
export function PushSecurityBridge(){
  const locked=useLock(st=>st.locked),hiddenAt=useLock(st=>st.hiddenAt);
  const loaded=usePrefs(st=>st.loaded),appLock=usePrefs(st=>st.prefs.appLock);
  const ready=useApp(st=>st.ready),foreground=useApp(st=>st.foreground),servers=useApp(st=>st.servers);
  const online=useApp(st=>st.servers.filter(s=>!s.parent && st.runtime[s.id]?.status==='online').map(s=>s.id).sort().join('|'));
  const retained=useApp(st=>JSON.stringify(st.servers.filter(s=>!s.parent && st.runtime[s.id]?.status!=='unauthorized').map(s=>({server:s.id,device:s.deviceId,url:s.url,token:s.token}))));
  useLayoutEffect(()=>{
    if(!pushNative)return;
    const state=useLock.getState();
    const grace=appLock && !!state.hiddenAt && Date.now()-state.hiddenAt>60000;
    pushNative.security(state.locked||grace||!loaded||!ready,appLock||!loaded,foreground,online?online.split('|'):[],JSON.parse(retained));
  },[locked,hiddenAt,loaded,ready,appLock,foreground,online,retained]);
  useEffect(()=>{
    if(!pushNative || !ready || !loaded)return;
    void pushNative.retain().catch(()=>undefined);
  },[ready,loaded,retained]);
  useEffect(()=>{
    if(Platform.OS==='web' && ready && loaded)void configureWebPushScope(webPushServer(servers),true).catch(()=>undefined);
  },[ready,loaded,servers]);
  useEffect(()=>{
    if(!pushNative || !ready || !loaded || locked || !foreground)return;
    const native=pushNative,controller=new AbortController();
    // Endpoint migrations repair only previously activated enrollments; no new opt-in.
    // Keyed on the online server ids, not the `servers` array: a store write that leaves the ids alone must not restart this.
    const repair=()=>repairEncryptedPush({signal:controller.signal,servers:useApp.getState().servers,online,
      status:(id,device)=>native.status(id,device),sync:syncEncryptedPush});
    void repair();const timer=setInterval(()=>void repair(),30000);
    return ()=>{controller.abort();clearInterval(timer);};
  },[ready,loaded,locked,foreground,online]);
  return null;
}
