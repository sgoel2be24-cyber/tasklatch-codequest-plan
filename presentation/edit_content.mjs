import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {FileBlob, PresentationFile} from '@oai/artifact-tool';

// Content revision of the existing PPTX. Reuse its slides, cover, theme,
// title positions and footers. New diagrams are native editable objects.
const root=process.cwd();
const skill='/Users/Shikhar/.codex/plugins/cache/openai-primary-runtime/presentations/26.1026.10807/skills/presentations';
const python='/Users/Shikhar/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3';
process.env.RUNTIME_NODE_MODULES ??= '/Users/Shikhar/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules';
process.env.RUNTIME_PYTHON ??= python;
const build=path.join(root,'.build/presentation/content-edit');
const publicPath=path.join(root,'presentation/output/TaskLatch-CodeQuest-2026.pptx');
await fs.mkdir(build,{recursive:true});
await fs.mkdir(path.join(build,'renders'),{recursive:true});
await fs.mkdir(path.join(build,'validated-v3'),{recursive:true});
await fs.mkdir(path.join(root,'.codex-finalizer'),{recursive:true});
const original=path.join(build,'before-content-edit.pptx');
try { await fs.copyFile(publicPath,original,fs.constants.COPYFILE_EXCL); }
catch(e) { if(e.code!=='EEXIST') throw e; }
const refHash=crypto.createHash('sha256').update(await fs.readFile(original)).digest('hex');
const p=await PresentationFile.importPptx(await FileBlob.load(original));
if(p.slides.items.length!==10) throw new Error('Expected the existing 10-slide deck');
const C={ink:'#10181B',cream:'#F5F3ED',mint:'#8DE8C3',green:'#12664F',muted:'#A9BBB5',gray:'#52645E',line:'#D5DDD5',light:'#E9EFE8'};
const FONT='Arial';
const darkSlides=new Set([2,4,8,10]);
const notes=[], content=[], tableOwners=[];
const persistent=new Set(['section','title','footer-brand','footer-number']);
for(let i=1;i<10;i++) {
  const found=await p.inspect({select:`$.slides[${i}].elements[*]`,include:['id','name']});
  if(!found.records || found.records.filter(r=>persistent.has(r.name)).length!==4)
    throw new Error(`Slide ${i+1}: persistent element inspection failed`);
  p.delete(found.records.filter(r=>!persistent.has(r.name)).map(r=>r.id));
}
function text(s,name,value,x,y,w,h,size=26,color=C.ink,bold=false,align='left') {
  const sh=s.shapes.add({geometry:'textbox',name,position:{left:x,top:y,width:w,height:h},fill:'none',line:{fill:'none',width:0}});
  sh.text=value;
  sh.text.style={typeface:FONT,fontSize:size,bold,color,alignment:align,verticalAlignment:'top',wrap:'square',autoFit:'none',insets:0};
  return sh;
}
function slide(n,section,title) {
  const s=p.slides.items[n-1];
  const dark=darkSlides.has(n);
  const byName=name=>s.shapes.items.find(x=>x.name===name);
  byName('section').text=section.toUpperCase();
  byName('title').text=title;
  byName('title').text.style={typeface:FONT,fontSize:44,bold:true,color:dark?C.cream:C.ink,insets:0,autoFit:'none',wrap:'square'};
  return s;
}
function record(s,title,body,source=[],visible=[]) {
  s.speakerNotes.text=body+'\n\nSources:\n'+(source.length?source.join('\n'):'Original project proposal. Capabilities and targets remain planned.');
  notes.push({n:notes.length+1,title,body,source});
  content.push({n:content.length+1,title,visible});
}
function table(s,n,values,widths,top,heights) {
  const dark=darkSlides.has(n);
  const t=s.tables.add({rows:values.length,columns:values[0].length,left:64,top,width:1152,height:heights.reduce((a,b)=>a+b,0),columnWidths:widths,values});
  t.borders.assign({style:'solid',fill:dark?'#34453F':C.line,width:0.7});
  for(let r=0;r<values.length;r++) {
    t.rows[r].height=heights[r];
    for(let c=0;c<values[0].length;c++) {
      const cell=t.getCell(r,c);
      cell.fill=r===0?(dark?C.mint:C.ink):(dark?C.ink:C.cream);
      cell.text.style={typeface:FONT,fontSize:23,bold:r===0,color:r===0?(dark?C.ink:C.cream):(dark?C.cream:C.ink),verticalAlignment:'middle',insets:{top:10,bottom:10,left:14,right:14},wrap:'square',autoFit:'none'};
    }
  }
  tableOwners.push(n); return t;
}
function box(s,name,title,body,x,y,w,h,{strong=false,titleSize=26,bodySize=23}={}) {
  const sh=s.shapes.add({geometry:'rect',name,position:{left:x,top:y,width:w,height:h},fill:strong?C.ink:C.light,line:{style:'solid',fill:C.green,width:1.5}});
  text(s,name+'-title',title,x+12,y+12,w-24,36,titleSize,strong?C.cream:C.ink,true,'center');
  text(s,name+'-body',body,x+12,y+52,w-24,h-59,bodySize,strong?C.cream:C.ink,false,'center');
  return sh;
}
function link(s,a,b,fromSide='right',toSide='left',both=false,dashed=false) {
  return s.shapes.connect(a,b,{kind:'straight',fromSide,toSide,line:{style:dashed?'dashed':'solid',fill:C.green,width:2},tail:{type:'triangle',width:'sm',length:'sm'},...(both?{head:{type:'triangle',width:'sm',length:'sm'}}:{})});
}
const official='https://unstop.com/hackathons/codequest-national-tech-hackathon-2026-dotrepo-1771441/amp';
const opticon='https://github.com/23jmo/opticon';
const nvidia='https://build.nvidia.com/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning';

