/* PREVIEW-ONLY mock backend + fake playback clock. Not part of the deliverable. */
(()=>{
'use strict';
const DAY0=Date.UTC(2026,6,22,8,0,0);
const TREE={nodes:[
  {node:'NODE-7F3A9C',cameras:[
    {cam:'cam1',days:[{day:'2026-07-22',segments:40},{day:'2026-07-21',segments:98}]},
    {cam:'cam2',days:[{day:'2026-07-22',segments:38}]}]},
  {node:'NODE-2B41D0',cameras:[
    {cam:'cam1',days:[{day:'2026-07-20',segments:61}]}]},
]};
function mkSegments(node,cam,day){
  const segs=[];let cum=0,start=DAY0;
  for(let i=0;i<40;i++){
    segs.push({start_ms:start,dur:60,cum,path:`${node}/${cam}/${day}/${String(i).padStart(4,'0')}.mp4`});
    cum+=60;start+=60000+(i===19?300000:0); // 5 min recording gap mid-day
  }
  return {segments:segs,total_dur:cum,start_ms:DAY0};
}
function mkTelemetry(start,end){
  const samples=[];
  const gapA=DAY0+8*60000,gapB=DAY0+10*60000; // 2 min telemetry dropout
  for(let t=Math.max(start,DAY0-30000);t<=end;t+=500){
    if(t>gapA&&t<gapB)continue;
    const m=(t-DAY0)/60000,r=Math.sin(t/7300)*Math.cos(t/1900);
    const p={
      mode:m%9<6?'AUTO':'GUIDED',armed:true,
      speed_kmh:Math.max(0,12+8*Math.sin(t/60000)+2.5*r),
      alt_m:412+6*Math.sin(t/90000),
      heading_deg:(180+120*Math.sin(t/120000)+360)%360,
      pitch_deg:-1.2+2*r,roll_deg:0.4+1.5*Math.sin(t/5100),
      battery_v:25.2-2.8*(m/45),battery_pct:Math.max(0,98-55*(m/45)),battery_a:11+4*Math.abs(r),
      mavlink_hz:3.8+0.4*Math.sin(t/9000),mavlink_loss_pct:Math.max(0,1.1*r),
      elrs_lq_pct:Math.round(Math.min(100,92+7*Math.sin(t/31000))),
      lat:47.3821000+0.0004*m+0.0001*r,lon:8.5412000+0.0006*m,
      gps_fix:'3D',gps_sats:14+Math.round(3*Math.sin(t/40000)),gps_hdop:0.7+0.3*Math.abs(r),
      home_dist_m:m*38,mission_dist_m:Math.max(0,1900-m*38),
    };
    if(Math.sin(t/777)>0.93)delete p.gps_hdop; // occasional missing fields
    if(Math.sin(t/913)>0.95){delete p.battery_a;delete p.mission_dist_m;}
    samples.push({t,p});
  }
  return {samples};
}
const realFetch=window.fetch.bind(window);
window.fetch=(url,opts)=>{
  const u=new URL(url,location.origin),q=u.searchParams;
  const json=o=>Promise.resolve(new Response(JSON.stringify(o),{headers:{'Content-Type':'application/json'}}));
  if(u.pathname==='/api/tree')return json(TREE);
  if(u.pathname==='/api/segments')return json(mkSegments(q.get('node'),q.get('cam'),q.get('day')));
  if(u.pathname==='/api/telemetry')return json(mkTelemetry(+q.get('start'),+q.get('end')));
  if(u.pathname==='/api/hls')return json({});
  return realFetch(url,opts);
};
addEventListener('DOMContentLoaded',()=>{
  const v=document.getElementById('video');
  let t=0,playing=true,last=performance.now();
  const tick=()=>{const n=performance.now();if(playing)t=Math.min(t+(n-last)/1000,2700);last=n;return t;};
  Object.defineProperty(v,'currentTime',{get:tick,set(x){t=x;last=performance.now();}});
  Object.defineProperty(v,'paused',{get(){return !playing;}});
  v.addEventListener('click',()=>{playing=!playing;});
});
})();
