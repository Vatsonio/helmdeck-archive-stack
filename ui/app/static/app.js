'use strict';
const $=s=>document.querySelector(s);
const enc=encodeURIComponent;
const video=$('#video'),video2=$('#video2'),wrap=$('#videowrap'),wrap2=$('#videowrap2'),
      osd=$('#osd'),gc=$('#graph'),stage=$('#stage'),mapC=$('#map');

const WHITE='#f2efe9',GREEN='#6fcf7a',RED='#e04a3a',YELLOW='#e0b02f',BLUE='#5aa7d6',GOLD='#c9a24a',DIM='#9a8d78',FAINT='#5a5044';
const CH=[
  {f:'speed_kmh',l:'SPD km/h',c:WHITE,fix:1},
  {f:'battery_pct',l:'BAT %',c:GREEN,max:100,fix:0},
  {f:'alt_m',l:'ALT m',c:BLUE,fix:1},
  {f:'elrs_lq_pct',l:'LQ %',c:GOLD,max:100,fix:0},
  {f:'mavlink_loss_pct',l:'LOSS %',c:RED,fix:1},
];
const RATES=[0.25,0.5,1,2,4,8];

const state={
  tree:[],expanded:new Set(),firstTree:true,active:null,
  segs:[],totalDur:0,range:null,view:null,gaps:[],
  samples:[],merged:[],markers:[],telemFail:false,
  sync:0,osdOn:true,mapOn:true,cmpOn:false,otherCam:null,
  hls:null,hls2:null,
  graphBase:null,mapBase:null,mapProj:null,hover:null,drag:null,
  inW:null,outW:null,pendingSeek:null,
  chOn:new Set(['speed_kmh','battery_pct']),
};

async function fetchJSON(url){const r=await fetch(url);if(!r.ok)throw new Error(r.status+' '+url);return r.json();}
const tfmt=w=>new Date(w).toISOString().slice(11,19)+'Z';
const nice=v=>{if(!(v>0))return 1;const p=Math.pow(10,Math.floor(Math.log10(v)));for(const m of[1,2,5,10])if(m*p>=v)return m*p;return 10*p;};

/* ---------------- tree ---------------- */
async function loadTree(){
  let data;
  try{data=await fetchJSON('/api/tree');}
  catch(e){if(!state.tree.length)$('#tree').innerHTML='<div class="msg err">LINK DOWN — RETRYING</div>';return;}
  state.tree=data.nodes||[];
  const first=state.firstTree;
  if(first){
    for(const n of state.tree){state.expanded.add('n:'+n.node);for(const c of n.cameras||[])state.expanded.add('c:'+n.node+'/'+c.cam);}
    state.firstTree=false;
  }
  renderTree();
  if(first&&!state.active){
    const hp=parseHash();
    if(hp){state.pendingSeek=hp.t||0;selectDay(hp.node,hp.cam,hp.day);}
  }
}
function renderTree(){
  const el=$('#tree');
  if(!state.tree.length){el.innerHTML='<div class="msg">NO RECORDINGS YET</div>';return;}
  const a=state.active,h=[];
  const esc=s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;');
  for(const n of state.tree){
    const nk='n:'+n.node,nOpen=state.expanded.has(nk);
    h.push(`<button class="trow nrow" data-k="${esc(nk)}"><span class="arrow">${nOpen?'▾':'▸'}</span>${esc(n.node)}</button>`);
    if(!nOpen)continue;
    for(const c of n.cameras||[]){
      const ck='c:'+n.node+'/'+c.cam,cOpen=state.expanded.has(ck);
      h.push(`<button class="trow crow" data-k="${esc(ck)}"><span class="arrow">${cOpen?'▾':'▸'}</span>${esc(c.cam)}</button>`);
      if(!cOpen)continue;
      for(const d of c.days||[]){
        const act=a&&a.node===n.node&&a.cam===c.cam&&a.day===d.day;
        h.push(`<button class="trow drow${act?' active':''}" data-day="1" data-node="${esc(n.node)}" data-cam="${esc(c.cam)}" data-d="${esc(d.day)}"><span>${esc(d.day)}</span><span class="count">${d.segments} seg</span></button>`);
      }
    }
  }
  el.innerHTML=h.join('');
}
$('#tree').addEventListener('click',e=>{
  const b=e.target.closest('.trow');if(!b)return;
  if(b.dataset.day){selectDay(b.dataset.node,b.dataset.cam,b.dataset.d);return;}
  const k=b.dataset.k;
  state.expanded.has(k)?state.expanded.delete(k):state.expanded.add(k);
  renderTree();
});