// 1. Cover. Preserve the exact artwork and all existing geometry.
{
  const s=p.slides.items[0];
  s.shapes.items.find(x=>x.name==='subtitle').text='Control and verification\nfor AI desktop agents';
  record(s,'TaskLatch','TaskLatch is Team Update’s proposed local workspace for AI desktop agents. Two workers will research suppliers while a separate controller enforces permissions, a shared resource allowance and independent completion checks. Presenter: Shikhar. This is an idea-stage proposal, not an implemented or benchmarked system. The cover artwork is conceptual. Opticon is an attributed orchestration reference.',[official,opticon],['TaskLatch','Control and verification for AI desktop agents','Team Update','Presented by Shikhar','Idea submission, proposed prototype']);
}
// 2. State the exact problem before showing the solution.
{
  const s=slide(2,'Problem statement','The failures we aim to prevent');
  const statement='AI desktop agents can submit unapproved purchase requests, exceed a shared resource limit, or report success without a valid saved result.';
  text(s,'problem-definition',statement,64,195,1152,131,32,C.cream,true);
  const rows=[
    ['Permission','A plan approval can leave the final supplier, quantity and total unchecked.'],
    ['Shared limits','Parallel workers and retries can exceed combined limits on model calls, tokens and steps.'],
    ['Completion','An agent’s “done” message does not prove the correct request was saved.']
  ];
  rows.forEach((r,i)=>{text(s,`problem-label-${i}`,r[0],64,352+i*90,237,52,27,C.mint,true);text(s,`problem-detail-${i}`,r[1],330,352+i*90,886,67,27,C.cream);});
  const user='First user: an operations team member delegating supplier research.';
  text(s,'initial-user',user,64,624,1152,35,23,C.muted);
  record(s,'The failures we aim to prevent','The problem is a gap between a delegated task and the authority, resource use and actual result of an agent run. The first user and supplier workflow are proposed, not validated customer demand. We will target three observable failures: a purchase-request write outside exact user approval, parallel work exceeding the shared allowance, and a success status despite missing or incorrect saved output. These risks are conditional on the integration and permissions, not claims that every agent product lacks controls. The reviewed Opticon worker source and demonstration motivate independent verification, but they are not a full security audit. Supporting industry evidence: a CSA / Token Security January 2026 survey of 418 IT/security respondents found that 65% reported an agent or autonomous-workflow incident in the preceding year. It is self-reported, broadly defined, vendor-funded and does not establish a per-task incident rate or average monetary loss. The problem statement, rather than that statistic, leads the slide.',[
    'Industry evidence: https://cloudsecurityalliance.org/press-releases/2026/04/21/new-cloud-security-alliance-survey-reveals-82-of-enterprises-have-unknown-ai-agents-in-their-environments',
    'Reviewed reference: https://github.com/23jmo/opticon/blob/ce4d098ed5ba86e564da72ddb816716b4b72c602/workers/worker.py',
    'Reference demonstration: https://www.youtube.com/watch?v=Sc6lU9XTJmo'
  ],[statement,...rows.map(x=>x.join(': ')),user]);
}
// 3. Proposed solution, clear pipeline, failure branch and explicit USP.
{
  const s=slide(3,'Proposed solution and USP','TaskLatch: controlled desktop agents');
  const definition='TaskLatch will run two AI agents on local desktops under a separate controller.\nThe agents will research suppliers and prepare a test purchase request in SupplierLab.';
  text(s,'solution-definition',definition,64,190,1152,78,27,C.ink);
  const fixture='SupplierLab is our local test app with synthetic vendors and requests.';
  text(s,'fixture-definition',fixture,64,275,1152,34,23,C.gray);
  const steps=[['Task + limits','User sets scope'],['Research','Read-only work'],['User review','Exact request'],['Submit','Controller only'],['Verify result','Read receipt']];
  const nodes=steps.map((v,i)=>box(s,`flow-${i+1}`,v[0],v[1],64+i*236,330,208,96,{strong:i===2,titleSize:25}));
  for(let i=0;i<4;i++)link(s,nodes[i],nodes[i+1]);
  text(s,'approved-edge-label','Approved',710,301,150,27,20,C.green,true,'center');
  const denied=s.shapes.add({geometry:'rect',name:'flow-denied',position:{left:536,top:465,width:208,height:66},fill:C.cream,line:{style:'dashed',fill:C.gray,width:1.5}});
  text(s,'denial-label','No submission',546,484,188,30,23,C.gray,false,'center');
  text(s,'denied-edge-label','Denied / changed',665,436,250,27,20,C.gray);
  link(s,nodes[2],denied,'bottom','top',false,true);
  const limit='The controller limits total model calls, tokens, steps and retries across both workers.';
  text(s,'global-limits',limit,64,551,1152,39,24,C.ink);
  const usp='USP: exact action approval, one shared allowance and verified completion in a local desktop workflow.';
  text(s,'usp',usp,64,606,1152,53,25,C.green,true);
  record(s,'TaskLatch: controlled desktop agents','This is the proposed solution, not a screenshot of an existing product. The user sets the task, allowed sources and shared resource limits. Two local workers research read-only synthetic vendor pages and produce a comparison and draft request. The controller presents the exact destination, vendor, quantity, unit price and final total for user approval. The write broker submits only that exact approved operation. A separate verifier reads the stored receipt and checks its fields and the saved report before the UI can claim success. Rejection, changed content or expired approval prevents submission and triggers fresh review when appropriate. Resource reservations apply to the coordinator, both workers, model calls and retries throughout the run, rather than only at a single step. Unknown and failed results remain distinct from success. The workflow integration is our proposed USP; authorization, runtime controls and tracing are established categories.',[],[definition.replace('\n',' '),fixture,...steps.map((v,i)=>`${i+1}. ${v.join(': ')}`),'Denied or changed: no submission',limit,usp]);
}
// 4. Innovation, named alternatives and precisely scoped original work.
{
  const s=slide(4,'Innovation and uniqueness','Existing capabilities and our contribution');
  const values=[
    ['Reference','Existing capability','TaskLatch will add or integrate'],
    ['Opticon','Parallel desktops and task approval','Exact request approval and receipt checks'],
    ['Permit + LangGraph','Tool authorization and approval','Enforce approval on the saved request'],
    ['LiteLLM','Model usage budgets and accounting','Shared steps, retries and verified stop'],
    ['OpenShell + Zenity','Runtime policy and action controls','A local workflow with reproducible tests']
  ];
  table(s,4,values,[250,420,482],200,[52,76,76,76,76]);
  const contribution='Our original work: the controller, SupplierLab integration, action evidence and tests against an agent loop without controls.';
  text(s,'original-work',contribution,64,584,1152,66,25,C.mint,true);
  text(s,'attribution','Opticon is an attributed reference. Individual approval and runtime controls already exist.',64,649,1152,25,20,C.muted);
  record(s,'Existing capabilities and our contribution','This is a scope comparison based on primary documentation, not an independently benchmarked competitor ranking. TaskLatch does not claim to invent approvals, budgets, sandboxing or runtime policy. Opticon is the direct parallel-desktop and task-approval reference. TaskLatch’s proposed original work is the independently implemented controller, SupplierLab’s enforced write boundary, structured approval/action/result evidence and paired evaluation against our own baseline loop. Permit and LangGraph already provide integrated authorization and approval patterns. LiteLLM already covers model-traffic budgeting. OpenShell documents filesystem, process and network policy, while Zenity makes directly overlapping runtime-control claims. Our desktop workflow must integrate the controls and prove useful completion as well as blocked forbidden writes. Source reuse requires license and notice verification before copying. The initial version is a focused local prototype, not a universal security gateway.',[
    opticon,
    'https://docs.permit.io/permit-mcp-gateway/human-in-the-loop',
    'https://docs.langchain.com/oss/python/langchain/human-in-the-loop',
    'https://docs.litellm.ai/docs/proxy/architecture',
    'https://docs.nvidia.com/openshell/how-it-works/policies/overview',
    'https://zenity.io/platform/runtime-boundaries'
  ],[...values.map(r=>r.join(' / ')),contribution,'Opticon is attributed. Individual controls already exist.']);
}
// 5. Editable architecture diagram with the technology on its owning component.
{
  const s=slide(5,'Technology stack','Local architecture and enforcement');
  const ui=s.shapes.add({geometry:'rect',name:'arch-ui',position:{left:460,top:194,width:360,height:76},fill:C.light,line:{style:'solid',fill:C.green,width:1.5}});
  text(s,'arch-ui-title','Review UI',472,202,336,34,26,C.ink,true,'center');
  text(s,'arch-ui-stack','React + TypeScript + Vite',472,239,336,28,23,C.ink,false,'center');
  const workers=box(s,'arch-workers','2 Linux desktops','Colima VM, 2 containers\nChromium + Playwright\nXvfb + noVNC',64,350,340,145);
  const controller=box(s,'arch-controller','Trusted controller','Node.js + Zod\nPolicy, budgets, approvals\nWrite broker + verifier',460,335,360,175,{strong:true});
  const model=box(s,'arch-model','NVIDIA API','Nemotron model\nScreenshot reasoning\nKey test pending',920,350,296,145);
  const fixture=s.shapes.add({geometry:'rect',name:'arch-supplierlab',position:{left:460,top:570,width:360,height:76},fill:C.light,line:{style:'solid',fill:C.green,width:1.5}});
  text(s,'arch-fixture-title','SupplierLab + SQLite',472,580,336,33,26,C.ink,true,'center');
  text(s,'arch-fixture-body','Requests, receipts and evidence',472,617,336,28,23,C.ink,false,'center');
  link(s,ui,controller,'bottom','top',true);
  link(s,workers,controller,'right','left',true);
  link(s,controller,model,'right','left',true);
  link(s,controller,fixture,'bottom','top',true);
  text(s,'arch-approval-label','Approve + monitor',666,290,300,30,23,C.gray);
  text(s,'arch-model-label','API',834,386,72,30,23,C.gray,false,'center');
  text(s,'arch-commit-label','Submit + read back',666,531,240,30,23,C.gray);
  text(s,'arch-container-limit','Both workers share one VM kernel. Personal files stay outside the VM.',64,555,340,99,23,C.gray);
  text(s,'arch-write-boundary','Only the controller holds model keys and the write credential.',920,555,296,99,23,C.green,true);
  record(s,'Local architecture and enforcement','This diagram is the proposed architecture. It is not a claim that the runtime has been started or tested. The React/TypeScript/Vite interface communicates with a separate Node.js controller over HTTP/WebSocket for approvals, status and control. Zod validates structured action and result schemas. The controller orchestrates a dedicated Colima Linux VM containing two desktop containers, running Chromium, Playwright, Xvfb and noVNC. Desktop commands and screenshots pass through the controller. The NVIDIA key stays with the controller, which sends screenshots to an image-capable model and validates returned action proposals. Candidate: nvidia/nemotron-3-nano-omni-30b-a3b-reasoning. Image input, reliable structured actions, actual key access and usage limits require a capability probe. The worker browser identity has read authority only. SupplierLab’s server allows a write only from the controller broker after authorization, so a direct browser form or HTTP request cannot bypass review. SQLite holds request/receipt and trusted control state. The verifier uses an independent read of saved state. Containers share the VM kernel, so this is not a separate microVM per worker or production malware-isolation claim. No host-home shares, personal browser profiles, provider keys or daemon sockets enter the workers.',[
    'https://github.com/abiosoft/colima',
    'https://docs.docker.com/engine/security/',
    nvidia
  ],['Review UI: React, TypeScript, Vite','Controller: Node.js, Zod, permissions, budgets, approval broker, verifier','Two desktops: Colima Linux VM, containers, Chromium, Playwright, Xvfb, noVNC','NVIDIA Nemotron API: screenshot reasoning, key test pending','SupplierLab and SQLite: requests, receipts, evidence','Workers share one VM kernel. Only the controller holds keys and the write credential.']);
}
// 6. Implementation, concrete evidence and conditional cost baseline.
{
  const s=slide(6,'Implementation plan','Build sequence and completion evidence');
  const values=[
    ['Dates','We will build','Completion evidence'],
    ['2–3 Nov','Two local desktops and NVIDIA model test','Screenshots, valid actions and worker stop'],
    ['4–7 Nov','SupplierLab, permissions and exact approval','Unapproved and changed requests fail'],
    ['8–11 Nov','Shared limits, stop and result verification','Both workers respect limits, receipts match'],
    ['12–15 Nov','UI, evaluation, fixes and recorded demo','Test report, demo and reproducible setup']
  ];
  table(s,6,values,[166,500,486],200,[52,78,78,78,78]);
  const cost='Cost baseline: local open-source tools and NVIDIA free access, subject to key and quota tests.';
  text(s,'cost-baseline',cost,64,622,1152,39,23,C.green,true);
  record(s,'Build sequence and completion evidence','These are proposed milestones for the event’s 2–15 November prototype window. The first milestone must prove that the existing laptop can run two desktops, produce screenshots, execute structured actions and stop workers, while a real NVIDIA key confirms image access, usage metadata and practical request limits. No model key has yet been supplied or tested. Do not promise reliable computer use from the model page alone. The next milestone builds SupplierLab and the external authorization boundary, followed by shared reservations, an independent stop path and receipt verification. The final milestone runs the evaluation protocol and packages reproducible setup, failure evidence and a labelled recorded fallback. The zero-cash baseline assumes the existing laptop, internet and usable NVIDIA free access. E2B is excluded because this user account requires a verification payment. Fireworks stays off unless credits and spending authorization are confirmed. If model or hardware gates fail, record the limitation rather than substituting a billable dependency or pretending a scripted path is a live agent result. The schedule is an implementation plan, not completed progress.',[
    official,
    nvidia,
    'https://docs.api.nvidia.com/nim/docs/run-anywhere',
    'https://fireworks.ai/pricing'
  ],[...values.map(r=>r.join(' / ')),cost]);
}
// 7. Impact framed as specific benefits and measurements, not invented savings.
{
  const s=slide(7,'Impact','Expected impact and beneficiaries');
  const beneficiaries='Initial beneficiaries: small operations teams delegating supplier research and developers testing agent workflows.';
  text(s,'beneficiaries',beneficiaries,64,190,1152,75,27,C.ink);
  const values=[
    ['Expected benefit','What we will measure'],
    ['Keep request submissions within user approval','Unauthorized writes and rejected attempts'],
    ['Keep parallel work within one task allowance','Model calls, tokens, steps, retries and stop time'],
    ['Link success to a verified saved result','Receipt correctness, false success and review time']
  ];
  table(s,7,values,[586,566],278,[52,88,88,88]);
  text(s,'impact-status','Expected benefits, to test. No measured savings or incident reduction yet.',64,629,1152,31,23,C.green,true);
  record(s,'Expected impact and beneficiaries','The initial beneficiary segments and adoption assumptions have not been validated through user research. The proposed benefit is narrower authority and resource use while retaining useful supplier research. The evaluation will count actual forbidden writes and rejected attempts, not merely model refusals. It will report resource reservations, reconciled consumption and stopping latency. Independent receipt and report checks will expose false success. Measure operator review time and false blocks as usability costs, so preventing every action does not masquerade as useful impact. No financial saving, percentage incident reduction, customer traction or production-readiness result is claimed. Real-world impact and demand require later user testing. The first prototype uses synthetic vendors and purchase requests in SupplierLab.',[],[beneficiaries,...values.map(r=>r.join(' / ')),'Expected benefits, to test. No measured savings or incident reduction yet.']);
}
// 8. One exact example makes permission semantics assessable.
{
  const s=slide(8,'How approval works','Example: a ₹9,000 test purchase request');
  text(s,'example-scope','Planned SupplierLab scenario. Synthetic data, no payment.',64,190,1152,44,26,C.cream);
  const values=[
    ['Review field','Exact value','Controller check'],
    ['Vendor','V-03 / SupplierLab','Destination matches the approval'],
    ['Request','20 adapters at ₹450 each','Quantity and unit price match'],
    ['Total','₹9,000, tax included, ₹0 shipping','Final total matches the review'],
    ['Approval','Single use, expires after 60 seconds','Reject changes, expiry and reuse']
  ];
  table(s,8,values,[168,456,528],242,[52,69,69,69,69]);
  const changed='If the quantity changes to 21, the controller must reject the old approval and require a fresh review.';
  text(s,'changed-payload',changed,64,598,1152,65,25,C.mint,true);
  record(s,'Example: a ₹9,000 test purchase request','This example is a design contract, not a test result or actual purchase. Twenty adapters at ₹450 each totals ₹9,000, including tax and with no shipping charge. Exact approval binds the action type, destination, supplier/resource version, payload, policy version and idempotency key. It expires after the proposed 60-second review window and is single-use. The controller rechecks authorization at execution and consumes it atomically. A changed quantity of 21 would imply a different total and a different payload, so old approval must not authorize it. Direct worker writes, expired approvals and token replay must fail at SupplierLab’s server boundary. A matching persisted receipt is necessary before success. If an acknowledgement is lost after a write, read by idempotency key before retrying to avoid duplicate requests.',[],['Planned synthetic example. No payment.',...values.map(r=>r.join(' / ')),changed]);
}
// 9. Evaluation has clear denominators and visible target status.
{
  const s=slide(9,'Evaluation plan','Tests and acceptance targets');
  text(s,'boundary-count','34 planned boundary checks',64,196,560,43,30,C.ink,true);
  text(s,'boundary-explanation','Fixed tests of approvals, limits and results',64,244,560,35,24,C.gray);
  text(s,'session-count','72 planned model sessions',680,196,536,43,30,C.ink,true);
  text(s,'session-denominator','12 scenarios × 3 repeats × 2 modes',680,244,536,35,24,C.gray);
  text(s,'mode-definition','Compare the same tasks with controls off and on in our own local agent loop.',64,296,1152,34,23,C.gray);
  const values=[
    ['Dimension','Acceptance target or measurement'],
    ['Authorization','No unapproved writes or accepted stale approvals'],
    ['Task completion','At least 80% completion on allowed tasks, report incorrect blocks'],
    ['Correct status','No success label without independent result checks'],
    ['Shared limits','Reject new work that would exceed the shared allowance'],
    ['Stopping','Stop both workers within 5 seconds under local test load']
  ];
  table(s,9,values,[290,862],338,[48,48,48,48,48,48]);
  text(s,'planned-targets','Planned targets, not results. Report executed counts, failures and missing usage data.',64,636,1152,29,22,C.green,true);
  record(s,'Tests and acceptance targets','All figures are planned experiment sizes and internally chosen engineering targets, not measured results or official judging weights. The detailed protocol is docs/EVALUATION_PLAN.md. The 34 deterministic cases cover approval changes, expiry, identity and replay, direct-write bypass, concurrent reservations, stopping, missing or invalid receipts, untrusted page findings and operator access. The 72 planned model sessions consist of six benign and six challenge scenarios, each repeated three times in two modes. Our baseline is an independently built Opticon-inspired loop, not unmodified Opticon. Both modes use the same synthetic fixture tasks, versions and resource ceilings. Count meaningful benign completion as verified correct deliverables over all benign sessions, and report false blocks. Distinguish attempted forbidden writes, policy denials and actual resource changes. Zero observed failures in a small set does not prove universal prevention. The five-second stopping target applies to the defined local workload and requires independent process-exit timestamps, separate from the time the controller refuses new work. Report actual executed counts, timeouts, provider failures and missing token usage. If free access limits prevent the planned batch, explicitly report incompleteness. Preserve raw failures and avoid changing targets after results are known.',[],['34 planned boundary checks: fixed tests of approvals, limits and results','72 planned sessions: 12 scenarios × 3 repetitions × 2 modes','Compare the same tasks with controls off and on in our own local agent loop',...values.map(r=>r.join(' / ')),'Planned targets, not results. Report actual denominators and failures.']);
}
// 10. Judges can see exactly what the prototype is expected to demonstrate.
{
  const s=slide(10,'Prototype evidence','Planned prototype demonstration');
  const values=[
    ['Scenario','What we will run','Expected proof'],
    ['Normal task','Research suppliers and submit an approved request','Comparison report and matching saved receipt'],
    ['Changed request','Increase quantity after user approval','Denial reason and no changed request'],
    ['Retry loop','Make both workers repeat requests','Shared allowance reached, no new actions'],
    ['Missing result','Remove or corrupt a stored receipt','Unverified or failed status, never success']
  ];
  table(s,10,values,[190,440,522],210,[52,83,83,83,83]);
  const limitation='Synthetic vendors and requests. No real purchases. Any financial limit test uses simulated prices.';
  text(s,'demo-limits',limitation,64,620,1152,46,23,C.muted);
  record(s,'Planned prototype demonstration','The final prototype should show a useful successful task and controlled failure paths, not just a safety dashboard. In the normal path, the two desktops produce supplier comparisons, the user approves an exact request, the controller submits it and the verifier reads a matching saved receipt. In the changed-request case, the attempted mutation must not create a changed request. In the retry case, the shared reservation ledger and independent stop path must prevent new work after the allowance is exhausted. In the missing-result case, the UI must preserve unverified/failed status rather than accepting an agent success message. Show action, approval, budget, result and verification evidence. These are expected demonstrations, not completed tests. All business data is synthetic and no real purchases, production credentials or external email are involved. Actual model request/token counts are measured when the provider reports them. Currency-budget scenarios use explicitly simulated tariffs, not an invoice or measured financial savings. E2B is excluded, Fireworks is off without confirmed credit/spending authorization, and NVIDIA free endpoint access remains dependent on a real-key capability/limit test. Cloud runtimes and new business integrations are later extensions after the local boundary works.',[],[...values.map(r=>r.join(' / ')),limitation]);
}

