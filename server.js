import express from "express";
import { chromium } from "playwright";

const app = express();
const PORT = process.env.PORT || 3000;
const PAGE_URL = "https://www.babergh.gov.uk/check-your-collection-day";
const NS = "_com_placecube_digitalplace_local_waste_portlet_CollectionDayFinderPortlet_";

function tidyPostcode(value) {
  return String(value || "").trim().toUpperCase().replace(/\\s+/g, " ");
}
function validPostcode(value) {
  return /^[A-Z]{1,2}\\d[A-Z\\d]?\\s*\\d[A-Z]{2}$/.test(value);
}
function escapeRegex(s) {
  return s.replace(/[.*+?^$()|[\\]\\\\]/g, "\\$&");
}

app.get("/api/collections", async (req, res) => {
  const postcode = tidyPostcode(req.query.postcode);
  const house = String(req.query.house || "").trim();

  if (!postcode || !validPostcode(postcode)) return res.status(400).json({error:"Enter a valid postcode."});
  if (!house) return res.status(400).json({error:"Enter a house number or name."});

  let browser;
  try {
    browser = await chromium.launch({headless:true});
    const page = await browser.newPage({
      userAgent:"Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36"
    });
    await page.goto(PAGE_URL,{waitUntil:"domcontentloaded",timeout:45000});

    await page.locator("#"+NS+"postcode").fill(postcode);
    await page.locator("#"+NS+"btnAddressLookup").click();

    const selectId = NS+"uprn";
    await page.waitForFunction((id)=>{
      const el=document.getElementById(id);
      return el && el.options && el.options.length>1;
    },selectId,{timeout:30000});

    const select=page.locator("#"+selectId);
    const options=await select.locator("option").evaluateAll((els)=>els.map(o=>({value:o.value,text:(o.textContent||"").trim()})));

    const hu=house.toUpperCase();
    const pu=postcode.toUpperCase();
    const re=new RegExp("^"+escapeRegex(hu)+"[A-Z]?([ ,]|$)");
    const match=options.find(o=>o.value && o.text.toUpperCase().includes(pu) && re.test(o.text.toUpperCase()));

    if(!match){
      return res.status(404).json({
        error:"Address not found for "+house+", "+postcode+".",
        addresses:options.filter(o=>o.value).map(o=>o.text)
      });
    }

    await select.selectOption(match.value);
    await page.locator("#"+NS+"fcd_submit").click();

    const table=page.locator("div.collection-days-page table");
    try {
      await table.waitFor({state:"visible",timeout:30000});
    } catch(e) {
      const text=(await page.locator("body").innerText()).toLowerCase();
      if(text.includes("temporarily unavailable")){
        return res.status(503).json({error:"Babergh's collection day finder is temporarily unavailable for this address."});
      }
      throw e;
    }

    const rows=await table.locator("tbody tr, tr").evaluateAll((trs)=>{
      const out=[];
      for(const tr of trs){
        const cells=[...tr.querySelectorAll("td")].map(td=>(td.textContent||"").trim().replace(/\\s+/g," "));
        if(cells.length<2 || !cells[0]) continue;
        const dates=[cells[1]];
        if(cells.length>=4 && cells[3]) dates.push(cells[3]);
        for(const date of dates) if(date) out.push({type:cells[0],date});
      }
      return out;
    });

    if(!rows.length) return res.status(502).json({error:"No collection dates were returned by Babergh."});
    return res.json({source:"Babergh District Council",address:match.text,uprn:match.value,collections:rows});
  } catch(err) {
    return res.status(500).json({error:"The live Babergh lookup failed.",detail:err instanceof Error?err.message:String(err)});
  } finally {
    if(browser) await browser.close();
  }
});

