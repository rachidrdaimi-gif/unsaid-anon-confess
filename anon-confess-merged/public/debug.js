function show(m){var p=document.createElement('pre');p.style.cssText='color:#f88;background:#000;padding:12px;white-space:pre-wrap;position:fixed;top:0;left:0;right:0;z-index:99999;font-size:12px';p.textContent=m;document.body.appendChild(p)}
window.addEventListener('error',function(e){show(e.message+' @ '+(e.filename||'')+':'+e.lineno)});
window.addEventListener('unhandledrejection',function(e){show('Promise: '+String(e.reason))});
