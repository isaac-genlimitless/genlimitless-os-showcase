import fs from "node:fs";
import path from "node:path";

// The running build's id (.next/BUILD_ID). Pages carry it so an open page can tell a deploy happened.
let cached: string | null = null;
export function buildId(): string {
  if (cached !== null) return cached;
  try { cached = fs.readFileSync(path.join(process.cwd(), ".next", "BUILD_ID"), "utf8").trim(); } catch { cached = ""; }
  return cached;
}

// Inline, runs before the app's JS. iOS keeps pages alive across deploys; this brings them back to life.
export const PWA_HEAL_JS = `(function(){var d=document.documentElement,B=d.getAttribute('data-build')||'';
function heal(){try{var k='glos-healed:'+B;if(sessionStorage.getItem(k))return;sessionStorage.setItem(k,'1');}catch(e){}location.reload();}
function busy(){var a=document.activeElement;if(a&&(a.tagName==='TEXTAREA'||a.tagName==='INPUT'||a.isContentEditable))return true;var t=document.querySelectorAll('textarea');for(var i=0;i<t.length;i++)if(t[i].value)return true;return false;}
addEventListener('error',function(e){var t=e.target,u=t&&(t.src||t.href)||'';if(typeof u==='string'&&u.indexOf('/_next/static/')>=0)heal();},true);
addEventListener('unhandledrejection',function(e){var r=e.reason,m=r?String(r.name)+' '+String(r.message):'';if(/ChunkLoadError|Loading (CSS )?chunk|dynamically imported module|Importing a module script failed/.test(m))heal();});
var hid=0,pending=false;
function check(){if(!B)return;if(pending){if(!busy())heal();return;}fetch('/api/build-id',{cache:'no-store'}).then(function(r){return r.ok?r.text():'';}).then(function(id){id=(id||'').trim();if(id&&id!==B){pending=true;if(!busy())heal();}}).catch(function(){});}
document.addEventListener('visibilitychange',function(){if(document.hidden)hid=Date.now();else if(hid&&Date.now()-hid>30000)check();});
addEventListener('pageshow',function(e){if(e.persisted)check();});
})();`;