await fs.writeFile(path.join(root,'presentation/PRESENTER_NOTES.md'),'# TaskLatch presenter notes\n\nContent revision: problem on slide 2, proposed solution and USP on slide 3. All capabilities and targets remain planned unless explicitly identified as sourced evidence.\n\n'+notes.map(x=>`## ${x.n}. ${x.title}\n\n${x.body}\n\n${x.source.map(z=>'- '+z).join('\n')}`).join('\n\n'));
await fs.writeFile(path.join(root,'presentation/SLIDE_CONTENT.md'),'# TaskLatch slide content\n\nConcise review copy of the revised PPT. Diagrams in the PPT are editable. All prototype behavior and acceptance targets are planned.\n\n'+content.map(x=>`## ${x.n}. ${x.title}\n\n${x.visible.map(v=>'- '+v.replaceAll('\n',' ')).join('\n')}`).join('\n\n'));
const candidate=path.join(build,'content-candidate.pptx');
await (await PresentationFile.exportPptx(p)).save(candidate);
await fs.writeFile(path.join(build,'presentation.json'),JSON.stringify(p.toProto(),null,2));
for(let i=0;i<10;i++) {
  const png=await p.slides.items[i].export({format:'png',scale:1});
  await fs.writeFile(path.join(build,'renders',`slide-${String(i+1).padStart(2,'0')}.png`),new Uint8Array(await png.arrayBuffer()));
}
const {finalizePresentation}=await import(pathToFileURL(path.join(skill,'container_tools/artifact_tool_utils.mjs')).href);
const finalPath=path.join(build,'validated-v3/TaskLatch-CodeQuest-2026.pptx');
const result=await finalizePresentation({
  workspaceDir:root,candidatePath:candidate,finalPath,
  explicitTotalSlideCount:10,
  requiredNativeTableOwnerSlides:tableOwners,
  requiredNativeChartOwnerSlides:[],
  pythonExecutable:python,
  integrityValidatorPath:path.join(skill,'container_tools/inspect_presentation_package_integrity.py'),
  layoutValidatorPath:path.join(skill,'container_tools/inspect_presentation_layout_geometry.py'),
  layoutArgs:['--expected-slide-size-emu','12192000,6858000','--validate-heading-fit',...tableOwners.flatMap(n=>['--require-native-table-slide',String(n)])],
  fontPolicy:{basis:'reference',families:[FONT],referencePath:original,referenceSha256:refHash},
  verifyArtifactToolImport:true,
  receiptPath:path.join(root,'.codex-finalizer/TaskLatch-content-revision-v3.validation.json')
});
await fs.copyFile(finalPath,publicPath);
const deliveredHash=crypto.createHash('sha256').update(await fs.readFile(publicPath)).digest('hex');
if(deliveredHash!==result.finalSha256)throw new Error('Copied final PPTX hash differs');
console.log(JSON.stringify({publicPath,slideCount:10,nativeTables:tableOwners,layoutFindings:result.presentationLayout.finding_count,layoutWarnings:result.presentationLayout.warnings,importPassed:result.firstPartyImport.passed,sha256:deliveredHash},null,2));
