(function(){
  if(document.getElementById('__sync_closing'))return;
  // 强制 flush chat 数据到磁盘（绕过防抖），确保 push 读到最新消息
  if (window.__flushChatNow__) { window.__flushChatNow__(); }
  var d=document.createElement('div');
  d.id='__sync_closing';
  d.innerHTML='<div style="position:fixed;inset:0;z-index:99999;display:flex;flex-direction:column;align-items:center;justify-content:center;background:rgba(0,0,0,0.65);backdrop-filter:blur(6px);color:#fff;font-size:18px;gap:18px;font-family:sans-serif"><div style="width:40px;height:40px;border:3px solid rgba(255,255,255,0.25);border-top-color:#fff;border-radius:50%;animation:__sync_spin 0.8s linear infinite"></div><span>请稍等，正在同步云端...</span></div><style>@keyframes __sync_spin{to{transform:rotate(360deg)}}</style>';
  document.body.appendChild(d);
})();