/* ---------------- deep link ---------------- */
function parseHash(){
  const m=location.hash.match(/^#([^/]+)\/([^/]+)\/([^/?]+)(?:\?t=([\d.]+))?/);
  if(!m)return null;
  return {node:decodeURIComponent(m[1]),cam:decodeURIComponent(m[2]),day:decodeURIComponent(m[3]),t:m[4]?+m[4]:0};
}
let lastHash=0;
function writeHash(){
  const a=state.active;if(!a||!state.segs.length)return;
  history.replaceState(null,'',`#${enc(a.node)}/${enc(a.cam)}/${enc(a.day)}?t=${video.currentTime.toFixed(1)}`);
}

/* ---------------- selection ---------------- */
async function selectDay(node,cam,day){
  state.active={node,cam,day};
  state.segs=[];state.samples=[];state.merged=[];state.markers=[];state.range=null;state.view=null;
  state.gaps=[];state.graphBase=null;state.mapBase=null;state.telemFail=false;state.inW=null;state.outW=null;
  renderTree();updateClipUI();
  $('#crumb').classList.remove('none');
  $('#crumb').innerHTML=`${node} <span class="sep">/</span> ${cam} <span class="sep">/</span> ${day}`;
  $('#empty').hidden=true;$('#notice').hidden=true;
  const ex=$('#exportBtn');ex.hidden=false;ex.href=`/api/export?node=${enc(node)}&cam=${enc(cam)}&day=${enc(day)}`;
  $('#copyBtn').disabled=false;$('#frameBtn').disabled=false;
  $('#clipCtl').hidden=false;$('#buf').hidden=false;
  updateCmpAvail();
  let segRes;
  try{segRes=await fetchJSON(`/api/segments?node=${enc(node)}&cam=${enc(cam)}&day=${enc(day)}`);}
  catch(e){notice('FAILED TO LOAD SEGMENT INDEX');return;}
  state.segs=segRes.segments||[];
  state.totalDur=segRes.total_dur||0;
  if(!state.segs.length){notice('NO SEGMENTS IN THIS RECORDING');return;}
  const last=state.segs[state.segs.length-1];
  state.range=[state.segs[0].start_ms,last.start_ms+last.dur*1000];
  state.view=[...state.range];
  state.gaps=[];
  for(let i=0;i<state.segs.length-1;i++){
    const e0=state.segs[i].start_ms+state.segs[i].dur*1000,s1=state.segs[i+1].start_ms;
    if(s1-e0>1500)state.gaps.push([e0,s1]);
  }
  attachHls(`/api/hls?node=${enc(node)}&cam=${enc(cam)}&day=${enc(day)}`);
  if(state.pendingSeek){const t=state.pendingSeek;state.pendingSeek=null;
    try{video.currentTime=t;}catch(e){}
    video.addEventListener('loadedmetadata',()=>{try{video.currentTime=t;}catch(e){}},{once:true});
  }
  if(state.cmpOn)setCmp(true); // reattach second cam for new day
  writeHash();
  loadTelemetry(node,state.range[0]-35000,state.range[1]+35000);
}
function notice(msg){const n=$('#notice');n.textContent=msg;n.hidden=false;}

async function loadTelemetry(node,start,end){
  try{
    const res=await fetchJSON(`/api/telemetry?node=${enc(node)}&start=${Math.floor(start)}&end=${Math.ceil(end)}`);
    state.samples=res.samples||[];
    const merged=[];let cur={};
    for(const s of state.samples){cur=Object.assign({},cur,s.p);merged.push(cur);}
    state.merged=merged;
    computeMarkers();
  }catch(e){state.samples=[];state.merged=[];state.telemFail=true;}
  state.graphBase=null;state.mapBase=null;
}
function computeMarkers(){
  const M=[];const prev={};
  for(const s of state.samples){
    const p=s.p;
    if(p.mode!=null&&prev.mode!=null&&p.mode!==prev.mode)M.push({t:s.t,c:WHITE,l:'MODE '+String(p.mode).toUpperCase()});
    if(p.armed!=null&&prev.armed!=null&&p.armed!==prev.armed)M.push({t:s.t,c:p.armed?RED:GREEN,l:p.armed?'ARMED':'DISARMED'});
    if(p.elrs_lq_pct!=null&&prev.elrs_lq_pct!=null&&p.elrs_lq_pct<40&&prev.elrs_lq_pct>=40)M.push({t:s.t,c:YELLOW,l:'LQ LOW '+Math.round(p.elrs_lq_pct)+'%'});
    if(p.gps_fix!=null&&prev.gps_fix!=null&&p.gps_fix!==prev.gps_fix)M.push({t:s.t,c:/3D|RTK/i.test(p.gps_fix)?GREEN:YELLOW,l:'GPS '+p.gps_fix});
    Object.assign(prev,p);
  }
  state.markers=M;
}

/* ---------------- hls ---------------- */
function attachHls(url){
  if(state.hls){state.hls.destroy();state.hls=null;}
  video.removeAttribute('src');video.load();
  const H=window.Hls;
  if(H&&H.isSupported()){
    state.hls=new H();
    state.hls.on(H.Events.ERROR,(_,d)=>{if(d.fatal)notice('STREAM ERROR: '+d.type);});
    state.hls.loadSource(url);state.hls.attachMedia(video);
  }else if(video.canPlayType('application/vnd.apple.mpegurl')){
    video.src=url;
  }else{
    notice('HEVC / HLS PLAYBACK NOT SUPPORTED IN THIS BROWSER');
  }
}
video.addEventListener('playing',()=>{$('#notice').hidden=true;});

/* ---------------- compare ---------------- */
function updateCmpAvail(){
  const a=state.active;state.otherCam=null;
  if(a){const n=state.tree.find(x=>x.node===a.node);
    if(n)for(const c of n.cameras||[])if(c.cam!==a.cam&&(c.days||[]).some(d=>d.day===a.day)){state.otherCam=c.cam;break;}}
  $('#cmpBtn').disabled=!state.otherCam;
  if(!state.otherCam&&state.cmpOn)setCmp(false);
}
function setCmp(on){
  state.cmpOn=on&&!!state.otherCam;
  $('#cmpBtn').classList.toggle('on',state.cmpOn);
  wrap2.hidden=!state.cmpOn;
  $('#cam1label').hidden=!state.cmpOn;
  if(state.hls2){state.hls2.destroy();state.hls2=null;}
  video2.removeAttribute('src');video2.load();
  if(state.cmpOn){
    const a=state.active;
    $('#cam1label').textContent=a.cam.toUpperCase();
    $('#cam2label').textContent=state.otherCam.toUpperCase();
    const url=`/api/hls?node=${enc(a.node)}&cam=${enc(state.otherCam)}&day=${enc(a.day)}`;
    const H=window.Hls;
    if(H&&H.isSupported()){state.hls2=new H();state.hls2.loadSource(url);state.hls2.attachMedia(video2);}
    else if(video2.canPlayType('application/vnd.apple.mpegurl'))video2.src=url;
  }
  fitStage();
}
$('#cmpBtn').addEventListener('click',()=>setCmp(!state.cmpOn));
function cmpSync(){
  if(!state.cmpOn)return;
  video2.playbackRate=video.playbackRate;
  if(video.paused!==video2.paused)video.paused?video2.pause():video2.play().catch(()=>{});
  if(video2.readyState>0&&Math.abs(video2.currentTime-video.currentTime)>0.35){
    try{video2.currentTime=video.currentTime;}catch(e){}
  }
}

/* ---------------- time mapping ---------------- */
function segIdxAt(ct){
  const s=state.segs;let lo=0,hi=s.length-1,ans=0;
  while(lo<=hi){const m=(lo+hi)>>1;if(s[m].cum<=ct){ans=m;lo=m+1;}else hi=m-1;}
  return ans;
}
function wallAt(ct){
  if(!state.segs.length)return null;
  const s=state.segs[segIdxAt(ct)];
  return s.start_ms+(ct-s.cum)*1000+state.sync*1000;
}
function ctAtWall(wall){
  const w=wall-state.sync*1000,s=state.segs;
  let lo=0,hi=s.length-1,ans=0;
  while(lo<=hi){const m=(lo+hi)>>1;if(s[m].start_ms<=w){ans=m;lo=m+1;}else hi=m-1;}
  const g=s[ans];
  return Math.max(0,Math.min(state.totalDur,g.cum+(w-g.start_ms)/1000));
}
function nearestSample(wall){
  const a=state.samples;if(!a.length)return -1;
  let lo=0,hi=a.length-1;
  while(lo<hi){const m=(lo+hi)>>1;if(a[m].t<wall)lo=m+1;else hi=m;}
  if(lo>0&&Math.abs(a[lo-1].t-wall)<=Math.abs(a[lo].t-wall))lo--;
  return lo;
}

/* ---------------- OSD ---------------- */
const C={val:WHITE,dim:DIM,acc:WHITE,ok:GREEN,bad:RED,warn:YELLOW};
const F=(v,d=0,u='')=>(v==null||Number.isNaN(v))?'-':(typeof v==='number'?v.toFixed(d):String(v))+u;
function block(ctx,x,y,lines,o){
  const lh=o.lh,pad=o.pad;
  let bw=0;for(const l of lines)bw=Math.max(bw,ctx.measureText(l.map(s=>s.t).join('')).width);
  bw+=pad*2;const bh=lines.length*lh+pad*1.4;
  if(o.right)x-=bw;if(o.bottom)y-=bh;
  ctx.fillStyle='rgba(10,8,5,0.62)';ctx.fillRect(x,y,bw,bh);
  ctx.strokeStyle='rgba(242,239,233,0.18)';ctx.lineWidth=1;ctx.strokeRect(x+.5,y+.5,bw-1,bh-1);
  ctx.textBaseline='top';
  lines.forEach((l,i)=>{let cx=x+pad;const cy=y+pad*0.8+i*lh;
    for(const s of l){ctx.fillStyle=s.c||C.val;ctx.fillText(s.t,cx,cy);cx+=ctx.measureText(s.t).width;}});
}
function drawOsd(){
  const dpr=devicePixelRatio||1,w=wrap.clientWidth,h=wrap.clientHeight;
  if(!w||!h)return;
  if(osd.width!==Math.round(w*dpr)||osd.height!==Math.round(h*dpr)){osd.width=Math.round(w*dpr);osd.height=Math.round(h*dpr);}
  const ctx=osd.getContext('2d');
  ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,w,h);
  if(!state.osdOn||!state.active||!state.segs.length)return;
  const fs=Math.max(11,Math.round(h/40));
  ctx.font=fs+'px ui-monospace,Menlo,Consolas,monospace';
  const o={lh:Math.round(fs*1.45),pad:Math.round(fs*0.7)};
  const M=12,ct=video.currentTime,wall=wallAt(ct);
  const idx=nearestSample(wall);
  const ok=idx>=0&&Math.abs(state.samples[idx].t-wall)<=3000;
  const d=ok?state.merged[idx]:null;
  const dm=t=>({t,c:C.dim}),vl=(t,c)=>({t,c:c||C.val});
  if(ok){
    const armed=d.armed===true?vl('ARMED',C.bad):d.armed===false?vl('DISARM',C.ok):vl('-',C.dim);
    block(ctx,M,M,[
      [vl(d.mode!=null?String(d.mode).toUpperCase():'-',C.acc),dm('  '),armed],
      [dm('SPD  '),vl(F(d.speed_kmh,1)),dm(' km/h')],
      [dm('ALT  '),vl(F(d.alt_m,1)),dm(' m')],
      [dm('HDG '),vl(F(d.heading_deg,0,'°')),dm('  P '),vl(F(d.pitch_deg,1,'°')),dm('  R '),vl(F(d.roll_deg,1,'°'))],
    ],o);
    const lq=d.elrs_lq_pct,lqc=lq==null?C.dim:lq>=70?C.ok:lq>=40?C.warn:C.bad;
    block(ctx,w-M,M,[
      [dm('BAT  '),vl(F(d.battery_v,1,'V')),dm(' '),vl(F(d.battery_pct,0,'%')),dm(' '),vl(F(d.battery_a,1,'A'))],
      [dm('MAV  '),vl(F(d.mavlink_hz,1,'Hz')),dm(' LOSS '),vl(F(d.mavlink_loss_pct,1,'%'))],
      [dm('LQ   '),vl(F(lq,0,'%'),lqc)],
    ],{...o,right:true});
    block(ctx,M,h-M,[
      [dm('LAT  '),vl(F(d.lat,7))],
      [dm('LON  '),vl(F(d.lon,7))],
      [dm('GPS  '),vl(F(d.gps_fix)),dm(' S'),vl(F(d.gps_sats)),dm(' H'),vl(F(d.gps_hdop,1))],
      [dm('HOME '),vl(F(d.home_dist_m,0,' m')),dm('  MSN '),vl(F(d.mission_dist_m,0,' m'))],
    ],{...o,bottom:true});
  }else{
    block(ctx,M,M,[[vl('NO TELEMETRY',C.bad)]],o);
  }
  const si=segIdxAt(ct);
  const tt=s=>{s=Math.max(0,Math.floor(s));return String(Math.floor(s/3600)).padStart(2,'0')+':'+String(Math.floor(s/60)%60).padStart(2,'0')+':'+String(s%60).padStart(2,'0');};
  const iso=wall!=null?new Date(wall).toISOString().replace('T',' ').slice(0,19)+'Z':'-';
  block(ctx,w-M,h-M,[
    [vl(iso,C.acc)],
    [dm('T+'),vl(tt(ct)),dm('  SEG '),vl((si+1)+'/'+state.segs.length),dm('  '),vl(video.playbackRate.toFixed(2).replace(/\.?0+$/,'')+'×',C.dim)],
  ],{...o,right:true,bottom:true});
}