app.get("/",(req,res)=>{
  res.type("html").send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Babergh Bin Day</title>
<style>
:root{font-family:Arial,sans-serif;color:#111827;background:#f3f4f6}*{box-sizing:border-box}body{margin:0}main{max-width:720px;margin:0 auto;padding:20px 14px 40px}
h1{font-size:2rem;margin:0 0 8px}p{line-height:1.45}.muted{color:#6b7280}.card{background:#fff;border:1px solid #e5e7eb;border-radius:18px;padding:16px;margin:14px 0}
label{display:block;font-weight:700;margin:0 0 7px}input,button{width:100%;min-height:48px;border-radius:12px;font-size:16px}input{border:1px solid #cbd5e1;padding:0 12px;margin-bottom:10px}
button{border:0;background:#111827;color:#fff;font-weight:700}.error{background:#fff7f7;border-color:#fecaca;color:#991b1b}.kicker{text-transform:uppercase;letter-spacing:.08em;font-size:.76rem;font-weight:800;color:#6b7280}
.nextTitle{font-size:1.8rem;font-weight:800;margin:8px 0}.week{padding:14px 0;border-top:1px solid #eef2f7}.date{font-weight:800;margin-bottom:8px}.pills{display:flex;flex-wrap:wrap;gap:8px}
.pill{display:inline-flex;align-items:center;gap:7px;padding:7px 10px;border:1px solid #e5e7eb;border-radius:999px;font-weight:700}.dot{width:12px;height:12px;border-radius:50%;background:#64748b}
.refuse{background:#111827}.recycling{background:#2563eb}.food{background:#16a34a}.paper{background:#f59e0b}.garden{background:#92400e}.tiny{font-size:.82rem;color:#6b7280}
</style></head><body><main>
<h1>Babergh Bin Day</h1><p class="muted">Live council lookup. Enter a postcode and house number/name.</p>
<form id="form" class="card"><label>Postcode</label><input id="postcode" value="CO10 1AU"><label>House number or name</label><input id="house" value="1"><button id="go">Check live collections</button></form>
<section id="message" class="card error" hidden></section><section id="results" hidden>
<div class="card"><div class="kicker">Next collection</div><div id="nextTitle" class="nextTitle"></div><div id="nextDate"></div><div id="address" class="tiny" style="margin-top:10px"></div></div>
<div class="card"><h2>Upcoming collection weeks</h2><div id="weeks"></div><p class="tiny">Food waste is shown with the main bin due on the same date.</p></div></section>
<script>
const f=document.getElementById("form"),go=document.getElementById("go"),msg=document.getElementById("message"),res=document.getElementById("results"),weeks=document.getElementById("weeks");
function wc(n){n=n.toLowerCase();if(n.includes("food"))return"food";if(n.includes("recycl"))return"recycling";if(n.includes("paper")||n.includes("card"))return"paper";if(n.includes("refuse")||n.includes("general"))return"refuse";if(n.includes("garden"))return"garden";return""}
function cw(n){return n.replace(/\\s+collection$/i,"").replace(/paper and card/i,"Paper & Card")}
function pd(s){const m=s.match(/^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\\s+(\\d{1,2})\\s+([A-Za-z]{3})\\s+(\\d{4})$/);return m?new Date(m[1]+" "+m[2]+" "+m[3]+" 12:00:00"):null}
function key(s){const d=pd(s);return d?d.toISOString().slice(0,10):s} function fmt(s){const d=pd(s);return d?new Intl.DateTimeFormat("en-GB",{weekday:"long",day:"numeric",month:"long",year:"numeric"}).format(d):s}
function grp(rows){const m=new Map();for(const r of rows){const k=key(r.date);if(!m.has(k))m.set(k,{date:r.date,items:[]});m.get(k).items.push(r)}return [...m.values()].sort((a,b)=>key(a.date).localeCompare(key(b.date)))}
function title(items){const names=[...new Set(items.map(x=>cw(x.type)))],food=names.filter(x=>/food/i.test(x)),main=names.filter(x=>!/food/i.test(x));return food.length&&main.length?[...main,"Food Waste"].join(" + "):names.join(" + ")}
f.addEventListener("submit",async e=>{e.preventDefault();msg.hidden=true;res.hidden=true;go.disabled=true;go.textContent="Checking Babergh…";
try{const p=document.getElementById("postcode").value.trim(),h=document.getElementById("house").value.trim();const r=await fetch("/api/collections?postcode="+encodeURIComponent(p)+"&house="+encodeURIComponent(h));const d=await r.json();if(!r.ok)throw new Error(d.error+(d.detail?" "+d.detail:""));const days=grp(d.collections);if(!days.length)throw new Error("No collection dates returned.");
document.getElementById("nextTitle").textContent=title(days[0].items);document.getElementById("nextDate").textContent=fmt(days[0].date);document.getElementById("address").textContent=d.address;weeks.innerHTML="";
for(const day of days){const div=document.createElement("div");div.className="week";const pills=day.items.map(x=>'<span class="pill"><span class="dot '+wc(x.type)+'"></span>'+cw(x.type)+'</span>').join("");div.innerHTML='<div class="date">'+fmt(day.date)+'</div><div class="pills">'+pills+'</div>';weeks.appendChild(div)}res.hidden=false}
catch(e){msg.textContent=e.message;msg.hidden=false}finally{go.disabled=false;go.textContent="Check live collections"}});
</script></main></body></html>`);
});

app.listen(PORT,"0.0.0.0",()=>console.log("Running on "+PORT));