import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {FileBlob,PresentationFile} from '@oai/artifact-tool';

// Theme-only revision. Import and restyle the approved content rather than
// regenerating it. The prior content deck is retained privately for comparison.
const root=process.cwd();
const skill='/Users/Shikhar/.codex/plugins/cache/openai-primary-runtime/presentations/26.1026.10807/skills/presentations';
const python='/Users/Shikhar/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3';
process.env.RUNTIME_NODE_MODULES ??= '/Users/Shikhar/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules';
process.env.RUNTIME_PYTHON ??= python;
const publicPath=path.join(root,'presentation/output/TaskLatch-CodeQuest-2026.pptx');
const build=path.join(root,'.build/presentation/theme-edit');
await fs.mkdir(path.join(build,'renders'),{recursive:true});
await fs.mkdir(path.join(build,'validated'),{recursive:true});
await fs.mkdir(path.join(root,'.codex-finalizer'),{recursive:true});
const source=path.join(build,'before-theme-edit.pptx');
try {await fs.copyFile(publicPath,source,fs.constants.COPYFILE_EXCL);}
catch(e){if(e.code!=='EEXIST')throw e;}
const p=await PresentationFile.importPptx(await FileBlob.load(source));
if(p.slides.items.length!==10)throw new Error('Expected 10 source slides');
const C={paper:'#FAF9F6',text:'#24292F',blue:'#214E78',muted:'#637080',line:'#D9DEE4',header:'#E9EEF3',band:'#F1F3F5',white:'#FFFFFF'};
p.theme.defaultFont='Arial';
p.theme.colorScheme={name:'TaskLatch Editorial',themeColors:{
  accent1:C.blue,accent2:'#56616D',accent3:'#8292A1',accent4:'#AFB8C1',accent5:'#D9DFE5',accent6:'#EDF1F4',
  bg1:C.paper,bg2:C.white,tx1:C.text,tx2:C.muted,dk1:C.text,dk2:'#38424E',lt1:C.white,lt2:'#F0F3F5',hlink:C.blue,folHlink:'#4D6074'
}};
const sections=[null,'Problem statement','Proposed solution and USP','Innovation and uniqueness','Technology stack','Implementation plan','Impact','How approval works','Evaluation plan','Prototype evidence'];
const diagramBoxes=new Set(['flow-1','flow-2','flow-3','flow-4','flow-5','flow-denied','arch-ui','arch-workers','arch-controller','arch-model','arch-supplierlab']);
function style(sh,{size=23,color=C.text,bold=false,font='Arial',align='left'}={}) {
  sh.text.style={typeface:font,fontSize:size,color,bold,alignment:align,verticalAlignment:'top',wrap:'square',autoFit:'none',insets:0};
}
for(let i=0;i<10;i++) {
  const s=p.slides.items[i];
  s.background.fill=C.paper;
  if(i===0)continue;
  for(const sh of s.shapes.items) {
    const n=sh.name;
    if(sh.geometry==='connector') {
      sh.line={style:sh.connectorLineStyle?.style==='dashed'?'dashed':'solid',fill:C.muted,width:1.4};
      continue;
    }
    if(diagramBoxes.has(n)) {
      const focus=n==='flow-3'||n==='arch-controller';
      sh.fill=focus?C.header:C.paper;
      sh.line={style:n==='flow-denied'?'dashed':'solid',fill:focus?C.blue:C.line,width:focus?1.2:0.9};
      continue;
    }
    if(n==='section') {sh.text=sections[i];style(sh,{size:20,color:C.blue});continue;}
    if(n==='title') {style(sh,{size:44,font:'Georgia'});continue;}
    if(n==='footer-brand') {sh.text='';style(sh,{size:16,color:C.muted});continue;}
    if(n==='footer-number') {style(sh,{size:16,color:C.muted,align:'right'});continue;}
    if(n==='problem-definition') {style(sh,{size:31});continue;}
    if(n.startsWith('problem-label-')) {style(sh,{size:27,color:C.blue,bold:true});continue;}
    if(n.startsWith('problem-detail-')||n==='solution-definition'||n==='beneficiaries') {style(sh,{size:27});continue;}
    if(n==='initial-user'||n==='fixture-definition') {style(sh,{size:23,color:C.muted});continue;}
    if(n.endsWith('-title')&&(n.startsWith('flow-')||n.startsWith('arch-'))) {style(sh,{size:n.startsWith('flow-')?25:26,bold:true,align:'center'});continue;}
    if(n.endsWith('-body')&&(n.startsWith('flow-')||n.startsWith('arch-'))) {style(sh,{size:23,align:'center'});continue;}
    if(n==='arch-ui-stack') {style(sh,{size:23,align:'center'});continue;}
    if(n==='denial-label') {style(sh,{size:23,color:C.muted,align:'center'});continue;}
    if(n==='approved-edge-label') {style(sh,{size:20,color:C.blue,bold:true,align:'center'});continue;}
    if(n==='denied-edge-label') {style(sh,{size:20,color:C.muted});continue;}
    if(n==='global-limits') {style(sh,{size:24});continue;}
    if(['usp','original-work','changed-payload'].includes(n)) {style(sh,{size:25,color:C.blue});continue;}
    if(n==='attribution') {style(sh,{size:20,color:C.muted});continue;}
    if(['arch-approval-label','arch-commit-label','arch-container-limit'].includes(n)) {style(sh,{size:23,color:C.muted});continue;}
    if(n==='arch-model-label') {style(sh,{size:23,color:C.muted,align:'center'});continue;}
    if(n==='arch-write-boundary'||n==='cost-baseline') {style(sh,{size:23,color:C.blue});continue;}
    if(n==='impact-status'||n==='mode-definition'||n==='demo-limits') {style(sh,{size:23,color:C.muted});continue;}
    if(n==='example-scope') {style(sh,{size:26});continue;}
    if(n==='boundary-count'||n==='session-count') {style(sh,{size:30,color:C.blue,font:'Georgia'});continue;}
    if(n==='boundary-explanation'||n==='session-denominator') {style(sh,{size:24,color:C.muted});continue;}
    if(n==='planned-targets') {style(sh,{size:22,color:C.muted});continue;}
    throw new Error(`Unmapped textbox on slide ${i+1}: ${n}`);
  }
}