/* ---------------- graph ---------------- */
function seriesPoints(field,v0,v1){
  const pts=[];
  for(const s of state.samples){if(s.t<v0-30000||s.t>v1+30000)continue;const v=s.p[field];if(typeof v==='number')pts.push([s.t,v]);}
  return pts;
}
function renderGraphBase(w,h,dpr){
  const c=document.createElement('canvas');c.width=w*dpr;c.height=h*dpr;
  const ctx=c.getContext('2d');ctx.setTransform(dpr,0,0,dpr,0,0);
  ctx.fillStyle='#14100c';ctx.fillRect(0,0,w,h);
  if(!state.view)return c;
  const [v0,v1]=state.view,span=Math.max(1,v1-v0);
  const X=t=>(t-v0)/span*w,padY=10,gh=h-padY*2;
  for(const [ga,gb] of state.gaps){
    if(gb<v0||ga>v1)continue;
    const xa=Math.max(0,X(ga)),xb=Math.min(w,X(gb));
    ctx.fillStyle='rgba(224,74,58,0.08)';ctx.fillRect(xa,0,xb-xa,h);
    if(xb-xa>34){ctx.fillStyle='rgba(224,74,58,0.55)';ctx.font='9px ui-monospace,Menlo,monospace';ctx.textBaseline='top';ctx.fillText('GAP',(xa+xb)/2-9,h-12);}
  }
  ctx.font='9px ui-monospace,Menlo,monospace';ctx.textBaseline='bottom';
  const steps=[10e3,30e3,60e3,120e3,300e3,600e3,1800e3,3600e3,7200e3,4*3600e3];
  let step=steps[steps.length-1];
  for(const s of steps)if(span/s<=w/80){step=s;break;}
  for(let t=Math.ceil(v0/step)*step;t<v1;t+=step){
    const x=X(t);ctx.strokeStyle='rgba(42,33,24,0.9)';ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,h);ctx.stroke();
    const dt=new Date(t);ctx.fillStyle=FAINT;
    let lbl=String(dt.getUTCHours()).padStart(2,'0')+':'+String(dt.getUTCMinutes()).padStart(2,'0');
    if(step<60e3)lbl+=':'+String(dt.getUTCSeconds()).padStart(2,'0');
    ctx.fillText(lbl,x+3,h-2);
  }
  ctx.strokeStyle='rgba(42,33,24,0.6)';
  for(let i=1;i<4;i++){const y=padY+gh*i/4;ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(w,y);ctx.stroke();}
  const labels=[];
  for(const ch of CH){
    if(!state.chOn.has(ch.f))continue;
    const pts=seriesPoints(ch.f,v0,v1);
    let max=ch.max;
    if(!max){max=0;for(const p of pts)max=Math.max(max,p[1]);max=nice(max||1);}
    labels.push({l:ch.l,max,c:ch.c});
    if(!pts.length)continue;
    ctx.strokeStyle=ch.c;ctx.lineWidth=1.25;ctx.beginPath();let pen=false,pt=0;
    for(const[t,v]of pts){
      const x=X(t),y=padY+gh-Math.max(0,Math.min(1,v/max))*gh;
      if(pen&&t-pt>15000)pen=false;
      pen?ctx.lineTo(x,y):ctx.moveTo(x,y);pen=true;pt=t;
    }
    ctx.stroke();
  }
  ctx.textBaseline='top';
  labels.forEach((L,i)=>{ctx.fillStyle=L.c;ctx.fillText(L.max+' '+L.l,4,4+i*11);});
  for(const m of state.markers){
    if(m.t<v0||m.t>v1)continue;
    const x=X(m.t);
    ctx.strokeStyle=m.c;ctx.lineWidth=1;
    ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,9);ctx.stroke();
    ctx.fillStyle=m.c;ctx.fillRect(x-2,0,4,4);
  }
  if(!state.samples.length){
    ctx.fillStyle=FAINT;ctx.font='11px ui-monospace,Menlo,monospace';
    ctx.fillText(state.telemFail?'TELEMETRY UNAVAILABLE':'NO TELEMETRY FOR THIS SPAN',w/2-90,h/2-6);
  }
  return c;
}
let gW=0,gH=0;
function drawGraph(){
  const dpr=devicePixelRatio||1,w=gc.clientWidth,h=gc.clientHeight;
  if(!w||!h)return;
  if(gc.width!==Math.round(w*dpr)||gc.height!==Math.round(h*dpr)){gc.width=Math.round(w*dpr);gc.height=Math.round(h*dpr);state.graphBase=null;}
  if(!state.graphBase||gW!==w||gH!==h){state.graphBase=renderGraphBase(w,h,dpr);gW=w;gH=h;}
  const ctx=gc.getContext('2d');ctx.setTransform(1,0,0,1,0,0);
  ctx.drawImage(state.graphBase,0,0);
  ctx.setTransform(dpr,0,0,dpr,0,0);
  if(!state.view){ctx.fillStyle=FAINT;ctx.font='11px ui-monospace,Menlo,monospace';ctx.fillText('NO RECORDING LOADED',12,h/2-5);return;}
  const [v0,v1]=state.view,span=Math.max(1,v1-v0),X=t=>(t-v0)/span*w;
  for(const [wv,lbl] of [[state.inW,'IN'],[state.outW,'OUT']]){
    if(wv==null||wv<v0||wv>v1)continue;
    const x=X(wv);
    ctx.strokeStyle=WHITE;ctx.setLineDash([3,3]);ctx.lineWidth=1;
    ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,h);ctx.stroke();ctx.setLineDash([]);
    ctx.fillStyle=WHITE;ctx.font='9px ui-monospace,Menlo,monospace';ctx.textBaseline='top';
    ctx.fillText(lbl,x+3,12);
  }
  if(state.inW!=null&&state.outW!=null&&state.outW>state.inW){
    const xa=Math.max(0,X(state.inW)),xb=Math.min(w,X(state.outW));
    ctx.fillStyle='rgba(242,239,233,0.05)';ctx.fillRect(xa,0,xb-xa,h);
  }
  if(state.drag){
    const [a,b]=state.drag,xa=Math.min(a,b),xb=Math.max(a,b);
    ctx.fillStyle='rgba(242,239,233,0.08)';ctx.fillRect(xa,0,xb-xa,h);
    ctx.strokeStyle='rgba(242,239,233,0.4)';ctx.strokeRect(xa+.5,.5,xb-xa-1,h-1);
  }
  const wall=wallAt(video.currentTime);
  if(wall!=null&&wall>=v0&&wall<=v1){
    const x=X(wall);
    ctx.strokeStyle=WHITE;ctx.lineWidth=1.5;
    ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,h);ctx.stroke();
    ctx.fillStyle=WHITE;
    ctx.beginPath();ctx.moveTo(x-4,0);ctx.lineTo(x+4,0);ctx.lineTo(x,6);ctx.closePath();ctx.fill();
  }
  if(state.hover!=null&&!state.drag){
    const hx=state.hover,ht=v0+hx/w*span;
    ctx.strokeStyle='rgba(242,239,233,0.25)';ctx.lineWidth=1;
    ctx.beginPath();ctx.moveTo(hx,0);ctx.lineTo(hx,h);ctx.stroke();
    const lines=[tfmt(ht)];
    const mk=state.markers.find(m=>Math.abs(X(m.t)-hx)<6);
    if(mk)lines.push('▪ '+mk.l);
    const idx=nearestSample(ht);
    if(idx>=0&&Math.abs(state.samples[idx].t-ht)<=5000){
      const d=state.merged[idx];
      for(const ch of CH){if(!state.chOn.has(ch.f))continue;
        const v=d[ch.f];lines.push(ch.l.split(' ')[0]+' '+(typeof v==='number'?v.toFixed(ch.fix):'-'));}
    }
    ctx.font='10px ui-monospace,Menlo,monospace';
    let bw=0;for(const L of lines)bw=Math.max(bw,ctx.measureText(L).width);
    bw+=12;const bh=lines.length*13+8;
    let bx=hx+8;if(bx+bw>w-4)bx=hx-8-bw;
    let by=Math.max(4,Math.min(h-bh-4,14));
    ctx.fillStyle='rgba(10,8,5,0.88)';ctx.fillRect(bx,by,bw,bh);
    ctx.strokeStyle='rgba(242,239,233,0.25)';ctx.strokeRect(bx+.5,by+.5,bw-1,bh-1);
    ctx.textBaseline='top';
    lines.forEach((L,i)=>{
      ctx.fillStyle=i===0?WHITE:(mk&&i===1?mk.c:DIM);
      if(i>0&&(!mk||i>1)){const ch=CH.filter(x=>state.chOn.has(x.f))[i-(mk?2:1)];if(ch)ctx.fillStyle=ch.c;}
      ctx.fillText(L,bx+6,by+4+i*13);
    });
  }
}
function setView(a,b){
  const [t0,t1]=state.range;
  let va=Math.max(t0,Math.min(a,b)),vb=Math.min(t1,Math.max(a,b));
  if(vb-va<5000){const c=(va+vb)/2;va=c-2500;vb=c+2500;}
  state.view=[va,vb];state.graphBase=null;
}
let gMouse=null;
gc.addEventListener('pointerdown',e=>{
  if(!state.view)return;
  gc.setPointerCapture(e.pointerId);
  gMouse={x0:e.offsetX,moved:false};
});
gc.addEventListener('pointermove',e=>{
  state.hover=e.offsetX;
  if(gMouse&&Math.abs(e.offsetX-gMouse.x0)>4){gMouse.moved=true;state.drag=[gMouse.x0,e.offsetX];}
});
gc.addEventListener('pointerup',e=>{
  if(!gMouse)return;
  const w=gc.clientWidth,[v0,v1]=state.view,span=v1-v0;
  if(gMouse.moved&&state.drag){
    const ta=v0+Math.min(...state.drag)/w*span,tb=v0+Math.max(...state.drag)/w*span;
    if(tb-ta>1000)setView(ta,tb);
  }else if(state.segs.length){
    let t=v0+e.offsetX/w*span;
    const mk=state.markers.find(m=>Math.abs((m.t-v0)/span*w-e.offsetX)<6);
    if(mk)t=mk.t;
    try{video.currentTime=ctAtWall(t);}catch(err){}
  }
  gMouse=null;state.drag=null;
});
gc.addEventListener('pointerleave',()=>{state.hover=null;});
gc.addEventListener('dblclick',()=>{if(state.range)setView(...state.range);});
gc.addEventListener('wheel',e=>{
  if(!state.view)return;e.preventDefault();
  const w=gc.clientWidth,[v0,v1]=state.view,span=v1-v0;
  const ct=v0+e.offsetX/w*span,f=e.deltaY>0?1.25:0.8;
  setView(ct-(ct-v0)*f,ct+(v1-ct)*f);
},{passive:false});

