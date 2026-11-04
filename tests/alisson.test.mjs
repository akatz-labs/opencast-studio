import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';

test('Alisson modes use distinct conditioning, aligned geometry, and no anchors or duplicate adapters',()=>{
 const result=spawnSync('python3',['-c',String.raw`
import sys
sys.path.insert(0, 'resources/motion/alisson')
from graph import build, geometry
for kind in ('character-swap','motion-transfer'):
 for audio in (False,True):
  for background in (False,True):
   g=build(kind,dict(quality='480p',seed=42,prompt='Replace the person on the right.'),406,720,120,background,audio)
   ref=g['13']['inputs']; assert ref['length']==107
   assert ref['width']%32==ref['height']%32==0
   assert abs(ref['width']/ref['height']-406/720)<.025
   assert g['13']['inputs']['prompt'].startswith('Replace the person on the right.')
   assert g['18']['inputs']['steps']==8
   assert g['15']['inputs']['model']==g['18']['inputs']['model']
   assert 'anchor' not in str(g).lower() and 'training_adapter' not in str(g)
   if kind=='character-swap':
    assert 'ref_videos.ref_video_1' not in ref
    assert g['14']['class_type']=='MiniMaxH3AddGuide'
    assert g['14']['inputs']['image']==['32',0]
    assert g['19']['inputs']['latent_image']==['13',1]
    assert ('audio' in g['14']['inputs'])==audio
    assert '12' not in g
   else:
    assert g['14']['class_type']=='BFSMiniMaxH3NativeTemporal'
    assert g['14']['inputs']['strength']==2
    assert ref['ref_videos.ref_video_1']==['32',0]
    assert ('ref_images.ref_image_2' in ref)==background
   for node in g.values():
    for value in node['inputs'].values():
     if isinstance(value,list):assert value[0] in g
assert geometry(1080,1920,1000,'720p')[2]==345
assert geometry(1920,1080,124,'480p')[2]==124
assert geometry(1080,1920,124,'720p')[:2]==(736,1344)
`],{encoding:'utf8'});
 assert.equal(result.status,0,result.stderr||result.stdout);
});
