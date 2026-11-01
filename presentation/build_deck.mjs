import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Presentation, PresentationFile } from '@oai/artifact-tool';

// Run the copy in .build/presentation to resolve the bundled workspace libraries.
// All measurements are CSS pixels at 96 dpi. All content except the cover art is editable.
const root = process.cwd();
const buildDir = path.join(root, '.build/presentation');
const skill = '/Users/Shikhar/.codex/plugins/cache/openai-primary-runtime/presentations/26.1026.10807/skills/presentations';
const runtimePython = '/Users/Shikhar/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3';
process.env.RUNTIME_NODE_MODULES ??= '/Users/Shikhar/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules';
process.env.RUNTIME_PYTHON ??= runtimePython;
const W = 1280, H = 720;
const C = {ink:'#10181B', cream:'#F5F3ED', mint:'#8DE8C3', green:'#12664F', muted:'#A9BBB5', gray:'#52645E', line:'#D5DDD5', light:'#E9EFE8'};
const FONT = 'Arial';
const presentation = Presentation.create({slideSize:{width:W,height:H}});
const notes = [];
const nativeTables = [];

function txt(slide, name, text, x,y,w,h,size=26,color=C.ink,bold=false,align='left') {
  const box = slide.shapes.add({geometry:'textbox',name,position:{left:x,top:y,width:w,height:h},fill:'none',line:{fill:'none',width:0}});
  box.text = text;
  box.text.style = {typeface:FONT,fontSize:size,bold,color,alignment:align,verticalAlignment:'top',wrap:'square',autoFit:'none',insets:0};
  return box;
}
function base(num, section, title, dark=false) {
  const slide = presentation.slides.add();
  slide.background.fill = dark ? C.ink : C.cream;
  const fg = dark ? C.cream : C.ink;
  txt(slide,'section',section.toUpperCase(),64,36,1120,26,18,dark?C.mint:C.green,true);
  txt(slide,'title',title,64,90,1152,90,44,fg,true);
  txt(slide,'footer-brand','TASKLATCH   /   TEAM UPDATE',64,672,950,23,16,dark?C.muted:C.gray);
  txt(slide,'footer-number',String(num).padStart(2,'0'),1160,672,56,23,16,dark?C.muted:C.gray,false,'right');
  return slide;
}
function note(slide,title,text,sources=[]) {
  const body = `${text}\n\nSources and disclosure:\n${sources.join('\n') || 'Original project proposal. Capabilities are planned, not measured results.'}`;
  slide.speakerNotes.text=body;
  notes.push({slide:notes.length+1,title,text,sources});
}
function table(slide, num, values, widths, top, rowHeights, opts={}) {
  const dark=!!opts.dark;
  const t=slide.tables.add({rows:values.length,columns:values[0].length,left:64,top,width:1152,height:rowHeights.reduce((a,b)=>a+b,0),columnWidths:widths,values});
  t.borders.assign({style:'solid',fill:dark?'#34453F':C.line,width:0.7});
  for(let r=0;r<values.length;r++) {
    t.rows[r].height=rowHeights[r];
    for(let c=0;c<values[0].length;c++) {
      const cell=t.getCell(r,c);
      cell.fill=r===0?(dark?C.mint:C.ink):(dark?C.ink:C.cream);
      cell.text.style={typeface:FONT,fontSize:r===0?23:24,color:r===0?(dark?C.ink:C.cream):(dark?C.cream:C.ink),bold:r===0,verticalAlignment:'middle',insets:{top:12,bottom:12,left:16,right:16},wrap:'square',autoFit:'none'};
    }
  }
  nativeTables.push(num);
  return t;
}

