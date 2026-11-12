import type { Slide } from "./store";
import { MUSIC_CSS, MUSIC_JS, MUSIC_BTN, musicAudioHtml } from "./music-player";
import { slideDurationMs } from "./duration";

/** CSP for the player page: inline CSS/JS, images from this origin only, no network calls. */
export const PLAYER_CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self'; media-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

const CSS = String.raw`*{box-sizing:border-box}html,body{margin:0;height:100%;overflow:hidden}body{font-family:system-ui,-apple-system,sans-serif;background:#fff8e7;color:#3b2a14;-webkit-tap-highlight-color:transparent}
.ss{display:flex;flex-direction:column;height:100vh;height:100dvh;max-width:820px;margin:0 auto;padding:max(10px,env(safe-area-inset-top)) 12px max(12px,env(safe-area-inset-bottom))}
.top{display:flex;align-items:center;gap:10px;min-height:40px}.ttl{flex:1;font-family:Georgia,'Times New Roman',serif;font-weight:700;font-size:1.15rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.back{color:#8a6200;text-decoration:none;font-weight:700;padding:6px 4px}.count{font-size:.95rem;color:#6b5230;font-variant-numeric:tabular-nums}
.bar{height:6px;border-radius:3px;background:#f3e2ad;overflow:hidden;margin:6px 0 10px}.fill{height:100%;width:0;background:#f2b705}
.banner{background:#3b2a14;color:#f2b705;text-align:center;padding:6px;border-radius:10px;font-weight:700;font-size:.85rem;margin-bottom:8px}
.stage{flex:1;min-height:0;position:relative;touch-action:pan-y;user-select:none;-webkit-user-select:none;cursor:pointer}
.slide{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;animation:fade .5s ease-out both}
@keyframes fade{from{opacity:0;transform:scale(.985)}to{opacity:1;transform:none}}
.photo{display:block;max-width:100%;max-height:100%;width:auto;height:auto;object-fit:contain;border-radius:16px;background:#fffdf6;box-shadow:0 8px 24px rgba(59,42,20,.18)}
.has-cap .photo{max-height:calc(100% - 3em)}.cap{margin-top:10px;font-family:Georgia,'Times New Roman',serif;text-align:center;color:#6b5230;font-size:1.05rem}
.qwrap{position:relative;width:100%;max-width:620px;max-height:100%;padding-top:28px;display:flex}
.mark{position:absolute;top:0;left:50%;transform:translateX(-50%);width:56px;height:56px;border-radius:50%;background:#f2b705;color:#3b2a14;font:700 56px/76px Georgia,'Times New Roman',serif;text-align:center;box-shadow:0 4px 12px rgba(184,138,0,.35);z-index:1}
.quote{margin:0;width:100%;max-height:100%;overflow:auto;background:#fff8e3;border:2px solid #f2b705;border-radius:24px;padding:42px 24px 24px;box-shadow:0 10px 30px rgba(59,42,20,.15);text-align:center}
.qt{margin:0;font-family:Georgia,'Times New Roman',serif;font-size:clamp(1.15rem,4.8vw,1.6rem);line-height:1.5;white-space:pre-wrap;overflow-wrap:anywhere}
.qn{margin-top:18px;font-weight:700;color:#8a6200;font-size:1.05rem;letter-spacing:.02em}.qn:before{content:"\2014\00a0"}
.empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-family:Georgia,serif;font-size:1.2rem;color:#6b5230}
.ctrls{display:flex;justify-content:center;align-items:center;gap:18px;padding-top:12px}
.ctrls button{width:56px;height:56px;border:0;border-radius:50%;background:#f2b705;color:#3b2a14;font-size:1.5rem;font-weight:700;box-shadow:0 3px 10px rgba(184,138,0,.35);cursor:pointer}
.ctrls #play{width:68px;height:68px;font-size:1.3rem}.ctrls button:focus-visible{outline:3px solid #3b2a14;outline-offset:2px}.ctrls button:disabled{opacity:.4}
.ctrls #shuf,.ctrls #orig{width:48px;height:48px;font-size:1.1rem}.ctrls #orig{font-size:.8rem;font-weight:700}.ctrls button[aria-pressed=true]{background:#3b2a14;color:#f2b705}
@media (prefers-reduced-motion:reduce){.slide{animation:none}}`;