/* ---------------- legend ---------------- */
function renderLegend(){
  $('#legend').innerHTML=CH.map(c=>`<button type="button" class="lgd${state.chOn.has(c.f)?' on':''}" data-f="${c.f}" style="--c:${c.c}">— ${c.l}</button>`).join('');
}
$('#legend').addEventListener('click',e=>{
  const b=e.target.closest('.lgd');if(!b)return;
  const f=b.dataset.f;
  state.chOn.has(f)?state.chOn.delete(f):state.chOn.add(f);
  state.graphBase=null;renderLegend();
});
renderLegend();

/* ---------------- track map ---------------- */
function renderMapBase(w,h,dpr){
  const c=document.createElement('canvas');c.width=w*dpr;c.height=h*dpr;
  const ctx=c.getContext('2d');ctx.setTransform(dpr,0,0,dpr,0,0);
  ctx.fillStyle='#0f0c08';ctx.fillRect(0,0,w,h);
  const pts=[];
  const step=Math.max(1,Math.floor(state.samples.length/2000));
  for(let i=0;i<state.samples.length;i+=step){
    const p=state.samples[i].p;
    if(typeof p.lat==='number'&&typeof p.lon==='number')pts.push([p.lat,p.lon]);
  }
  if(pts.length<2){state.mapProj=null;
    ctx.fillStyle=FAINT;ctx.font='10px ui-monospace,Menlo,monospace';ctx.fillText('NO GPS TRACK',w/2-38,h/2-5);return c;}
  let la0=90,la1=-90,lo0=180,lo1=-180;
  for(const[la,lo]of pts){la0=Math.min(la0,la);la1=Math.max(la1,la);lo0=Math.min(lo0,lo);lo1=Math.max(lo1,lo);}
  const cosl=Math.cos((la0+la1)/2*Math.PI/180);
  const dx=(lo1-lo0)*cosl||1e-9,dy=(la1-la0)||1e-9,pad=14;
  const k=Math.min((w-pad*2)/dx,(h-pad*2)/dy);
  const ox=(w-dx*k)/2,oy=(h-dy*k)/2;
  const proj=(la,lo)=>[ox+(lo-lo0)*cosl*k,h-oy-(la-la0)*k];
  state.mapProj=proj;
  ctx.strokeStyle='rgba(42,33,24,0.9)';
  for(let i=1;i<4;i++){
    ctx.beginPath();ctx.moveTo(w*i/4,0);ctx.lineTo(w*i/4,h);ctx.stroke();
    ctx.beginPath();ctx.moveTo(0,h*i/4);ctx.lineTo(w,h*i/4);ctx.stroke();
  }
  ctx.strokeStyle=DIM;ctx.lineWidth=1.25;ctx.beginPath();
  pts.forEach(([la,lo],i)=>{const[x,y]=proj(la,lo);i?ctx.lineTo(x,y):ctx.moveTo(x,y);});
  ctx.stroke();
  const[hx,hy]=proj(pts[0][0],pts[0][1]);
  ctx.fillStyle=GREEN;ctx.fillRect(hx-3,hy-3,6,6);
  ctx.fillStyle=FAINT;ctx.font='9px ui-monospace,Menlo,monospace';ctx.fillText('HOME',hx+6,hy-3);
  return c;
}
let mW=0,mH=0;
function drawMap(){
  const panel=$('#mapPanel');
  const show=state.mapOn&&!!state.active;
  panel.hidden=!show;
  if(!show)return;
  const dpr=devicePixelRatio||1,w=mapC.clientWidth,h=mapC.clientHeight;
  if(!w||!h)return;
  if(mapC.width!==Math.round(w*dpr)||mapC.height!==Math.round(h*dpr)){mapC.width=Math.round(w*dpr);mapC.height=Math.round(h*dpr);state.mapBase=null;}
  if(!state.mapBase||mW!==w||mH!==h){state.mapBase=renderMapBase(w,h,dpr);mW=w;mH=h;}
  const ctx=mapC.getContext('2d');ctx.setTransform(1,0,0,1,0,0);
  ctx.drawImage(state.mapBase,0,0);
  ctx.setTransform(dpr,0,0,dpr,0,0);
  const wall=state.segs.length?wallAt(video.currentTime):null;
  const idx=wall!=null?nearestSample(wall):-1;
  const coordEl=$('#mapCoord');
  if(idx>=0&&state.mapProj){
    const d=state.merged[idx];
    if(typeof d.lat==='number'&&typeof d.lon==='number'){
      const[x,y]=state.mapProj(d.lat,d.lon);
      if(typeof d.heading_deg==='number'){
        const a=(d.heading_deg-90)*Math.PI/180;
        ctx.strokeStyle=WHITE;ctx.lineWidth=1.5;
        ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(x+10*Math.cos(a),y+10*Math.sin(a));ctx.stroke();
      }
      ctx.fillStyle=WHITE;ctx.beginPath();ctx.arc(x,y,3.5,0,7);ctx.fill();
      coordEl.textContent=d.lat.toFixed(5)+', '+d.lon.toFixed(5);
      return;
    }
  }
  coordEl.textContent='';
}
$('#mapToggle').addEventListener('click',e=>{
  state.mapOn=!state.mapOn;e.currentTarget.classList.toggle('on',state.mapOn);
});

