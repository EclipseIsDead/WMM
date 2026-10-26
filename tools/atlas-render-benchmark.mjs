#!/usr/bin/env node
/** Source-checkout CPU benchmark. Run `pnpm build` first. No terminal I/O/FPS claim. */
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { admitAtlas, projectAtlasGrid } from '../packages/core/dist/index.js';
import { canonicalJsonBytes, sha256Hex } from '../packages/canonical/dist/index.js';
import { validateWorkspaceMapView } from '../packages/wire-contracts/dist/index.js';
import { renderAtlasGrid, projectAtlasViewport, atlasRasterStats } from '../apps/cli/dist/workspace/atlas-renderer.js';
import { shadeAtlasGrid, shadeAtlasScreen } from '../apps/cli/dist/workspace/atlas-shader.js';
import { renderWorkspaceScreen } from '../apps/cli/dist/workspace/presentation.js';
import { WorkspaceController } from '../apps/cli/dist/workspace/controller.js';
import { mapFixture, workspaceFixture } from '../apps/cli/test/atlas-fixture.ts';

const demo = JSON.parse(readFileSync(new URL('../fixtures/authoring/atlas-project.json', import.meta.url), 'utf8')).atlases[0];
const dense = { ...demo, id: 'dense', physicalCoverage: [{ surface: 'land', geometry: { kind: 'polygon', vertices: [[0,0],[1200,0],[1200,800],[0,800],[0,0]] } }], features: Array.from({length:64}, (_, i) => {
  const x = i % 8 * 150 + 10, y = Math.floor(i / 8) * 100 + 10;
  return { id: `region_${i}`, entityId: `place:region_${i}`, label: `Region ${i}`, geometry: { kind:'polygon', vertices:[[x,y],[x+100,y],[x+100,y+60],[x,y+60],[x,y]] }, anchor:[x+50,y+30], precision:'approximate', locator:'Synthetic benchmark only' };
}) };
function measure(fn, count) {
  const samples = [];
  for (let i=0;i<count;i++) { const start=performance.now(); fn(i); samples.push(performance.now()-start); }
  samples.sort((a,b)=>a-b);
  return { samples:count, medianMs:Number(samples[Math.floor(count/2)].toFixed(3)), p95Ms:Number(samples[Math.ceil(count*.95)-1].toFixed(3)) };
}
let failures = 0;
console.log(JSON.stringify({ runtime:process.version, platform:`${process.platform}/${process.arch}`, scope:'CPU raster/shader/layout; excludes Ink reconciliation, terminal transport and emulator paint', caches:'at most four immutable rasters and 64 point queries; process-local only' }));
for (const [name, input] of [['demo',demo], ['64-regions',dense]]) {
  const atlas = admitAtlas(input, { worldId:input.worldId, placeIds:input.features.map(feature=>feature.entityId), sourceIds:[input.provenance.sourceId] });
  for (const [columns, rows] of [[72,18],[160,60]]) {
    try {
      const coldGeometry = measure(() => projectAtlasGrid(atlas,{columns,rows}), 12);
      const grid = projectAtlasViewport(atlas,columns,rows), before=atlasRasterStats();
      let runCount=0;
      const warmCellPass = measure(i => {
        const selectedFeatureId=atlas.features[i%atlas.features.length].id;
        const reused=projectAtlasViewport(atlas,columns,rows);
        if (reused!==grid) throw new Error('Warm cell pass rerasterized immutable geometry');
        const options={layer:'reference',selectedFeatureId};
        const frame=shadeAtlasGrid({atlas,grid,glyphs:renderAtlasGrid(atlas,grid,options),options,row:0},'truecolor');
        runCount=frame.rows.reduce((count,row)=>count+row.length,0);
      },100);
      if (atlasRasterStats().rasterizations!==before.rasterizations) throw new Error('Selection/colour redraw rebuilt geometry');
      console.log(JSON.stringify({name,columns,rows,coldGeometry,warmCellPass,runCount,status:'rendered',extraRasterizations:atlasRasterStats().rasterizations-before.rasterizations}));
    } catch (error) { failures++; console.log(JSON.stringify({name,columns,rows,status:error.code??'failed',message:error.message})); }
  }
  const initial=workspaceFixture(), base={...initial.workspace.base,worldId:atlas.worldId};
  const workspace={...initial,workspace:{...initial.workspace,base,worldTitle:`Synthetic ${name} benchmark`,proposals:[]}};
  const map={...mapFixture(atlas),base,atlasDigest:sha256Hex(canonicalJsonBytes(atlas))};
  if (!validateWorkspaceMapView(map).valid) throw new Error('Invalid benchmark map view');
  const controller=new WorkspaceController({read:()=>workspace,mutate:()=>{throw new Error('Read-only benchmark');},readMap:()=>map},workspace);
  controller.input('2'); controller.input('m');
  for (const [columns,rows] of [[80,24],[120,36],[240,80]]) {
    try {
      const draw=()=> { let paint; const screen=renderWorkspaceScreen(controller.getSnapshot(),columns,rows,undefined,value=>{paint=value;}); if(!paint)throw new Error('No drawable benchmark atlas'); return shadeAtlasScreen(screen,paint,'truecolor'); };
      draw();
      const before=atlasRasterStats();
      const warmScreen=measure(i=>{controller.input(i%2?'k':'j',{},columns,rows);draw();},50);
      if(atlasRasterStats().rasterizations!==before.rasterizations)throw new Error('Full-screen selection rerasterized');
      console.log(JSON.stringify({name,terminalColumns:columns,terminalRows:rows,warmScreen,extraRasterizations:0,status:'rendered'}));
    } catch(error) { failures++; console.log(JSON.stringify({name,terminalColumns:columns,terminalRows:rows,status:error.code??'failed',message:error.message})); }
  }
}
if(failures)process.exitCode=1;