// ASCII only: the pause/replay/play/quote symbols are JS string escapes (❚, ↻, ▶, “) that the browser decodes.
const JS = String.raw`var stage=document.getElementById('stage'),fill=document.getElementById('fill'),count=document.getElementById('count'),pb=document.getElementById('play');
var i=0,playing=S.length>0,el0=0,start=0,ended=false,vid=null;
function el(t,c,x){var e=document.createElement(t);if(c)e.className=c;if(x!=null)e.textContent=x;return e}
function ui(){pb.textContent=playing?'❚❚':(ended?'↻':'▶');pb.setAttribute('aria-label',playing?'Pause':(ended?'Replay':'Play'));musSync()}
function preload(n){var s=S[n];if(s&&s.t==='p'){var im=new Image();im.src=s.src}}
function show(n){if(!S.length)return;if(vid){try{vid.pause()}catch(e){}}vid=null;i=(n+S.length)%S.length;ended=false;el0=0;start=performance.now();var s=S[i],d=el('div','slide '+s.t);
if(s.t==='v'){if(s.cap)d.className+=' has-cap';var v=el('video','photo');v.playsInline=true;v.setAttribute('playsinline','');v.preload='auto';v.controls=false;v.loop=false;v.src=s.src;vid=v;
v.addEventListener('loadedmetadata',function(){if(isFinite(v.duration)&&v.duration>0)s.ms=v.duration*1000});
v.addEventListener('error',function(){if(vid!==v)return;vid=null;s.ms=1500;el0=0;start=performance.now();musSync()});
d.appendChild(v);if(s.cap)d.appendChild(el('div','cap',s.cap));
if(playing){var pr=v.play();if(pr&&pr.catch)pr.catch(function(){v.muted=true;var p2=v.play();if(p2&&p2.catch)p2.catch(function(){})})}}
else if(s.t==='p'){if(s.cap)d.className+=' has-cap';var im=el('img','photo');im.src=s.src;im.alt=s.cap||('Photo '+(i+1)+' of '+S.length);im.draggable=false;d.appendChild(im);if(s.cap)d.appendChild(el('div','cap',s.cap))}
else{var w=el('div','qwrap');w.appendChild(el('div','mark','“'));var q=el('figure','quote');q.appendChild(el('blockquote','qt',s.text));if(s.name)q.appendChild(el('figcaption','qn',s.name));w.appendChild(q);d.appendChild(w)}
stage.textContent='';stage.appendChild(d);count.textContent=(i+1)+' / '+S.length;fill.style.width='0%';preload((i+1)%S.length);ui()}
function elapsed(){if(vid)return vid.currentTime*1000;return playing?el0+(performance.now()-start):el0}
function frame(){var s=S[i];if(s){var e=elapsed();fill.style.width=Math.min(100,e/s.ms*100)+'%';var done=vid?(vid.ended||e>=301000):e>=s.ms;if(playing&&done){if(i===S.length-1){playing=false;ended=true;if(vid){vid.pause()}else el0=s.ms;ui()}else show(i+1)}}requestAnimationFrame(frame)}
function setPlaying(v){if(!S.length||v===playing)return;if(v){if(ended)show(0);start=performance.now();playing=true;if(vid){var pr=vid.play();if(pr&&pr.catch)pr.catch(function(){})}}else{el0=elapsed();playing=false;if(vid)vid.pause()}ui()}
function go(d){if(S.length)show(i+d)}
function toggle(){setPlaying(!playing)}
function tap(x){var r=stage.getBoundingClientRect(),f=(x-r.left)/r.width;if(f<0.3)go(-1);else if(f>0.7)go(1);else toggle()}
document.getElementById('prev').onclick=function(){go(-1)};document.getElementById('next').onclick=function(){go(1)};pb.onclick=toggle;
document.addEventListener('keydown',function(e){var b=e.target&&e.target.tagName==='BUTTON';if(e.key==='ArrowRight'){go(1);e.preventDefault()}else if(e.key==='ArrowLeft'){go(-1);e.preventDefault()}else if((e.key===' '||e.key==='k')&&!b){toggle();e.preventDefault()}});
var tx=null,ty=0;stage.addEventListener('touchstart',function(e){var t=e.changedTouches[0];tx=t.clientX;ty=t.clientY},{passive:true});
stage.addEventListener('touchend',function(e){if(tx==null)return;var t=e.changedTouches[0],dx=t.clientX-tx,dy=t.clientY-ty;tx=null;if(Math.abs(dx)>40&&Math.abs(dx)>Math.abs(dy)*1.2){go(dx<0?1:-1);e.preventDefault()}else if(Math.abs(dx)<12&&Math.abs(dy)<12){tap(t.clientX);e.preventDefault()}},{passive:false});
stage.addEventListener('click',function(e){tap(e.clientX)});
document.addEventListener('visibilitychange',function(){if(document.hidden)setPlaying(false)});
if(!S.length){stage.appendChild(el('div','empty','No slides yet'));pb.disabled=true}else show(0);
var S0=S.slice(),shuffled=false,sb=document.getElementById('shuf'),ob=document.getElementById('orig');
function fy(a){for(var k=a.length-1;k>0;k--){var j=Math.floor(Math.random()*(k+1)),t=a[k];a[k]=a[j];a[j]=t}return a}
function reorder(arr){S.length=0;Array.prototype.push.apply(S,arr);show(0)}
function doShuffle(){if(S.length<2)return;reorder(fy(S0.slice()));shuffled=true;sb.setAttribute('aria-pressed','true');ob.hidden=false}
function doRestore(){if(!shuffled)return;reorder(S0);shuffled=false;sb.setAttribute('aria-pressed','false');ob.hidden=true}
sb.onclick=doShuffle;ob.onclick=doRestore;if(S.length<2)sb.disabled=true;
ui();requestAnimationFrame(frame);`;