// 01 — cover. This image is conceptual artwork, not a product screenshot.
{
  const s=presentation.slides.add(); s.background.fill=C.ink;
  const bytes=await fs.readFile(path.join(root,'presentation/assets/tasklatch-cover.png'));
  s.images.add({blob:bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),contentType:'image/png',alt:'Conceptual silver latch with two mint filaments on a dark background',fit:'cover',position:{left:0,top:0,width:W,height:H}});
  txt(s,'event','CODEQUEST 2026',64,52,540,34,23,C.mint,true);
  txt(s,'title','TaskLatch',64,225,590,104,76,C.cream,true);
  txt(s,'subtitle','Controlled local desktops\nfor AI agents',68,350,535,108,36,C.cream);
  txt(s,'team','Team Update\nPresented by Shikhar',68,550,520,74,26,C.cream);
  txt(s,'stage','IDEA SUBMISSION   /   PROPOSED PROTOTYPE',68,666,1020,28,18,C.muted);
  note(s,'TaskLatch','TaskLatch is an independently planned local computer-agent control project. The idea is to keep delegated browser work useful while putting consequential actions behind controller-enforced permissions, shared resource limits and independent outcome verification. The working scope is two local desktop workers, one synthetic supplier workflow and no mandatory paid infrastructure. Team name and presenter are provided by the user. Cover illustration is AI-generated conceptual art, not evidence of an implemented application.',[
    'CodeQuest official requirements: https://unstop.com/hackathons/codequest-national-tech-hackathon-2026-dotrepo-1771441/amp',
    'Opticon reference: https://github.com/23jmo/opticon'
  ]);
}
// 02 — evidence and the precise problem.
{
  const s=base(2,'Problem statement','Delegation can outgrow permission',true);
  txt(s,'stat','65%',64,215,480,150,128,C.mint,true);
  txt(s,'stat-definition','reported an AI-agent or autonomous-workflow\nsecurity incident in the preceding year',68,385,570,100,27,C.cream);
  txt(s,'risk-heading','For a small operations team',720,223,490,72,30,C.cream,true);
  txt(s,'risk-body','A research task can become a purchase request.\n\nA retry loop can consume the shared allowance.\n\nA worker can claim success after an error.',720,310,475,266,27,C.cream);
  txt(s,'survey-caveat','CSA / Token Security survey, Jan 2026. 418 IT/security respondents. Self-reported incidents, broad definition, vendor-funded. No average dollar loss established.',68,568,560,79,20,C.muted);
  note(s,'Delegation can outgrow permission','The headline is a survey finding, not a measured incident rate per task. CSA surveyed 418 IT and security professionals in January 2026, with Token Security funding and co-developing the questionnaire. Sixty-five percent reported an incident involving AI agents or autonomous workflows in the prior twelve months. Among incident-affected respondents, 35 percent reported financial cost, but the source does not establish an average dollar loss. Do not extrapolate a market-wide loss. The three examples at right are the proposed product problem boundaries. Demand for the specific small-team supplier workflow remains a user-research hypothesis. We exclude the unverified viral Clawdbot purchase anecdote from headline evidence.',[
    'CSA announcement: https://cloudsecurityalliance.org/press-releases/2026/04/21/new-cloud-security-alliance-survey-reveals-82-of-enterprises-have-unknown-ai-agents-in-their-environments',
    'First-party incident account, separate qualitative evidence: https://www.saastr.com/replits-new-release-address-most-of-the-challenges-we-hit-vibe-coding-but-is-prosumer-vibe-coding-really-ready-for-commercial-apps-yet/'
  ]);
}
// 03 — narrow, useful first workflow.
{
  const s=base(3,'Target user and first workflow','Supplier research with a controlled handoff');
  txt(s,'user','First user: an operations generalist comparing suppliers for a small team.',64,195,1140,70,28,C.gray);
  table(s,3,[
    ['Stage','Worker activity','Authority boundary'],
    ['Research','Compare approved suppliers in parallel','Read pages and save source evidence'],
    ['Prepare','Create a comparison and draft request','Create local artifacts only'],
    ['Commit','Broker submits the approved request','Exact approval before any request write'],
    ['Verify','Read the independently stored receipt','Confirm success after verification']
  ],[160,500,492],270,[52,68,68,68,68]);
  txt(s,'fixture','SupplierLab uses synthetic vendors and requests in a real local app. No real payments.',64,628,1150,32,23,C.green,true);
  note(s,'Supplier research with a controlled handoff','The initial workflow deliberately stops at a purchase request in a local fixture application, not an actual purchase or external email. SupplierLab will contain synthetic vendor pages and a local request database. Two workers research in parallel. Their browser sessions have read authority only. They produce citations, comparison data and a draft. Only a controller-owned action broker can create the final test request after exact approval. A separate verification read checks the receipt and its expected fields. This makes the important boundary observable without spending money or giving the agent access to personal accounts. User frequency and willingness to adopt still require interviews.',[]);
}
// 04 — proposed differentiating bundle.
{
  const s=base(4,'Proposed solution and USP','Bounded work, from request to receipt',true);
  const rows=[
    ['01','Permissions outside the agent','The controller owns write authority. Approval binds to a specific action and payload.'],
    ['02','One shared resource allowance','Reserve requests, tokens, steps and retries before work. Stop all workers when required.'],
    ['03','Completion backed by evidence','Validate the saved artifact and receipt. Preserve failure, blocked and unverified outcomes.']
  ];
  rows.forEach((r,i)=>{const y=216+i*127;txt(s,`number-${i}`,r[0],64,y,74,56,40,C.mint,true);txt(s,`control-${i}`,r[1],170,y,1034,48,31,C.cream,true);txt(s,`detail-${i}`,r[2],170,y+49,1025,70,26,C.muted);});
  txt(s,'usp','Proposed USP: one local workflow joining action permission, shared limits and verified outcomes.',64,619,1148,43,24,C.mint);
  note(s,'Bounded work, from request to receipt','These are the three core additions, not an invitation to add a large feature catalogue. Exact approvals, budgets and runtime controls already exist in other products. Our proposed contribution is their coherent application to a small, locally runnable computer-agent workflow with a clear controlled commit and evidence of the outcome. Policy is enforced by the controller and request service, rather than by hoping a system prompt will be obeyed. A reservation ledger accounts for concurrent workers. Verification is separate from the worker narrative. Evidence must include useful task completion as well as prevention. All capabilities on this slide are proposed.',[
    'Comparable approval pattern: https://docs.permit.io/permit-mcp-gateway/human-in-the-loop',
    'Comparable runtime policies: https://docs.nvidia.com/openshell/how-it-works/policies/overview'
  ]);
}
// 05 — concrete mechanism.
{
  const s=base(5,'How the control works','Approval binds to the exact action');
  txt(s,'example-label','Illustrative SupplierLab request',64,190,1150,43,27,C.gray);
  table(s,5,[
    ['Review field','Exact proposed value','Controller rule'],
    ['Destination','SupplierLab / vendor V-03','Approved destination and resource only'],
    ['Payload','20 adapters at ₹450 each','Quantity and unit price are fixed'],
    ['Total','₹9,000, tax included, no shipping','Total must match the reviewed quote'],
    ['Approval','Request PR-017, expires in 60 seconds','Single use, payload and policy bound']
  ],[200,466,486],246,[52,67,67,67,67]);
  txt(s,'mutation-rule','A changed payload, stale approval or direct browser write is rejected. The user must review the new action.',64,596,1152,64,25,C.green,true);
  note(s,'Approval binds to the exact action','This is an illustrative action, not a screenshot or test result. The broker canonicalizes the destination, action type, resource, exact payload, relevant policy version and idempotency key. A user approval records the bound hash and expiry. The broker consumes approval atomically and checks it again immediately before the write. Editing quantity, price, destination or policy invalidates the approval. Retries cannot reuse a consumed approval to create a second request. The backend must enforce write authority independently of the browser UI. Workers have no write token and no route that bypasses the broker. Approval identity, expiry, denial, duplicate submission, race conditions and time-of-check/time-of-use changes are part of the evaluation cases. The sample arithmetic is 20 multiplied by 450 equals 9,000.',[]);
}
// 06 — honest alternatives and originality.
{
  const s=base(6,'Innovation and existing solutions','Desktop delegation with enforceable boundaries');
  table(s,6,[
    ['Existing approach','Documented strength','Our proposed focus'],
    ['Opticon','Parallel desktops, approval, replay','Exact action approval and receipt checks'],
    ['E2B','Hosted desktop sandboxes','Local execution with no cloud account'],
    ['Permit + LangGraph','Authorization and approval patterns','Exact approval at the desktop commit'],
    ['LiteLLM','Model usage accounting and limits','Steps, retries and verified worker stop'],
    ['OpenShell + Zenity','Runtime and action controls','A narrow local workflow and evidence']
  ],[236,442,474],190,[52,64,64,64,64,64]);
  txt(s,'attribution','Opticon-inspired desktop workflow. Independent implementation planned.',64,628,1152,33,23,C.green,true);
  note(s,'Desktop delegation with enforceable boundaries','This comparison describes documented product scope, not an independently benchmarked ranking or a claim that competitors cannot add the proposed workflow. Opticon is the direct orchestration reference. A static review at commit ce4d098ed5ba86e564da72ddb816716b4b72c602 and its demonstration showed task approval, desktop orchestration and replay. The reviewed worker emits completion events after certain error paths, so independent verification is a concrete area to improve in our own implementation. This is not a full Opticon security audit. E2B is excluded because this user account requires a verification payment, regardless of public credit wording. Permit and LangGraph already support approval patterns. LiteLLM covers model traffic. OpenShell explicitly documents filesystem, network and process policy, while Zenity makes directly overlapping runtime-control claims. We must earn differentiation through the specific workflow, transparent boundaries and evaluation, not a first-ever claim. Opticon source reuse rights and notices must be verified before any copying. Baseline will be our own Opticon-inspired loop, not an unchanged Opticon benchmark.',[
    'Opticon: https://github.com/23jmo/opticon',
    'Opticon demo: https://www.youtube.com/watch?v=Sc6lU9XTJmo',
    'E2B: https://e2b.dev/pricing',
    'Permit: https://docs.permit.io/permit-mcp-gateway/human-in-the-loop',
    'LangGraph: https://docs.langchain.com/oss/python/langchain/human-in-the-loop',
    'LiteLLM: https://docs.litellm.ai/docs/proxy/architecture',
    'OpenShell: https://docs.nvidia.com/openshell/how-it-works/policies/overview',
    'Zenity: https://zenity.io/platform/runtime-boundaries'
  ]);
}
// 07 — architecture as an editable native table.
{
  const s=base(7,'Technology stack and architecture','Two local desktops, one trusted controller');
  table(s,7,[
    ['Layer','Proposed stack','Responsibility'],
    ['Review surface','React, TypeScript, Vite, WebSocket','Status, approvals and evidence'],
    ['Trusted controller','Node.js, Zod, SQLite','Policy, ledger, broker and verifier'],
    ['Desktop workers','Colima Linux VM, two containers','Chromium, Playwright, Xvfb, noVNC'],
    ['Model access','Direct NVIDIA hosted API','Image-aware planning, pending key tests'],
    ['Test business app','SupplierLab + local receipt store','Synthetic data, broker-only writes']
  ],[224,464,464],208,[52,65,65,65,65,65]);
  txt(s,'boundary','Shared VM kernel. No home mounts or personal profiles. Keys remain with the controller.',64,628,1152,32,23,C.green,true);
  note(s,'Two local desktops, one trusted controller','A dedicated local Colima Linux VM hosts two Linux desktop containers. These are not separate cloud machines or separate microVMs per agent. The host must remain awake and performance is untested. The controller remains outside worker authority and retains provider credentials. Worker screenshots and read actions are structured inputs. Browser mutation is disabled by server authorization, not by hiding a button. The controller broker is the only write principal. The initial runtime spike must prove screenshot, click/type, independent noVNC views and reliable stop for both workers without personal home shares, personal browser profiles or daemon sockets. Containers share the VM kernel, so this is a constrained prototype boundary, not a claim of complete malware isolation. Candidate NVIDIA model: nvidia/nemotron-3-nano-omni-30b-a3b-reasoning. Image input, structured actions and actual key limits require testing. A local model adapter seam and runtime adapter seam allow future alternatives, but cloud portability is not implemented.',[
    'Colima: https://github.com/abiosoft/colima',
    'Docker security: https://docs.docker.com/engine/security/',
    'NVIDIA candidate: https://build.nvidia.com/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning'
  ]);
}
// 08 — evaluation as central product evidence.
{
  const s=base(8,'Prototype evaluation','Useful completion must survive the controls',true);
  txt(s,'det-count','34',64,202,220,105,80,C.mint,true);
  txt(s,'det-label','planned deterministic\nboundary checks',64,317,320,92,27,C.cream);
  txt(s,'model-count','72',440,202,220,105,80,C.mint,true);
  txt(s,'model-label','planned model-backed\nsessions across two modes',440,317,365,92,27,C.cream);
  txt(s,'status','PLANNED\nNOT RESULTS',880,236,330,109,30,C.mint,true);
  table(s,8,[
    ['Test dimension','Target or measurement'],
    ['Boundary integrity','All deterministic checks pass, no unauthorized writes'],
    ['Task usefulness','At least 80% benign completion, measured false blocks'],
    ['Truth and stopping','No false success, measured stop latency and retry limits']
  ],[350,802],438,[47,52,52,52],{dark:true});
  note(s,'Useful completion must survive the controls','The detailed evaluation protocol is docs/EVALUATION_PLAN.md. The 34 deterministic cases cover approval identity, changes and expiry; concurrent reservations; verification of missing or incorrect receipts; untrusted content; operational stop and recovery; and cost reporting. Seventy-two planned model-backed sessions means six benign tasks plus six challenge tasks, each repeated three times in two modes. Modes are our own baseline loop and the controlled TaskLatch mode. These are repeated sessions over 12 scenarios, not 72 independent task designs. Record actual denominators, blocked action attempts, legitimate completion, false blocks, false success, approval burden, resource usage, overhead and stop latency. Targets shown are release aspirations, not measurements or guarantees. A stop target of five seconds applies only under the defined prototype workload. There must be no claim of safety based on blocking every task. Store raw evidence and preserve failure cases. On a free endpoint, financial-cap tests use an explicitly simulated tariff; no measured dollar savings should be claimed. Run feasibility and model checks before committing to the full model-backed batch.',[]);
}
// 09 — implementation, costs, dependencies.
{
  const s=base(9,'Implementation and feasibility','A zero-cash prototype with early gates');
  table(s,9,[
    ['Window','Build milestone','Required evidence'],
    ['2–3 Nov','Prove two desktops and the model adapter','Screenshot, structured action, stop and quota probe'],
    ['4–7 Nov','Build SupplierLab and the control boundary','Approval binding, broker-only write, receipt check'],
    ['8–11 Nov','Add shared limits, UI and fault handling','Concurrent reservations, denial and recovery cases'],
    ['12–15 Nov','Evaluate, fix and package the prototype','Results, failure log, demo and reproducible setup']
  ],[166,500,486],211,[52,77,77,77,77]);
  txt(s,'cost','Local open-source runtime + existing laptop + NVIDIA free endpoint, if the key passes testing.',64,589,1152,42,24,C.green,true);
  txt(s,'cost-caveat','E2B excluded. Fireworks off unless credits are confirmed. Free API limits may constrain the evaluation batch.',64,635,1152,37,21,C.gray);
  note(s,'A zero-cash prototype with early gates','The baseline requires no mandatory cash payment for cloud desktops or application hosting. This assumes existing laptop and internet access, working local runtime support and usable NVIDIA free hosted endpoint access. Electricity and internet are not represented as literally costless resources. NVIDIA free access is quota- and availability-dependent, not an unlimited production entitlement. No key has been supplied or tested. Fireworks API calls are usage billed and remain disabled unless credits and spending authorization are confirmed. E2B is not a dependency because the actual user account is payment blocked. Dollar-budget scenarios use simulated tariffs, while actual request and token counters are measured. If vision or structured action tests fail, do not silently claim computer-use support or switch to a billable provider. Record the limitation and use the deterministic fixture to establish control logic while the provider gate is resolved. Detailed backlog, dependency order, acceptance criteria and hardware constraints are in the project plan. The prototype window follows the event listing and should be rechecked before submission.',[
    'Event: https://unstop.com/hackathons/codequest-national-tech-hackathon-2026-dotrepo-1771441/amp',
    'NVIDIA candidate: https://build.nvidia.com/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning',
    'NIM access: https://docs.api.nvidia.com/nim/docs/run-anywhere',
    'Fireworks pricing: https://fireworks.ai/pricing'
  ]);
}
// 10 — expected impact plus what judges can verify.
{
  const s=base(10,'Beneficiaries and intended impact','Delegated work with a reviewable outcome',true);
  txt(s,'beneficiary-title','Who benefits',64,216,480,48,31,C.mint,true);
  txt(s,'beneficiaries','Small teams delegating supplier research\n\nDevelopers testing computer-agent controls\n\nLearners without paid cloud desktops',64,288,505,243,28,C.cream);
  txt(s,'evidence-title','What the prototype should prove',704,216,510,72,31,C.mint,true);
  txt(s,'evidence','A useful task completes within its limits.\n\nA changed or unapproved action is blocked.\n\nThe final status matches an independent receipt.',704,304,504,242,27,C.cream);
  txt(s,'impact-caveat','Expected impact, to measure: fewer unauthorized writes and false success reports, with acceptable review effort.',64,570,1152,70,26,C.cream);
  txt(s,'future','Future extension: new action and runtime adapters after the local boundary is demonstrated.',64,642,1150,26,21,C.muted);
  note(s,'Delegated work with a reviewable outcome','Expected beneficiaries are hypotheses, not validated customer segments. Intended impact is fewer unauthorized writes and fewer false completion reports while retaining acceptable legitimate completion and approval effort. The prototype must show both the successful path and blocked/error paths, with inspectable action records, receipt checks and actual metric denominators. Do not present projected financial savings, customer counts or production safety guarantees. Scalability is an architectural path through runtime and action adapters, not a claim that this laptop prototype scales to an enterprise fleet. The local first version is intentionally constrained to two workers and one workflow. Team Update will independently implement the project and disclose Opticon inspiration. Source reuse requires license verification and notices. The judging criteria have not been given numerical weights; the deck maps visibly to the official required topics without inventing scores.',[
    'Originality and required topics: https://unstop.com/hackathons/codequest-national-tech-hackathon-2026-dotrepo-1771441/amp',
    'Orchestration inspiration: https://github.com/23jmo/opticon'
  ]);
}