/* ---------------- clip in/out ---------------- */
function wallRaw(){const w=wallAt(video.currentTime);return w==null?null:w-state.sync*1000;}
function setIn(){const w=wallRaw();if(w==null)return;state.inW=w;if(state.outW!=null&&state.outW<=w)state.outW=null;updateClipUI();}
function setOut(){const w=wallRaw();if(w==null)return;state.outW=w;if(state.inW!=null&&state.inW>=w)state.inW=null;updateClipUI();}
function updateClipUI(){
  const a=state.active;
  $('#setIn').classList.toggle('set',state.inW!=null);
  $('#setOut').classList.toggle('set',state.outW!=null);
  $('#clipLbl').textContent=(state.inW!=null?'IN '+tfmt(state.inW):'')+(state.inW!=null&&state.outW!=null?' ':'')+(state.outW!=null?'OUT '+tfmt(state.outW):'');
  const ready=a&&state.inW!=null&&state.outW!=null&&state.outW>state.inW;
  $('#clipBtn').hidden=!ready;
  $('#clipClear').hidden=state.inW==null&&state.outW==null;
  if(ready)$('#clipBtn').href=`/api/export?node=${enc(a.node)}&cam=${enc(a.cam)}&day=${enc(a.day)}&start_ms=${Math.round(state.inW)}&end_ms=${Math.round(state.outW)}`;
}
$('#setIn').addEventListener('click',setIn);
$('#setOut').addEventListener('click',setOut);
$('#clipClear').addEventListener('click',()=>{state.inW=null;state.outW=null;updateClipUI();});

