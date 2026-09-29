/* SOC-RAP MVP — all processing runs in this browser; nothing is sent to any server. */
/* ============================================================
   SOC-RAP MVP · minimal, dependency-free XLSX reader and writer
   Uses the browser's own DecompressionStream / CompressionStream.
   ============================================================ */
const XL = (()=>{
  const dec = new TextDecoder(), enc = new TextEncoder();
  function zipEntries(buf){
    const dv = new DataView(buf);
    let eocd=-1; for(let i=buf.byteLength-22;i>=Math.max(0,buf.byteLength-65557);i--){ if(dv.getUint32(i,true)===0x06054b50){eocd=i;break;} }
    if(eocd<0) throw new Error("The workbook is damaged (no zip directory).");
    const n=dv.getUint16(eocd+10,true); let p=dv.getUint32(eocd+16,true); const out=new Map();
    for(let k=0;k<n;k++){
      if(p+46>buf.byteLength || dv.getUint32(p,true)!==0x02014b50) throw new Error("The workbook is damaged.");
      const method=dv.getUint16(p+10,true), csize=dv.getUint32(p+20,true), usize=dv.getUint32(p+24,true);
      const nl=dv.getUint16(p+28,true), el=dv.getUint16(p+30,true), cl=dv.getUint16(p+32,true), off=dv.getUint32(p+42,true);
      if(p+46+nl>buf.byteLength || off+30>buf.byteLength) throw new Error("The workbook is damaged.");
      const name=dec.decode(new Uint8Array(buf,p+46,nl)); out.set(name,{method,csize,usize,off}); p+=46+nl+el+cl;
    }
    return out;
  }
  const MAX_PART = 200*1024*1024;
  async function readEntry(buf, e){
    const dv=new DataView(buf); const nl=dv.getUint16(e.off+26,true), el=dv.getUint16(e.off+28,true);
    const start=e.off+30+nl+el;
    if(start+e.csize>buf.byteLength) throw new Error("The workbook is damaged.");
    const data=new Uint8Array(buf, start, e.csize);
    if(e.method===0) return dec.decode(data);
    if(e.method!==8) throw new Error("The workbook uses an unsupported compression method.");
    // Stream the decompression and stop as soon as the output passes the size the file declared.
    const limit = Math.min(MAX_PART, e.usize + 1024);
    const reader = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
    const chunks=[]; let total=0;
    for(;;){
      const {done, value} = await reader.read(); if(done) break;
      total += value.length;
      if(total > limit){ try{ await reader.cancel(); }catch(_){} throw new Error("A workbook part expands beyond its declared size (possible zip bomb). It was not opened."); }
      chunks.push(value);
    }
    const out=new Uint8Array(total); let o=0; for(const c of chunks){ out.set(c,o); o+=c.length; }
    return dec.decode(out);
  }
  function parseXml(txt){
    if(/<!DOCTYPE|<!ENTITY/i.test(txt)) throw new Error("The workbook contains a DTD or entity declarations, which are refused for safety.");
    const doc = new DOMParser().parseFromString(txt,"application/xml");
    if(doc.getElementsByTagName("parsererror").length) throw new Error("The workbook XML couldn't be read.");
    return doc;
  }
  const byTag = (el,t) => Array.from(el.getElementsByTagNameNS("*",t));
  const MAX_COLS = 16384, MAX_ROW_INDEX = 500010;
  function colIdx(ref){ const m=/^([A-Z]{1,3})\d/.exec(ref||""); if(!m) throw new Error("The workbook has an invalid cell reference."); let n=0; for(const ch of m[1]) n=n*26+(ch.charCodeAt(0)-64); if(n>MAX_COLS) throw new Error("The workbook has more columns than Excel allows."); return n-1; }
  async function read(buf){
    const ents = zipEntries(buf);
    const get = async name => ents.has(name) ? parseXml(await readEntry(buf, ents.get(name))) : null;
    const wb = await get("xl/workbook.xml"); if(!wb) throw new Error("This zip file isn't an Excel workbook.");
    const rels = await get("xl/_rels/workbook.xml.rels");
    const relMap = new Map(); if(rels) byTag(rels,"Relationship").forEach(r=>relMap.set(r.getAttribute("Id"), r.getAttribute("Target")));
    const ssDoc = await get("xl/sharedStrings.xml");
    const ss = ssDoc ? byTag(ssDoc,"si").map(si=>byTag(si,"t").map(t=>t.textContent).join("")) : [];
    const sheets = [];
    for(const sh of byTag(wb,"sheet")){
      const rid = sh.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships","id") || sh.getAttribute("r:id");
      let target = relMap.get(rid); if(!target || /^[a-z]+:/i.test(target) || target.includes("..")) continue;
      target = target.replace(/^\/?xl\//,"").replace(/^\//,"");
      const path = "xl/" + target;
      if(!ents.has(path)) continue;
      const doc = await get(path);
      const rows = [];
      for(const r of byTag(doc,"row")){
        const arr = [];
        for(const c of byTag(r,"c")){
          const ref=c.getAttribute("r"), t=c.getAttribute("t"); const i = ref ? colIdx(ref) : arr.length;
          if(i>=MAX_COLS) throw new Error("The workbook has more columns than Excel allows.");
          const vEl = byTag(c,"v")[0]; let v = vEl ? vEl.textContent : null;
          if(t==="s") v = v==null ? null : (ss[parseInt(v,10)] ?? null);
          else if(t==="inlineStr") v = byTag(c,"t").map(x=>x.textContent).join("");
          else if(t==="b") v = v==="1";
          else if(t==="e") v = null;
          else if(t==="str") v = v;
          else if(v!=null && v!=="") v = Number(v);
          arr[i] = v;
        }
        const ri = (parseInt(r.getAttribute("r"),10)||rows.length+1)-1;
        if(ri<0 || ri>=MAX_ROW_INDEX) throw new Error("The workbook has more rows than the 500,000 limit.");
        rows[ri] = arr;
      }
      sheets.push({name: sh.getAttribute("name"), rows: Array.from(rows, x=>x||[])});
    }
    return sheets;
  }

  /* ----- writer ----- */
  const crcT = (()=>{ const t=new Uint32Array(256); for(let n=0;n<256;n++){ let c=n; for(let k=0;k<8;k++) c = c&1 ? 0xEDB88320^(c>>>1) : c>>>1; t[n]=c>>>0; } return t; })();
  function crc32(u8){ let c=0xFFFFFFFF; for(let i=0;i<u8.length;i++) c=crcT[(c^u8[i])&255]^(c>>>8); return (c^0xFFFFFFFF)>>>0; }
  async function deflate(u8){ const cs=new Blob([u8]).stream().pipeThrough(new CompressionStream("deflate-raw")); return new Uint8Array(await new Response(cs).arrayBuffer()); }
  async function zip(files){
    const parts=[], central=[]; let off=0;
    for(const [name, content] of files){
      const nm=enc.encode(name), raw=enc.encode(content), crc=crc32(raw), comp=await deflate(raw);
      const lh=new DataView(new ArrayBuffer(30));
      lh.setUint32(0,0x04034b50,true); lh.setUint16(4,20,true); lh.setUint16(6,0x0800,true); lh.setUint16(8,8,true); lh.setUint16(10,0,true); lh.setUint16(12,0x21,true);
      lh.setUint32(14,crc,true); lh.setUint32(18,comp.length,true); lh.setUint32(22,raw.length,true); lh.setUint16(26,nm.length,true); lh.setUint16(28,0,true);
      parts.push(new Uint8Array(lh.buffer), nm, comp);
      const ch=new DataView(new ArrayBuffer(46));
      ch.setUint32(0,0x02014b50,true); ch.setUint16(4,20,true); ch.setUint16(6,20,true); ch.setUint16(8,0x0800,true); ch.setUint16(10,8,true); ch.setUint16(14,0x21,true);
      ch.setUint32(16,crc,true); ch.setUint32(20,comp.length,true); ch.setUint32(24,raw.length,true); ch.setUint16(28,nm.length,true); ch.setUint32(42,off,true);
      central.push(new Uint8Array(ch.buffer), nm);
      off += 30+nm.length+comp.length;
    }
    const cdSize = central.reduce((a,b)=>a+b.length,0);
    const e=new DataView(new ArrayBuffer(22)); e.setUint32(0,0x06054b50,true); e.setUint16(8,files.length,true); e.setUint16(10,files.length,true); e.setUint32(12,cdSize,true); e.setUint32(16,off,true);
    return new Blob([...parts,...central,new Uint8Array(e.buffer)],{type:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"});
  }
  const esc = s => String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g,"").replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/g,"$1").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  function colName(i){ let s=""; i++; while(i>0){ const m=(i-1)%26; s=String.fromCharCode(65+m)+s; i=Math.floor((i-1)/26); } return s; }
  // Styles: 0 normal · 1 header · 2 good · 3 bad · 4 bold · 5..10 heat levels (light → dark)
  const HEAT = ["EAF2FC","C6DCF6","9EC5F4","5598E7","256ABF","104281"];
  function stylesXml(){
    const fills = ['<fill><patternFill patternType="none"/></fill>','<fill><patternFill patternType="gray125"/></fill>',
      '<fill><patternFill patternType="solid"><fgColor rgb="FF002855"/></patternFill></fill>',
      '<fill><patternFill patternType="solid"><fgColor rgb="FFE5F3E5"/></patternFill></fill>',
      '<fill><patternFill patternType="solid"><fgColor rgb="FFFBE8E8"/></patternFill></fill>',
      ...HEAT.map(c=>`<fill><patternFill patternType="solid"><fgColor rgb="FF${c}"/></patternFill></fill>`)];
    const fonts = ['<font><sz val="11"/><name val="Calibri"/></font>','<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>','<font><b/><sz val="11"/><name val="Calibri"/></font>','<font><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>'];
    const xfs = ['<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>',
      '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>',
      '<xf numFmtId="0" fontId="0" fillId="3" borderId="0" xfId="0" applyFill="1"/>',
      '<xf numFmtId="0" fontId="0" fillId="4" borderId="0" xfId="0" applyFill="1"/>',
      '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>',
      ...HEAT.map((c,i)=>`<xf numFmtId="0" fontId="${i>=3?3:0}" fillId="${5+i}" borderId="0" xfId="0" applyFont="1" applyFill="1"/>`)];
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="${fonts.length}">${fonts.join("")}</fonts><fills count="${fills.length}">${fills.join("")}</fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="${xfs.length}">${xfs.join("")}</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
  }
  // Text is neutralized against formula injection (CWE-1236) before it is written.
  const neutral = v => /^[=+\-@\t\r\n\uFF1D\uFF0B\uFF0D\uFF20]/.test(v) ? "'"+v : v;
  function sheetXml(sh){
    const rows = sh.rows.map((r,ri)=>{
      const cells = r.map((cell,ci)=>{
        let v = cell, st = 0;
        if(cell && typeof cell==="object" && !(cell instanceof Date)){ v = cell.v; st = cell.s||0; }
        if(ri===0 && sh.header!==false) st = 1;
        const ref = colName(ci)+(ri+1), sa = st?` s="${st}"`:"";
        if(v===null || v===undefined || v==="") return st?`<c r="${ref}"${sa}/>`:"";
        if(typeof v==="number" && isFinite(v)) return `<c r="${ref}"${sa}><v>${v}</v></c>`;
        if(typeof v==="boolean") return `<c r="${ref}"${sa} t="b"><v>${v?1:0}</v></c>`;
        return `<c r="${ref}"${sa} t="inlineStr"><is><t xml:space="preserve">${esc(neutral(String(v)).slice(0,32000))}</t></is></c>`;
      }).join("");
      return `<row r="${ri+1}">${cells}</row>`;
    }).join("");
    const ncol = Math.max(1,...sh.rows.map(r=>r.length));
    const cols = sh.widths ? `<cols>${sh.widths.map((w,i)=>`<col min="${i+1}" max="${i+1}" width="${w}" customWidth="1"/>`).join("")}</cols>` : "";
    const pane = sh.header!==false ? `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` : "";
    const af = sh.filter ? `<autoFilter ref="A1:${colName(ncol-1)}${sh.rows.length}"/>` : "";
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${pane}${cols}<sheetData>${rows}</sheetData>${af}</worksheet>`;
  }
  async function write(sheets, meta={}){
    const names = sheets.map((s,i)=>esc(s.name.replace(/[\\/?*[\]:]/g," ").slice(0,31)));
    const files = [
      ["[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_,i)=>`<Override PartName="/xl/worksheets/sheet${i+1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`],
      ["_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`],
      ["docProps/core.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${esc(meta.title||"SOC report")}</dc:title><dc:creator>SOC-RAP</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString().slice(0,19)}Z</dcterms:created></cp:coreProperties>`],
      ["xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names.map((n,i)=>`<sheet name="${n}" sheetId="${i+1}" r:id="rId${i+1}"/>`).join("")}</sheets></workbook>`],
      ["xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_,i)=>`<Relationship Id="rId${i+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i+1}.xml"/>`).join("")}<Relationship Id="rId${sheets.length+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
      ["xl/styles.xml", stylesXml()],
      ...sheets.map((s,i)=>[`xl/worksheets/sheet${i+1}.xml`, sheetXml(s)])
    ];
    return zip(files);
  }
  return {read, write, HEAT_LEVELS: HEAT.length};
})();

/* ============================================================
   SOC-RAP MVP · deck graphics drawn as images in the reference style
   (theme: accent1 0057B8, accent2 002855, accent3 7BAFD4, accent4 FFB500, accent6 373A36).
   Images render in every viewer: PowerPoint, Keynote, Google Slides, Quick Look.
   ============================================================ */
const DECK_FONT = '"Tw Cen MT","Century Gothic","Segoe UI",Arial,sans-serif';
const DK = {blue:"#0057B8", navy:"#002855", light:"#7BAFD4", amber:"#FFB500", char:"#373A36", grid:"#D9D9D9", axis:"#595959", ink:"#000000", sub:"#404040"};
function deckCanvas(wIn, hIn, draw){
  const dpi = 220, c = document.createElement("canvas");
  c.width = Math.round(wIn*dpi); c.height = Math.round(hIn*dpi);
  const g = c.getContext("2d"); g.scale(dpi/72, dpi/72);           // 1 unit = 1 pt
  g.fillStyle = "#FFFFFF"; g.fillRect(0,0,wIn*72,hIn*72);
  g.textBaseline = "middle"; g.lineJoin = "round";
  draw(g, wIn*72, hIn*72);
  return c.toDataURL("image/png");
}
const font = (pt, bold) => `${bold?"700 ":""}${pt}px ${DECK_FONT}`;
function niceStep(max, ticks=5){ const raw=max/ticks, p=Math.pow(10,Math.floor(Math.log10(raw||1))), n=raw/p; return (n<=1?1:n<=2?2:n<=2.5?2.5:n<=5?5:10)*p; }
// Pattern fills matching the reference chart (PowerPoint presets)
function pattern(g, kind, fg, bg){
  const t = document.createElement("canvas"), s = 6*4; t.width=t.height=s;
  const p = t.getContext("2d"); p.scale(4,4); p.fillStyle=bg; p.fillRect(0,0,6,6); p.strokeStyle=fg; p.fillStyle=fg;
  if(kind==="wdDnDiag"){ p.lineWidth=2; for(let k=-6;k<=12;k+=6){ p.beginPath(); p.moveTo(k,0); p.lineTo(k+6,6); p.stroke(); } }
  else if(kind==="ltUpDiag"){ p.lineWidth=.8; for(let k=-6;k<=12;k+=3){ p.beginPath(); p.moveTo(k,6); p.lineTo(k+6,0); p.stroke(); } }
  else if(kind==="pct40"){ for(let y=0;y<6;y+=1.5) for(let x=((y/1.5)%2)*1.5;x<6;x+=3) p.fillRect(x,y,1.1,1.1); }
  const pat = g.createPattern(t,"repeat"); pat.setTransform(new DOMMatrix().scale(.25)); return pat;
}
const SEV_STYLE = {
  Critical:{solid:"#3D586A"}, High:{pat:"wdDnDiag",fg:DK.blue,bg:"#FFFFFF"}, Medium:{pat:"ltUpDiag",fg:DK.char,bg:"#FFFFFF"},
  Low:{solid:DK.navy}, Informational:{pat:"pct40",fg:"#BFC9D5",bg:DK.blue}
};
function sevFill(g, name){ const st=SEV_STYLE[name]; return st.solid || pattern(g, st.pat, st.fg, st.bg); }
function legendRow(g, items, cx, y){
  g.font = font(9); let total = items.reduce((a,[n])=>a+14+g.measureText(n).width+14,0), x = cx-total/2;
  for(const [n,fill,line] of items){
    if(line){ g.strokeStyle=fill; g.lineWidth=2; g.beginPath(); g.moveTo(x,y); g.lineTo(x+12,y); g.stroke(); g.fillStyle=fill; g.beginPath(); g.arc(x+6,y,2.4,0,7); g.fill(); }
    else { g.fillStyle=fill; g.fillRect(x+1,y-4,8,8); if(typeof fill!=="string"){ g.strokeStyle="#7F7F7F"; g.lineWidth=.4; g.strokeRect(x+1,y-4,8,8);} }
    g.fillStyle=DK.sub; g.textAlign="left"; g.fillText(n, x+14, y); x += 14+g.measureText(n).width+14;
  }
}

/* Slide 4 · case funnel (trapezoids with dashed leader lines) */
function drawFunnel(rows){
  return deckCanvas(4.3, 1.75, (g,W,H)=>{
    const n=rows.length, top=4, rowH=(H-8)/n, wTop=150, wBot=62, cx=78, labX=170;
    rows.forEach(([v,label,color],i)=>{
      const w0 = wTop-(wTop-wBot)*i/n, w1 = wTop-(wTop-wBot)*(i+1)/n, y0=top+i*rowH, y1=y0+rowH-1.2;
      g.fillStyle=color.startsWith("#")?color:"#"+color; g.beginPath(); g.moveTo(cx-w0/2,y0); g.lineTo(cx+w0/2,y0); g.lineTo(cx+w1/2,y1); g.lineTo(cx-w1/2,y1); g.closePath(); g.fill();
      g.fillStyle="#FFFFFF"; g.font=font(10,true); g.textAlign="center"; g.fillText(fmtInt(v), cx, (y0+y1)/2+.5);
      const edge = cx+(w0+w1)/4; g.strokeStyle="#595959"; g.lineWidth=.6; g.setLineDash([1.6,1.6]); g.beginPath(); g.moveTo(edge+2,(y0+y1)/2); g.lineTo(labX-3,(y0+y1)/2); g.stroke(); g.setLineDash([]);
      g.fillStyle=DK.ink; g.font=font(8.5); g.textAlign="left"; g.fillText(label, labX, (y0+y1)/2+.5, W-labX-2);
    });
  });
}

/* Slide 5 · severity columns with the reference's pattern fills */
function drawSeverity(counts){
  return deckCanvas(6.7, 5.5, (g,W,H)=>{
    const m={l:40,r:10,t:18,b:44}, pw=W-m.l-m.r, ph=H-m.t-m.b;
    const max=Math.max(1,...ALL_PRIOS.map(p=>counts[p])), step=niceStep(max*1.08), top=Math.ceil(max*1.08/step)*step;
    const y=v=>m.t+ph-v/top*ph;
    g.font=font(9); g.textAlign="right";
    for(let v=0; v<=top+1e-9; v+=step){ g.strokeStyle=DK.grid; g.lineWidth=.6; g.beginPath(); g.moveTo(m.l,y(v)); g.lineTo(W-m.r,y(v)); g.stroke(); g.fillStyle=DK.axis; g.fillText(fmtInt(v), m.l-5, y(v)); }
    const slot=pw/ALL_PRIOS.length, bw=slot*.56;
    ALL_PRIOS.forEach((p,i)=>{
      const v=counts[p], x=m.l+slot*i+(slot-bw)/2, yy=y(v);
      g.fillStyle=sevFill(g,p); g.fillRect(x,yy,bw,m.t+ph-yy);
      if(SEV_STYLE[p].pat && v){ g.strokeStyle=SEV_STYLE[p].fg; g.lineWidth=.6; g.strokeRect(x,yy,bw,m.t+ph-yy); }
      g.fillStyle=DK.sub; g.font=font(10.5); g.textAlign="center"; g.fillText(fmtInt(v), x+bw/2, yy-8);
    });
    g.strokeStyle="#BFBFBF"; g.lineWidth=.8; g.beginPath(); g.moveTo(m.l,m.t+ph); g.lineTo(W-m.r,m.t+ph); g.stroke();
    legendRow(g, ALL_PRIOS.map(p=>[p, sevFill(g,p)]), m.l+pw/2, H-14);
  });
}

/* Slide 6 · horizontal category bars, largest at the bottom */
function drawCategories(items){
  const rows = items.slice().sort((a,b)=>a.v-b.v);
  return deckCanvas(6.7, 4.2, (g,W,H)=>{
    g.font=font(9.5,true); const lw=Math.min(150, Math.max(...rows.map(r=>g.measureText(r.k).width))+10);
    const m={l:lw,r:34,t:6,b:22}, pw=W-m.l-m.r, ph=H-m.t-m.b;
    const max=Math.max(1,...rows.map(r=>r.v)), step=niceStep(max*1.1), top=Math.ceil(max*1.1/step)*step;
    const x=v=>m.l+v/top*pw, rh=ph/rows.length, bh=rh*.5;
    g.font=font(8.5); g.textAlign="center";
    for(let v=0; v<=top+1e-9; v+=step){ g.strokeStyle=DK.grid; g.lineWidth=.6; g.beginPath(); g.moveTo(x(v),m.t); g.lineTo(x(v),m.t+ph); g.stroke(); g.fillStyle=DK.axis; g.fillText(fmtInt(v), x(v), H-10); }
    rows.forEach((r,i)=>{
      const yc=m.t+rh*i+rh/2;
      g.fillStyle=DK.light; g.fillRect(m.l, yc-bh/2, x(r.v)-m.l, bh);
      g.fillStyle=DK.ink; g.font=font(9.5,true); g.textAlign="right"; g.fillText(r.k, m.l-6, yc);
      g.textAlign="left"; g.fillText(fmtInt(r.v), x(r.v)+4, yc);
    });
  });
}

/* Slide 7 · close-reason pie with outside labels */
function drawPie(parts){
  const colors=[DK.blue, DK.navy, DK.light, DK.amber];
  return deckCanvas(4.9, 3.2, (g,W,H)=>{
    const total=parts.reduce((a,p)=>a+p[1],0)||1, cx=W/2, cy=(H-26)/2+4, r=Math.min(W*.24,(H-26)/2-18);
    let a0=-Math.PI/2;
    parts.forEach(([n,v],i)=>{
      const a1=a0+v/total*Math.PI*2; g.fillStyle=colors[i%4]; g.beginPath(); g.moveTo(cx,cy); g.arc(cx,cy,r,a0,a1); g.closePath(); g.fill();
      g.strokeStyle="#FFFFFF"; g.lineWidth=1; g.stroke();
      const mid=(a0+a1)/2, ex=cx+Math.cos(mid)*(r+14), ey=cy+Math.sin(mid)*(r+12);
      g.strokeStyle="#7F7F7F"; g.lineWidth=.5; g.beginPath(); g.moveTo(cx+Math.cos(mid)*r*.98, cy+Math.sin(mid)*r*.98); g.lineTo(ex,ey); g.stroke();
      g.fillStyle=DK.sub; g.font=font(9); g.textAlign=Math.cos(mid)>=0?"left":"right"; g.fillText(`${n}, ${fmtInt(v)}`, ex+(Math.cos(mid)>=0?3:-3), ey);
      a0=a1;
    });
    legendRow(g, parts.map(([n],i)=>[n, colors[i%4]]), W/2, H-10);
  });
}

/* Slide 7 · daily disposition combo: FP & Pending columns, TP & BP lines with labels */
function drawDispositionTrend(days, fp, pend, tp, bp){
  return deckCanvas(12.7, 2.6, (g,W,H)=>{
    const m={l:34,r:10,t:24,b:52}, pw=W-m.l-m.r, ph=H-m.t-m.b;
    g.fillStyle=DK.ink; g.font=font(11,true); g.textAlign="center"; g.fillText("Disposition Trend", W/2, 10);
    const max=Math.max(1,...tp,...bp,...fp,...pend), step=niceStep(max*1.12,4), top=Math.ceil(max*1.12/step)*step;
    const y=v=>m.t+ph-v/top*ph, slot=pw/Math.max(1,days.length), cx=i=>m.l+slot*i+slot/2;
    g.font=font(7.5); g.textAlign="right";
    for(let v=0; v<=top+1e-9; v+=step){ g.strokeStyle=DK.grid; g.lineWidth=.5; g.beginPath(); g.moveTo(m.l,y(v)); g.lineTo(W-m.r,y(v)); g.stroke(); g.fillStyle=DK.axis; g.fillText(fmtInt(v), m.l-4, y(v)); }
    const bw=Math.min(7,slot*.3);
    days.forEach((d,i)=>{ g.fillStyle=DK.light; g.fillRect(cx(i)-bw, y(fp[i]), bw, m.t+ph-y(fp[i])); g.fillStyle=DK.amber; g.fillRect(cx(i), y(pend[i]), bw, m.t+ph-y(pend[i])); });
    const line=(vals,color)=>{ g.strokeStyle=color; g.lineWidth=2; g.beginPath(); vals.forEach((v,i)=>i?g.lineTo(cx(i),y(v)):g.moveTo(cx(i),y(v))); g.stroke();
      vals.forEach((v,i)=>{ g.fillStyle=color; g.beginPath(); g.arc(cx(i),y(v),2.2,0,7); g.fill(); g.fillStyle=DK.sub; g.font=font(6.5); g.textAlign="center"; g.fillText(fmtInt(v), cx(i), y(v)-6); }); };
    line(bp, DK.navy); line(tp, DK.blue);
    g.save(); g.font=font(7); g.fillStyle=DK.axis;
    days.forEach((d,i)=>{ g.save(); g.translate(cx(i), m.t+ph+6); g.rotate(-Math.PI/4); g.textAlign="right"; g.fillText(d,0,0); g.restore(); });
    g.restore();
    legendRow(g, [["False Positive",DK.light],["Pending",DK.amber],["True Positive",DK.blue,true],["Benign Positive",DK.navy,true]], W/2, H-7);
  });
}

"use strict";
/* ============================================================
   SOC-RAP MVP · core engine (ingest, classify, validate, SLA)
   All processing happens in this browser tab. Nothing is sent anywhere.
   ============================================================ */
const PRIOS = ["Critical","High","Medium","Low"];
const ALL_PRIOS = ["Critical","High","Medium","Low","Informational"];
const SCORE_MAP = {"100":"Critical","80":"High","60":"Medium","40":"Low","-1":"Informational"};
const METRICS = [
  {k:"TTA", name:"Time to Acknowledge", short:"Acknowledge"},
  {k:"TTI", name:"Time to Investigate", short:"Investigate"},
  {k:"TTC", name:"Time to Contain", short:"Contain"},
  {k:"TTR", name:"Time to Remediate", short:"Remediate"}
];
const UNIT_SEC = {s:1, min:60, h:3600};
const DEFAULT_LIMITS = {
  Critical:{TTA:[30,"min"],TTI:[1,"h"],TTC:[4,"h"],TTR:[16,"h"]},
  High:{TTA:[1,"h"],TTI:[2,"h"],TTC:[8,"h"],TTR:[20,"h"]},
  Medium:{TTA:[8,"h"],TTI:[4,"h"],TTC:[12,"h"],TTR:[24,"h"]},
  Low:{TTA:[12,"h"],TTI:[8,"h"],TTC:[24,"h"],TTR:[72,"h"]}
};
const DEFAULT_TARGETS = {
  Critical:{TTA:98,TTI:98,TTC:98,TTR:98},
  High:{TTA:97,TTI:97,TTC:97,TTR:95},
  Medium:{TTA:90,TTI:90,TTC:90,TTR:90},
  Low:{TTA:90,TTI:90,TTC:90,TTR:90}
};
const clone = o => JSON.parse(JSON.stringify(o));
// Counters keyed by values from uploaded files use null-prototype objects, so keys such as "__proto__" or "constructor" are plain data.
const dict = () => Object.create(null);
const cleanText = (s, max=4000) => String(s ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g,"").slice(0,max);

/* ---------- Title normalization & rule engine ---------- */
function normTitle(s){
  return String(s ?? "").normalize("NFKC").replace(/\p{Cf}/gu,"").toLowerCase()
    .replace(/[^a-z0-9]+/g," ").trim().slice(0,1024);
}
// Safety gate for user-authored patterns (the production build uses RE2; see spec §12.3)
function checkPattern(p){
  if(typeof p!=="string" || !p.trim()) return "Enter a pattern.";
  if(p.length > 300) return "Keep patterns under 300 characters.";
  if(/\(\?[=!<]/.test(p)) return "Lookarounds aren't allowed. Titles are normalized, so use \\b for word edges.";
  if(/\\[1-9]|\\k</.test(p)) return "Backreferences aren't allowed.";
  if(/\{\s*\d{4,}/.test(p)) return "Repeat counts above 999 aren't allowed.";
  // A repeated group ( … )+ ( … )* ( … ){n,} that itself contains a repeat or an alternative can backtrack exponentially.
  const src = p.replace(/\\./g,"_").replace(/\[[^\]]*\]/g,"_");
  const stack=[];
  for(let i=0;i<src.length;i++){
    const ch=src[i];
    if(ch==="("){ stack.push({risky:false}); continue; }
    if(ch===")"){ const g=stack.pop()||{risky:false}; const q=src[i+1];
      if(g.risky && (q==="+"||q==="*"||q==="{")) return "Repeating a group that contains a repeat or | (for example (a|aa)+ or (a+)+) can hang the matcher. Simplify the pattern.";
      if(stack.length && (g.risky || q==="+"||q==="*"||q==="{")) stack[stack.length-1].risky=true;
      continue; }
    if((ch==="+"||ch==="*"||ch==="{"||ch==="|") && stack.length) stack[stack.length-1].risky=true;
  }
  if(stack.length) return "The pattern has an unclosed bracket.";
  try{ new RegExp(p); }catch(e){ return "This isn't a valid pattern: " + e.message; }
  return null;
}
function compileRules(rules){
  return rules.filter(r=>r.enabled!==false && typeof r.pattern==="string" && (!String(r.rule_id).startsWith("CAT-USER") || !checkPattern(r.pattern))).slice().sort((a,b)=>a.precedence-b.precedence || (a.rule_id<b.rule_id?-1:1))
    .map(r=>({...r, rx:new RegExp(r.pattern)}));
}
function classifyNorm(n, compiled){
  for(const r of compiled){
    const m = r.rx.exec(n);
    if(m) return {ruleId:r.rule_id, category:r.category, sub:r.subcategory, bucket:r.report_bucket, match:m[0].trim()};
  }
  return {ruleId:"CAT-FALLBACK", category:"Uncategorized", sub:"", bucket:"Uncategorized", match:""};
}

/* ---------- Timestamp detection (requirement 6) ---------- */
const TS_MIN = Date.UTC(2000,0,1), TS_MAX = Date.UTC(2100,0,1);
function parseTs(v, tzMin){
  if(v===null || v===undefined || v==="") return {ms:null, form:"empty"};
  if(v instanceof Date){ const t=v.getTime(); return isNaN(t)?{ms:NaN,form:"invalid"}:{ms:t,form:"Excel date"}; }
  let n = null;
  if(typeof v==="number") n=v;
  else if(typeof v==="string" && /^\s*-?\d+(\.\d+)?\s*$/.test(v)) n=Number(v);
  if(n!==null){
    const digits = String(Math.floor(Math.abs(n))).length;
    let ms=null, form="";
    if(n>20000 && n<80000){ ms=Math.round((n-25569)*86400000); form="Excel serial"; }
    else if(digits>=9 && digits<=10){ ms=n*1000; form="epoch seconds"; }
    else if(digits>=12 && digits<=13){ ms=n; form="epoch ms"; }
    else if(digits>=15 && digits<=16){ ms=Math.round(n/1000); form="epoch µs"; }
    else if(digits>=18 && digits<=19){ ms=Math.round(n/1e6); form="epoch ns"; }
    if(ms===null || ms<TS_MIN || ms>TS_MAX) return {ms:NaN, form:"invalid"};
    return {ms, form};
  }
  const s = String(v).trim();
  const naive = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?$/);
  let ms, form;
  if(naive){
    const [,Y,M,D,h,mi,se,frac] = naive;
    ms = Date.UTC(+Y,+M-1,+D,+h,+mi,+(se||0), frac?+(frac+"00").slice(0,3):0) - (tzMin||0)*60000;
    form = "date text (no zone, read as report time zone)";
  } else {
    ms = Date.parse(s); form = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(s) ? "ISO-8601 with zone" : "date text";
  }
  if(isNaN(ms) || ms<TS_MIN || ms>TS_MAX) return {ms:NaN, form:"invalid"};
  return {ms, form};
}

/* ---------- Column mapping ---------- */
const FIELDS = [
  {k:"id", label:"Case ID", req:true, syn:["id","caseid","case","ticketid","ticket","number","incidentid"]},
  {k:"title", label:"Alert title", req:true, syn:["title","alertname","alert","name","summary","rulename"]},
  {k:"description", label:"Description", syn:["description","details"]},
  {k:"priorityScore", label:"Priority score", syn:["priority","priorityscore","severityscore","score"], numeric:true},
  {k:"priorityLabel", label:"Priority label", syn:["priority","prioritylabel","severity","severitylabel"], text:true},
  {k:"createdAt", label:"Created", req:true, syn:["createdat","created","createdtime","creationtime","time","opened","openedat"]},
  {k:"assignedAt", label:"Acknowledged (assigned)", syn:["assignedat","acknowledgedat","ackat","assigned"]},
  {k:"investigatedTill", label:"Investigation end", syn:["investigatedtill","investigatedat","investigationend"]},
  {k:"containmentAt", label:"Contained", syn:["containmentat","containedat","containment"]},
  {k:"closedAt", label:"Closed", syn:["closedat","closingtime","resolvedat","closed","closetime"]},
  {k:"tta", label:"TTA seconds (supplied)", syn:["timetoacknowledge","tta"]},
  {k:"tti", label:"TTI seconds (supplied)", syn:["timetoinvestigate","tti"]},
  {k:"ttc", label:"TTC seconds (supplied)", syn:["timetocontain","ttc"]},
  {k:"ttr", label:"TTR seconds (supplied)", syn:["timetoclose","timetoresolve","timetoremediate","ttr"]},
  {k:"stage", label:"Stage", syn:["stage","status","state"]},
  {k:"disposition", label:"Disposition", syn:["disposition","verdict"]},
  {k:"closeReason", label:"Close reason", syn:["closereason"]},
  {k:"rootCause", label:"Root cause", syn:["rootcause"]},
  {k:"assignee", label:"Assignee / tier", syn:["userassigned","assignee","owner","assignedto","tier"]},
  {k:"isClosed", label:"Closed flag", syn:["iscaseclosed","isclosed"]}
];
const hkey = s => String(s).toLowerCase().replace(/[^a-z0-9]/g,"");
function autoMap(headers, rows){
  const used = new Set(), map = {};
  const sampleVals = h => rows.slice(0,50).map(r=>r[h]).filter(v=>v!==null&&v!==undefined&&v!=="");
  const isNumericCol = h => { const v=sampleVals(h); return v.length>0 && v.every(x=>typeof x==="number"|| /^-?\d+(\.\d+)?$/.test(String(x).trim())); };
  for(const f of FIELDS){
    for(const s of f.syn){
      const h = headers.find(h=>!used.has(h) && hkey(h)===s && (!f.numeric || isNumericCol(h)) && (!f.text || !isNumericCol(h)));
      if(h){ map[f.k]=h; used.add(h); break; }
    }
  }
  return map;
}

/* ---------- Build case objects ---------- */
function toBool(v){ if(typeof v==="boolean") return v; const s=String(v??"").toLowerCase(); return s==="true"||s==="1"||s==="yes"; }
function numOrNull(v){ if(v===null||v===undefined||v==="") return null; const n=Number(v); return isNaN(n)?null:n; }
function buildCases(rows, map, tzMin, sourceName){
  const g = (r,k) => map[k] ? r[map[k]] : undefined;
  return rows.map((r,i)=>{
    const c = {
      src: sourceName, row: i+2,
      id: cleanText(g(r,"id"),200).trim(),
      title: cleanText(g(r,"title"),1000).trim(),
      description: cleanText(g(r,"description")),
      score: numOrNull(g(r,"priorityScore")),
      label: g(r,"priorityLabel") ? cleanText(g(r,"priorityLabel"),100).trim() : null,
      stage: cleanText(g(r,"stage"),200), disposition: cleanText(g(r,"disposition"),200).trim(),
      closeReason: cleanText(g(r,"closeReason"),200), rootCause: cleanText(g(r,"rootCause"),200),
      assignee: cleanText(g(r,"assignee"),200), isClosedFlag: map.isClosed ? toBool(g(r,"isClosed")) : null,
      supplied: {TTA:numOrNull(g(r,"tta")), TTI:numOrNull(g(r,"tti")), TTC:numOrNull(g(r,"ttc")), TTR:numOrNull(g(r,"ttr"))},
      raw: {}, ts: {}
    };
    for(const k of ["createdAt","assignedAt","investigatedTill","containmentAt","closedAt"]){
      const v = g(r,k); c.raw[k]=v; const p=parseTs(v,tzMin); c.ts[k]=p.ms;
    }
    return c;
  });
}

/* ---------- Evaluation state ---------- */
const S = {
  cases: [], sources: [], limits: clone(DEFAULT_LIMITS), targets: clone(DEFAULT_TARGETS),
  rules: [], compiled: [], tz: 330, cadence: "monthly", start: null, end: null,
  edits: {}, voids: {}, dropped: {}, catOverride: {}, audit: [], acceptedNB: {},
  isSample: true, ackZero: true, nextUid: 0, periodTz: 0, retainMonths: 3, topN: 15, showNums: true, tab: "overview",
  report: {client:"Contoso (Demo)", source:"Google SecOps", slaTakeaway:"", slaNext:"", sevTakeaway:"", sevNext:"", catTakeaway:""}
};
const limitSec = (p,m) => { const [v,u]=S.limits[p][m]; return Math.round(Number(v)*UNIT_SEC[u]); };

function uidOf(c){ return c.uid; }
function effective(c){
  const e = S.edits[c.uid] || {};
  return {
    priority: e.priority ?? c.priority,
    ts: {...c.ts, ...(e.ts||{})}
  };
}
// Score ranges used when a score isn't one of the standard values (100/80/60/40/-1).
function scoreBand(n){ if(n<=0) return "Informational"; if(n>=90) return "Critical"; if(n>=70) return "High"; if(n>=50) return "Medium"; return "Low"; }
function resolvePriority(c){
  c.prioNote = "";
  const lbl = c.label ? ALL_PRIOS.find(p=>p.toLowerCase()===c.label.toLowerCase()) : undefined;
  if(c.score!==null && !isNaN(c.score)){
    const exact = SCORE_MAP[String(c.score)];
    if(exact){ if(lbl && lbl!==exact) c.prioNote = `Score ${c.score} = ${exact}; label said ${c.label}. Score used.`; return exact; }
    if(lbl){ c.prioNote = `Score ${c.score} isn't a standard value; used the priority label (${lbl}).`; return lbl; }
    const band = scoreBand(c.score); c.prioNote = `Score ${c.score} isn't a standard value; mapped by range to ${band}.`; return band;
  }
  if(lbl) return lbl;
  return null;
}
function classifyAll(){
  S.compiled = compileRules(S.rules);
  for(const c of S.cases){
    c.norm = normTitle(c.title);
    const ov = S.catOverride[c.norm];
    c.cat = ov ? {ruleId:"MANUAL", category:ov.category, sub:"Manual override", bucket:ov.bucket, match:""} : classifyNorm(c.norm, S.compiled);
  }
}
function prepareAll(){
  S.cases.forEach(c=>{ if(c.uid===undefined) c.uid = S.nextUid++; c.priority = resolvePriority(c); });
  classifyAll();
}

const AUTO = /automated closure/i;
function isOpen(c, ts){ return ts.closedAt==null && c.isClosedFlag!==true; }

// Status per metric: MET | NOT_MET | PENDING | NA | ERROR
function evaluate(c, asOf){
  const ef = effective(c), ts = ef.ts, pr = ef.priority, out = {};
  const created = ts.createdAt;
  const derived = {
    TTA: ts.assignedAt!=null ? (ts.assignedAt-created)/1000 : null,
    TTI: ts.investigatedTill!=null ? (ts.investigatedTill-created)/1000 : (ts.closedAt!=null ? (ts.closedAt-created)/1000 : null),
    TTC: ts.containmentAt!=null ? (ts.containmentAt-created)/1000 : null,
    TTR: ts.closedAt!=null ? (ts.closedAt-created)/1000 : null
  };
  const editedTs = !!(S.edits[c.uid] && S.edits[c.uid].ts);
  const chrono = ts.assignedAt!=null && ts.closedAt!=null && ts.closedAt < ts.assignedAt;
  for(const {k} of METRICS){
    if(S.dropped[c.uid]) { out[k]={s:"NA", why:"Dropped duplicate"}; continue; }
    if(created==null || isNaN(created)) { out[k]={s:"ERROR", why:"Created time missing or invalid"}; continue; }
    if(!pr) { out[k]={s:"ERROR", why:"Priority not recognized"}; continue; }
    if(pr==="Informational") { out[k]={s:"NA", why:"Informational (excluded)"}; continue; }
    if(S.voids[c.uid+":"+k]) { out[k]={s:"NA", why:"Voided: "+S.voids[c.uid+":"+k]}; continue; }
    if(k==="TTA" && chrono) { out[k]={s:"ERROR", why:"Closed before acknowledged"}; continue; }
    const lim = limitSec(pr,k);
    // A supplied elapsed value wins unless the reviewer edited the timestamps.
    let el = (!editedTs && c.supplied[k]!=null) ? c.supplied[k] : derived[k];
    if(el==null){
      if(k==="TTA" && S.ackZero) { out[k]={s:"MET", el:0, imputed:true, why: AUTO.test(String(c.rootCause)) ? "No acknowledge time (automated closure): counted as 0 s" : "No acknowledge time: counted as 0 s"}; continue; }
      if(k==="TTA" && AUTO.test(String(c.rootCause))) { out[k]={s:"NA", why:"Automated closure"}; continue; }
      if(k==="TTC") { out[k]={s:"NA", why:"No containment recorded"}; continue; }
      if(isOpen(c,ts) && k==="TTR"){
        const age = (asOf - created)/1000;
        out[k] = age>lim ? {s:"NOT_MET", why:"Open past limit", el:null} : {s:"PENDING", why:"Open, within limit"};
        continue;
      }
      out[k]={s:"NA", why: isOpen(c,ts) ? "Not recorded (case still open)" : "No milestone recorded"}; continue;
    }
    if(el<0) { out[k]={s:"ERROR", why:"Negative elapsed time"}; continue; }
    out[k] = {s: el<=lim ? "MET":"NOT_MET", el};
  }
  return out;
}

/* ---------- Periods (tz-aware) ---------- */
const DAY = 86400000;
// Periods (day/week/month boundaries) use S.periodTz; display and heatmap hours use S.tz.
function ymdToMs(ymd){ const [y,m,d]=ymd.split("-").map(Number); return Date.UTC(y,m-1,d) - S.periodTz*60000; }
function msToYmd(ms){ const d=new Date(ms + S.periodTz*60000); return d.toISOString().slice(0,10); }
function addDaysYmd(ymd,n){ const [y,m,d]=ymd.split("-").map(Number); return new Date(Date.UTC(y,m-1,d+n)).toISOString().slice(0,10); }
function monthBounds(ym){ const [y,m]=ym.split("-").map(Number); const s=new Date(Date.UTC(y,m-1,1)).toISOString().slice(0,10); const e=new Date(Date.UTC(y,m,0)).toISOString().slice(0,10); return [s,e]; }
function mondayOf(ymd){ const [y,m,d]=ymd.split("-").map(Number); const dt=new Date(Date.UTC(y,m-1,d)); const wd=(dt.getUTCDay()+6)%7; return addDaysYmd(ymd,-wd); }
function periodRange(){ return {from: ymdToMs(S.start), to: ymdToMs(addDaysYmd(S.end,1))}; }
function prevPeriod(start=S.start, end=S.end){
  if(S.cadence==="monthly"){ const [y,m]=start.split("-").map(Number); const pm = new Date(Date.UTC(y,m-2,1)).toISOString().slice(0,7); const [s,e]=monthBounds(pm); return {start:s,end:e}; }
  const len = Math.round((ymdToMs(addDaysYmd(end,1)) - ymdToMs(start))/DAY);
  return {start: addDaysYmd(start,-len), end: addDaysYmd(start,-1)};
}
const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const MONTH_FULL = ["January","February","March","April","May","June","July","August","September","October","November","December"];
function fmtYmd(ymd){ const [y,m,d]=ymd.split("-").map(Number); return `${d} ${MON[m-1]} ${y}`; }
function periodLabel(start,end,cad){
  const [y,m]=start.split("-").map(Number);
  if(cad==="monthly") return `${MONTH_FULL[m-1]} ${y}`;
  if(start===end) return fmtYmd(start);
  return `${fmtYmd(start)} – ${fmtYmd(end)}`;
}
function shortPeriodLabel(start,end,cad){
  const [y,m]=start.split("-").map(Number);
  if(cad==="monthly") return `${MON[m-1]}-${String(y).slice(2)}`;
  return periodLabel(start,end,cad);
}

/* ---------- Aggregation ---------- */
function quantile(sorted,q){ if(!sorted.length) return null; const pos=(sorted.length-1)*q, lo=Math.floor(pos), hi=Math.ceil(pos); return sorted[lo]+(sorted[hi]-sorted[lo])*(pos-lo); }
const round2 = x => Math.round((x+Number.EPSILON)*100)/100;
function maxTs(){ let m=0; for(const c of S.cases){ for(const k in c.ts){ const v=c.ts[k]; if(v && !isNaN(v) && v>m) m=v; } } return m; }

function aggregate(from, to){
  const asOf = Math.min(to, maxTs() || to);
  const inP = S.cases.filter(c=>{ const t=effective(c).ts.createdAt; return t!=null && !isNaN(t) && t>=from && t<to && !S.dropped[c.uid]; });
  const A = {from, to, asOf, cases:inP, total:inP.length, byPrio:dict(), sla:{}, overall:{}, bucket:dict(), category:dict(),
             disp:dict(), closeR:dict(), daily:new Map(), hourly:Array.from({length:24},()=>({})), heat:new Map(), dispByTitle:new Map(),
             auto:0, tp:0, open:0, uncategorized:0, evaluable:0, tier12:0, tier3:0, simulation:0};
  for(const p of ALL_PRIOS) A.byPrio[p]=0;
  for(const p of PRIOS){ A.sla[p]={}; for(const {k} of METRICS) A.sla[p][k]={met:0,notMet:0,pending:0,na:0,err:0,vals:[]}; }
  for(const {k} of METRICS) A.overall[k]={met:0,notMet:0,pending:0,na:0,err:0,vals:[]};
  const bucketDays = (to-from) <= 2*DAY;
  for(const c of inP){
    const ef = effective(c), pr = ef.priority, ts = ef.ts;
    if(pr) A.byPrio[pr]++;
    if(pr && pr!=="Informational") A.evaluable++;
    A.bucket[c.cat.bucket]=(A.bucket[c.cat.bucket]||0)+1;
    A.category[c.cat.category]=(A.category[c.cat.category]||0)+1;
    if(c.cat.category==="Uncategorized") A.uncategorized++;
    if(c.cat.sub==="Simulation") A.simulation++;
    if(AUTO.test(String(c.rootCause))) A.auto++;
    const d = c.disposition || "Unknown"; A.disp[d]=(A.disp[d]||0)+1;
    if(/^true positive$/i.test(d)) A.tp++;
    const open = isOpen(c,ts); if(open) A.open++;
    const cr = open ? "Pending" : ({Malicious:"Malicious",NotMalicious:"Non-Malicious",Maintenance:"Maintenance"}[c.closeReason] || "Other");
    A.closeR[cr]=(A.closeR[cr]||0)+1;
    if(/tier\s*-?[12]\b/i.test(String(c.assignee))) A.tier12++; else if(/tier\s*-?3\b/i.test(String(c.assignee))) A.tier3++;
    const hr = new Date(ts.createdAt + S.tz*60000).getUTCHours();
    const key = bucketDays ? String(new Date(ts.createdAt + S.periodTz*60000).getUTCHours()).padStart(2,"0")+":00" : msToYmd(ts.createdAt);
    if(!A.daily.has(key)) A.daily.set(key,dict());
    const dd = A.daily.get(key); dd[d]=(dd[d]||0)+1;
    const hk = c.title || "(no title)";
    if(!A.heat.has(hk)) A.heat.set(hk, new Array(24).fill(0));
    A.heat.get(hk)[hr]++;
    if(!A.dispByTitle.has(hk)) A.dispByTitle.set(hk,dict());
    const dt=A.dispByTitle.get(hk); dt[d]=(dt[d]||0)+1;
    const ev = evaluate(c, asOf); c._ev = ev;
    if(!pr || pr==="Informational") continue;
    for(const {k} of METRICS){
      const r = ev[k], cell = A.sla[pr][k], ov = A.overall[k];
      const bump = f => { cell[f]++; ov[f]++; };
      if(r.s==="MET") bump("met"); else if(r.s==="NOT_MET") bump("notMet"); else if(r.s==="PENDING") bump("pending"); else if(r.s==="NA") bump("na"); else bump("err");
      if((r.s==="MET"||r.s==="NOT_MET") && r.el!=null && !r.imputed){ cell.vals.push(r.el); ov.vals.push(r.el); }
      if(r.imputed){ cell.zero=(cell.zero||0)+1; ov.zero=(ov.zero||0)+1; }
    }
  }
  if(!bucketDays){
    // fill empty days so gaps read as zero
    for(let t=from; t<to; t+=DAY){ const k=msToYmd(t); if(!A.daily.has(k)) A.daily.set(k,dict()); }
  } else {
    for(let h=0;h<24;h++){ const k=String(h).padStart(2,"0")+":00"; if(!A.daily.has(k)) A.daily.set(k,dict()); }
  }
  A.daily = new Map([...A.daily.entries()].sort((a,b)=>a[0]<b[0]?-1:1));
  const fin = (cell, tgt) => {
    const den = cell.met + cell.notMet; const s = cell.vals.slice().sort((a,b)=>a-b);
    cell.n = den; cell.pct = den ? round2(cell.met/den*100) : null; cell.target = tgt;
    cell.status = cell.pct===null ? "none" : (tgt!=null ? (cell.pct >= tgt ? "ok":"bad") : "none");
    cell.mean = s.length ? s.reduce((a,b)=>a+b,0)/s.length : null; cell.median = quantile(s,.5); cell.p95 = quantile(s,.95);
  };
  for(const p of PRIOS) for(const {k} of METRICS) fin(A.sla[p][k], S.targets[p][k]);
  for(const {k} of METRICS) fin(A.overall[k], null);
  return A;
}

/* ---------- Validation / review queue (requirement 7) ---------- */
function buildIssues(A){
  const issues = [];
  const inIds = new Set(A.cases.map(c=>c.uid));
  // Uncategorized, grouped by normalized title
  const groups = new Map();
  for(const c of A.cases) if(c.cat.category==="Uncategorized"){ if(!groups.has(c.norm)) groups.set(c.norm,[]); groups.get(c.norm).push(c); }
  for(const [n, cs] of groups) issues.push({key:"UNCAT:"+n, type:"UNCAT", blocking:false, title:cs[0].title, cases:cs, norm:n});
  // Invalid priority (blank or unreadable score and no usable label)
  for(const c of A.cases){ if(!effective(c).priority) issues.push({key:"PRIO:"+c.uid, type:"PRIO", blocking:true, cases:[c]}); }
  // Priorities corrected from the score column (non-blocking, for the record)
  const fixes = new Map();
  for(const c of A.cases){ if(c.prioNote && !(S.edits[c.uid]&&S.edits[c.uid].priority)){ if(!fixes.has(c.prioNote)) fixes.set(c.prioNote,[]); fixes.get(c.prioNote).push(c); } }
  for(const [note, cs] of fixes) issues.push({key:"PFIX:"+note, type:"PFIX", blocking:false, cases:cs, note});
  // Chronology
  for(const c of A.cases){
    const ts = effective(c).ts;
    if(ts.assignedAt!=null && ts.closedAt!=null && ts.closedAt<ts.assignedAt && !S.voids[c.uid+":TTA"])
      issues.push({key:"CHRONO:"+c.uid, type:"CHRONO", blocking:true, cases:[c]});
    for(const k of ["assignedAt","investigatedTill","containmentAt","closedAt"])
      if(ts[k]!=null && !isNaN(ts[k]) && ts.createdAt!=null && ts[k] < ts.createdAt - 1000 && !(k==="closedAt"&&S.voids[c.uid+":TTR"]))
        issues.push({key:"NEG:"+c.uid+":"+k, type:"NEG", blocking:true, cases:[c], field:k});
  }
  // Unparseable timestamps
  for(const c of S.cases){
    if(S.dropped[c.uid]) continue;
    for(const k of ["createdAt","assignedAt","investigatedTill","containmentAt","closedAt"]){
      const v = effective(c).ts[k];
      if(v!==null && v!==undefined && isNaN(v) && (k!=="createdAt" ? inIds.has(c.uid) : true))
        issues.push({key:"TS:"+c.uid+":"+k, type:"TS", blocking:true, cases:[c], field:k});
    }
  }
  // Duplicate IDs (any member in this period)
  const byId = new Map();
  for(const c of S.cases){ if(S.dropped[c.uid] || !c.id) continue; const k=c.src+"\u0000"+c.id; if(!byId.has(k)) byId.set(k,[]); byId.get(k).push(c); }
  for(const [id, cs] of byId) if(cs.length>1 && cs.some(c=>inIds.has(c.uid))) issues.push({key:"DUP:"+id, type:"DUP", blocking:true, cases:cs, id:cs[0].id});
  return issues;
}

/* ---------- Formatting ---------- */
const fmtInt = n => n==null ? "—" : Number(n).toLocaleString("en-US");
const fmtPct = (x,dp=2) => x==null ? "—" : (dp===2 ? x.toFixed(2).replace(/\.00$/,"") : x.toFixed(dp)) + "%";
function fmtDur(sec){
  if(sec==null) return "—";
  const m = sec/60;
  if(m < 60) return (Math.round(m*100)/100).toFixed(2) + " Min";
  return (Math.round(m/60*10)/10).toFixed(1) + " Hours";
}
function fmtLimit(p,m){ const [v,u]=S.limits[p][m]; const n=Number(v); return u==="min" ? `${n} Minutes` : u==="h" ? `${n} ${n===1?"Hour":"Hours"}` : `${n} Seconds`; }
function fmtLocal(ms){ if(ms==null||isNaN(ms)) return "—"; const d=new Date(ms+S.tz*60000); return d.toISOString().slice(0,16).replace("T"," ") + (S.tz?" IST":" UTC"); }
function fmtUtc(ms){ if(ms==null||isNaN(ms)) return "—"; return new Date(ms).toISOString().slice(0,19).replace("T"," ")+" UTC"; }
function fmtIst(ms){ if(ms==null||isNaN(ms)) return "—"; return new Date(ms+330*60000).toISOString().slice(0,19).replace("T"," ")+" IST"; }
function pctChange(a,b){ if(!b) return null; return (a-b)/b*100; }

/* ---------- Observations (template-based, traceable) ---------- */
function observations(A, P, curLbl, prevLbl){
  const o = [], src = S.report.source || "SOC";
  const d = A.total - (P?P.total:0), pc = P && P.total ? pctChange(A.total,P.total) : null;
  if(P && P.total) o.push(`${curLbl} case volume totaled ${fmtInt(A.total)} ${src} cases, ${d>=0?"an increase":"a decrease"} of ${fmtInt(Math.abs(d))} (${pc>=0?"+":""}${pc.toFixed(1)}%) from ${prevLbl}.`);
  else o.push(`${curLbl} case volume totaled ${fmtInt(A.total)} ${src} cases. No data was loaded for ${prevLbl}, so there is no comparison.`);
  o.push(`${fmtInt(A.byPrio.Critical)} Critical, ${fmtInt(A.byPrio.High)} High, ${fmtInt(A.byPrio.Medium)} Medium, ${fmtInt(A.byPrio.Low)} Low and ${fmtInt(A.byPrio.Informational)} Informational cases were triggered.`);
  if(P && P.total){
    const keys = new Set([...Object.keys(A.bucket),...Object.keys(P.bucket)]);
    const mv = [...keys].map(k=>({k, d:(A.bucket[k]||0)-(P.bucket[k]||0), cur:A.bucket[k]||0, prev:P.bucket[k]||0})).sort((a,b)=>Math.abs(b.d)-Math.abs(a.d));
    const neu = mv.filter(x=>x.prev===0 && x.cur>0);
    if(neu.length) o.push(`New this period: ${neu.map(x=>`${x.k} (${fmtInt(x.cur)})`).join(", ")}, absent in ${prevLbl}.`);
    const top = mv.filter(x=>x.prev>0).slice(0,2);
    if(top.length) o.push(`Largest changes among existing buckets: ${top.map(x=>`${x.k} ${x.d>=0?"+":"−"}${fmtInt(Math.abs(x.d))} (${fmtInt(x.prev)} → ${fmtInt(x.cur)})`).join("; ")}.`);
  }
  if(A.auto) o.push(`Automation closed ${fmtInt(A.auto)} cases (${(A.auto/A.total*100).toFixed(1)}% of volume).`);
  const tpB = dict(); for(const c of A.cases) if(/^true positive$/i.test(c.disposition)) tpB[c.cat.bucket]=(tpB[c.cat.bucket]||0)+1;
  const tpTop = Object.entries(tpB).sort((a,b)=>b[1]-a[1]).slice(0,3);
  if(A.tp) o.push(`${fmtInt(A.tp)} true positive cases, led by ${tpTop.map(([k,v])=>`${k} (${fmtInt(v)})`).join(", ")}.`);
  if(A.open) o.push(`${fmtInt(A.open)} cases remain open (waiting on the client or under active coordination).`);
  const miss = [];
  for(const p of PRIOS) for(const {k} of METRICS){ const c=A.sla[p][k]; if(c.status==="bad") miss.push(`${p} ${k} ${fmtPct(c.pct)} vs ${c.target}% target`); }
  o.push(miss.length ? `SLA targets missed: ${miss.join("; ")}.` : `All SLA compliance targets were met for evaluable cases.`);
  return o;
}
function detectionInsights(A){
  const rows = [...A.dispByTitle.entries()].map(([t,d])=>{
    const n = Object.values(d).reduce((a,b)=>a+b,0);
    const tp=(d["True Positive"]||0)/n*100, bp=(d["Benign Positive"]||0)/n*100, fp=(d["False Positive"]||0)/n*100;
    return {t,n,tp,bp,fp};
  }).sort((a,b)=>b.n-a.n);
  const share = r => r.n/A.total*100;
  const acts = [];
  const pri = rows.filter(r=>r.tp>=80 && r.n>=10).slice(0,2);
  const tune = rows.filter(r=>r.bp>=90 && r.n>=20).slice(0,2);
  const val = rows.filter(r=>r.bp>=99.5 && r.n>=10 && !tune.includes(r)).slice(0,1);
  const mon = rows.filter(r=>share(r)>=15 && r.tp>=50).slice(0,1);
  if(pri.length) acts.push(["Prioritize", `Keep focus on ${pri.map(r=>`${r.t} (~${Math.round(r.tp)}% TP)`).join(" and ")} as high-confidence detections.`]);
  if(tune.length) acts.push(["Tune", `Review ${tune.map(r=>`${r.t} (~${Math.round(r.bp)}% BP)`).join(" and ")} for tuning opportunities.`]);
  if(val.length) acts.push(["Validate", `Review ${val[0].t} (100% BP) to see whether detection logic or enrichment can be improved.`]);
  if(mon.length) acts.push(["Monitor", `Keep watching ${mon[0].t}, which combines high volume (~${Math.round(share(mon[0]))}% of alerts) with a ~${Math.round(mon[0].tp)}% true positive rate.`]);
  acts.push(["Measure", "Track alert volume and disposition month over month to confirm tuning improves quality without losing detection coverage."]);
  acts.push(["Align", "Keep comparing hourly alert volume with analyst availability and adjust coverage if the pattern shifts."]);
  const hours = new Array(24).fill(0); for(const arr of A.heat.values()) arr.forEach((v,i)=>hours[i]+=v);
  let best=0,bi=0; for(let i=0;i<24;i++){ const w=hours[i]+hours[(i+1)%24]+hours[(i+2)%24]+hours[(i+3)%24]; if(w>best){best=w;bi=i;} }
  const f = [];
  if(rows[0]) f.push(`${rows[0].t} generated ${fmtInt(rows[0].n)} alerts (~${Math.round(share(rows[0]))}% of volume), the largest single volume driver.`);
  if(rows[1]) f.push(`${rows[1].t} generated ${fmtInt(rows[1].n)} alerts, the second-largest driver.`);
  if(rows[0]) f.push(`${rows[0].t} had a ~${Math.round(rows[0].tp)}% true positive rate.`);
  if(A.total) f.push(`The busiest 4-hour window was ${String(bi).padStart(2,"0")}:00–${String((bi+4)%24).padStart(2,"0")}:00 ${S.tz?"IST":"UTC"}, with ${fmtInt(best)} alerts (${(best/A.total*100).toFixed(0)}%).`);
  return {rows, acts, findings:f};
}

/* ============================================================
   SOC-RAP MVP · UI (all DOM built with textContent, never innerHTML)
   ============================================================ */
function h(tag, attrs, ...kids){
  const el = document.createElement(tag);
  if(attrs) for(const [k,v] of Object.entries(attrs)){
    if(v===null || v===undefined || v===false) continue;
    if(k==="class") el.className=v;
    else if(k==="text") el.textContent=v;
    else if(k==="style") el.setAttribute("style",v);
    else if(k.startsWith("on")){ if(typeof v==="function") el.addEventListener(k.slice(2),v); }   // never inline handler strings
    else if(k==="value") el.value=v;
    else if(k==="checked") el.checked=!!v;
    else el.setAttribute(k, v===true?"":v);
  }
  for(const kid of kids.flat()){ if(kid===null||kid===undefined||kid===false) continue; el.append(kid instanceof Node ? kid : document.createTextNode(String(kid))); }
  return el;
}
const SVGNS = "http://www.w3.org/2000/svg";
function s(tag, attrs, ...kids){ const el=document.createElementNS(SVGNS,tag); if(attrs) for(const [k,v] of Object.entries(attrs)){ if(v!=null) el.setAttribute(k,v); } for(const kid of kids.flat()){ if(kid==null) continue; el.append(kid instanceof Node?kid:document.createTextNode(String(kid))); } return el; }
const $ = sel => document.querySelector(sel);
function toast(msg){ const t=h("div",{class:"toast",role:"status",text:msg}); document.body.append(t); setTimeout(()=>t.remove(), 3600); }
const tip = () => $("#tip");
function showTip(e, lines){ const t=tip(); t.replaceChildren(...lines.map(l=>h("div",{text:l}))); t.hidden=false; moveTip(e); }
function moveTip(e){ const t=tip(); const x=Math.min(e.clientX+14, window.innerWidth-t.offsetWidth-8), y=Math.min(e.clientY+14, window.innerHeight-t.offsetHeight-8); t.style.left=x+"px"; t.style.top=y+"px"; }
function hideTip(){ tip().hidden=true; }
function withTip(el, lines){ el.addEventListener("pointerenter",e=>showTip(e,typeof lines==="function"?lines():lines)); el.addEventListener("pointermove",moveTip); el.addEventListener("pointerleave",hideTip); return el; }
const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const PRIO_COLOR = {Critical:"#6B1D1A",High:"#D9472B",Medium:"#FFB500",Low:"#7A9A45",Informational:"#8C97A8"};

/* ---------- Charts (hand-drawn SVG, theme tokens) ---------- */
function niceMax(v){ if(v<=0) return 1; const p=Math.pow(10,Math.floor(Math.log10(v))); const n=v/p; return (n<=1?1:n<=2?2:n<=2.5?2.5:n<=5?5:10)*p; }
function groupedBars(cats, series, {height=240, fmt=fmtInt}={}){
  const W=560, H=height, m={t:18,r:8,b:30,l:44};
  const max = niceMax(Math.max(1,...series.flatMap(s=>s.values)));
  const iw=W-m.l-m.r, ih=H-m.t-m.b, gw=iw/cats.length, bw=Math.min(28,(gw-14)/series.length);
  const y = v => m.t + ih - v/max*ih;
  const svg = s("svg",{viewBox:`0 0 ${W} ${H}`,class:"chart",role:"img","aria-label":"Bar chart"});
  for(let i=0;i<=4;i++){ const v=max*i/4, yy=y(v); svg.append(s("line",{x1:m.l,x2:W-m.r,y1:yy,y2:yy,stroke:i?"var(--grid)":"var(--axis)","stroke-width":1}), s("text",{x:m.l-6,y:yy+4,"text-anchor":"end"},fmtInt(Math.round(v)))); }
  cats.forEach((c,i)=>{
    const gx = m.l + gw*i + (gw - bw*series.length - 2*(series.length-1))/2;
    series.forEach((se,j)=>{
      const v=se.values[i], x=gx+j*(bw+2), yy=y(v), hgt=Math.max(0,m.t+ih-yy);
      const r = Math.min(4,bw/2,hgt);
      const path = hgt>0 ? `M${x},${m.t+ih} V${yy+r} Q${x},${yy} ${x+r},${yy} H${x+bw-r} Q${x+bw},${yy} ${x+bw},${yy+r} V${m.t+ih} Z` : "";
      const hit = s("rect",{x, y:m.t, width:bw, height:ih, fill:"transparent"});
      const g = s("g",null, s("path",{d:path, fill:se.color}), hit);
      withTip(g, [`${c} · ${se.name}`, fmt(v)]);
      svg.append(g);
      if(j===0 && hgt>0) svg.append(s("text",{x:x+bw/2,y:yy-4,"text-anchor":"middle",class:"lbl"},fmt(v)));
    });
    svg.append(s("text",{x:m.l+gw*i+gw/2,y:H-10,"text-anchor":"middle"},c));
  });
  return svg;
}
function hBars(items, {prevMap=null, color="var(--s1)"}={}){
  const rowH=26, W=560, lblW=150, m={t:4,r:70,b:4};
  const H = m.t+m.b+rowH*items.length;
  const max = Math.max(1,...items.map(i=>i.v), ...(prevMap?Object.values(prevMap):[0]));
  const iw = W-lblW-m.r;
  const svg = s("svg",{viewBox:`0 0 ${W} ${H}`,class:"chart",role:"img","aria-label":"Horizontal bar chart"});
  items.forEach((it,i)=>{
    const y=m.t+i*rowH, bw=it.v/max*iw, bh=14;
    svg.append(s("text",{x:lblW-8,y:y+rowH/2+4,"text-anchor":"end",style:"fill:var(--ink-2);font-size:12px"},it.k));
    const g=s("g");
    if(prevMap && prevMap[it.k]!=null){ const pw=prevMap[it.k]/max*iw; g.append(s("rect",{x:lblW,y:y+(rowH-bh)/2+bh+1,width:Math.max(0,pw),height:3,fill:"var(--prev)"})); }
    const r=Math.min(4,bw/2);
    if(bw>0) g.append(s("path",{d:`M${lblW},${y+(rowH-bh)/2} H${lblW+bw-r} Q${lblW+bw},${y+(rowH-bh)/2} ${lblW+bw},${y+(rowH-bh)/2+r} V${y+(rowH+bh)/2-r} Q${lblW+bw},${y+(rowH+bh)/2} ${lblW+bw-r},${y+(rowH+bh)/2} H${lblW} Z`,fill:color}));
    g.append(s("rect",{x:lblW,y,width:iw,height:rowH,fill:"transparent"}));
    const prev = prevMap ? (prevMap[it.k]||0) : null;
    withTip(g, prevMap ? [it.k, `This period: ${fmtInt(it.v)}`, `Previous: ${fmtInt(prev)}`] : [it.k, fmtInt(it.v)]);
    svg.append(g, s("text",{x:lblW+bw+6,y:y+rowH/2+4,class:"lbl"},fmtInt(it.v)));
  });
  return svg;
}
function stackedCols(keys, series, colors, {height=250}={}){
  const W=900, H=height, m={t:10,r:8,b:34,l:40};
  const totals = keys.map((_,i)=>series.reduce((a,se)=>a+se.values[i],0));
  const max = niceMax(Math.max(1,...totals));
  const iw=W-m.l-m.r, ih=H-m.t-m.b, gw=iw/keys.length, bw=Math.max(3,Math.min(22,gw-4));
  const y = v => m.t + ih - v/max*ih;
  const svg = s("svg",{viewBox:`0 0 ${W} ${H}`,class:"chart",role:"img","aria-label":"Stacked column chart"});
  for(let i=0;i<=4;i++){ const v=max*i/4, yy=y(v); svg.append(s("line",{x1:m.l,x2:W-m.r,y1:yy,y2:yy,stroke:i?"var(--grid)":"var(--axis)"}), s("text",{x:m.l-6,y:yy+4,"text-anchor":"end"},fmtInt(Math.round(v)))); }
  const every = Math.ceil(keys.length/15);
  keys.forEach((k,i)=>{
    const x = m.l + gw*i + (gw-bw)/2; let acc=0;
    const g = s("g");
    series.forEach((se,j)=>{
      const v=se.values[i]; if(!v) return;
      const y0=y(acc), y1=y(acc+v); acc+=v;
      g.append(s("rect",{x,y:y1,width:bw,height:Math.max(0,y0-y1-(acc<totals[i]?0:0)),fill:colors[j],stroke:"var(--surface)","stroke-width":1}));
    });
    g.append(s("rect",{x:m.l+gw*i,y:m.t,width:gw,height:ih,fill:"transparent"}));
    withTip(g, [k.length===10?fmtYmd(k):k, `Total ${fmtInt(totals[i])}`, ...series.map((se)=>`${se.name}: ${fmtInt(se.values[i])}`)]);
    svg.append(g);
    if(i%every===0) svg.append(s("text",{x:x+bw/2,y:H-14,"text-anchor":"middle"}, k.length===10 ? k.slice(8)+" "+MON[+k.slice(5,7)-1] : k.slice(0,2)));
  });
  return svg;
}
function legend(items){ return h("div",{class:"legend"}, items.map(([n,c])=>h("span",null,h("i",{style:`background:${c}`}),n))); }

/* ---------- App shell ---------- */
const TABS = [
  ["overview","Overview"],["heatmaps","Heatmaps"],["compare","Compare"],["review","Review"],["cases","Cases"],["settings","Settings"],["data","Data"]
];
let A = null, P = null, P2 = null, ISSUES = [];
function openBlocking(){ return ISSUES.filter(i=>i.blocking && !isResolved(i)); }
function isResolved(i){
  if(i.type==="UNCAT" || i.type==="PFIX") return !!S.acceptedNB[i.key];
  return false; // blocking issues disappear from ISSUES once fixed
}
function recompute(){
  const {from,to} = periodRange();
  A = aggregate(from,to);
  const pp = prevPeriod(); const pf = ymdToMs(pp.start), pt = ymdToMs(addDaysYmd(pp.end,1));
  P = aggregate(pf,pt);
  P.label = periodLabel(pp.start,pp.end,S.cadence); P.short = shortPeriodLabel(pp.start,pp.end,S.cadence);
  const p2 = prevPeriod(pp.start,pp.end); P2 = aggregate(ymdToMs(p2.start), ymdToMs(addDaysYmd(p2.end,1)));
  P2.label = periodLabel(p2.start,p2.end,S.cadence); P2.short = shortPeriodLabel(p2.start,p2.end,S.cadence);
  A.label = periodLabel(S.start,S.end,S.cadence); A.short = shortPeriodLabel(S.start,S.end,S.cadence);
  ISSUES = buildIssues(A);
}
function render(){
  recompute();
  renderChrome();
  renderTabs();
  const main = $("#main"); main.replaceChildren();
  if(!S.cases.length && !["data","settings"].includes(S.tab)){
    main.append(pageHead(clientName(S.clientId), "No data loaded for this client yet."),
      h("div",{class:"panel"}, h("p",{style:"margin:0 0 10px",text:`Upload ${clientName(S.clientId)}'s case export to see SLA results, heatmaps and comparisons. Each client's data stays separate.`}), h("button",{type:"button",class:"btn primary",onclick:()=>{S.tab="data";render();}},"Go to Data")));
    return;
  }
  ({overview:viewOverview, heatmaps:viewHeatmaps, compare:viewCompare, review:viewReview, cases:viewCases, settings:viewSettings, data:viewData})[S.tab](main);
}
function renderChrome(){
  $("#demoFlag").hidden = !S.isSample;
  const srcs = S.sources.map(s=>s.name).join(" + ");
  $("#srcChip").replaceChildren(clientSwitcher());
  document.querySelectorAll("#cadenceSeg button").forEach(b=>b.setAttribute("aria-pressed", String(b.dataset.v===S.cadence)));
  document.querySelectorAll("#tzSeg button").forEach(b=>b.setAttribute("aria-pressed", String(Number(b.dataset.v)===S.tz)));
  const pi = $("#periodInputs"); pi.replaceChildren();
  const set = (st,en)=>{ S.start=st; S.end=en; render(); };
  if(S.cadence==="monthly"){
    pi.append(h("input",{type:"month",id:"inMonth","aria-label":"Month",value:S.start.slice(0,7),onchange:e=>{ if(!e.target.value) return; const [a,b]=monthBounds(e.target.value); set(a,b);} }));
  } else if(S.cadence==="weekly"){
    pi.append(h("label",{class:"small muted",for:"inWeek",text:"Week of"}), h("input",{type:"date",id:"inWeek",value:S.start,onchange:e=>{ if(!e.target.value) return; const mo=mondayOf(e.target.value); set(mo,addDaysYmd(mo,6)); }}));
  } else if(S.cadence==="daily"){
    pi.append(h("input",{type:"date",id:"inDay","aria-label":"Day",value:S.start,onchange:e=>{ if(e.target.value) set(e.target.value,e.target.value);} }));
  } else {
    pi.append(h("input",{type:"date",id:"inFrom","aria-label":"From",value:S.start,onchange:e=>{ if(e.target.value && e.target.value<=S.end) set(e.target.value,S.end);} }), "to",
              h("input",{type:"date",id:"inTo","aria-label":"To",value:S.end,onchange:e=>{ if(e.target.value && e.target.value>=S.start) set(S.start,e.target.value);} }));
  }
  const pp = prevPeriod();
  $("#cmpLabel").textContent = `${A.label} vs ${periodLabel(pp.start,pp.end,S.cadence)}`;
  const nb = openBlocking().length;
  for(const id of ["#btnXlsx","#btnPptx"]){ const b=$(id); b.title = nb ? `Fix ${nb} blocking item${nb>1?"s":""} in Review first` : ""; }
}
function renderTabs(){
  const nav = $("#tabs"); nav.replaceChildren();
  const nb = openBlocking().length, nn = ISSUES.filter(i=>!i.blocking && !isResolved(i)).length;
  for(const [k,label] of TABS){
    const b = h("button",{type:"button",class:"tab",role:"tab","aria-selected":String(S.tab===k),id:"tab-"+k,onclick:()=>{S.tab=k; try{localStorage.setItem("socrap.tab",k);}catch(e){} render(); $("#main").focus({preventScroll:true});}}, label);
    if(k==="review" && (nb||nn)) b.append(h("span",{class:"badge"+(nb?"":" soft"),text:String(nb||nn),"aria-label":`${nb} blocking, ${nn} to review`}));
    nav.append(b);
  }
}
function pageHead(title, sub, ...right){ return h("div",{class:"page-head"}, h("div",null,h("h2",{text:title}), sub?h("p",{text:sub}):null), right.length?h("div",{class:"ctl"},...right):null); }
function deltaSpan(cur, prev, {pts=false, goodUp=true}={}){
  if(prev==null || (pts===false && !prev)) return h("span",{class:"delta-flat small",text:"no prior data"});
  const d = cur - prev; const cls = Math.abs(d)<1e-9 ? "delta-flat" : ((d>0)===goodUp ? "delta-up" : "delta-down");
  if(Math.abs(d)<1e-9) return h("span",{class:"delta-flat small",text:"No change"});
  const txt = pts ? `${d>=0?"▲":"▼"} ${Math.abs(d).toFixed(2)} pts` : `${d>=0?"▲":"▼"} ${fmtInt(Math.abs(d))} (${d>=0?"+":"−"}${Math.abs(pctChange(cur,prev)).toFixed(1)}%)`;
  return h("span",{class:cls+" small",text:txt});
}

/* ---------- Overview ---------- */
function viewOverview(main){
  const nb = openBlocking();
  main.append(pageHead(`${A.label}`, `${S.report.client} · ${S.report.source} cases · compared with ${P.label}. Informational cases are excluded from SLA.`));
  if(nb.length) main.append(h("div",{class:"callout bad",role:"alert"}, h("b",{text:`${nb.length} item${nb.length>1?"s":""} need a fix before export.`}), h("span",{text:"Invalid priorities, duplicate IDs and impossible timestamps would skew SLA results."}), h("button",{type:"button",class:"btn sm",onclick:()=>{S.tab="review";render();}},"Open Review")));
  const tpRate = A.total ? A.tp/A.total*100 : 0, ptp = P.total ? P.tp/P.total*100 : null;
  const k = (label, v, d, note) => h("div",{class:"kpi"}, h("span",{class:"eyebrow",text:label}), h("span",{class:"v num",text:v}), d, note?h("span",{class:"d",text:note}):null);
  main.append(h("div",{class:"kpis"},
    k("Cases", fmtInt(A.total), deltaSpan(A.total,P.total,{goodUp:false})),
    k("SLA-evaluable", fmtInt(A.evaluable), null, `${fmtInt(A.byPrio.Informational)} Informational excluded`),
    k("Auto-closed", fmtInt(A.auto), deltaSpan(A.auto,P.auto)),
    k("True positive rate", fmtPct(tpRate,1), ptp==null?null:deltaSpan(tpRate,ptp,{pts:true}), `${fmtInt(A.tp)} cases`),
    k("Open", fmtInt(A.open), null, "Counted as pending until past the limit"),
    k("Uncategorized", fmtInt(A.uncategorized), null, A.total?`${(A.uncategorized/A.total*100).toFixed(1)}% of cases`:"")
  ));
  main.append(slaMatrix());
  const src = S.report.source;
  const sev = h("div",{class:"panel"}, h("div",{class:"panel-head"}, h("h3",{text:"Cases by severity"}), h("span",{class:"small muted",text:`${A.short} vs ${P.short}`})),
    groupedBars(ALL_PRIOS, [{name:A.short,values:ALL_PRIOS.map(p=>A.byPrio[p]),color:"var(--s1)"},{name:P.short,values:ALL_PRIOS.map(p=>P.byPrio[p]),color:"var(--prev)"}]),
    legend([[A.short,"var(--s1)"],[P.short,"var(--prev)"]]));
  const items = Object.entries(A.bucket).map(([k,v])=>({k,v})).sort((a,b)=>b.v-a.v);
  const cat = h("div",{class:"panel"}, h("div",{class:"panel-head"}, h("h3",{text:"Cases by report bucket"}), h("span",{class:"small muted",text:"Thin grey line = previous period"})),
    items.length ? hBars(items,{prevMap:P.bucket}) : h("p",{class:"muted",text:"No cases in this period."}));
  main.append(h("div",{class:"grid2"}, sev, cat));
  const keys=[...A.daily.keys()], DS=[["True Positive","var(--s1)"],["Benign Positive","var(--s2)"],["False Positive","var(--s3)"],["Waiting Client","var(--s4)"]];
  const series = DS.map(([n])=>({name:n, values:keys.map(k=>A.daily.get(k)[n]||0)}));
  main.append(h("div",{class:"panel"}, h("div",{class:"panel-head"}, h("h3",{text: (A.to-A.from)<=2*DAY ? "Disposition by hour" : "Daily disposition trend"}), h("span",{class:"small muted",text:S.periodTz?"Days in IST":"Days in UTC"})),
    stackedCols(keys, series, DS.map(d=>d[1])), legend(DS)));
  main.append(h("div",{class:"panel"}, h("div",{class:"panel-head"}, h("h3",{text:"Key observations"}), h("span",{class:"small muted",text:"Generated from the numbers above. They go into the PowerPoint."})),
    h("ul",{class:"obs"}, observations(A,P,A.label,P.label).map(t=>h("li",{text:t})))));
}
function slaMatrix(){
  const t = h("table",{class:"sla"});
  t.append(h("thead",null,h("tr",null,h("th",{text:"Priority"}), METRICS.map(m=>h("th",{text:`${m.k} · ${m.short}`})))));
  const tb = h("tbody");
  const cellEl = (c, pc, p, m) => {
    const chip = c.pct===null ? h("span",{class:"chip neutral",text:"No evaluable cases"}) :
      c.status==="ok" ? h("span",{class:"chip good",text:`✓ Meets ${c.target}%`}) : h("span",{class:"chip bad",text:`✗ Below ${c.target}%`});
    const td = h("td",null, h("div",{class:"cell"},
      h("span",{class:"pct num",text:c.pct===null?"—":fmtPct(c.pct)}),
      h("span",{class:"meta num",text:`n=${fmtInt(c.n)}${c.zero?` · ${fmtInt(c.zero)} at 0 s`:""}${c.pending?` · ${c.pending} pending`:""} · limit ${fmtLimit(p,m)}`}),
      h("span",null, chip, " ", pc && pc.pct!=null && c.pct!=null ? deltaSpan(c.pct,pc.pct,{pts:true}) : null)));
    return withTip(td, ()=>[`${p} · ${m}`, `Met ${fmtInt(c.met)} · Not met ${fmtInt(c.notMet)} · Pending ${fmtInt(c.pending)} · N/A ${fmtInt(c.na)}`, `Mean ${fmtDur(c.mean)} · Median ${fmtDur(c.median)} · P95 ${fmtDur(c.p95)}${c.zero?` (excludes ${fmtInt(c.zero)} cases counted as 0 s)`:""}`, pc&&pc.pct!=null?`Previous: ${fmtPct(pc.pct)}`:"Previous: no data"]);
  };
  for(const p of PRIOS){
    tb.append(h("tr",null, h("td",null, h("span",{class:"prio",style:`background:${PRIO_COLOR[p]}`}), h("b",{text:p}), h("div",{class:"small muted num",text:`${fmtInt(A.byPrio[p])} cases`})),
      METRICS.map(m=>cellEl(A.sla[p][m.k], P.sla[p][m.k], p, m.k))));
  }
  tb.append(h("tr",null, h("td",null,h("b",{text:"All priorities"}),h("div",{class:"small muted",text:"case-weighted"})), METRICS.map(m=>{ const c=A.overall[m.k]; return h("td",null,h("div",{class:"cell"},h("span",{class:"pct num",text:c.pct==null?"—":fmtPct(c.pct)}),h("span",{class:"meta num",text:`n=${fmtInt(c.n)} · median ${fmtDur(c.median)}`}))); })));
  t.append(tb);
  return h("div",{class:"panel"}, h("div",{class:"panel-head"}, h("h3",{text:"SLA compliance by priority"}), h("span",{class:"small muted",text:"Hover a cell for mean, median and P95. Change limits and targets in Settings."})), h("div",{class:"tbl-wrap"},t));
}

/* ---------- Heatmaps (requirement 9) ---------- */
function heatColor(p){ return `color-mix(in oklab, var(--heat-hi) ${Math.round(p*100)}%, var(--heat-lo))`; }
function viewHeatmaps(main){
  main.append(pageHead("Heatmaps", `${A.label} · hours in ${S.tz?"IST (UTC+5:30)":"UTC"}. Switch the time zone in the toolbar.`,
    h("label",{for:"topN",class:"small muted",text:"Detections"}),
    h("select",{id:"topN",onchange:e=>{S.topN=+e.target.value; render();}}, [10,15,20,30].map(n=>h("option",{value:n,selected:S.topN===n?"":null,text:`Top ${n}`}))),
    h("label",{class:"small",style:"display:flex;gap:6px;align-items:center"}, h("input",{type:"checkbox",id:"showNums",checked:S.showNums,onchange:e=>{S.showNums=e.target.checked; render();}}),"Show numbers")));
  const rows = [...A.heat.entries()].map(([t,arr])=>({t,arr,n:arr.reduce((a,b)=>a+b,0)})).sort((a,b)=>b.n-a.n).slice(0,S.topN);
  const max = Math.max(1,...rows.flatMap(r=>r.arr));
  const tbl = h("table",{class:"heat"});
  tbl.append(h("thead",null,h("tr",null,h("th",{class:"rowh",text:"Alert name"}), Array.from({length:24},(_,i)=>h("th",{text:String(i)})), h("th",{text:"Total"}))));
  const tb=h("tbody");
  const flip = css("--heat-flip");
  for(const r of rows){
    const tr=h("tr",null,h("th",{class:"rowh",title:r.t,text:r.t}));
    r.arr.forEach((v,i)=>{ const p=v/max; const td=h("td",{class:"c num",style:`background:${heatColor(p)};color:${p>0.5?flip:"var(--ink-2)"}`, text: S.showNums && v ? String(v):""});
      withTip(td,[r.t, `${String(i).padStart(2,"0")}:00–${String(i).padStart(2,"0")}:59 ${S.tz?"IST":"UTC"}`, `${fmtInt(v)} alerts (${(v/r.n*100).toFixed(0)}% of this detection)`]); tr.append(td); });
    tr.append(h("td",{class:"tot num",text:fmtInt(r.n)})); tb.append(tr);
  }
  tbl.append(tb);
  main.append(h("div",{class:"panel"}, h("div",{class:"panel-head"}, h("h3",{text:"Alert volume by detection and hour"}), h("span",{class:"small muted",text:`Darker = more alerts. Peak cell: ${fmtInt(max)}.`})), rows.length? h("div",{style:"overflow-x:auto"},tbl) : h("p",{class:"muted",text:"No cases in this period."})));
  // Disposition heatmap
  const cols = ["Benign Positive","True Positive","False Positive","Waiting Client"];
  const drows = [...A.dispByTitle.entries()].map(([t,d])=>({t,d,n:Object.values(d).reduce((a,b)=>a+b,0)})).sort((a,b)=>b.n-a.n).slice(0,S.topN);
  const t2 = h("table",{class:"heat"});
  t2.append(h("thead",null,h("tr",null,h("th",{class:"rowh",text:"Alert name"}), cols.map(c=>h("th",{text:c})), h("th",{text:"Total"}))));
  const tb2=h("tbody");
  for(const r of drows){
    const tr=h("tr",null,h("th",{class:"rowh",title:r.t,text:r.t}));
    cols.forEach(c=>{ const v=r.d[c]||0, p=v/r.n; const td=h("td",{class:"pc num",style:`background:${heatColor(p)};color:${p>0.5?flip:"var(--ink-2)"}`,text:(p*100).toFixed(1)+"%"}); withTip(td,[r.t,`${c}: ${fmtInt(v)} of ${fmtInt(r.n)}`]); tr.append(td); });
    tr.append(h("td",{class:"tot num",text:fmtInt(r.n)})); tb2.append(tr);
  }
  t2.append(tb2);
  const ins = detectionInsights(A);
  main.append(h("div",{class:"grid2"},
    h("div",{class:"panel"}, h("div",{class:"panel-head"}, h("h3",{text:"Disposition by detection"}), h("span",{class:"small muted",text:"Share of each detection's cases"})), drows.length?h("div",{style:"overflow-x:auto"},t2):h("p",{class:"muted",text:"No cases in this period."})),
    h("div",{class:"panel"}, h("h3",{text:"Findings and next actions"}), h("ul",{class:"obs",style:"margin-top:10px"}, ins.findings.map(f=>h("li",{text:f})), ins.acts.map(([a,t])=>h("li",null,h("b",{text:a+": "}),t))))));
}

/* ---------- Compare (requirement 10) ---------- */
function viewCompare(main){
  main.append(pageHead("Period comparison", `${A.label} against ${P.label}, with ${P2.label} for a three-period trend.`));
  main.append(trendPanel());
  if(!P.total) main.append(h("div",{class:"callout info"}, h("span",{text:`No cases were loaded for ${P.label}. Add that period's export on the Data tab to compare.`})));
  const row = (label, a, b, opts) => h("tr",null, h("td",{text:label}), h("td",{class:"r num",text:fmtInt(a)}), h("td",{class:"r num",text:fmtInt(b)}), h("td",{class:"r"}, deltaSpan(a,b,opts||{goodUp:false})));
  const t1 = h("table",null, h("thead",null,h("tr",null,h("th",{text:"Volume"}),h("th",{class:"r",text:A.short}),h("th",{class:"r",text:P.short}),h("th",{class:"r",text:"Change"}))),
    h("tbody",null, row("Total cases",A.total,P.total), ALL_PRIOS.map(p=>row(p,A.byPrio[p],P.byPrio[p])), row("Auto-closed",A.auto,P.auto,{goodUp:true}), row("True positives",A.tp,P.tp), row("Open",A.open,P.open)));
  const keys = [...new Set([...Object.keys(A.bucket),...Object.keys(P.bucket)])].sort((a,b)=>(A.bucket[b]||0)-(A.bucket[a]||0));
  const t2 = h("table",null, h("thead",null,h("tr",null,h("th",{text:"Report bucket"}),h("th",{class:"r",text:A.short}),h("th",{class:"r",text:P.short}),h("th",{class:"r",text:"Change"}))),
    h("tbody",null, keys.map(k=>{ const a=A.bucket[k]||0,b=P.bucket[k]||0; return h("tr",null,h("td",null,k," ", b===0&&a>0?h("span",{class:"chip warn",text:"New"}):null, a===0&&b>0?h("span",{class:"chip neutral",text:"Gone"}):null),h("td",{class:"r num",text:fmtInt(a)}),h("td",{class:"r num",text:fmtInt(b)}),h("td",{class:"r"},b?deltaSpan(a,b,{goodUp:false}):h("span",{class:"small muted",text:"—"}))); })));
  main.append(h("div",{class:"grid2"}, h("div",{class:"panel"},h("h3",{text:"Incident volume",style:"margin-bottom:10px"}),h("div",{class:"tbl-wrap"},t1)), h("div",{class:"panel"},h("h3",{text:"By report bucket",style:"margin-bottom:10px"}),h("div",{class:"tbl-wrap"},t2))));
  const t3 = h("table",null, h("thead",null,h("tr",null,h("th",{text:"Priority · metric"}),h("th",{class:"r",text:A.short}),h("th",{class:"r",text:P.short}),h("th",{class:"r",text:"Change"}),h("th",{text:"Target"}),h("th",{text:"Status"}))), h("tbody"));
  for(const p of PRIOS) for(const m of METRICS){
    const a=A.sla[p][m.k], b=P.sla[p][m.k];
    const st = a.pct==null ? h("span",{class:"chip neutral",text:"No cases"}) : a.status==="ok" ? h("span",{class:"chip good",text:"✓ Meets"}) : h("span",{class:"chip bad",text:"✗ Below"});
    const crossed = a.pct!=null && b.pct!=null && a.status!==b.status ? h("span",{class:"chip warn",text: a.status==="ok"?"Recovered":"Newly below"}) : null;
    t3.lastChild.append(h("tr",null,h("td",{text:`${p} · ${m.k}`}),h("td",{class:"r num",text:fmtPct(a.pct)}),h("td",{class:"r num",text:fmtPct(b.pct)}),h("td",{class:"r"}, a.pct!=null&&b.pct!=null?deltaSpan(a.pct,b.pct,{pts:true}):h("span",{class:"small muted",text:"—"})),h("td",{class:"num",text:a.target+"%"}),h("td",null,st," ",crossed)));
  }
  main.append(h("div",{class:"panel"},h("h3",{text:"SLA compliance",style:"margin-bottom:10px"}),h("div",{class:"tbl-wrap"},t3)));
  main.append(h("div",{class:"panel"},h("h3",{text:"What changed",style:"margin-bottom:10px"}),h("ul",{class:"obs"},observations(A,P,A.label,P.label).map(t=>h("li",{text:t})))));
}

function trendPanel(){
  const per = [P2,P,A];
  const has = per.map(x=>x.total>0);
  const th = h("tr",null, h("th",{text:"Last three periods"}), per.map((x,i)=>h("th",{class:"r",text:x.short+(has[i]?"":" (no data)")})), h("th",{class:"r",text:`Change vs ${P.short}`}));
  const tb = h("tbody");
  const row = (label, vals, {pct=false, goodUp=false, bold=false}={}) => {
    tb.append(h("tr",null, h("td",bold?{style:"font-weight:600"}:null,label),
      vals.map((v,i)=>h("td",{class:"r num",text: !has[i] ? "—" : pct ? fmtPct(v) : fmtInt(v)})),
      h("td",{class:"r"}, has[1]&&has[2]&&vals[1]!=null&&vals[2]!=null ? deltaSpan(vals[2],vals[1],{pts:pct,goodUp}) : h("span",{class:"small muted",text:"—"}))));
  };
  const sec = t => tb.append(h("tr",null,h("td",{colspan:"5",class:"eyebrow",style:"background:var(--surface-2)",text:t})));
  sec("Volume");
  row("Total cases", per.map(x=>x.total), {bold:true});
  row("SLA-evaluable (excl. Informational)", per.map(x=>x.evaluable));
  ALL_PRIOS.forEach(p=>row(p, per.map(x=>x.byPrio[p])));
  row("Auto-closed", per.map(x=>x.auto), {goodUp:true});
  row("True positives", per.map(x=>x.tp));
  sec("Report buckets");
  [...new Set(per.flatMap(x=>Object.keys(x.bucket)))].sort((a,b)=>(A.bucket[b]||0)-(A.bucket[a]||0)).forEach(k=>row(k, per.map(x=>x.bucket[k]||0)));
  sec("SLA compliance");
  for(const p of PRIOS) for(const m of METRICS){ if(per.every(x=>x.sla[p][m.k].pct==null)) continue; row(`${p} · ${m.k}`, per.map(x=>x.sla[p][m.k].pct), {pct:true, goodUp:true}); }
  const t = h("table",null,h("thead",null,th),tb);
  const missing = per.filter((x,i)=>!has[i]).map(x=>x.label);
  return h("div",{class:"panel"}, h("div",{class:"panel-head"}, h("h3",{text:"Three-period trend"}), h("span",{class:"small muted",text: missing.length ? `Upload ${missing.join(" and ")} on the Data tab to fill the gaps.` : "All three periods loaded."})), h("div",{class:"tbl-wrap"},t));
}

/* ---------- Review (requirement 7) ---------- */
function logAudit(action, detail){ S.audit.unshift({at:new Date().toISOString().slice(0,19).replace("T"," "), action, detail}); }
function suggestPattern(norm){
  const stop = new Set(["the","a","an","of","to","for","from","on","in","by","with","and","or","is","was","ref","vendor"]);
  const toks = norm.split(" ").filter(t=>t.length>2 && !stop.has(t) && !/^\d+$/.test(t)).slice(0,3);
  return toks.length ? "\\b" + toks.join(" ").replace(/[.*+?^${}()|[\]\\]/g,"\\$&") + "\\b" : "";
}
function allCategories(){ return [...new Set(S.rules.map(r=>r.category).concat(Object.values(S.catOverride).map(o=>o.category)))].filter(Boolean).sort(); }
function allBuckets(){ return [...new Set(S.rules.map(r=>r.report_bucket))].filter(Boolean).sort(); }
function viewReview(main){
  const nb = openBlocking(), nn = ISSUES.filter(i=>!i.blocking && !isResolved(i));
  main.append(pageHead("Review", `Records in ${A.label} that can't be evaluated as they are. Your fixes are logged and never change the uploaded file.`));
  main.append(h("div",{class:"callout "+(nb.length?"bad":"ok")},
    h("b",{text: nb.length ? `${nb.length} blocking` : "Ready to export"}),
    h("span",{class:"num",text:`${fmtInt(A.total)} records · ${fmtInt(A.evaluable)} SLA-evaluable · ${fmtInt(A.byPrio.Informational)} Informational excluded · ${nn.length} to review · Uncategorized ${A.total?(A.uncategorized/A.total*100).toFixed(1):"0.0"}%`})));
  if(!ISSUES.length) main.append(h("p",{class:"muted",text:"Nothing needs attention for this period."}));
  const openUncat = ISSUES.filter(i=>i.type==="UNCAT" && !isResolved(i));
  if(openUncat.length>1){
    const nCases = openUncat.reduce((a,i)=>a+i.cases.length,0);
    const err = h("span",{class:"small",style:"color:var(--bad-ink)"});
    main.append(h("div",{class:"panel"},
      h("h3",{text:`Assign all ${openUncat.length} uncategorized titles (${nCases} cases) at once`,style:"margin-bottom:8px"}),
      h("div",{class:"formrow"},
        h("label",{for:"bulkCat",text:"Category"}), h("input",{type:"text",id:"bulkCat",list:"catList",value:"M365 Defender",style:"width:190px"}),
        h("label",{for:"bulkBkt",text:"Report bucket"}), h("select",{id:"bulkBkt"}, allBuckets().map(b=>h("option",{value:b,selected:b==="M365 Defender"?"":null,text:b}))),
        h("label",{style:"display:flex;gap:6px;align-items:center"}, h("input",{type:"checkbox",id:"bulkRule",checked:true}), "Add a rule for each title"),
        h("button",{type:"button",class:"btn primary sm",onclick:()=>{
          const cat=$("#bulkCat").value.trim(), bkt=$("#bulkBkt").value, mk=$("#bulkRule").checked;
          if(!cat){ err.textContent="Enter a category."; return; }
          let n=0;
          for(const it of openUncat){
            if(mk){ const p="^"+it.norm.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")+"$";
              S.rules.push({precedence:50,rule_id:"CAT-USER-"+String(S.rules.filter(r=>r.rule_id.startsWith("CAT-USER")).length+1).padStart(2,"0"),category:cat,subcategory:"Added in review",report_bucket:bkt,pattern:p,enabled:true}); }
            else S.catOverride[it.norm]={category:cat,bucket:bkt};
            n+=it.cases.length;
          }
          logAudit("Categorized (bulk)", `${openUncat.length} titles, ${n} cases → ${cat} / ${bkt}`);
          classifyAll(); render(); toast(`Categorized ${n} cases as ${cat}`);
        }}, "Apply to all"), err)));
  }
  const order = {PRIO:0,DUP:1,CHRONO:2,NEG:3,TS:4,PFIX:5,UNCAT:6};
  for(const it of ISSUES.slice().sort((a,b)=>order[a.type]-order[b.type])) main.append(issueCard(it));
  if(S.audit.length){
    const t=h("table",null,h("thead",null,h("tr",null,h("th",{text:"When"}),h("th",{text:"Action"}),h("th",{text:"Detail"}))),h("tbody",null,S.audit.map(a=>h("tr",null,h("td",{class:"num",text:a.at}),h("td",{text:a.action}),h("td",{text:a.detail})))));
    main.append(h("div",{class:"panel"},h("h3",{text:"Edit history",style:"margin-bottom:10px"}),h("div",{class:"tbl-wrap"},t)));
  }
}
function issueCard(it){
  const c = it.cases[0];
  const resolved = isResolved(it);
  const sevBar = h("span",{class:"sev",style:`background:${it.blocking?"var(--bad-ink)":"var(--warn-ink)"}`});
  const chip = it.blocking ? h("span",{class:"chip bad",text:"Blocks export"}) : h("span",{class:"chip warn",text:resolved?"Accepted":"Review"});
  let title, body;
  if(it.type==="UNCAT"){
    title = `No category rule matches “${it.title}” (${it.cases.length} case${it.cases.length>1?"s":""})`;
    const idC=`cat-${it.cases[0].uid}`, idB=`bkt-${it.cases[0].uid}`, idP=`pat-${it.cases[0].uid}`, idR=`mk-${it.cases[0].uid}`;
    const pat = h("input",{type:"text",id:idP,class:"mono",style:"flex:1;min-width:220px",value:suggestPattern(it.norm)});
    const err = h("span",{class:"small",style:"color:var(--bad-ink)"});
    body = [
      h("div",{class:"small muted",text:`Case IDs: ${it.cases.slice(0,6).map(x=>x.id).join(", ")}${it.cases.length>6?"…":""}`}),
      h("div",{class:"formrow"}, h("label",{for:idC,text:"Category"}), h("input",{type:"text",id:idC,list:"catList",placeholder:"e.g. ServiceNow",style:"width:190px"}),
        h("label",{for:idB,text:"Report bucket"}), h("select",{id:idB}, allBuckets().map(b=>h("option",{value:b,selected:b==="Other"?"":null,text:b})))),
      h("div",{class:"formrow"}, h("label",{style:"display:flex;gap:6px;align-items:center"}, h("input",{type:"checkbox",id:idR,checked:true}), "Also add a rule"), pat),
      err,
      h("div",{class:"formrow"},
        h("button",{type:"button",class:"btn primary sm",onclick:()=>{
          const cat=$("#"+idC).value.trim(), bkt=$("#"+idB).value, mk=$("#"+idR).checked, p=$("#"+idP).value.trim();
          if(!cat){ err.textContent="Enter a category."; return; }
          if(mk){ const e=checkPattern(p); if(e){ err.textContent=e; return; } if(!new RegExp(p).test(it.norm)){ err.textContent="The pattern doesn't match this title. Adjust it or untick “Also add a rule”."; return; }
            S.rules.push({precedence:50,rule_id:"CAT-USER-"+String(S.rules.filter(r=>r.rule_id.startsWith("CAT-USER")).length+1).padStart(2,"0"),category:cat,subcategory:"Added in review",report_bucket:bkt,pattern:p,enabled:true});
            logAudit("Rule added", `${cat} → ${bkt}: ${p}`);
          } else { S.catOverride[it.norm]={category:cat,bucket:bkt}; }
          logAudit("Categorized", `“${it.title}” → ${cat} / ${bkt} (${it.cases.length} cases)`);
          classifyAll(); render(); toast(`Categorized ${it.cases.length} case${it.cases.length>1?"s":""} as ${cat}`);
        }}, `Apply to ${it.cases.length} case${it.cases.length>1?"s":""}`),
        h("button",{type:"button",class:"btn sm",onclick:()=>{ S.acceptedNB[it.key]=true; logAudit("Left uncategorized", `“${it.title}”`); render(); }}, "Leave uncategorized"))
    ];
  } else if(it.type==="PFIX"){
    title = `${it.cases.length} case${it.cases.length>1?"s":""}: ${it.note}`;
    const id=`pf-${it.cases[0].uid}`;
    body = [ h("div",{class:"small muted",text:`Case IDs: ${it.cases.slice(0,8).map(x=>x.id).join(", ")}${it.cases.length>8?"…":""}`}),
      h("div",{class:"formrow"},
        h("button",{type:"button",class:"btn primary sm",onclick:()=>{ S.acceptedNB[it.key]=true; logAudit("Priority correction accepted", `${it.note} (${it.cases.length} cases)`); render(); }},"Accept"),
        h("label",{for:id,text:"or set all to"}), h("select",{id}, ALL_PRIOS.map(p=>h("option",{value:p,text:p}))),
        h("button",{type:"button",class:"btn sm",onclick:()=>{ const v=$("#"+id).value; it.cases.forEach(x=>{ S.edits[x.uid]={...(S.edits[x.uid]||{}),priority:v}; }); logAudit("Priority set", `${it.cases.length} cases → ${v} (${it.note})`); render(); toast(`Set ${it.cases.length} case${it.cases.length>1?"s":""} to ${v}`); }},"Apply")) ];
  } else if(it.type==="PRIO"){
    title = `Case ${c.id}: the priority score is blank or unreadable (${c.score ?? c.label ?? "blank"})`;
    const id=`pr-${c.uid}`;
    body = [ h("div",{class:"small muted",text:`${c.title} · created ${fmtLocal(c.ts.createdAt)}`}),
      h("div",{class:"formrow"}, h("label",{for:id,text:"Set priority"}), h("select",{id}, ALL_PRIOS.map(p=>h("option",{value:p,text:p}))),
        h("button",{type:"button",class:"btn primary sm",onclick:()=>{ const v=$("#"+id).value; S.edits[c.uid]={...(S.edits[c.uid]||{}),priority:v}; logAudit("Priority set", `Case ${c.id}: ${c.score ?? c.label} → ${v}`); render(); toast(`Case ${c.id} set to ${v}`); }},"Save")) ];
  } else if(it.type==="DUP"){
    title = `Case ID ${it.id} appears ${it.cases.length} times in ${it.cases[0].src}`;
    body = [ h("div",{class:"small muted",text:it.cases.map(x=>`${x.src} row ${x.row}: ${x.title}`).join(" | ")}),
      h("div",{class:"formrow"}, h("button",{type:"button",class:"btn primary sm",onclick:()=>{ it.cases.slice(1).forEach(x=>S.dropped[x.uid]=true); logAudit("Duplicate dropped", `Kept first row of case ${it.id}, dropped ${it.cases.length-1}`); render(); toast(`Kept one copy of case ${it.id}`); }},"Keep the first, drop the rest")) ];
  } else if(it.type==="CHRONO" || it.type==="NEG"){
    const field = it.type==="CHRONO" ? "assignedAt" : it.field;
    const ts = effective(c).ts;
    title = it.type==="CHRONO" ? `Case ${c.id}: closed before it was acknowledged` : `Case ${c.id}: ${field} is earlier than creation`;
    const id=`ts-${c.uid}-${field}`;
    const cur = ts[field]!=null ? new Date(ts[field]+S.tz*60000).toISOString().slice(0,16) : "";
    const metric = field==="assignedAt"?"TTA":field==="closedAt"?"TTR":field==="investigatedTill"?"TTI":"TTC";
    body = [ h("div",{class:"small muted num",text:`${c.title} · created ${fmtLocal(ts.createdAt)} · acknowledged ${fmtLocal(ts.assignedAt)} · closed ${fmtLocal(ts.closedAt)}`}),
      h("div",{class:"formrow"}, h("label",{for:id,text:`Correct ${field} (${S.tz?"IST":"UTC"})`}), h("input",{type:"datetime-local",id,value:cur}),
        h("button",{type:"button",class:"btn primary sm",onclick:()=>{ const v=$("#"+id).value; if(!v) return; const ms=Date.UTC(+v.slice(0,4),+v.slice(5,7)-1,+v.slice(8,10),+v.slice(11,13),+v.slice(14,16)) - S.tz*60000; const e=S.edits[c.uid]||{}; S.edits[c.uid]={...e, ts:{...(e.ts||{}), [field]:ms}}; logAudit("Timestamp corrected", `Case ${c.id} ${field}: ${fmtLocal(ts[field])} → ${fmtLocal(ms)}`); render(); }},"Save"),
        h("button",{type:"button",class:"btn sm",onclick:()=>{ S.voids[c.uid+":"+metric]="timestamps inconsistent"; logAudit("Metric voided", `Case ${c.id} ${metric} set to N/A (timestamps inconsistent)`); render(); }},`Mark ${metric} N/A`)) ];
  } else if(it.type==="TS"){
    title = `Case ${c.id}: ${it.field} can't be read as a date`;
    body = [ h("div",{class:"small muted",text:`Value in file: ${String(c.raw[it.field])}`}),
      h("div",{class:"formrow"}, h("button",{type:"button",class:"btn sm",onclick:()=>{ const e=S.edits[c.uid]||{}; S.edits[c.uid]={...e,ts:{...(e.ts||{}),[it.field]:null}}; logAudit("Timestamp cleared", `Case ${c.id} ${it.field}`); render(); }},"Treat as blank")) ];
  }
  const d = h("details",{class:"rv"+(resolved?" done":""), open: (!resolved && it.blocking) ? "" : null},
    h("summary",null, sevBar, chip, h("span",{class:"t",text:title})), h("div",{class:"body"},...body));
  return d;
}

/* ---------- Cases ---------- */
let caseFilter = {q:"", bucket:"", status:""};
function viewCases(main){
  main.append(pageHead("Cases", `Every case in ${A.label} with converted times, category and SLA status.`));
  const bks = Object.keys(A.bucket).sort();
  main.append(h("div",{class:"formrow"},
    h("input",{type:"search",id:"caseQ",placeholder:"Search title or ID",value:caseFilter.q,style:"min-width:240px",oninput:e=>{caseFilter.q=e.target.value; drawRows();}}),
    h("select",{id:"caseB","aria-label":"Bucket",onchange:e=>{caseFilter.bucket=e.target.value; drawRows();}}, h("option",{value:"",text:"All buckets"}), bks.map(b=>h("option",{value:b,selected:caseFilter.bucket===b?"":null,text:b}))),
    h("select",{id:"caseS","aria-label":"SLA status",onchange:e=>{caseFilter.status=e.target.value; drawRows();}}, [["","Any SLA status"],["NOT_MET","Any metric not met"],["PENDING","Any metric pending"],["ERROR","Any data error"]].map(([v,t])=>h("option",{value:v,selected:caseFilter.status===v?"":null,text:t})))
  ));
  const holder = h("div"); main.append(holder);
  const chipFor = r => { const m={MET:["good","Met"],NOT_MET:["bad","Not met"],PENDING:["warn","Pending"],NA:["neutral","N/A"],ERROR:["bad","Error"]}[r.s]; return withTip(h("span",{class:"chip "+m[0],text:m[1]}), [r.why || (r.el!=null?`Elapsed ${fmtDur(r.el)}`:m[1])]); };
  function drawRows(){
    const q = caseFilter.q.toLowerCase();
    const rows = A.cases.filter(c=>(!q || c.title.toLowerCase().includes(q) || c.id.includes(q)) && (!caseFilter.bucket || c.cat.bucket===caseFilter.bucket) && (!caseFilter.status || METRICS.some(m=>c._ev && c._ev[m.k].s===caseFilter.status)));
    const t = h("table",{class:"cases"}, h("thead",null,h("tr",null,["ID","Created (raw → local)","Title","Priority","Category / bucket","Rule",...METRICS.map(m=>m.k),"Disposition"].map(x=>h("th",{text:x})))));
    const tb = h("tbody");
    for(const c of rows.slice(0,250)){
      const ef = effective(c);
      tb.append(h("tr",null, h("td",{class:"num mono",text:c.id}),
        h("td",{class:"num"}, h("div",{class:"mono muted",text:String(c.raw.createdAt ?? "")}), h("div",{text:fmtLocal(ef.ts.createdAt)})),
        h("td",{class:"title",text:c.title}), h("td",{text:ef.priority||"?"}),
        h("td",null,h("div",{text:c.cat.category}),h("div",{class:"small muted",text:c.cat.bucket})),
        h("td",null,h("div",{class:"mono small",text:c.cat.ruleId}), c.cat.match?h("div",{class:"small muted mono",text:`“${c.cat.match}”`}):null),
        METRICS.map(m=>h("td",null, c._ev?chipFor(c._ev[m.k]):null)), h("td",{class:"small",text:c.disposition})));
    }
    t.append(tb);
    holder.replaceChildren(h("p",{class:"small muted",text:`Showing ${fmtInt(Math.min(250,rows.length))} of ${fmtInt(rows.length)} matching cases. The Excel download has all of them.`}), h("div",{class:"tbl-wrap"},t));
  }
  drawRows();
}

/* ---------- Settings (requirements 1, 4, 8) ---------- */
function viewSettings(main){
  main.append(pageHead("Settings", "Changes apply immediately to every view and export."));
  // SLA limits
  const t = h("table",{class:"slagrid"}, h("thead",null,h("tr",null,h("th",{text:"Priority"}), METRICS.map(m=>h("th",{text:`${m.k} limit`})))));
  const tb=h("tbody");
  for(const p of PRIOS){
    tb.append(h("tr",null, h("td",null,h("span",{class:"prio",style:`background:${PRIO_COLOR[p]}`}),h("b",{text:p})), METRICS.map(m=>{
      const [v,u]=S.limits[p][m.k]; const id=`lim-${p}-${m.k}`;
      const sec = h("span",{class:"sec num",text:`= ${fmtInt(limitSec(p,m.k))} seconds`});
      const upd = ()=>{ const nv=Number($("#"+id).value), nu=$("#"+id+"-u").value; if(!(nv>0) || nv*UNIT_SEC[nu] > 30*86400){ sec.textContent="Enter a value from 1 second to 30 days"; sec.style.color="var(--bad-ink)"; return; } S.limits[p][m.k]=[nv,nu]; sec.style.color=""; sec.textContent=`= ${fmtInt(limitSec(p,m.k))} seconds`; };
      return h("td",null, h("div",{class:"formrow",style:"gap:4px"},
        h("input",{type:"number",id,min:"0",step:"any",value:v,"aria-label":`${p} ${m.k} value`,oninput:upd,onchange:()=>{upd(); logAudit("SLA limit changed",`${p} ${m.k} = ${fmtLimit(p,m.k)}`); rerenderKeep();}}),
        h("select",{id:id+"-u","aria-label":`${p} ${m.k} unit`,onchange:()=>{upd(); logAudit("SLA limit changed",`${p} ${m.k} = ${fmtLimit(p,m.k)}`); rerenderKeep();}}, [["s","Seconds"],["min","Minutes"],["h","Hours"]].map(([k,l])=>h("option",{value:k,selected:u===k?"":null,text:l})))), sec);
    })));
  }
  tb.append(h("tr",null,h("td",null,h("span",{class:"prio",style:`background:${PRIO_COLOR.Informational}`}),h("b",{text:"Informational"})), h("td",{colspan:"4",class:"muted",text:"Excluded from SLA. Still counted in volume."})));
  t.append(tb);
  const warns = PRIOS.flatMap(p=>[limitSec(p,"TTA")>limitSec(p,"TTI")?`${p}: TTA limit is longer than TTI`:null, limitSec(p,"TTC")>limitSec(p,"TTR")?`${p}: TTC limit is longer than TTR`:null]).filter(Boolean);
  const ackRow = h("label",{class:"small",style:"display:flex;gap:8px;align-items:center;margin-top:10px"}, h("input",{type:"checkbox",id:"ackZero",checked:S.ackZero,onchange:e=>{ S.ackZero=e.target.checked; logAudit("Setting changed", S.ackZero?"Missing acknowledge time counts as 0 s (Met)":"Missing acknowledge time is N/A"); rerenderKeep(); }}), "When a case has no acknowledge time, count TTA as 0 seconds (Met). These cases are left out of the average time.");
  main.append(h("div",{class:"panel"}, h("h3",{text:"Which day does a case belong to?",style:"margin-bottom:8px"}),
    h("div",{class:"formrow"}, h("div",{class:"seg",role:"group","aria-label":"Period time zone"},
      [[0,"UTC (matches the export)"],[330,"IST"]].map(([v,l])=>h("button",{type:"button","aria-pressed":String(S.periodTz===v),onclick:()=>{ S.periodTz=v; logAudit("Setting changed",`Periods counted in ${v?"IST":"UTC"}`); rerenderKeep(); }},l))),
      h("span",{class:"small muted",text:"Daily, weekly and monthly totals are counted on this clock. With UTC, June 2026 in your test file is 3,195 cases (2,631 excluding Informational), the same as the source export and the July deck. The toolbar's IST/UTC switch only changes displayed times and heatmap hours."}))));
  main.append(h("div",{class:"panel"}, h("div",{class:"panel-head"},h("h3",{text:"SLA maximum limits"}),h("button",{type:"button",class:"btn sm",onclick:()=>{S.limits=clone(DEFAULT_LIMITS);S.targets=clone(DEFAULT_TARGETS);logAudit("SLA reset","Limits and targets restored to defaults");rerenderKeep();}},"Restore defaults")),
    h("div",{class:"tbl-wrap"},t), ackRow, warns.length?h("p",{class:"small",style:"color:var(--warn-ink);margin:8px 0 0",text:"Check: "+warns.join("; ")+". This is allowed but unusual."}):null));
  // Targets
  const tgtInput = (p,m) => h("input",{type:"number",min:"0",max:"100",step:"0.1",id:`tgt-${p}-${m.k}`,value:S.targets[p][m.k],"aria-label":`${p} ${m.k} target`,onchange:e=>{ const v=Number(e.target.value); if(v>=0&&v<=100){ S.targets[p][m.k]=Math.round(v*10)/10; logAudit("Target changed",`${p} ${m.k} = ${S.targets[p][m.k]}%`); rerenderKeep(); } else toast("Targets must be between 0 and 100."); }});
  const t2 = h("table",{class:"slagrid"},
    h("thead",null,h("tr",null,h("th",{text:"Priority"}), METRICS.map(m=>h("th",{text:`${m.k} target %`})))),
    h("tbody",null, PRIOS.map(p=>h("tr",null, h("td",null,h("b",{text:p})), METRICS.map(m=>h("td",null,tgtInput(p,m)))))));
  main.append(h("div",{class:"panel"}, h("h3",{text:"Compliance targets",style:"margin-bottom:10px"}), h("div",{class:"tbl-wrap"},t2)));
  // Report text
  const f = (k,label,ph,multi) => h("div",{style:"display:flex;flex-direction:column;gap:4px"}, h("label",{for:"rep-"+k,class:"small muted",text:label}), multi? h("textarea",{id:"rep-"+k,rows:"2",placeholder:ph,oninput:e=>{S.report[k]=e.target.value;}},S.report[k]) : h("input",{type:"text",id:"rep-"+k,value:S.report[k],placeholder:ph,oninput:e=>{S.report[k]=e.target.value;},onchange:()=>rerenderKeep()}));
  main.append(h("div",{class:"panel"}, h("div",{class:"panel-head"},h("h3",{text:"Report text for the PowerPoint"}),h("span",{class:"small muted",text:"Leave blank to use generated text."})),
    h("div",{class:"grid2",style:"gap:12px"}, f("client","Client name","Contoso"), f("source","Case source label","Google SecOps"),
      f("slaTakeaway","SLA slide: Key Takeaway",defaultText().slaTakeaway,true), f("slaNext","SLA slide: Next Step",defaultText().slaNext,true),
      f("sevTakeaway","Severity slide: Key Takeaway",defaultText().sevTakeaway,true), f("sevNext","Severity slide: Next Step",defaultText().sevNext,true))));
  // Rules
  main.append(rulesPanel());
}
function rerenderKeep(){ const y=window.scrollY; render(); window.scrollTo(0,y); }
function rulesPanel(){
  const counts = dict(); for(const c of A.cases) counts[c.cat.ruleId]=(counts[c.cat.ruleId]||0)+1;
  const out = h("div",{class:"tester-out",role:"status",text:"Paste an alert title to see which rule fires."});
  const run = v => {
    if(!v.trim()){ out.textContent="Paste an alert title to see which rule fires."; return; }
    const n=normTitle(v), r=classifyNorm(n,S.compiled);
    out.replaceChildren(h("div",null,h("b",{text:r.category}),` · bucket ${r.bucket} · rule `,h("span",{class:"mono",text:r.ruleId})), h("div",{class:"small muted mono",text:`normalized: “${n}”${r.match?`  matched: “${r.match}”`:""}`}));
  };
  const tester = h("div",{class:"tester"}, h("label",{for:"ruleTest",class:"small muted",text:"Test a title"}), h("input",{type:"text",id:"ruleTest",placeholder:"e.g. HD011_ProofPoint_TAP_threat_email_delivered",oninput:e=>run(e.target.value)}), out);
  const err = h("span",{class:"small",style:"color:var(--bad-ink)"});
  const add = h("div",{class:"formrow"},
    h("input",{type:"text",id:"nrCat",placeholder:"Category",style:"width:150px","aria-label":"New rule category",list:"catList"}),
    h("select",{id:"nrBkt","aria-label":"New rule bucket"}, allBuckets().map(b=>h("option",{value:b,text:b}))),
    h("input",{type:"text",id:"nrPat",class:"mono",placeholder:"\\bsentinelone\\b",style:"flex:1;min-width:200px","aria-label":"New rule pattern"}),
    h("button",{type:"button",class:"btn primary sm",onclick:()=>{ const cat=$("#nrCat").value.trim(), p=$("#nrPat").value.trim(); if(!cat){err.textContent="Enter a category.";return;} const e=checkPattern(p); if(e){err.textContent=e;return;}
      S.rules.push({precedence:270,rule_id:"CAT-USER-"+String(S.rules.filter(r=>r.rule_id.startsWith("CAT-USER")).length+1).padStart(2,"0"),category:cat,subcategory:"User rule",report_bucket:$("#nrBkt").value,pattern:p,enabled:true});
      logAudit("Rule added",`${cat}: ${p}`); classifyAll(); rerenderKeep(); toast("Rule added"); }},"Add rule"), err);
  const t = h("table",{class:"rules"}, h("thead",null,h("tr",null,["On","Order","Rule","Category / sub-category","Bucket","Pattern","Cases"].map(x=>h("th",{text:x})))));
  const tb=h("tbody");
  for(const r of S.rules.slice().sort((a,b)=>a.precedence-b.precedence)){
    tb.append(h("tr",null, h("td",null,h("input",{type:"checkbox",id:"en-"+r.rule_id,"aria-label":`Enable ${r.rule_id}`,checked:r.enabled!==false,onchange:e=>{r.enabled=e.target.checked; logAudit(r.enabled?"Rule enabled":"Rule disabled", r.rule_id); classifyAll(); rerenderKeep();}})),
      h("td",{class:"num",text:r.precedence}), h("td",{class:"mono",text:r.rule_id}), h("td",null,h("div",{text:r.category}),h("div",{class:"small muted",text:r.subcategory})), h("td",{text:r.report_bucket}), h("td",{class:"pat",text:r.pattern}), h("td",{class:"r num",text:fmtInt(counts[r.rule_id]||0)})));
  }
  tb.append(h("tr",null,h("td"),h("td",{class:"num",text:"999"}),h("td",{class:"mono",text:"CAT-FALLBACK"}),h("td",{text:"Uncategorized"}),h("td",{text:"Uncategorized"}),h("td",{class:"pat muted",text:"No rule matched: goes to Review"}),h("td",{class:"r num",text:fmtInt(counts["CAT-FALLBACK"]||0)})));
  t.append(tb);
  return h("div",{class:"panel"}, h("div",{class:"panel-head"},h("h3",{text:"Category rules"}),h("span",{class:"small muted",text:"Titles are normalized first (invisible characters removed, lowercase, separators become spaces). The first matching rule wins."})),
    h("div",{class:"grid2",style:"margin-bottom:14px"}, tester, h("div",{class:"tester"},h("span",{class:"small muted",text:"Add a rule"}),add)),
    h("div",{class:"tbl-wrap"},t));
}
function defaultText(){
  const bad = []; for(const p of PRIOS) for(const {k} of METRICS){ const c=A.sla[p][k]; if(c.status==="bad") bad.push(`${p} ${k}`); }
  const d = P.total ? A.total-P.total : null;
  const newB = Object.keys(A.bucket).filter(k=>!(P.bucket[k]>0) && P.total);
  return {
    slaTakeaway: bad.length ? `SLA targets were missed for ${bad.join(", ")}; all other targets were met.` : "All SLA compliance targets were met for evaluable cases.",
    slaNext: bad.length ? `Review the breaching cases for ${bad.slice(0,2).join(" and ")} and adjust triage priorities or staffing.` : "Keep monitoring SLA performance and fine-tune new detections to control alert volume.",
    sevTakeaway: d==null ? `${fmtInt(A.total)} cases were generated this period.` : `Case volume ${d>=0?"rose":"fell"} by ${fmtInt(Math.abs(d))}${newB.length?`, driven by new detection sources (${newB.join(", ")})`:""}.`,
    sevNext: "Continue rule tuning and filtering to reduce noise while maintaining detection coverage.",
    catTakeaway: ""
  };
}

/* ============================================================
   SOC-RAP MVP · data loading, file safety checks, exports, boot
   ============================================================ */
const MAX_BYTES = 50*1024*1024, MAX_UNZIPPED = 500*1024*1024, MAX_RATIO = 100, MAX_ENTRIES = 1000, MAX_ROWS = 500000;
let pending = null; // {name, sha, sheets, sheetIdx, headers, rows, map}

/* ---------- Libraries: pinned versions, loaded only when needed ---------- */
const LIBS = {
  // One pinned file with Subresource Integrity: the browser refuses to run it if a single byte differs.
  PptxGenJS: [{src:"vendor/pptxgen.bundle.js", integrity:"sha384-qb0Xhi7LLYpvW1HCK6oMrmDLSY9sy7vwm6ZlV6KjtrlL9yg30+YN4neTwnmX+Kp8"}]
};
function loadScript({src, integrity}){ return new Promise((res,rej)=>{ const el=document.createElement("script"); el.integrity=integrity; el.src=src; el.crossOrigin="anonymous"; el.referrerPolicy="no-referrer"; el.onload=res; el.onerror=()=>{el.remove();rej(new Error("load failed"));}; document.head.append(el); }); }
async function needLib(name){
  if(window[name]) return window[name];
  for(const u of LIBS[name]){ try{ await loadScript(u); if(window[name]) return window[name]; }catch(e){} }
  throw new Error(`Couldn't load the ${name} library. Check your connection and try again.`);
}

/* ---------- File safety (spec §12.3) ---------- */
function inspectZip(buf){
  const dv = new DataView(buf);
  if(buf.byteLength<22 || dv.getUint32(0,true)!==0x04034b50) throw new Error("This isn't a valid .xlsx workbook.");
  let eocd=-1; for(let i=buf.byteLength-22;i>=Math.max(0,buf.byteLength-65557);i--){ if(dv.getUint32(i,true)===0x06054b50){eocd=i;break;} }
  if(eocd<0) throw new Error("The workbook is damaged (no zip directory).");
  const n=dv.getUint16(eocd+10,true), cdOff=dv.getUint32(eocd+16,true);
  if(n>MAX_ENTRIES) throw new Error(`The workbook has ${n} internal parts. The limit is ${MAX_ENTRIES}.`);
  let p=cdOff, total=0; const names=[];
  const dec = new TextDecoder();
  for(let k=0;k<n;k++){
    if(p+46>buf.byteLength || dv.getUint32(p,true)!==0x02014b50) throw new Error("The workbook is damaged.");
    total += dv.getUint32(p+24,true);
    const nl=dv.getUint16(p+28,true), el=dv.getUint16(p+30,true), cl=dv.getUint16(p+32,true);
    names.push(dec.decode(new Uint8Array(buf,p+46,nl))); p+=46+nl+el+cl;
  }
  if(total>MAX_UNZIPPED || total/buf.byteLength>MAX_RATIO) throw new Error("The workbook expands to an unsafe size (possible zip bomb). It was not opened.");
  if(names.some(x=>/vbaProject\.bin$/i.test(x)||/(^|\/)activeX\//i.test(x))) throw new Error("The workbook contains macros or ActiveX controls. Save it as a plain .xlsx without macros and upload again.");
  if(names.some(x=>x.startsWith("/")||x.split("/").includes(".."))) throw new Error("The workbook has unsafe internal paths. It was not opened.");
}
async function sha256(buf){ if(!(window.crypto && crypto.subtle)) return "unavailable-in-this-context"; const d=await crypto.subtle.digest("SHA-256",buf); return [...new Uint8Array(d)].map(b=>b.toString(16).padStart(2,"0")).join(""); }
function parseCsv(text){
  const rows=[]; let row=[], f="", q=false;
  for(let i=0;i<text.length;i++){
    const ch=text[i];
    if(q){ if(ch==='"'){ if(text[i+1]==='"'){f+='"';i++;} else q=false; } else f+=ch; continue; }
    if(ch==='"') q=true; else if(ch===','){ row.push(f); f=""; } else if(ch==='\n'||ch==='\r'){ if(ch==='\r'&&text[i+1]==='\n') i++; row.push(f); rows.push(row); row=[]; f=""; if(rows.length>MAX_ROWS+1) break; } else f+=ch;
    if(f.length>32768) throw new Error("A CSV field is longer than 32 KB. Check the file.");
  }
  if(f!==""||row.length){ row.push(f); rows.push(row); }
  return rows.filter(r=>r.some(x=>x!==""));
}
function cellVal(v){
  if(v===null||v===undefined) return null;
  if(v instanceof Date) return v;
  if(typeof v==="object"){
    if("result" in v) return cellVal(v.result);
    if(Array.isArray(v.richText)) return v.richText.map(t=>t.text).join("");
    if("text" in v) return String(v.text);
    if("error" in v) return null;
    return null;
  }
  return v;
}
function scoreHeaders(headers){ const keys=new Set(headers.map(hkey)); return FIELDS.reduce((a,f)=>a+(f.syn.some(s=>keys.has(s))?1:0),0); }
async function readFile(file){
  const name = file.name;
  if(!/\.(xlsx|csv)$/i.test(name)) throw new Error(`“${name}” isn't supported. Upload a .xlsx or .csv export. Macro-enabled (.xlsm) and legacy .xls files are refused.`);
  if(file.size>MAX_BYTES) throw new Error(`“${name}” is ${(file.size/1048576).toFixed(1)} MB. The limit is 50 MB.`);
  const buf = await file.arrayBuffer();
  const sha = await sha256(buf);
  let sheets = [];
  if(/\.csv$/i.test(name)){
    let text = new TextDecoder("utf-8").decode(buf).replace(/^﻿/,"");
    const rows = parseCsv(text); if(rows.length<2) throw new Error("The CSV has no data rows.");
    if(rows[0].length>200) throw new Error("The CSV has more than 200 columns. Remove unused columns and try again.");
    const headers = rows[0].map((x,i)=>cleanText(x,200).trim()||`Column ${i+1}`);
    sheets = [{name:"CSV", headers, rows: rows.slice(1,MAX_ROWS+1).map(r=>Object.fromEntries(headers.map((h,i)=>[h, r[i]===undefined||r[i]===""?null:r[i]])))}];
  } else {
    inspectZip(buf);
    const raw = await XL.read(buf);
    for(const ws of raw){
      if(ws.rows.length<2) continue;
      let best={score:-1,row:0,headers:[]};
      for(let r=0;r<Math.min(5,ws.rows.length);r++){
        const hs = Array.from(ws.rows[r]||[], (v,i)=>v==null||v===""?`Column ${i+1}`:cleanText(v,200).trim()).slice(0,200);
        const sc = scoreHeaders(hs); if(sc>best.score) best={score:sc,row:r,headers:hs};
      }
      const rows=[];
      for(let r=best.row+1; r<ws.rows.length && rows.length<MAX_ROWS; r++){
        const v=ws.rows[r]||[]; const o=Object.create(null); best.headers.forEach((h,i)=>{ o[h]= v[i]===undefined||v[i]===""?null:v[i]; });
        if(Object.values(o).some(x=>x!==null)) rows.push(o);
      }
      sheets.push({name:ws.name, headers:best.headers, rows, score:best.score});
    }
    if(!sheets.length) throw new Error("No sheet with data was found in the workbook.");
  }
  let idx = 0; sheets.forEach((s,i)=>{ if((s.score??0)>(sheets[idx].score??0)) idx=i; });
  const sh = sheets[idx];
  return {name, size:file.size, sha, sheets, sheetIdx:idx, headers:sh.headers, rows:sh.rows, map:autoMap(sh.headers, sh.rows)};
}

/* ---------- Sample data ---------- */
function loadSample(){
  const raw = JSON.parse(document.getElementById("sample-data").textContent);
  const D = raw.dicts, K = raw.keys;
  const rows = raw.rows.map(a=>{
    const o=Object.create(null); K.forEach((k,i)=>{ let v=a[i];
      if(D[k]) v = v<0 ? null : D[k][v];
      else if(k==="isCaseClosed") v = !!v;
      else if(["assignedAt","investigatedTill","containmentAt","closedAt"].includes(k) && v!=null) v = a[K.indexOf("createdAt")] + v;
      o[k]=v; }); return o;
  });
  const headers = K.slice();
  const map = autoMap(headers, rows);
  S.cases = buildCases(rows, map, S.tz, "Sample");
  S.sources = [{name:"Sample: June 2026 test data (3,195 cases) + synthetic May 2026", rows:rows.length, sha:"built-in", sheet:"—"}];
  S.isSample = true; S.saved=false; S.edits={}; S.voids={}; S.dropped={}; S.catOverride={}; S.acceptedNB={}; S.audit=[];
  S.report = {client:DEMO_NAME, source:"Google SecOps", slaTakeaway:"", slaNext:"", sevTakeaway:"", sevNext:"", catTakeaway:""};
  S.limits = clone(DEFAULT_LIMITS); S.targets = clone(DEFAULT_TARGETS); S.rules = seedRules(); S.retainMonths=3; S.periodTz=0; S.ackZero=true; S.nextUid=0;
  prepareAll(); setDefaultPeriod();
}
function setDefaultPeriod(){
  // Default to the latest month that has a real share of cases (ignores a few spill-over cases at an export's edge).
  const cnt = monthCounts(), months = Object.keys(cnt).sort();
  const max = Math.max(0,...Object.values(cnt));
  const ym = months.filter(m=>cnt[m] >= max*0.2).pop() || new Date().toISOString().slice(0,7);
  S.cadence="monthly"; const [a,b]=monthBounds(ym); S.start=a; S.end=b;
}
function monthCounts(){ const cnt=dict(); for(const c of S.cases){ const t=c.ts.createdAt; if(t && !isNaN(t)){ const m=msToYmd(t).slice(0,7); cnt[m]=(cnt[m]||0)+1; } } return cnt; }

/* ---------- Saved history (this browser only, IndexedDB) ---------- */
const Store = (()=>{
  const DB="socrap-history";
  const open = () => new Promise((res,rej)=>{ let r; try{ r=indexedDB.open(DB,1); }catch(e){ return rej(e); } r.onupgradeneeded=()=>r.result.createObjectStore("kv"); r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error); });
  const run = async (mode, fn) => { const db=await open(); return new Promise((res,rej)=>{ const tx=db.transaction("kv",mode); const out=fn(tx.objectStore("kv")); tx.oncomplete=()=>{ db.close(); res(out && out.result); }; tx.onerror=tx.onabort=()=>{ db.close(); rej(tx.error); }; }); };
  return { get:k=>run("readonly",s=>s.get(k)), put:(k,v)=>run("readwrite",s=>s.put(v,k)), del:k=>run("readwrite",s=>s.delete(k)) };
})();
const CASE_FIELDS = ["uid","src","row","id","title","description","score","label","stage","disposition","closeReason","rootCause","assignee","isClosedFlag","supplied","raw","ts"];
function applyRetention(){
  const months = Object.keys(monthCounts()).sort();
  if(months.length <= S.retainMonths) return 0;
  const keep = new Set(months.slice(-S.retainMonths));
  const before = S.cases.length;
  S.cases = S.cases.filter(c=>{ const t=c.ts.createdAt; return !(t && !isNaN(t)) || keep.has(msToYmd(t).slice(0,7)); });
  const removed = before - S.cases.length;
  if(removed) logAudit("History trimmed", `Kept the latest ${S.retainMonths} months; removed ${fmtInt(removed)} older cases`);
  syncSources(); return removed;
}
function syncSources(){ const n=dict(); S.cases.forEach(c=>n[c.src]=(n[c.src]||0)+1); S.sources = S.sources.filter(s=>n[s.name]).map(s=>({...s, rows:n[s.name]})); }
/* ---------- Client workspaces: each client's data, settings and review history are saved under its own key ---------- */
const DEMO_ID = "demo", DEMO_NAME = "Contoso (Demo)";
const seedRules = () => JSON.parse(document.getElementById("rules-data").textContent).rules.map(r=>({...r,enabled:true}));
const clientName = id => id===DEMO_ID ? DEMO_NAME : (S.clients.find(c=>c.id===id)||{}).name || "Client";
function blankWorkspace(name){
  return {v:2, cases:[], sources:[], retainMonths:3, periodTz:0, tz:330, ackZero:true, limits:clone(DEFAULT_LIMITS), targets:clone(DEFAULT_TARGETS),
    userRules:[], ruleOff:[], edits:{}, voids:{}, dropped:{}, catOverride:{}, acceptedNB:{}, audit:[],
    report:{client:name, source:"Google SecOps", slaTakeaway:"", slaNext:"", sevTakeaway:"", sevNext:"", catTakeaway:""}};
}
function snapshot(){
  return {v:2, savedAt:new Date().toISOString(), cases:S.cases.map(c=>Object.fromEntries(CASE_FIELDS.map(k=>[k,c[k]]))), sources:S.sources,
    retainMonths:S.retainMonths, periodTz:S.periodTz, tz:S.tz, ackZero:S.ackZero, limits:S.limits, targets:S.targets,
    userRules:S.rules.filter(r=>r.rule_id.startsWith("CAT-USER")), ruleOff:S.rules.filter(r=>r.enabled===false).map(r=>r.rule_id),
    edits:S.edits, voids:S.voids, dropped:S.dropped, catOverride:S.catOverride, acceptedNB:S.acceptedNB, audit:S.audit.slice(0,500), report:S.report,
    cadence:S.cadence, start:S.start, end:S.end};
}
// Stored workspaces are validated field by field before use; anything malformed falls back to defaults.
function sanitizeWorkspace(ws, name){
  const b = blankWorkspace(name); if(!ws || typeof ws!=="object") return b;
  const obj = v => v && typeof v==="object" && !Array.isArray(v) ? v : null;
  const out = {...b};
  out.cases = Array.isArray(ws.cases) ? ws.cases.filter(c=>obj(c) && obj(c.ts) && typeof c.title==="string") : [];
  out.sources = Array.isArray(ws.sources) ? ws.sources.filter(s=>obj(s) && typeof s.name==="string").map(s=>({name:cleanText(s.name,300), rows:+s.rows||0, sha:cleanText(s.sha,80), sheet:cleanText(s.sheet,100)})) : [];
  out.retainMonths = [3,6,12].includes(ws.retainMonths) ? ws.retainMonths : 3;
  out.periodTz = [0,330].includes(ws.periodTz) ? ws.periodTz : 0;
  out.tz = [0,330].includes(ws.tz) ? ws.tz : 330;
  out.ackZero = ws.ackZero!==false;
  const lim = obj(ws.limits), tgt = obj(ws.targets);
  for(const p of PRIOS) for(const {k} of METRICS){
    const v = lim && lim[p] && lim[p][k];
    if(Array.isArray(v) && UNIT_SEC[v[1]] && Number(v[0])>0 && Number(v[0])*UNIT_SEC[v[1]]<=30*86400) out.limits[p][k]=[Number(v[0]), v[1]];
    const t = tgt && tgt[p] ? Number(tgt[p][k]) : NaN; if(t>=0 && t<=100) out.targets[p][k]=t;
  }
  out.userRules = Array.isArray(ws.userRules) ? ws.userRules.filter(r=>obj(r) && /^CAT-USER-\d+$/.test(r.rule_id) && !checkPattern(r.pattern))
    .map(r=>({precedence:Number(r.precedence)||270, rule_id:r.rule_id, category:cleanText(r.category,100), subcategory:cleanText(r.subcategory,100), report_bucket:cleanText(r.report_bucket,100), pattern:r.pattern, enabled:r.enabled!==false})) : [];
  out.ruleOff = Array.isArray(ws.ruleOff) ? ws.ruleOff.filter(x=>typeof x==="string") : [];
  for(const k of ["edits","voids","dropped","catOverride","acceptedNB"]) out[k] = obj(ws[k]) ? ws[k] : {};
  out.audit = Array.isArray(ws.audit) ? ws.audit.filter(obj).slice(0,500).map(a=>({at:cleanText(a.at,40), action:cleanText(a.action,100), detail:cleanText(a.detail,1000)})) : [];
  const rep = obj(ws.report) || {}; for(const k of Object.keys(b.report)) if(typeof rep[k]==="string") out.report[k]=cleanText(rep[k],2000);
  if(["daily","weekly","monthly","custom"].includes(ws.cadence) && /^\d{4}-\d{2}-\d{2}$/.test(ws.start||"") && /^\d{4}-\d{2}-\d{2}$/.test(ws.end||"")){ out.cadence=ws.cadence; out.start=ws.start; out.end=ws.end; }
  return out;
}
function applyWorkspace(ws, name){
  ws = sanitizeWorkspace(ws, name); ws.report = {...ws.report, client:name};
  S.cases = (ws.cases||[]).map(c=>({...c})); S.sources = ws.sources||[];
  S.retainMonths=ws.retainMonths; S.periodTz=ws.periodTz; S.tz=ws.tz; S.ackZero=ws.ackZero;
  S.limits=clone(ws.limits); S.targets=clone(ws.targets);
  const off = new Set(ws.ruleOff||[]); S.rules = seedRules().concat(clone(ws.userRules||[])).map(r=>({...r, enabled:!off.has(r.rule_id)}));
  S.edits=ws.edits||{}; S.voids=ws.voids||{}; S.dropped=ws.dropped||{}; S.catOverride=ws.catOverride||{}; S.acceptedNB=ws.acceptedNB||{}; S.audit=ws.audit||[];
  S.report = ws.report; S.isSample=false; S.saved=true;
  S.nextUid = Math.max(0, ...S.cases.map(c=>Number.isInteger(c.uid)?c.uid+1:0));
  prepareAll();
  if(S.cases.length && ws.start && ws.end && ws.cadence){ S.cadence=ws.cadence; S.start=ws.start; S.end=ws.end; } else setDefaultPeriod();
}
async function saveNow(){
  if(!S.clientId || S.clientId===DEMO_ID) return;
  try{ await Store.put("client:"+S.clientId, snapshot()); await Store.put("clients", S.clients); await Store.put("active", S.clientId); S.saved=true; }
  catch(e){ S.saved=false; toast("This browser wouldn't save the data, so it will be kept for this session only."); }
}
let saveTimer = null;
function scheduleSave(){ if(S.clientId===DEMO_ID) return; clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 700); }
async function switchClient(id){
  if(id===S.clientId) return;
  clearTimeout(saveTimer); await saveNow();
  pending = null; clearArmed = false; S.newClientOpen = false;
  if(id===DEMO_ID){ loadSample(); S.clientId = DEMO_ID; try{ await Store.put("active", DEMO_ID); }catch(e){} }
  else {
    let ws = null; try{ ws = await Store.get("client:"+id); }catch(e){}
    applyWorkspace(ws || blankWorkspace(clientName(id)), clientName(id)); S.clientId = id; try{ await Store.put("active", id); }catch(e){}
  }
  S.tab = S.cases.length ? (S.tab==="data"?"overview":S.tab) : "data";
  render(); toast(`Switched to ${clientName(id)}`);
}
function validClientName(name, exceptId){
  const n = cleanText(name,200).trim();
  if(!n) return "Enter a client name.";
  if(n.length>60) return "Keep the name under 60 characters.";
  if(n.toLowerCase()===DEMO_NAME.toLowerCase() || S.clients.some(c=>c.id!==exceptId && c.name.toLowerCase()===n.toLowerCase())) return "A client with that name already exists.";
  return null;
}
async function createClient(name){
  const err = validClientName(name); if(err){ toast(err); return false; }
  clearTimeout(saveTimer); await saveNow();
  const id = "c_" + Date.now().toString(36) + Math.random().toString(36).slice(2,6);
  name = cleanText(name,60).trim();
  S.clients.push({id, name, created:new Date().toISOString()});
  applyWorkspace(blankWorkspace(name), name); S.clientId = id; S.newClientOpen=false;
  logAudit("Client created", name.trim());
  await saveNow(); return true;
}
async function renameClient(name){
  const err = validClientName(name, S.clientId); if(err){ toast(err); return; }
  const c = S.clients.find(x=>x.id===S.clientId); const old=c.name; c.name = cleanText(name,60).trim(); S.report.client = c.name;
  logAudit("Client renamed", `${old} → ${c.name}`); await saveNow(); render(); toast("Client renamed");
}
async function deleteClient(){
  const id = S.clientId, name = clientName(id);
  try{ await Store.del("client:"+id); }catch(e){}
  S.clients = S.clients.filter(c=>c.id!==id); try{ await Store.put("clients", S.clients); }catch(e){}
  S.clientId = null; await switchClient(S.clients[0] ? S.clients[0].id : DEMO_ID);
  toast(`Deleted ${name} and all of its saved data`);
}
async function initClients(){
  try{
    const cl = await Store.get("clients");
    S.clients = Array.isArray(cl) ? cl.filter(c=>c && typeof c.id==="string" && /^c_[a-z0-9_]+$/.test(c.id) && typeof c.name==="string").map(c=>({id:c.id, name:cleanText(c.name,60), created:cleanText(c.created,40)})) : [];
    if(!S.clients.length){
      // One-time move of data saved by the earlier single-client version.
      const old = await Store.get("history");
      if(old && Array.isArray(old.cases) && old.cases.length){
        const id="c_migrated"; S.clients=[{id, name:"My client", created:new Date().toISOString()}];
        await Store.put("client:"+id, {...blankWorkspace("My client"), cases:old.cases, sources:old.sources||[], retainMonths:old.retainMonths||3, periodTz:old.periodTz??0});
        await Store.put("clients", S.clients); await Store.put("active", id); await Store.del("history");
      }
    }
    const active = await Store.get("active");
    if(active && active!==DEMO_ID && S.clients.some(c=>c.id===active)){ S.clientId = DEMO_ID; await switchClient(active); return true; }
  }catch(e){}
  render(); return false;
}
function clientSwitcher(){
  const box = h("div",{class:"client-box"});
  const sel = h("select",{id:"clientSel","aria-label":"Client",onchange:e=>switchClient(e.target.value)},
    S.clients.slice().sort((a,b)=>a.name.localeCompare(b.name)).map(c=>h("option",{value:c.id,selected:c.id===S.clientId?"":null,text:c.name})),
    h("option",{value:DEMO_ID,selected:S.clientId===DEMO_ID?"":null,text:`${DEMO_NAME} · sample`}));
  box.append(h("label",{for:"clientSel",class:"eyebrow",style:"color:inherit;opacity:.8",text:"Client"}), sel);
  if(S.newClientOpen){
    const inp = h("input",{type:"text",id:"newClientName",placeholder:"Client name",maxlength:"60","aria-label":"New client name",onkeydown:e=>{ if(e.key==="Enter") go(); if(e.key==="Escape"){ S.newClientOpen=false; render(); } }});
    const go = async()=>{ if(await createClient(inp.value)){ S.tab="data"; render(); toast(`Created ${inp.value.trim()}. Upload its first export.`); } };
    box.append(inp, h("button",{type:"button",class:"btn sm primary",onclick:go},"Create"), h("button",{type:"button",class:"btn sm",onclick:()=>{S.newClientOpen=false; render();}},"Cancel"));
    setTimeout(()=>inp.focus(),0);
  } else box.append(h("button",{type:"button",class:"btn sm",onclick:()=>{S.newClientOpen=true; render();}},"+ New client"));
  return box;
}
function clientPanel(){
  if(S.clientId===DEMO_ID) return h("div",{class:"callout info"}, h("span",{text:`You're viewing the demo client. Create a client with “+ New client” at the top, or upload a file below and name the client when asked. Each client keeps its own data, history, settings and review fixes.`}));
  const inp = h("input",{type:"text",id:"renameClient",value:clientName(S.clientId),maxlength:"60",style:"width:240px","aria-label":"Client name"});
  return h("div",{class:"panel"},
    h("div",{class:"panel-head"}, h("h3",{text:`Client: ${clientName(S.clientId)}`}), h("span",{class:"small muted",text:"This client's data, months, SLA settings, rules and review fixes are stored separately from every other client."})),
    h("div",{class:"formrow"}, inp, h("button",{type:"button",class:"btn sm",onclick:()=>renameClient(inp.value)},"Rename"),
      h("button",{type:"button",class:"btn sm",style:delArmed?"border-color:var(--bad-ink);color:var(--bad-ink)":null,onclick:async()=>{
        if(!delArmed){ delArmed=true; render(); setTimeout(()=>{ if(delArmed){ delArmed=false; render(); } },5000); return; }
        delArmed=false; await deleteClient(); }}, delArmed ? `Click again to delete ${clientName(S.clientId)} and all its data` : "Delete client")));
}
let delArmed = false;

/* ---------- Data view ---------- */
function viewData(main){
  main.append(pageHead("Data", `Load ${S.clientId===DEMO_ID?"a client's":clientName(S.clientId)+"'s"} case export. Files are read in this browser tab only and are never uploaded anywhere.`));
  main.append(clientPanel());
  const fileIn = h("input",{type:"file",id:"fileIn",accept:".xlsx,.csv",multiple:true,style:"display:none",onchange:e=>handleFiles(e.target.files)});
  const drop = h("div",{class:"drop",id:"drop"},
    h("b",{text:"Drop the case export here"}), h("span",{class:"small muted",text:".xlsx or .csv, up to 50 MB. Add a second file for the previous period to enable comparison."}),
    h("div",{class:"formrow",style:"justify-content:center"}, h("button",{type:"button",class:"btn primary",onclick:()=>fileIn.click()},"Choose files"), S.isSample ? h("button",{type:"button",class:"btn",onclick:()=>{ loadSample(); pending=null; S.tab="overview"; render(); toast("Sample data reset"); }},"Reset sample data") : null),
    h("span",{class:"small muted",text: S.isSample ? "Uploading here creates a new client for the file (you'll name it next). Later uploads for that client are added to its months." : `New files are added to ${clientName(S.clientId)}'s months. The same case ID in two files keeps the newer copy.`}),
    h("label",{class:"small",style:"display:flex;gap:6px;align-items:center"}, h("input",{type:"checkbox",id:"replaceMode"}), "Start fresh: remove the months already loaded"), fileIn);
  drop.addEventListener("dragover",e=>{e.preventDefault(); drop.classList.add("over");});
  drop.addEventListener("dragleave",()=>drop.classList.remove("over"));
  drop.addEventListener("drop",e=>{e.preventDefault(); drop.classList.remove("over"); handleFiles(e.dataTransfer.files);});
  main.append(h("div",{class:"panel"},drop));
  if(pending) main.append(mappingPanel());
  const t = h("table",null,h("thead",null,h("tr",null,["Source","Sheet","Rows","SHA-256"].map(x=>h("th",{text:x})))), h("tbody",null,S.sources.map(s=>h("tr",null,h("td",{text:s.name}),h("td",{text:s.sheet}),h("td",{class:"num",text:fmtInt(s.rows)}),h("td",{class:"mono small",text:s.sha==="built-in"?"built-in":s.sha.slice(0,16)+"…"})))));
  main.append(historyPanel());
  main.append(h("div",{class:"panel"},h("h3",{text:"Loaded files",style:"margin-bottom:10px"}),h("div",{class:"tbl-wrap"},t)));
  main.append(h("div",{class:"panel"},h("h3",{text:"How files are handled"}), h("ul",{class:"obs small",style:"margin-top:8px"},
    h("li",{text:"Only .xlsx and .csv are accepted. Macro-enabled workbooks, ActiveX content and oversized or zip-bomb files are refused before parsing."}),
    h("li",{text:"Epoch timestamps (seconds, milliseconds, microseconds), Excel dates and ISO-8601 text are detected per column and converted. Times are stored in UTC and shown in the time zone you pick."}),
    h("li",{text:"Text from the file is always displayed as plain text. Cells starting with =, +, -, @ are neutralized in the Excel download so they can't run as formulas."}),
    h("li",{text:"Uploaded months are saved in this browser only (never on a server), so they're still here next time you open the app. Clearing your browser's site data removes them; you can also clear them above."}))));
}
let clearArmed = false;
function historyPanel(){
  const cnt = monthCounts(), months = Object.keys(cnt).sort().reverse();
  const nonInfo = m => S.cases.filter(c=>c.ts.createdAt && msToYmd(c.ts.createdAt).startsWith(m) && c.priority && c.priority!=="Informational").length;
  const files = m => [...new Set(S.cases.filter(c=>c.ts.createdAt && msToYmd(c.ts.createdAt).startsWith(m)).map(c=>c.src))].join(", ");
  const t = h("table",null, h("thead",null,h("tr",null,["Month","Cases","Excl. Informational","From file",""].map(x=>h("th",{text:x})))),
    h("tbody",null, months.map(m=>{ const [y,mo]=m.split("-").map(Number); return h("tr",null, h("td",{text:`${MONTH_FULL[mo-1]} ${y}`}), h("td",{class:"num",text:fmtInt(cnt[m])}), h("td",{class:"num",text:fmtInt(nonInfo(m))}), h("td",{class:"small",text:files(m)}),
      h("td",null, S.isSample?null:h("button",{type:"button",class:"btn sm",onclick:async()=>{ S.cases=S.cases.filter(c=>!(c.ts.createdAt && msToYmd(c.ts.createdAt).startsWith(m))); syncSources(); logAudit("Month removed",`${MONTH_FULL[mo-1]} ${y}`); await saveNow(); if(S.cases.length){ setDefaultPeriod(); } render(); toast(`Removed ${MONTH_FULL[mo-1]} ${y}`); }},"Remove"))); })));
  const status = S.isSample ? "Demo client: sample data, not saved." : S.saved ? `Saved in this browser for ${clientName(S.clientId)} · keeping the latest ${S.retainMonths} months` : "Kept for this session only";
  return h("div",{class:"panel"},
    h("div",{class:"panel-head"}, h("h3",{text:"Months loaded"}), h("span",{class:"small muted",text:status})),
    h("div",{class:"tbl-wrap"},t),
    h("div",{class:"formrow",style:"margin-top:12px"},
      h("label",{for:"retain",text:"Keep history for"}),
      h("select",{id:"retain",onchange:async e=>{ S.retainMonths=+e.target.value; applyRetention(); await saveNow(); if(S.cases.length) setDefaultPeriod(); render(); }}, [3,6,12].map(n=>h("option",{value:n,selected:S.retainMonths===n?"":null,text:`the latest ${n} months`}))),
      S.isSample ? null : h("button",{type:"button",class:"btn sm",style:clearArmed?"border-color:var(--bad-ink);color:var(--bad-ink)":null,onclick:async()=>{
        if(!clearArmed){ clearArmed=true; render(); setTimeout(()=>{ if(clearArmed){ clearArmed=false; render(); } },5000); return; }
        clearArmed=false; S.cases=[]; S.sources=[]; S.edits={}; S.voids={}; S.dropped={}; S.acceptedNB={}; logAudit("Data cleared","All months removed"); await saveNow(); setDefaultPeriod(); render(); toast(`Removed all months for ${clientName(S.clientId)}`); }}, clearArmed ? `Click again to remove all of ${clientName(S.clientId)}'s months` : "Remove all months")));
}
async function handleFiles(files){
  const list=[...files]; if(!list.length) return;
  const f = list[0];
  try{
    toast(`Reading ${f.name}…`);
    pending = await readFile(f);
    pending.replace = $("#replaceMode") ? $("#replaceMode").checked : false;
    pending.queue = list.slice(1);
    S.tab="data"; render();
  }catch(e){ pending=null; render(); showError(e.message); }
}
function showError(msg){ const m=$("#main"); m.prepend(h("div",{class:"callout bad",role:"alert"},h("b",{text:"File not loaded."}),h("span",{text:msg}))); }
function mappingPanel(){
  const pd = pending;
  const hdrOpts = sel => [h("option",{value:"",text:"— not in file —"}), ...pd.headers.map(x=>h("option",{value:x,selected:sel===x?"":null,text:x}))];
  const t = h("table",{class:"map"}, h("thead",null,h("tr",null,["Field","Column in your file","First value"].map(x=>h("th",{text:x})))));
  const tb = h("tbody");
  for(const f of FIELDS){
    const col = pd.map[f.k], first = col ? pd.rows.find(r=>r[col]!=null&&r[col]!=="")?.[col] : null;
    tb.append(h("tr",null, h("td",null,f.label, f.req?h("span",{class:"chip bad",style:"margin-left:6px",text:"required"}):null),
      h("td",null,h("select",{id:"map-"+f.k,"aria-label":`Column for ${f.label}`,onchange:e=>{ pd.map[f.k]=e.target.value||undefined; render(); }}, hdrOpts(col))),
      h("td",{class:"mono small",text:first==null?"":(first instanceof Date?first.toISOString():String(first)).slice(0,60)})));
  }
  t.append(tb);
  const missing = FIELDS.filter(f=>f.req && !pd.map[f.k]).map(f=>f.label);
  // Epoch preview (requirement 6)
  const lines = [];
  for(const k of ["createdAt","assignedAt","closedAt"]){
    const col=pd.map[k]; if(!col) continue; const v = pd.rows.find(r=>r[col]!=null&&r[col]!=="")?.[col]; if(v==null) continue;
    const p = parseTs(v,S.tz);
    lines.push(`${k.padEnd(10)} ${String(v instanceof Date?v.toISOString():v).padEnd(26)} → ${fmtUtc(p.ms)}  |  ${fmtIst(p.ms)}   (${p.form})`);
  }
  const sheetSel = pd.sheets.length>1 ? h("div",{class:"formrow"},h("label",{for:"sheetSel",text:"Sheet"}), h("select",{id:"sheetSel",onchange:e=>{ const i=+e.target.value; const sh=pd.sheets[i]; Object.assign(pd,{sheetIdx:i,headers:sh.headers,rows:sh.rows,map:autoMap(sh.headers,sh.rows)}); render(); }}, pd.sheets.map((s,i)=>h("option",{value:i,selected:i===pd.sheetIdx?"":null,text:`${s.name} (${fmtInt(s.rows.length)} rows)`})))) : null;
  return h("div",{class:"panel"},
    h("div",{class:"panel-head"}, h("h3",{text:`Check columns · ${pd.name}`}), h("span",{class:"small muted mono",text:`SHA-256 ${pd.sha.slice(0,16)}… · ${fmtInt(pd.rows.length)} rows`})),
    sheetSel,
    h("p",{class:"small muted",style:"margin:6px 0",text:"Columns were matched automatically. Change any that are wrong. Timestamp conversion preview:"}),
    h("div",{class:"preview",text: lines.join("\n") || "Map the Created column to see the conversion."}),
    h("div",{class:"tbl-wrap",style:"margin-top:12px"},t),
    missing.length ? h("p",{class:"small",style:"color:var(--bad-ink)",text:`Map these required fields first: ${missing.join(", ")}.`}) : null,
    S.isSample ? h("div",{class:"formrow",style:"margin-top:12px"}, h("label",{for:"pdClient",text:"Save as client"}), h("input",{type:"text",id:"pdClient",maxlength:"60",placeholder:"Client name",value:pd.clientName||"",style:"width:240px",oninput:e=>{pd.clientName=e.target.value;}})) : null,
    h("div",{class:"formrow",style:"margin-top:12px"},
      h("button",{type:"button",class:"btn primary",disabled:missing.length?"":null,onclick:useData}, S.isSample ? "Create client and use this data" : pd.replace ? "Use this data" : `Add to ${clientName(S.clientId)}`),
      h("button",{type:"button",class:"btn",onclick:()=>{pending=null;render();}},"Cancel")));
}
async function useData(){
  const pd = pending;
  if(S.isSample){ const nm=(pd.clientName||"").trim(); if(!(await createClient(nm))) return; }
  const newCases = buildCases(pd.rows, pd.map, S.tz, pd.name);
  if(!S.isSample && !pd.replace){
    // The same case in two files (e.g. overlapping exports): keep the copy from the newer file.
    const byId = new Map(S.cases.filter(c=>!S.dropped[c.uid]).map((c,i)=>[c.id,i]));
    let merged = 0; newCases.forEach(n=>{ if(byId.has(n.id)){ S.cases[byId.get(n.id)]._supersede = true; merged++; } });
    S.cases = S.cases.filter(c=>!c._supersede).concat(newCases);
    if(merged) logAudit("Overlap merged", `${merged} case IDs were in an earlier file; kept the copy from ${pd.name}`); S.sources.push({name:pd.name, rows:pd.rows.length, sha:pd.sha, sheet:pd.sheets[pd.sheetIdx].name}); }
  else { S.cases = newCases; S.sources=[{name:pd.name, rows:pd.rows.length, sha:pd.sha, sheet:pd.sheets[pd.sheetIdx].name}]; S.edits={}; S.voids={}; S.dropped={}; S.acceptedNB={}; }
  S.isSample = false;
  logAudit("Data loaded", `${pd.name} · ${fmtInt(pd.rows.length)} rows · SHA-256 ${pd.sha.slice(0,16)}…`);
  prepareAll();
  applyRetention();
  await saveNow();
  const q = pd.queue || [];
  pending = null;
  if(q.length){ try{ pending = await readFile(q[0]); pending.replace=false; pending.queue=q.slice(1); render(); return; }catch(e){ showError(e.message); } }
  setDefaultPeriod(); S.tab="overview"; render();
  const nm = Object.keys(monthCounts()).length;
  toast(`Loaded ${fmtInt(newCases.length)} cases · ${nm} month${nm>1?"s":""} available · showing ${A.label} vs ${P.label}`);
}

/* ---------- Download helper (viewer confirms every save) ---------- */
async function offerFile(filename, blob){
  if(window.claude && typeof window.claude.use==="function"){
    const dl = await window.claude.use("downloads");
    if(!dl){ toast("Downloads aren't available in this view."); return; }
    try{ await dl.save({filename, data:blob}); toast(`${filename} saved`); }
    catch(e){ if(e && e.code==="declined") toast("Download cancelled"); else if(e && e.code==="rate_limited") toast("A download prompt is already open."); else toast("The download couldn't be completed here."); }
    return;
  }
  // Opened as a local file outside Claude: use a normal browser download.
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = filename; document.body.append(a); a.click(); setTimeout(()=>{URL.revokeObjectURL(a.href); a.remove();},1000);
}
function exportGate(){
  const nb = openBlocking();
  if(nb.length){ S.tab="review"; render(); toast(`Fix ${nb.length} blocking item${nb.length>1?"s":""} before exporting.`); return false; }
  return true;
}
const safeName = s => String(s).replace(/[^A-Za-z0-9._-]+/g,"_").replace(/^_+|_+$/g,"").slice(0,80) || "Report";
function fileStem(){ return `SOC_Report_${safeName(S.report.client)}_${S.cadence}_${S.start}_to_${S.end}`; }

/* ---------- Excel export (requirement 13) ---------- */
async function exportExcel(){
  if(!exportGate()) return;
  const btn=$("#btnXlsx"); btn.disabled=true; btn.textContent="Building…";
  try{
    const sheets = [];
    const G={v:null,s:2}, B={v:null,s:3};
    // README
    sheets.push({name:"README", header:false, widths:[30,110], rows:[
      [{v:"Report",s:4},"SOC SLA and service review"],[{v:"Client",s:4},S.report.client],[{v:"Period",s:4},`${A.label} (${S.start} to ${S.end}, ${S.cadence})`],[{v:"Compared with",s:4},P.label],
      [{v:"Period counted in",s:4},S.periodTz?"IST (UTC+5:30)":"UTC"],[{v:"Times shown in",s:4},S.tz?"Asia/Kolkata (IST, UTC+5:30)":"UTC"],[{v:"Sources",s:4},S.sources.map(x=>`${x.name} [${x.sheet}] ${x.rows} rows, SHA-256 ${x.sha}`).join(" | ")],
      [{v:"Generated",s:4},new Date().toISOString()],[{v:"Rule set",s:4},`Seed v3 + ${S.rules.filter(r=>r.rule_id.startsWith("CAT-USER")).length} user rules`],
      [{v:"Cases in period",s:4},A.total],[{v:"SLA-evaluable",s:4},A.evaluable],[{v:"Informational (excluded)",s:4},A.byPrio.Informational],[{v:"Review edits",s:4},S.audit.length],
      [{v:"SLA rule",s:4},"Compliance % = Met / (Met + Not met). Pending, N/A and data errors are excluded from the denominator."],
      [{v:"Formula safety",s:4},"Text starting with = + - @ is prefixed with an apostrophe so it can't run as a formula."]]});
    // SLA
    const sla=[["Priority","Metric","Limit","Limit (seconds)","Target %","Met","Not met","Pending","N/A","Data error","Compliance %","Status","Mean","Median","P95",`Previous % (${P.short})`]];
    for(const p of PRIOS) for(const m of METRICS){ const c=A.sla[p][m.k], pc=P.sla[p][m.k];
      sla.push([p,m.k,fmtLimit(p,m.k),limitSec(p,m.k),c.target,c.met,c.notMet,c.pending,c.na,c.err,c.pct,{v:c.pct==null?"No evaluable cases":c.status==="ok"?"Meets target":"Below target",s:c.pct==null?0:c.status==="ok"?2:3},fmtDur(c.mean),fmtDur(c.median),fmtDur(c.p95),pc.pct]); }
    sheets.push({name:"SLA Compliance", widths:[12,8,14,14,9,8,9,9,8,10,13,18,13,13,13,16], rows:sla});
    // Cases
    const hdr=["Case ID","Title","Priority","Category","Sub-category","Report bucket","Rule","Matched text","Created (raw)","Created UTC","Created local","Acknowledged local","Closed local","Disposition","Stage","Root cause","Assignee",...METRICS.flatMap(m=>[`${m.k} seconds`,`${m.k} status`,`${m.k} note`])];
    const cr=[hdr];
    for(const c of A.cases){ const ef=effective(c), ev=c._ev;
      cr.push([c.id,c.title,ef.priority||"Invalid",c.cat.category,c.cat.sub,c.cat.bucket,c.cat.ruleId,c.cat.match,String(c.raw.createdAt??""),fmtUtc(ef.ts.createdAt),fmtLocal(ef.ts.createdAt),fmtLocal(ef.ts.assignedAt),fmtLocal(ef.ts.closedAt),c.disposition,String(c.stage??""),String(c.rootCause??""),String(c.assignee??""),
        ...METRICS.flatMap(m=>{const r=ev[m.k]; return [r.el!=null?Math.round(r.el):null, r.s.replace("_"," "), r.why||""];})]); }
    sheets.push({name:"Cases", filter:true, widths:hdr.map(x=>x==="Title"?60:x.includes("note")?26:16), rows:cr});
    // Category trend
    const bks = Object.keys(A.bucket).sort((a,b)=>A.bucket[b]-A.bucket[a]);
    const byDayB=new Map(); for(const c of A.cases){ const d=msToYmd(effective(c).ts.createdAt); if(!byDayB.has(d)) byDayB.set(d,dict()); const o=byDayB.get(d); o[c.cat.bucket]=(o[c.cat.bucket]||0)+1; }
    const ct=[["Day",...bks,"Total"]];
    for(const d of A.daily.keys()){ const o=byDayB.get(d)||{}; ct.push([d,...bks.map(b=>o[b]||0),bks.reduce((a,b)=>a+(o[b]||0),0)]); }
    ct.push([{v:"Total",s:4},...bks.map(b=>({v:A.bucket[b],s:4})),{v:A.total,s:4}]);
    sheets.push({name:"Category Trend", widths:[14,...bks.map(()=>15),10], rows:ct});
    // Disposition trend
    const dks=Object.keys(A.disp).sort(); const dtr=[["Day",...dks,"Total"]];
    for(const [d,o] of A.daily) dtr.push([d,...dks.map(k=>o[k]||0),dks.reduce((a,k)=>a+(o[k]||0),0)]);
    sheets.push({name:"Disposition Trend", widths:[14,...dks.map(()=>16),10], rows:dtr});
    // Heatmap
    const hrows=[...A.heat.entries()].map(([t,a])=>({t,a,n:a.reduce((x,y)=>x+y,0)})).sort((a,b)=>b.n-a.n);
    const hmax=Math.max(1,...hrows.flatMap(r=>r.a));
    sheets.push({name:"Heatmap", widths:[60,...Array(24).fill(5),8], rows:[["Alert name",...Array.from({length:24},(_,i)=>String(i)),"Total"], ...hrows.map(r=>[r.t,...r.a.map(v=>v?{v,s:5+Math.min(XL.HEAT_LEVELS-1,Math.floor(v/hmax*XL.HEAT_LEVELS))}:0),r.n])]});
    // Comparison
    const cp=[["Dimension",P2.short,P.short,A.short,`Change vs ${P.short}`,"Change %"]];
    const cmp=(k,f)=>{ const c2=P2.total?f(P2):null, b=P.total?f(P):null, a=f(A); cp.push([k,c2,b,a,b!=null?a-b:null,b?Math.round((a-b)/b*1000)/10:null]); };
    cmp("Total cases",x=>x.total); cmp("SLA-evaluable",x=>x.evaluable); ALL_PRIOS.forEach(p=>cmp(p,x=>x.byPrio[p])); cmp("Auto-closed",x=>x.auto); cmp("True positives",x=>x.tp);
    [...new Set([...Object.keys(A.bucket),...Object.keys(P.bucket),...Object.keys(P2.bucket)])].forEach(k=>cmp("Bucket: "+k,x=>x.bucket[k]||0));
    for(const p of PRIOS) for(const m of METRICS){ const g=x=>x.total?x.sla[p][m.k].pct:null; const a=g(A),b=g(P); cp.push([`SLA ${p} ${m.k} %`,g(P2),b,a,a!=null&&b!=null?round2(a-b):null,null]); }
    cp.push([]); observations(A,P,A.label,P.label).forEach(o=>cp.push([o]));
    sheets.push({name:"Comparison", widths:[44,14,14,14,16,12], rows:cp});
    // Exceptions & edits
    const ex=[["When / type","Action / status","Detail"]];
    S.audit.slice().reverse().forEach(a=>ex.push([a.at,a.action,a.detail]));
    ISSUES.forEach(i=>ex.push([i.type,i.blocking?"Blocking (open)":(isResolved(i)?"Accepted":"Open"), i.type==="UNCAT"?`${i.title} (${i.cases.length} cases)`:`Case ${i.cases[0].id}`]));
    sheets.push({name:"Exceptions & Edits", widths:[22,24,100], rows:ex});
    const blob = await XL.write(sheets,{title:`SOC report ${A.label}`});
    await offerFile(fileStem()+".xlsx", blob);
  }catch(e){ toast(e.message || "Excel export failed."); console.error(e); }
  finally{ btn.disabled=false; btn.textContent="Download Excel"; }
}

/* ---------- PowerPoint export (requirements 11, 12) ---------- */
const PPT = {blue:"0057B8", navy:"002855", light:"7BAFD4", black:"000000", grey:"595959", font:"Tw Cen MT",
  prio:{Critical:"6B1D1A",High:"D9472B",Medium:"FFB500",Low:"7A9A45"}};
function scale3(p){ // green → yellow → red (like the reference heat maps)
  const lerp=(a,b,t)=>Math.round(a+(b-a)*t);
  const G=[99,190,123], Y=[255,235,132], R=[248,105,107];
  const [a,b,t] = p<.5 ? [G,Y,p*2] : [Y,R,(p-.5)*2];
  return [0,1,2].map(i=>lerp(a[i],b[i],t).toString(16).padStart(2,"0")).join("").toUpperCase();
}
async function exportPptx(){
  if(!exportGate()) return;
  const btn=$("#btnPptx"); btn.disabled=true; btn.textContent="Building…";
  try{
    const PptxGenJS = await needLib("PptxGenJS");
    const pptx = new PptxGenJS(); pptx.layout="LAYOUT_WIDE"; pptx.author="SOC-RAP"; pptx.company=S.report.client; pptx.title=`Monthly Service Review – ${A.label}`;
    const F = PPT.font, src = S.report.source || "SOC", yr = S.start.slice(0,4);
    const dt = defaultText();
    const T = k => cleanText((S.report[k] && S.report[k].trim()) || dt[k], 2000);
    let page = 0;
    const footer = (sl, note) => { page++; if(note) sl.addText(note,{x:3,y:7.05,w:6,h:.3,fontFace:F,fontSize:8,color:"7F7F7F"}); sl.addText(`${yr}     ${page}`,{x:11.6,y:7.05,w:1.3,h:.3,fontFace:F,fontSize:8,color:"7F7F7F",align:"right"}); };
    const title = (sl, t) => sl.addText(t,{x:.5,y:.3,w:12.3,h:.9,fontFace:F,fontSize:36,bold:true,color:PPT.black,valign:"top",fit:"shrink"});
    const bullets = (arr, size=12, color="000000") => arr.map((t,i)=>({text:t,options:{bullet:true,breakLine:i<arr.length-1,fontSize:size,color}}));
    // 1 Agenda
    let sl = pptx.addSlide(); sl.background={color:PPT.blue};
    sl.addText("Agenda",{x:.3,y:3.1,w:4,h:.9,fontFace:F,fontSize:30,bold:true,color:"FFFFFF"});
    sl.addText(["Program Summary","Program Metrics","Service Improvement","Threat Hunting","Rate | Scoping Elements"].map((t,i,a)=>({text:t,options:{bullet:{type:"number"},breakLine:i<a.length-1}})),{x:5.1,y:1.4,w:6.5,h:3.6,fontFace:F,fontSize:20,color:"FFFFFF",paraSpaceAfter:14,valign:"top"});
    footer(sl);
    // 2, 3 section dividers
    sl = pptx.addSlide(); sl.background={color:PPT.black}; sl.addText("Program Summary",{x:.5,y:2.9,w:11,h:1,fontFace:F,fontSize:36,bold:true,color:"FFFFFF"}); footer(sl);
    sl = pptx.addSlide(); sl.background={color:PPT.black}; sl.addText("Threat Detection,\nResponse and\nProgram Metrics",{x:.5,y:2.4,w:11,h:2.2,fontFace:F,fontSize:36,bold:true,color:"FFFFFF",valign:"top"}); footer(sl);
    // 4 SLA summary
    sl = pptx.addSlide(); title(sl,"Security Event SLA Summary");
    sl.addText([{text:"Key Takeaway",options:{bold:true,color:PPT.blue,fontSize:18,breakLine:true}},{text:T("slaTakeaway"),options:{fontSize:15,breakLine:true}},{text:" ",options:{fontSize:6,breakLine:true}},{text:"Next Step",options:{bold:true,color:PPT.blue,fontSize:18,breakLine:true}},{text:T("slaNext"),options:{fontSize:15}}],{x:.5,y:1.25,w:7.6,h:2.05,fontFace:F,valign:"top",fit:"shrink"});
    const fun = [[A.total,`${src} Cases Generated`,"868B84"],[A.auto,"Automated Closure","2B2B2B"],[A.tier12,"Tier 1 and 2 Investigations","7EB6F0"],[A.tier3,"Tier 3 Investigations","3D95F2"],[A.simulation,"Simulation Cases","262626"]];
    sl.addImage({data:drawFunnel(fun), x:8.95, y:1.0, w:4.3, h:1.75, altText:"Case funnel"});
    sl.addNotes(fun.map(([v,l])=>`${l}: ${v}`).join("\n"));
    const hc = (t,o={}) => ({text:t,options:{bold:true,align:"center",valign:"middle",fontFace:F,...o}});
    const rowsT = [
      [hc(`Key Performance Indicators (${src} Cases)`,{colspan:14,fill:{color:PPT.navy},color:"FFFFFF",fontSize:14,align:"left"})],
      [hc("",{fill:{color:"FFFFFF"}}), hc("Service Level Targets\nMonthly Average",{colspan:6,fill:{color:PPT.blue},color:"FFFFFF",fontSize:12}), hc("",{fill:{color:"FFFFFF"}}), hc("Actual",{colspan:6,fill:{color:PPT.blue},color:"FFFFFF",fontSize:12})],
      [hc("",{fill:{color:"FFFFFF"}}), ...["Time to\nAcknowledge","Time to\nInvestigate","Time to Contain"].map(t=>hc(t,{colspan:2,fill:{color:"D9D9D9"},fontSize:9.5})), hc("Cases",{fill:{color:"D9D9D9"},fontSize:9.5}), ...["Average Time\nto Acknowledge","Average Time to\nInvestigate","Average Time\nto Contain"].map(t=>hc(t,{colspan:2,fill:{color:"D9D9D9"},fontSize:9.5}))]
    ];
    for(const p of PRIOS){
      const c = t => ({text:t,options:{align:"center",valign:"middle",fontFace:F,fontSize:10}});
      const act = (m) => { const x=A.sla[p][m]; const good = x.status!=="bad"; return [ {text:fmtDur(x.mean),options:{align:"center",valign:"middle",fontFace:F,fontSize:10,color:"4E7A1E"}}, {text:x.pct==null?"—":fmtPct(x.pct),options:{align:"center",valign:"middle",fontFace:F,fontSize:10,color:good?"4E7A1E":"C00000",bold:!good}} ]; };
      rowsT.push([ {text:p,options:{bold:true,color:"FFFFFF",fill:{color:PPT.prio[p]},align:"center",valign:"middle",fontFace:F,fontSize:10}},
        c(fmtLimit(p,"TTA")), c(S.targets[p].TTA+"%"), c(fmtLimit(p,"TTI")), c(S.targets[p].TTI+"%"), c(fmtLimit(p,"TTC")), c(S.targets[p].TTC+"%"),
        {text:fmtInt(A.byPrio[p]),options:{bold:true,align:"center",valign:"middle",fontFace:F,fontSize:10}}, ...act("TTA"), ...act("TTI"), ...act("TTC") ]);
    }
    sl.addTable(rowsT,{x:.5,y:3.35,w:12.3,colW:[.85,.95,.55,.95,.55,.95,.55,.7,1.05,.8,1.05,.8,1.05,.8].map(x=>x*12.3/11.7),rowH:[.36,.46,.46,.37,.37,.37,.37],border:{type:"solid",pt:.5,color:"D9D9D9"},fontFace:F});
    footer(sl,"Note: Informational cases are not part of the SLA calculations");
    // 5 Severity
    const obs = observations(A,P,A.label,P.label);
    sl = pptx.addSlide(); title(sl,`${src} Cases - Severity`);
    sl.addImage({data:drawSeverity(A.byPrio), x:.4, y:1.35, w:6.7, h:5.5, altText:"Cases by severity"});
    sl.addNotes("Cases by severity\n"+ALL_PRIOS.map(p=>`${p}: ${A.byPrio[p]}`).join("\n"));
    sl.addText([{text:"Key Observations",options:{bold:true,color:PPT.blue,fontSize:12,breakLine:true}}, ...bullets(obs.slice(0,6),10.5)],{x:7.35,y:1.3,w:5.6,h:3.35,fontFace:F,valign:"top",fit:"shrink"});
    sl.addText([{text:"Key Takeaway",options:{bold:true,color:"FFB500",fontSize:12,breakLine:true}},{text:T("sevTakeaway"),options:{fontSize:11,breakLine:true}},{text:" ",options:{fontSize:6,breakLine:true}},{text:"Next Step",options:{bold:true,color:"FFB500",fontSize:12,breakLine:true}},{text:T("sevNext"),options:{fontSize:11}}],{x:7.35,y:4.8,w:5.6,h:2.1,fontFace:F,color:"FFFFFF",fill:{color:PPT.blue},valign:"top",margin:8,fit:"shrink"});
    footer(sl);
    // 6 Categories
    sl = pptx.addSlide(); title(sl,`${src} Incident Total Tickets Created: Categories`);
    const bk = Object.keys(A.bucket).sort((a,b)=>A.bucket[b]-A.bucket[a]);
    sl.addImage({data:drawCategories(bk.map(b=>({k:b,v:A.bucket[b]}))), x:.4, y:1.3, w:6.7, h:4.2, altText:"Cases by category"});
    sl.addNotes("Cases by report bucket\n"+bk.map(b=>`${b}: ${A.bucket[b]}`).join("\n"));
    const catObs = []; const newB = bk.filter(b=>P.total && !(P.bucket[b]>0));
    if(newB.length) catObs.push(`${newB.join(" and ")} ${newB.length>1?"were":"was"} newly introduced this period (${newB.map(b=>fmtInt(A.bucket[b])).join(" and ")} cases).`);
    if(bk[0]) catObs.push(`${bk[0]} was the largest bucket with ${fmtInt(A.bucket[bk[0]])} cases (${(A.bucket[bk[0]]/A.total*100).toFixed(0)}%).`);
    if(A.auto) catObs.push(`Automation remained a major driver of case handling: ${fmtInt(A.auto)} cases were auto-closed.`);
    if(A.bucket.Other) catObs.push(`The “Other” bucket (${fmtInt(A.bucket.Other)}) mainly reflects overflow and simulation cases.`);
    if(A.uncategorized) catObs.push(`${fmtInt(A.uncategorized)} cases remain uncategorized for manual review.`);
    sl.addText([{text:"Key Takeaway",options:{bold:true,color:"FFB500",fontSize:12,breakLine:true}}, ...bullets((S.report.catTakeaway?[S.report.catTakeaway]:[]).concat(catObs),11,"FFFFFF")],{x:7.35,y:1.3,w:5.6,h:4.1,fontFace:F,color:"FFFFFF",fill:{color:PPT.blue},valign:"top",margin:8,fit:"shrink"});
    const allB = [...new Set([...bk,...Object.keys(P.bucket),...Object.keys(P2.bucket)])];
    const th = t => ({text:t,options:{bold:true,color:"FFFFFF",fill:{color:PPT.navy},align:"center",fontFace:F,fontSize:9}});
    const tr = (lbl,o,col,bold) => [{text:lbl,options:{bold:true,color:PPT.blue,fontFace:F,fontSize:9,align:"center"}}, ...allB.map(b=>({text:fmtInt(o[b]||0),options:{color:col,fontFace:F,fontSize:9,align:"center"}})), {text:fmtInt(Object.values(o).reduce((a,b)=>a+b,0)),options:{bold:true,fontFace:F,fontSize:9,align:"center"}}];
    const bRows = [[th("Month"),...allB.map(th),th("Total")], tr(A.short,A.bucket,"D9472B"), tr(P.short,P.bucket,"000000")];
    if(P2.total) bRows.push(tr(P2.short,P2.bucket,"000000"));
    sl.addTable(bRows,{x:.5,y:5.75,w:12.3,rowH:.3,border:{type:"solid",pt:.5,color:"D9D9D9"}});
    footer(sl);
    // 7 Daily disposition
    sl = pptx.addSlide(); title(sl,`${src} Cases Daily Disposition Trend`);
    const cr = ["Maintenance","Non-Malicious","Malicious","Pending"].filter(k=>A.closeR[k]);
    if(cr.length) sl.addImage({data:drawPie(cr.map(k=>[k,A.closeR[k]])), x:.3, y:1.2, w:4.9, h:3.2, altText:"Cases by close reason"});
    const dispObs = [
      `A total of ${fmtInt(A.total)} cases were identified, split between ${fmtInt(A.closeR["Non-Malicious"]||0)} non-malicious and ${fmtInt(A.closeR.Malicious||0)} malicious cases.`,
      `${fmtInt(A.closeR.Maintenance||0)} cases were closed as maintenance.`,
      `${fmtInt(A.open)} cases remain open and are escalated or under active coordination.`];
    const peak = [...A.daily.entries()].map(([d,o])=>[d,Object.values(o).reduce((a,b)=>a+b,0)]).sort((a,b)=>b[1]-a[1])[0];
    if(peak && peak[1]) dispObs.push(`The busiest ${peak[0].length===10?"day":"hour"} was ${peak[0].length===10?fmtYmd(peak[0]):peak[0]} with ${fmtInt(peak[1])} cases.`);
    sl.addText([{text:"Key Observations",options:{bold:true,color:"FFB500",fontSize:12,breakLine:true}}, ...bullets(dispObs,11,"FFFFFF")],{x:5.4,y:1.2,w:7.5,h:3.1,fontFace:F,color:"FFFFFF",fill:{color:PPT.blue},valign:"top",margin:8,fit:"shrink"});
    const dk=[...A.daily.keys()], lineS=[["True Positive","0B3B60"],["Benign Positive","E36C2F"],["False Positive","2E7D32"],["Waiting Client","00A3E0"]];
    const dLbl = dk.map(k=>k.length===10?`${+k.slice(5,7)}/${+k.slice(8)}/${k.slice(0,4)}`:k), dv = n => dk.map(k=>A.daily.get(k)[n]||0);
    sl.addImage({data:drawDispositionTrend(dLbl, dv("False Positive"), dv("Waiting Client"), dv("True Positive"), dv("Benign Positive")), x:.3, y:4.4, w:12.7, h:2.6, altText:"Daily disposition trend"});
    sl.addNotes("Close reasons\n"+cr.map(k=>`${k}: ${A.closeR[k]}`).join("\n")+"\n\nDaily disposition (FP / Pending / TP / BP)\n"+dk.map((k,i)=>`${dLbl[i]}: ${dv("False Positive")[i]} / ${dv("Waiting Client")[i]} / ${dv("True Positive")[i]} / ${dv("Benign Positive")[i]}`).join("\n"));
    footer(sl);
    // 8 MDR alert analysis
    sl = pptx.addSlide(); title(sl,`MDR Alert Analysis – ${A.label}`);
    const ins = detectionInsights(A);
    sl.addText("Alert Heat Map – alert volume by detection and hour",{x:.5,y:1.3,w:8.4,h:.3,fontFace:F,fontSize:13,bold:true});
    const top = [...A.heat.entries()].map(([t,a])=>({t,a,n:a.reduce((x,y)=>x+y,0)})).sort((a,b)=>b.n-a.n).slice(0,10);
    const hmx = Math.max(1,...top.flatMap(r=>r.a));
    const cut = (t,n) => t.length>n ? t.slice(0,n-1)+"…" : t;
    const M = [0.01,0.02,0.01,0.02];
    const hh = t => ({text:t,options:{bold:true,fontSize:5.5,fill:{color:"BDD7EE"},align:"center",fontFace:"Calibri",margin:M}});
    const heatRows = [[{text:"Row Labels",options:{bold:true,fontSize:5.5,fill:{color:"BDD7EE"},fontFace:"Calibri",margin:M}}, ...Array.from({length:24},(_,i)=>hh(String(i))), hh("Grand Total")]];
    top.forEach(r=>heatRows.push([{text:cut(r.t,52),options:{fontSize:5.5,fontFace:"Calibri",margin:M}}, ...r.a.map(v=>({text:v?String(v):"",options:{fontSize:5.5,align:"center",fontFace:"Calibri",margin:M,fill:v?{color:scale3(v/hmx)}:undefined}})), {text:String(r.n),options:{fontSize:5.5,align:"right",fontFace:"Calibri",margin:M}}]));
    sl.addTable(heatRows,{x:.5,y:1.62,w:8.4,colW:[2.6,...Array(24).fill(.215),.64],rowH:.155,border:{type:"solid",pt:.25,color:"FFFFFF"}});
    sl.addText("Disposition Heat Map – top detections by volume and outcome",{x:.5,y:3.62,w:8.4,h:.3,fontFace:F,fontSize:13,bold:true});
    const dtop = ins.rows.slice(0,12);
    const dRows = [[{text:"Row Labels",options:{bold:true,fontSize:6,fill:{color:"BDD7EE"},fontFace:"Calibri",margin:M}}, hh("Benign Positive"), hh("True Positive"), hh("False Positive"), hh("Grand Total")]];
    const dc = (t,o={}) => ({text:t,options:{fontSize:6,align:"right",fontFace:"Calibri",margin:M,...o}});
    dtop.forEach(r=>dRows.push([dc(cut(r.t,80),{align:"left"}), dc(r.bp.toFixed(2)+"%",{fill:{color:scale3(r.bp/100)}}), dc(r.tp.toFixed(2)+"%",{fill:{color:scale3(1-r.tp/100)}}), dc(r.fp.toFixed(2)+"%",{fill:{color:scale3(r.fp/100)}}), dc(String(r.n))]));
    sl.addTable(dRows,{x:.5,y:3.95,w:8.4,colW:[4.9,.9,.9,.9,.8],rowH:.19,border:{type:"solid",pt:.25,color:"FFFFFF"}});
    sl.addShape(pptx.ShapeType.line,{x:9.15,y:1.3,w:0,h:5.6,line:{color:"D9D9D9",width:.75}});
    sl.addText([{text:`Executive findings – what we saw in ${A.label}`,options:{bold:true,fontSize:12,breakLine:true}}, ...bullets([`${A.label} generated ${fmtInt(A.total)} total alerts`, ...ins.findings],8)],{x:9.3,y:1.3,w:3.75,h:2.7,fontFace:F,valign:"top",fit:"shrink"});
    const actRuns = [{text:"MDR Findings and Next Actions",options:{bold:true,fontSize:12,breakLine:true}}];
    const acts = ins.acts.slice(0,5);
    acts.forEach(([a,t],i)=>{ actRuns.push({text:a+": ",options:{bold:true,color:PPT.blue,fontSize:8,bullet:true}}); actRuns.push({text:t,options:{fontSize:8,breakLine:i<acts.length-1}}); });
    sl.addText(actRuns,{x:9.3,y:4.05,w:3.75,h:2.95,fontFace:F,valign:"top",fit:"shrink"});
    footer(sl);
    let blob;
    try{ blob = await pptx.write({outputType:"blob"}); }catch(e){ blob = await pptx.write("blob"); }
    await offerFile(fileStem()+".pptx", blob);
  }catch(e){ toast(e.message || "PowerPoint export failed."); console.error(e); }
  finally{ btn.disabled=false; btn.textContent="Download PowerPoint"; }
}

/* ---------- Boot ---------- */
function boot(){
  S.rules = JSON.parse(document.getElementById("rules-data").textContent).rules.map(r=>({...r,enabled:true}));
  try{ const t=localStorage.getItem("socrap.tab"); if(t && TABS.some(x=>x[0]===t)) S.tab=t; }catch(e){}
  const hash = (location.hash||"").slice(1); if(TABS.some(x=>x[0]===hash)) S.tab=hash;
  S.clientId = DEMO_ID; S.clients = [];
  loadSample();
  document.querySelectorAll("#cadenceSeg button").forEach(b=>b.addEventListener("click",()=>{
    const v=b.dataset.v; S.cadence=v;
    if(v==="monthly"){ const [a,c]=monthBounds(S.end.slice(0,7)); S.start=a; S.end=c; }
    else if(v==="weekly"){ const mo=mondayOf(addDaysYmd(S.end,-6)); S.start=mo; S.end=addDaysYmd(mo,6); }
    else if(v==="daily"){ S.start=S.end; }
    render();
  }));
  document.querySelectorAll("#tzSeg button").forEach(b=>b.addEventListener("click",()=>{ S.tz=Number(b.dataset.v); render(); }));
  $("#btnXlsx").addEventListener("click",exportExcel);
  $("#btnPptx").addEventListener("click",exportPptx);
  const dl = h("datalist",{id:"catList"}); document.body.append(dl);
  const origRender = render;
  render = function(){ origRender(); dl.replaceChildren(...allCategories().map(c=>h("option",{value:c}))); };
  render = function(){ origRender(); dl.replaceChildren(...allCategories().map(c=>h("option",{value:c}))); scheduleSave(); };
  render();
  initClients();
}
window.SOC = {S, Store, switchClient, createClient, saveNow, monthCounts, get P2(){return P2;}, buildCases, autoMap, prepareAll, aggregate, parseTs, normTitle, classifyNorm, evaluate, buildIssues, get A(){return A;}, get P(){return P;}, render:()=>render(), setPeriod:(a,b,c)=>{S.cadence=c;S.start=a;S.end=b;render();}};
boot();