await fs.mkdir(buildDir,{recursive:true});
await fs.mkdir(path.join(buildDir,'renders'),{recursive:true});
await fs.mkdir(path.join(root,'presentation/output'),{recursive:true});
await fs.mkdir(path.join(root,'.codex-finalizer'),{recursive:true});
await fs.writeFile(path.join(root,'presentation/PRESENTER_NOTES.md'),'# TaskLatch presenter notes\n\nAll capabilities and targets are proposed unless explicitly described as sourced evidence.\n\n'+notes.map(n=>`## ${n.slide}. ${n.title}\n\n${n.text}\n\n${n.sources.map(s=>'- '+s).join('\n')}`).join('\n\n'));
await fs.writeFile(path.join(buildDir,'presentation.json'),JSON.stringify(presentation.toProto(),null,2));
const candidate=path.join(buildDir,'TaskLatch-candidate.pptx');
await (await PresentationFile.exportPptx(presentation)).save(candidate);
for(let i=0;i<presentation.slides.items.length;i++) {
  const slide=presentation.slides.items[i];
  const png=await slide.export({format:'png',scale:1});
  await fs.writeFile(path.join(buildDir,'renders',`slide-${String(i+1).padStart(2,'0')}.png`),new Uint8Array(await png.arrayBuffer()));
}
const {finalizePresentation}=await import(pathToFileURL(path.join(skill,'container_tools/artifact_tool_utils.mjs')).href);
const result=await finalizePresentation({
  workspaceDir:root,candidatePath:candidate,
  finalPath:path.join(root,'presentation/output/TaskLatch-CodeQuest-2026.pptx'),
  explicitTotalSlideCount:10,
  requiredNativeTableOwnerSlides:nativeTables,
  requiredNativeChartOwnerSlides:[],
  tableArithmeticContracts:[],
  pythonExecutable:runtimePython,
  integrityValidatorPath:path.join(skill,'container_tools/inspect_presentation_package_integrity.py'),
  layoutValidatorPath:path.join(skill,'container_tools/inspect_presentation_layout_geometry.py'),
  layoutArgs:['--expected-slide-size-emu','12192000,6858000','--validate-bullet-geometry','--validate-heading-fit',...nativeTables.flatMap(n=>['--require-native-table-slide',String(n)])],
  fontPolicy:{basis:'design',families:[FONT]},
  verifyArtifactToolImport:true,
  receiptPath:path.join(root,'.codex-finalizer/TaskLatch-CodeQuest-2026.validation.json')
});
console.log(JSON.stringify({finalPath:result.finalPath,slideCount:result.presentationLayout.slide_count,layoutFindings:result.presentationLayout.finding_count,layoutWarnings:result.presentationLayout.warnings,importPassed:result.firstPartyImport.passed,sha256:result.finalSha256},null,2));