// A typographic cover replaces the generated latch render.
const cover=p.slides.items[0];
const imageIds=await p.inspect({select:'$.slides[0].elements[?(@.kind == "image")]',include:['id']});
if(imageIds.records.length!==1)throw new Error('Expected one image on the source cover');
p.delete(imageIds.records.map(x=>x.id));
const named=n=>cover.shapes.items.find(x=>x.name===n);
named('event').text='CodeQuest 2026';
named('event').position={left:64,top:64,width:1152,height:34};
style(named('event'),{size:22,color:C.blue});
named('stage').text='Idea submission / Proposed prototype';
named('stage').position={left:64,top:112,width:1152,height:34};
style(named('stage'),{size:20,color:C.muted});
named('title').position={left:64,top:234,width:1152,height:140};
style(named('title'),{size:96,color:C.blue,font:'Georgia'});
named('subtitle').position={left:68,top:390,width:1080,height:106};
style(named('subtitle'),{size:34});
named('team').position={left:68,top:572,width:1000,height:80};
style(named('team'),{size:26});
cover.speakerNotes.text=cover.speakerNotes.text.replace('The cover artwork is conceptual. ','');

// Quiet tables with a pale header, neutral alternating rows and hairline rules.
const tableSnapshot=await p.inspect({kind:'table',maxChars:100000});
const tables=tableSnapshot.ndjson.split('\n').filter(Boolean).map(x=>JSON.parse(x)).filter(x=>x.kind==='table');
for(const row of tables) {
  const t=p.resolve(row.id);
  t.borders.assign({style:'solid',fill:C.line,width:0.45});
  for(let r=0;r<row.rows;r++)for(let c=0;c<row.cols;c++) {
    const cell=t.getCell(r,c);
    cell.fill=r===0?C.header:(r%2===0?C.band:C.paper);
    cell.text.style={typeface:'Arial',fontSize:23,color:r===0?C.blue:C.text,bold:r===0||c===0,alignment:'left',verticalAlignment:'middle',wrap:'square',autoFit:'none',insets:{top:10,bottom:10,left:14,right:14}};
  }
}

const candidate=path.join(build,'theme-candidate.pptx');
await (await PresentationFile.exportPptx(p)).save(candidate);
await fs.writeFile(path.join(build,'presentation.json'),JSON.stringify(p.toProto(),null,2));
for(let i=0;i<10;i++) {
  const png=await p.slides.items[i].export({format:'png',scale:1});
  await fs.writeFile(path.join(build,'renders',`slide-${String(i+1).padStart(2,'0')}.png`),new Uint8Array(await png.arrayBuffer()));
}
const {finalizePresentation}=await import(pathToFileURL(path.join(skill,'container_tools/artifact_tool_utils.mjs')).href);
const owners=tables.map(t=>t.slideIndex+1);
const validated=path.join(build,'validated/TaskLatch-CodeQuest-2026.pptx');
const result=await finalizePresentation({
  workspaceDir:root,candidatePath:candidate,finalPath:validated,explicitTotalSlideCount:10,
  requiredNativeTableOwnerSlides:owners,requiredNativeChartOwnerSlides:[],pythonExecutable:python,
  integrityValidatorPath:path.join(skill,'container_tools/inspect_presentation_package_integrity.py'),
  layoutValidatorPath:path.join(skill,'container_tools/inspect_presentation_layout_geometry.py'),
  layoutArgs:['--expected-slide-size-emu','12192000,6858000','--validate-heading-fit',...owners.flatMap(n=>['--require-native-table-slide',String(n)])],
  fontPolicy:{basis:'design',families:['Arial','Georgia']},verifyArtifactToolImport:true,
  receiptPath:path.join(root,'.codex-finalizer/TaskLatch-editorial-theme.validation.json')
});
await fs.copyFile(validated,publicPath);
const sha=crypto.createHash('sha256').update(await fs.readFile(publicPath)).digest('hex');
if(sha!==result.finalSha256)throw new Error('Delivered theme deck differs from validated bytes');
const notesPath=path.join(root,'presentation/PRESENTER_NOTES.md');
await fs.writeFile(notesPath,(await fs.readFile(notesPath,'utf8')).replace('The cover artwork is conceptual. ',''));
console.log(JSON.stringify({publicPath,sha256:sha,slideCount:10,layoutFindings:result.presentationLayout.finding_count,layoutWarnings:result.presentationLayout.warnings,fontCounts:result.fontSelection.observed_font_use_counts,importPassed:result.firstPartyImport.passed},null,2));
