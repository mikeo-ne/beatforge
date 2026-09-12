// minimal DOM/AudioContext shim so the app's boot path and MIDI writer can run in Node
function El(tag){
  const e = {
    tagName:tag, children:[], style:{}, dataset:{}, classList:{
      _s:new Set(), add(...c){c.forEach(x=>this._s.add(x))}, remove(...c){c.forEach(x=>this._s.delete(x))},
      toggle(c,f){ if(f===undefined){ this._s.has(c)?this._s.delete(c):this._s.add(c);} else { f?this._s.add(c):this._s.delete(c);} },
      contains(c){return this._s.has(c)} },
    _html:"", _text:"", value:"", files:[], firstChild:null,
    appendChild(...n){ n.forEach(x=>this.children.push(x)); this.firstChild=this.children[0]||null; return n[0]; },
    append(...n){ this.appendChild(...n); },
    addEventListener(){}, removeEventListener(){}, remove(){}, click(){},
    querySelector(s){ return El("q"); }, querySelectorAll(s){ return []; },
    closest(){ return null; }, matches(){ return false; },
    setAttribute(){}, getAttribute(){ return null; }, focus(){}, dispatchEvent(){ return true; },
    getContext(){ return null; }, clientWidth:800,
    set innerHTML(v){ this._html=v; this.children=[]; }, get innerHTML(){ return this._html; },
    set textContent(v){ this._text=v; }, get textContent(){ return this._text; },
    set onclick(f){ this._onclick=f; }, get onclick(){ return this._onclick; },
    set onchange(f){}, set oninput(f){},
  };
  return e;
}
const registry = {};
global.document = {
  createElement: t => El(t),
  querySelector: s => (registry[s] = registry[s] || El(s)),
  querySelectorAll: () => [],
  addEventListener(){}, body:El("body"), documentElement:El("html"),
};
global.window = { addEventListener(){}, devicePixelRatio:1, AudioContext:function(){
  this.createGain=()=>({connect(){},gain:{value:1}}); this.createOscillator=()=>({connect(){},start(){},stop(){},frequency:{value:0,setValueAtTime(){},exponentialRampToValueAtTime(){}}});
  this.createGain=()=>({connect(){},gain:{value:1,setValueAtTime(){},linearRampToValueAtTime(){},exponentialRampToValueAtTime(){}}});
  this.createBiquadFilter=()=>({connect(){},frequency:{value:0},Q:{value:0}});
  this.createBufferSource=()=>({connect(){},start(){},buffer:null});
  this.createBuffer=(c,l)=>({getChannelData:()=>new Float32Array(l)});
  this.createConvolver=()=>({connect(){},buffer:null});
  this.createWaveShaper=()=>({connect(){},curve:null,oversample:""});
  this.createDynamicsCompressor=()=>({connect(){},threshold:{value:0},ratio:{value:0},attack:{value:0},release:{value:0}});
  this.destination={}; this.currentTime=0; this.sampleRate=44100; this.state="running"; this.resume=()=>{};
}};
global.navigator = { userAgent:"node" };
global.URL.createObjectURL = () => "blob:x";
global.URL.revokeObjectURL = () => {};
global.Blob = function(){};
global.fetch = () => Promise.reject(new Error("no network in test"));
global.setInterval = () => 0; global.clearInterval = () => {};
global.alert = () => {};
global.atob = s => Buffer.from(s, "base64").toString("binary");
global.btoa = s => Buffer.from(s, "binary").toString("base64");
global.Event = function(t){ this.type = t; };
