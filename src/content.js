// Content script — runs on opencode.ai pages to surface login status and workspace hint
(function(){
  function extractWorkspace(){
    const m=location.pathname.match(/\/workspace\/(wrk_[A-Za-z0-9]+)/);
    if(m) return m[1];
    const html=document.documentElement.innerHTML;
    const mm=html.match(/wrk_[A-Za-z0-9]+/);
    return mm? mm[0] : null;
  }
  function notify(){
    const ws=extractWorkspace();
    if(ws){
      chrome.storage.local.set({workspaceId: ws});
    }
    // also tell background we are on opencode domain (helps auth detection)
    chrome.runtime.sendMessage({type:"CHECK_AUTH"}).catch(()=>{});
  }
  notify();
  // watch SPA navigation
  let lastUrl=location.href;
  setInterval(()=>{
    if(location.href!==lastUrl){
      lastUrl=location.href;
      notify();
    }
  }, 1500);
  // listen for messages from background
  chrome.runtime.onMessage.addListener((msg)=>{
    if(msg.type==="REQUEST_WORKSPACE"){
      const ws=extractWorkspace();
      return Promise.resolve(ws);
    }
  });
})();