/* ---------------- top bar controls ---------------- */
$('#osdToggle').addEventListener('click',e=>{
  state.osdOn=!state.osdOn;e.currentTarget.classList.toggle('on',state.osdOn);
});
$('#sync').addEventListener('input',e=>{
  state.sync=parseFloat(e.target.value);
  $('#syncVal').textContent=(state.sync>=0?'+':'')+state.sync.toFixed(1)+'s';
});
$('#rate').addEventListener('change',e=>{video.playbackRate=parseFloat(e.target.value);});
function cycleRate(){
  const i=RATES.indexOf(video.playbackRate);
  const r=RATES[(i+1+RATES.length)%RATES.length]||1;
  video.playbackRate=r;$('#rate').value=String(r);
}
$('#copyBtn').addEventListener('click',e=>{
  const w=wallAt(video.currentTime);if(w==null)return;
  const idx=nearestSample(w);
  const d=idx>=0?state.merged[idx]:{};
  const iso=new Date(w).toISOString().replace('T',' ').slice(0,19)+'Z';
  const txt=iso+(typeof d.lat==='number'?'  '+d.lat.toFixed(7)+', '+d.lon.toFixed(7):'');
  navigator.clipboard&&navigator.clipboard.writeText(txt);
  const b=e.currentTarget,old=b.textContent;b.textContent='COPIED';setTimeout(()=>b.textContent=old,900);
});
$('#frameBtn').addEventListener('click',()=>{
  const a=state.active;if(!a)return;
  const c=document.createElement('canvas');
  c.width=video.videoWidth||1280;c.height=video.videoHeight||720;
  const ctx=c.getContext('2d');
  ctx.fillStyle='#000';ctx.fillRect(0,0,c.width,c.height);
  try{ctx.drawImage(video,0,0,c.width,c.height);}catch(e){}
  try{ctx.drawImage(osd,0,0,c.width,c.height);}catch(e){}
  const w=wallAt(video.currentTime);
  const name=`${a.node}_${a.cam}_${w!=null?new Date(w).toISOString().replace(/[:.]/g,'-').slice(0,19):'frame'}.png`;
  c.toBlob(b=>{if(!b)return;const u=URL.createObjectURL(b);const l=document.createElement('a');l.href=u;l.download=name;l.click();setTimeout(()=>URL.revokeObjectURL(u),3000);});
});
$('#keysBtn').addEventListener('click',()=>{$('#keys').hidden=false;});
$('#keys').addEventListener('click',()=>{$('#keys').hidden=true;});

