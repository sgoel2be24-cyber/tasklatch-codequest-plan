import fs from 'node:fs/promises';
import path from 'node:path';
import { FileBlob, PresentationFile } from '@oai/artifact-tool';

// Read-only round-trip render of the exact validated PPTX.
const root=process.cwd();
const finalPath=path.join(root,'presentation/output/TaskLatch-CodeQuest-2026.pptx');
const deck=await PresentationFile.importPptx(await FileBlob.load(finalPath));
const out=path.join(root,'.build/presentation/final-renders');
await fs.mkdir(out,{recursive:true});
for(let i=0;i<deck.slides.items.length;i++) {
  const png=await deck.slides.items[i].export({format:'png',scale:1});
  await fs.writeFile(path.join(out,`slide-${String(i+1).padStart(2,'0')}.png`),new Uint8Array(await png.arrayBuffer()));
}
console.log(JSON.stringify({importedSlides:deck.slides.items.length,renderDirectory:out}));
