import {LitElement,html} from "lit";
import {customElement,state} from "lit/decorators.js";
import {Controller} from "../../Controller";
import {GameView} from "../../view";

interface Ev{id:number;tick:number;text:string;icon:string}
interface Snap{threat:number;rep:number;cbs:Map<string,string>;attacks:Map<string,number>;allies:Set<number>}

@customElement("world-diplomacy-monitor")
export class WorldDiplomacyMonitor extends LitElement implements Controller{
 public game:GameView;
 @state() private open=false;
 @state() private events:Ev[]=[];
 private snaps=new Map<string,Snap>(); private ready=false; private seq=1;
 init(){this.baseline();}
 getTickIntervalMs(){return 150;}
 tick(){
  if(!this.game||this.game.inSpawnPhase())return;
  if(!this.ready){this.baseline();return;}
  const alive=new Set<string>();
  for(const p of this.game.players()){
   alive.add(p.id()); const prev=this.snaps.get(p.id()),cur=this.snap(p);
   if(prev){
    for(const [id,type] of cur.cbs)if(!prev.cbs.has(id))this.push("⚖",`${p.displayName()} gained ${type.toUpperCase()} CB against ${this.name(id)}`);
    for(const [id,type] of prev.cbs)if(!cur.cbs.has(id))this.push("⚖",`${p.displayName()}'s ${type.toUpperCase()} CB against ${this.name(id)} ended/was used`);
    for(const [id,target] of cur.attacks)if(!prev.attacks.has(id))this.push("⚔",`${p.displayName()} attacked ${this.smallName(target)}`);
    for(const a of cur.allies)if(!prev.allies.has(a))this.push("🤝",`${p.displayName()} allied with ${this.smallName(a)}`);
    if(cur.threat!==prev.threat)this.push("!",`${p.displayName()} Threat ${this.sign(cur.threat-prev.threat)} → ${Math.round(cur.threat)}`);
    if(cur.rep!==prev.rep)this.push("★",`${p.displayName()} Reputation ${this.sign(cur.rep-prev.rep)} → ${Math.round(cur.rep)}`);
   }
   this.snaps.set(p.id(),cur);
  }
  for(const id of this.snaps.keys())if(!alive.has(id))this.snaps.delete(id);
 }
 private baseline(){if(!this.game)return;this.snaps.clear();for(const p of this.game.players())this.snaps.set(p.id(),this.snap(p));this.ready=true;}
 private snap(p:ReturnType<GameView["players"]>[number]):Snap{
  const cbs=new Map<string,string>();for(const cb of p.casusBelli())if(cb.expiresAt>this.game.ticks())cbs.set(cb.targetID,cb.type.replace(/_/g, " "));
  const attacks=new Map<string,number>();for(const a of p.outgoingAttacks())if(!a.retreating)attacks.set(a.id,a.targetID);
  const allies=new Set<number>();for(const a of p.allies())allies.add(a.smallID());
  return{threat:p.threat(),rep:p.reputation(),cbs,attacks,allies};
 }
 private name(id:string){try{return this.game.player(id).displayName();}catch{return id;}}
 private smallName(id:number){try{const p=this.game.playerBySmallID(id);return p.isPlayer()?p.displayName():"Terra Nullius";}catch{return`#${id}`;}}
 private sign(v:number){const n=Math.round(v);return n>=0?`+${n}`:`${n}`;}
 private push(icon:string,text:string){this.events=[{id:this.seq++,tick:this.game.ticks(),icon,text},...this.events].slice(0,150);}
 render(){return html`<div class="fixed right-3 top-28 z-[1000] pointer-events-auto">
  <button class="ml-auto block rounded-md border border-amber-400/70 bg-zinc-950/90 px-3 py-2 text-xs font-bold text-amber-300" @click=${()=>this.open=!this.open}>🌐 WORLD LOG ${this.events.length?`(${this.events.length})`:""}</button>
  ${this.open?html`<div class="mt-2 w-[540px] max-w-[calc(100vw-24px)] rounded-lg border border-amber-400/60 bg-zinc-950/95 text-zinc-100 shadow-2xl">
   <div class="flex justify-between border-b border-white/10 px-3 py-2"><div><b class="text-amber-300">World Diplomacy Log</b><div class="text-[11px] text-zinc-400">CBs · wars · alliances · Threat · Reputation · timestamp = game tick</div></div><button @click=${()=>this.events=[]}>Clear</button></div>
   <div class="max-h-[55vh] overflow-y-auto px-2 py-2">${this.events.length?this.events.map(e=>html`<div class="grid grid-cols-[58px_22px_1fr] gap-1 border-b border-white/5 px-1 py-1.5 text-xs"><span class="font-mono text-zinc-500">T${e.tick}</span><span>${e.icon}</span><span>${e.text}</span></div>`):html`<div class="p-5 text-center text-zinc-500">No world decisions recorded yet.</div>`}</div>
  </div>`:""}
 </div>`;}
 createRenderRoot(){return this;}
}