/** THE slideshow player (one implementation). Returns a complete HTML page. */
export function renderSlideshowPlayer(o: { title: string; slides: Slide[]; photoUrl: (photo: string) => string; backHref?: string; backLabel?: string; banner?: string; music?: { src: string; volume: number } }): string {
  const data = o.slides.map((s) => s.type === "photo"
    ? { t: "p", src: o.photoUrl(s.photo), cap: s.caption || "", ms: slideDurationMs(s) }
    : s.type === "video"
    ? { t: "v", src: o.photoUrl(s.video), cap: s.caption || "", ms: slideDurationMs(s) }
    : { t: "q", text: s.text, name: s.name, ms: slideDurationMs(s) });
  // ASCII only on purpose: never put literal U+2028/U+2029 in source (TS reads them as line breaks inside a regex literal).
  const json = JSON.stringify(data).replace(/</g, "\\u003c").replace(new RegExp(String.fromCharCode(0x2028), "g"), "\\u2028").replace(new RegExp(String.fromCharCode(0x2029), "g"), "\\u2029");
  const back = o.backHref ? `<a class="back" href="${esc(o.backHref)}">${esc(o.backLabel || "‹ Back")}</a>` : "";
  const vol = o.music ? Math.max(0, Math.min(1, Number.isFinite(o.music.volume) ? o.music.volume : 0.6)) : 0;
  const mjson = o.music ? JSON.stringify({ v: vol }) : "null";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="robots" content="noindex"><title>${esc(o.title)}</title><style>${CSS}${MUSIC_CSS}</style></head><body><div class="ss"><header class="top">${back}<div class="ttl">${esc(o.title)}</div><div class="count" id="count" aria-live="polite"></div></header><div class="bar"><div class="fill" id="fill"></div></div>${o.banner ? `<div class="banner">${esc(o.banner)}</div>` : ""}<div class="stage" id="stage" aria-roledescription="carousel" aria-label="${esc(o.title)}"></div><nav class="ctrls"><button id="prev" type="button" aria-label="Previous slide">&#8249;</button><button id="play" type="button" aria-label="Pause"></button><button id="next" type="button" aria-label="Next slide">&#8250;</button><button id="shuf" type="button" aria-label="Shuffle slides" aria-pressed="false" title="Shuffle">&#8644;</button><button id="orig" type="button" aria-label="Restore original order" title="Original order" hidden>Reset</button>${o.music ? MUSIC_BTN : ""}</nav></div>${o.music ? musicAudioHtml(o.music.src) : ""}<script>(function(S,M){${JS}${MUSIC_JS}})(${json},${mjson});</script></body></html>`;
}
