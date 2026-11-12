const escAttr = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

export const MUSIC_CSS = String.raw`.ctrls #mus{width:48px;height:48px;font-size:1.25rem}`;
export const MUSIC_BTN = `<button id="mus" type="button" aria-label="Mute music" aria-pressed="false" title="Music on/off">&#9834;</button>`;
export const musicAudioHtml = (src: string) => `<audio id="bgm" src="${escAttr(src)}" loop preload="metadata"></audio>`;

/** Appended inside the player's closure. Uses its vars: playing, vid. M = {v: volume 0..1} or null. */
export const MUSIC_JS = String.raw`var bg=document.getElementById('bgm'),mb=document.getElementById('mus'),mstart=false,mmuted=false,mbroken=false;
function musSync(){if(!bg||mbroken)return;var want=mstart&&!mmuted&&playing&&!vid;if(want&&bg.paused){var p=bg.play();if(p&&p.catch)p.catch(function(){mstart=false;try{bg.pause()}catch(e){}})}else if(!want&&!bg.paused){bg.pause()}bg.setAttribute('data-state',want?'on':'off')}
if(bg){bg.volume=Math.max(0,Math.min(1,(M&&typeof M.v==='number')?M.v:0.6));
bg.addEventListener('error',function(){mbroken=true;if(mb)mb.hidden=true});
var musGo=function(){if(mstart||mbroken)return;mstart=true;musSync()};
['click','touchend','keydown'].forEach(function(n){document.addEventListener(n,musGo,true)});
if(mb)mb.onclick=function(){mmuted=!mmuted;mb.setAttribute('aria-pressed',mmuted?'true':'false');if(!mmuted)mstart=true;musSync()};
musSync()}`;