function updateSegInfo(){
  const el=$('#segInfo');
  if(!state.segs.length){el.hidden=true;return;}
  el.hidden=false;
  const i=segIdxAt(video.currentTime),s=state.segs[i];
  $('#segLabel').textContent='SEG '+String(i+1).padStart(3,'0')+' · '+tfmt(s.start_ms);
  $('#segDl').href='/seg?path='+enc(s.path)+'&download=1';
}
function updateBuf(){
  const el=$('#buf');
  if(video.readyState===0){el.textContent='BUF —';el.className='mono';return;}
  let v=0;
  try{const b=video.buffered,ct=video.currentTime;
    for(let i=0;i<b.length;i++)if(ct>=b.start(i)-0.5&&ct<=b.end(i)){v=b.end(i)-ct;break;}}catch(e){}
  el.textContent='BUF '+v.toFixed(1)+'s';
  el.className='mono '+(v>5?'ok':v>2?'warn':'bad');
}

/* ---------------- hotkeys ---------------- */
addEventListener('keydown',e=>{
  if(e.target.matches&&e.target.matches('input,select,textarea'))return;
  if(e.target===video||e.target===video2)return;
  if(!$('#keys').hidden){$('#keys').hidden=true;return;}
  const k=e.key;
  const seek=d=>{if(!state.segs.length)return;try{video.currentTime=Math.max(0,Math.min(state.totalDur,video.currentTime+d));}catch(err){}};
  const toggle=()=>{video.paused?video.play().catch(()=>{}):video.pause();};
  if(k===' '){e.preventDefault();toggle();}
  else if(k==='ArrowLeft'){e.preventDefault();seek(e.shiftKey?-60:-5);}
  else if(k==='ArrowRight'){e.preventDefault();seek(e.shiftKey?60:5);}
  else if(k==='['){const i=segIdxAt(video.currentTime);if(state.segs[i-1])try{video.currentTime=state.segs[i-1].cum;}catch(err){}}
  else if(k===']'){const i=segIdxAt(video.currentTime);if(state.segs[i+1])try{video.currentTime=state.segs[i+1].cum;}catch(err){}}
  else if(k==='j'||k==='J')seek(-10);
  else if(k==='k'||k==='K')toggle();
  else if(k==='l'||k==='L')cycleRate();
  else if(k===','){video.pause();seek(-1/25);}
  else if(k==='.'){video.pause();seek(1/25);}
  else if(k==='i'||k==='I')setIn();
  else if(k==='o'||k==='O')setOut();
  else if(k==='?')$('#keys').hidden=false;
});

/* ---------------- layout / loop ---------------- */
function fitStage(){
  const panes=state.cmpOn?2:1,gap=12;
  const bw=(stage.clientWidth-24-(panes-1)*gap)/panes,bh=stage.clientHeight-24;
  let w=bw,h=bw*9/16;
  if(h>bh){h=bh;w=h*16/9;}
  for(const el of[wrap,wrap2]){el.style.width=Math.floor(w)+'px';el.style.height=Math.floor(h)+'px';}
}
new ResizeObserver(fitStage).observe(stage);
fitStage();
(function loop(){
  drawOsd();drawGraph();drawMap();
  if(state.segs.length){
    updateSegInfo();updateBuf();cmpSync();
    if(performance.now()-lastHash>2000){lastHash=performance.now();writeHash();}
  }
  requestAnimationFrame(loop);
})();
loadTree();
setInterval(loadTree,30000);
